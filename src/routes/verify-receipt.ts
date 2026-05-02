import type { Env } from '../index';
import { json } from '../lib/http';
import {
  applyAppleTransaction,
  isValidToken,
  loadEntitlement,
} from '../lib/entitlement';
import { verifyTransactionId } from '../lib/apple-api';

/**
 * Client-reported purchase verification. The iOS client POSTs the
 * transactionId of a freshly verified `Transaction` immediately after a
 * successful purchase. We use Apple's App Store Server API to fetch the
 * authoritative transaction info (signed JWS), verify, and update the ledger.
 *
 * This endpoint is best-effort from the client's perspective — if it fails
 * we fall back to lazy verification on the next /analyze call (the same
 * client also carries the JWS via StoreKit's currentEntitlements).
 *
 * For v1 we accept the client-reported transactionId at face value AFTER
 * cross-checking with App Store Server API (so a forged client report can't
 * grant a real transaction it doesn't own). The lookup itself is the trust
 * anchor here — if Apple confirms the transaction exists with the same
 * appAccountToken, we trust the rest.
 *
 * App Store Server API integration is wired but stubbed; see TODO.
 */

interface VerifyBody {
  transactionId?: string;
  originalTransactionId?: string;
  productId?: string;
}

export async function handleVerifyReceipt(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const token = request.headers.get('X-Account-Token');
  if (!isValidToken(token)) {
    return json({ error: 'missing_or_invalid_account_token' }, 400);
  }

  let body: VerifyBody;
  try { body = (await request.json()) as VerifyBody; }
  catch { return json({ error: 'invalid_json' }, 400); }

  if (!body.transactionId || !body.productId) {
    return json({ error: 'missing_fields' }, 400);
  }

  // Pull Apple secrets — Worker refuses to grant entitlements without them.
  // (Forging client → server entitlement would otherwise be a single curl.)
  const e = env as unknown as {
    APPLE_PRIVATE_KEY?: string;
    APPLE_BUNDLE_ID?: string;
    APPLE_KEY_ID?: string;
    APPLE_ISSUER_ID?: string;
  };
  if (!e.APPLE_PRIVATE_KEY || !e.APPLE_BUNDLE_ID || !e.APPLE_KEY_ID || !e.APPLE_ISSUER_ID) {
    console.warn('[verify-receipt] Apple secrets not configured');
    return json({ error: 'verification_unavailable', detail: 'apple_secrets_not_set' }, 503);
  }

  // ---- Real App Store Server API verification ----
  // Apple is the trust anchor. We hit their server with our signed JWT,
  // they hand back the transaction info as a JWS, we verify and decode.
  // Anything the client claimed in the request body is ignored if it
  // doesn't match Apple's authoritative response.
  const lookup = await verifyTransactionId(body.transactionId, {
    keyId: e.APPLE_KEY_ID,
    issuerId: e.APPLE_ISSUER_ID,
    bundleId: e.APPLE_BUNDLE_ID,
    privateKeyPem: e.APPLE_PRIVATE_KEY,
  });
  if (!lookup.ok) {
    console.warn('[verify-receipt] Apple lookup failed', lookup.reason, lookup.status);
    return json({ error: 'verification_failed', detail: lookup.reason }, 401);
  }
  const tx = lookup.transaction.transaction;

  // Bundle-id check — protects against someone replaying a transactionId
  // from a *different* app. Apple's API returns transactions for any app
  // the issuer is authorized for; we have to filter ourselves.
  if (tx.bundleId !== e.APPLE_BUNDLE_ID) {
    console.warn('[verify-receipt] bundleId mismatch', tx.bundleId, 'vs', e.APPLE_BUNDLE_ID);
    return json({ error: 'wrong_bundle' }, 401);
  }

  // appAccountToken check — the client claimed this transaction belongs
  // to `token`. Apple's response includes the appAccountToken Apple saw at
  // purchase time. They must match — otherwise a user could try to graft
  // someone else's purchase onto their own account.
  if (tx.appAccountToken && tx.appAccountToken.replace(/-/g, '').toLowerCase()
      !== token.replace(/-/g, '').toLowerCase()) {
    console.warn('[verify-receipt] appAccountToken mismatch');
    return json({ error: 'token_mismatch' }, 401);
  }

  // Apply the verified transaction to the ledger.
  await applyAppleTransaction(
    {
      token,
      productId: tx.productId,
      transactionId: tx.transactionId,
      expiresMs: tx.expiresDate,
      purchaseMs: tx.purchaseDate,
    },
    env.RATE_KV,
  );

  const ent = await loadEntitlement(token, env.RATE_KV);
  return json({ ok: true, tier: ent.tier, environment: lookup.transaction.environment }, 200);
}
