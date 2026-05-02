# 🐾 Carmel Worker — KittyScan Backend

> Production-grade Cloudflare Worker that brokers Anthropic Claude vision
> calls for the [KittyScan iOS app](https://github.com/KittyScan/Kitty-Scan),
> with server-side Apple StoreKit verification, a tier-aware entitlement
> ledger, multi-layer rate limiting, and per-request cost tracking.

---

## Why this exists

KittyScan's iOS client never holds an API key. Every Claude vision request
goes through this Worker, which:

1. **Authenticates the device** (account-token + device-id headers).
2. **Decides the model** based on the user's verified subscription tier.
3. **Enforces a layered quota** so a single jailbroken client cannot
   drain the monthly Anthropic spend cap.
4. **Verifies Apple StoreKit purchases server-side** using the App Store
   Server API JWS payload as the trust anchor — a forged client report
   cannot grant entitlement.
5. **Tracks per-request token cost** in real time and fires a webhook
   alert before the spend ceiling hits.

`/analyze` p99 stays under ~3.5 s end-to-end (Claude vision dominates).

---

## Architecture

```
                  iOS App (SwiftUI + StoreKit 2)
                              │
                              │  HTTPS  (X-Account-Token, X-Device-Id, X-Tier)
                              ▼
   ┌──────────────────────────────────────────────────────────────┐
   │                  Cloudflare Worker (TypeScript)              │
   │                                                              │
   │   POST /analyze ────┐                                        │
   │                     ├──▶ checkAndIncrementIp (KV)            │
   │                     ├──▶ entitlement gate (KV ledger)        │
   │                     ├──▶ checkAndIncrement device (KV)       │
   │                     ├──▶ tier-aware model selection          │
   │                     │      • subscriber → Sonnet 4           │
   │                     │      • free / pack → Haiku 4.5         │
   │                     ├──▶ callAnthropic                       │
   │                     ├──▶ trackAndMaybeAlert (cost ledger)    │
   │                     └──▶ consume entitlement / free counter  │
   │                                                              │
   │   POST /verify-receipt ─▶ Apple App Store Server API JWS    │
   │                          ├──▶ bundle-id + token cross-check  │
   │                          └──▶ applyAppleTransaction (ledger) │
   │                                                              │
   │   POST /webhook/apple ──▶ Apple JWS notification verify      │
   │                          └──▶ subscription state reconcile   │
   │                                                              │
   │   POST /feedback ────────▶ KV record + Resend email forward  │
   └─────────────────────────────────┬────────────────────────────┘
                                     │
                              ┌──────┴──────┐
                              ▼             ▼
                       Workers KV    Anthropic API
                       (state)       (Claude vision)
```

---

## Highlights

### Tier-aware model orchestration
A single header (`X-Tier`) decides between two Claude model classes:

```ts
const model = tier === 'premium'
  ? (env.MODEL || 'claude-sonnet-4-6')          // accuracy
  : 'claude-haiku-4-5-20251001';                // ~6× cheaper
```

The tier is signaled by the iOS client based on a server-verified StoreKit
transaction — not the client-claimed tier. A jailbroken client setting
`X-Tier: premium` still falls back to whatever the entitlement ledger
proves they paid for.

### Server-side Apple JWS verification
`/verify-receipt` is the trust anchor for paid features:

1. iOS posts the freshly-issued `transactionId` after `Transaction.verified`.
2. Worker calls Apple App Store Server API with a signed ES256 JWT (signed
   in WebCrypto from the .p8 PKCS#8 key).
3. Apple returns the canonical transaction as a JWS — Worker verifies the
   signature and decodes the payload.
4. Cross-check `bundleId` (rejects replay from another app) and
   `appAccountToken` (rejects grafting someone else's purchase).
5. `applyAppleTransaction` writes a tier upgrade to the KV ledger, guarded
   by an `isTransactionApplied` idempotency check.

The Worker refuses to grant entitlement if the four Apple secrets aren't
configured (returns 503 rather than fail-open).

### Three layers of abuse defense

| Layer | Key | Purpose |
|---|---|---|
| `checkAndIncrementIp` | `ip:<ip>:<hour>` | 20/hour ceiling — catches fresh-device-id enumeration from a single IP. |
| `checkAndIncrement` | `day:<deviceId>:<date>` + `month:<deviceId>:<month>` | Per-device daily / monthly quota — defense-in-depth. |
| Entitlement ledger | `ent:<accountToken>` | The real quota. Free-tier counter (`free:<accountToken>`) is keyed by an iCloud-synced UUID so deleting the app no longer resets the trial. |

All three back to the same Anthropic Console hard $20/mo Spend Limit. Worst
case: an attacker who somehow bypasses every layer still hits Anthropic's
503 at $20.

### Per-request cost tracking with edge-triggered alerts

```ts
const cost = inTok * INPUT_PRICE_PER_TOKEN + outTok * OUTPUT_PRICE_PER_TOKEN;
const next = prev + cost;
await kv.put(`cost:${month}`, next.toFixed(6), { expirationTtl: 86_400 * 70 });
if (prev < alertThresholdUsd && next >= alertThresholdUsd) {
  await sendAlert(webhook, month, next, env);    // fires exactly once per month
}
```

Token-by-token cost rolls into a monthly KV counter. The alert is
edge-triggered (`prev < threshold && next >= threshold`) so the webhook
fires exactly once per month even if traffic stays above the line.

---

## Tech Stack

- **Runtime**: Cloudflare Workers (V8 isolate, edge-deployed)
- **Language**: TypeScript
- **Storage**: Workers KV (rate counters, entitlement ledger, cost ledger)
- **Crypto**: WebCrypto (ES256 JWT signing for Apple App Store Server API)
- **AI**: Anthropic Claude Sonnet 4 / Haiku 4.5 (vision + chat)
- **Tooling**: Wrangler, esbuild

---

## Layout

```
src/
├── index.ts                    # Entry, route dispatch, CORS, env typing
├── routes/
│   ├── analyze.ts              # /analyze — gate + Claude call + bookkeeping
│   ├── verify-receipt.ts       # /verify-receipt — Apple JWS verify
│   ├── apple-webhook.ts        # /webhook/apple — Apple subscription events
│   └── feedback.ts             # /feedback — user-reported bug/feedback ingest
└── lib/
    ├── anthropic.ts            # Claude API client + retry
    ├── apple-api.ts            # Apple App Store Server API HTTP wrapper
    ├── apple-jws.ts            # JWS verify + decode (incoming Apple payloads)
    ├── apple-jwt.ts            # JWT sign (outgoing Apple requests)
    ├── costs.ts                # Cost ledger + threshold-crossing alerts
    ├── entitlement.ts          # Tier ledger + Apple transaction application
    ├── http.ts                 # JSON helpers, CORS
    ├── ratelimit.ts            # Per-IP + per-device sliding windows in KV
    └── waf.ts                  # Hot-path block list
```

`src/` is ~1,500 lines of TypeScript.

---

## Deploy

```bash
# First time setup
npx wrangler login
npx wrangler kv:namespace create RATE_KV   # paste id into wrangler.toml

# Set the secrets (none of these touch the repo)
npx wrangler secret put ANTHROPIC_KEY
npx wrangler secret put APPLE_BUNDLE_ID
npx wrangler secret put APPLE_KEY_ID
npx wrangler secret put APPLE_ISSUER_ID
npx wrangler secret put APPLE_PRIVATE_KEY    # .p8 PEM body, single line

# Ship
npx wrangler deploy
```

---

## Notes

- All secrets are stored as Cloudflare Worker secrets via `wrangler secret put`,
  never in source.
- iOS client repo: <https://github.com/KittyScan/Kitty-Scan>

## License

All rights reserved. Source available for portfolio review.
