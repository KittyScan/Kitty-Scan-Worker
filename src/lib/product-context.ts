/**
 * Product state snapshot fed to the AI analyst alongside raw telemetry.
 *
 * Without this, the analyst keeps recommending features we've already
 * shipped ("add CSAT 👍/👎" when 👍/👎 has been live for weeks). The
 * snapshot is the ground truth for "what already exists" so Claude can:
 *   • avoid re-recommending shipped features
 *   • point at the actual file/feature when proposing improvements
 *   • focus recommendations on the deliberate gap list
 *
 * UPDATE THIS WHENEVER YOU SHIP A FEATURE. The cost of forgetting is the
 * analyst suggesting things you finished last sprint.
 */

export const PRODUCT_CONTEXT = `
KittyScan — AI cat health iOS app. Privacy-first, kitty-themed, currently in App Store review (v1.0).

═════════════════════════════════════════════════════
SHIPPED (do NOT recommend rebuilding these)
═════════════════════════════════════════════════════

CORE
- Camera + photo picker → on-device quality check → AI analyze
- Health report: composite score + 4 sub-scores (eyes/fur/posture/energy)
- Per-axis textual conditions, suggestions, warnings
- Cat profile (name, breed, age, sex, neuter status, known issues, avatar)
- Multi-cat support with selector on home screen
- Cat identity check (Vision-based) — flags "different cat" with bottom sheet to create new profile

PAYMENTS / TIERS
- Free: 3 lifetime analyses
- 10-pack: \$2.99 — 10 analyses, never expire
- 30-pack: \$6.99 — 30 analyses, never expire
- Pro Monthly: \$6.99/mo — 50 analyses + 30 chats per month
- Apple StoreKit 2; server-side JWS verification (/verify-receipt)
- Entitlement ledger in Cloudflare KV; 30-day TTL on free counters
- Self-heal: HTTP 402 → re-sync all StoreKit entitlements → retry once
- 402 ALWAYS becomes a paywall sheet, never an error banner
- Apple App Store Server Notifications webhook (/webhook/apple) wired up

ONBOARDING
- Sign in with Apple, Google Sign-In, plus "Skip" option
- 3-step onboarding: welcome → breed/theme picker → profile create
- 22 cat themes (default is free; 21 locked behind any purchase via .themeLocked paywall)
- Cute kitty tone throughout (ฅ, (=^・ω・^=), 喵)

CONTENT FEATURES
- Daily diary tab: meals, water, mood, weight, discomfort, notes
- Last 7 days of diary auto-feed into next analysis prompt
- History tab with per-axis trend chart
- Per-report follow-up chat (Pro-only, Haiku)
- Per-report 👍/👎 footer with 4-reason picker on 👎
- Share/export: PNG, JSON, PDF
- Email composer integration

LOCALIZATION
- UI: zh-Hans + en (other 28 languages fall back to English UI)
- AI output: 30 languages, prompt-level instruction passes user's choice to Claude
- Language picker in Settings

PERFORMANCE / UX
- Phase 1: streaming analysis — pre-JSON observation streams as typewriter card,
  TTFT < 1.5s (vs 5s before)
- Phase 2: Pro-tier multi-turn agent loop with two tools (get_scan_history,
  get_diary_entries). 4-stage progress card (observe → history → diary → write).
  Uses Haiku 4.5 server-side for cost (~40% cheaper than the old single-shot Sonnet).
- Cost-quota self-heal so users never see "Analysis failed" for quota reasons
- Low-quota proactive popup at 5/3/1 remaining (cute kitty copy)

PRIVACY
- No analytics SDKs (no Firebase / Amplitude / Mixpanel / Segment)
- No IDFA, no ATT prompt
- Photos pass through Worker during API call only — NOT persisted on backend
- Cat profiles, reports, diary, chat history stored locally via SwiftData
- iCloud KV (NSUbiquitousKeyValueStore) syncs ONE thing across devices: the
  Account Token UUID — so deleting the app doesn't reset the free trial

OBSERVABILITY (this dashboard)
- Per-call log in KV (log:* prefix, 30d TTL): route, status, model, tier,
  duration, tokens, country
- Cost ledger (cost:YYYY-MM)
- Feedback ledger (fb:* prefix)
- Entitlement ledger (ent:*)
- Admin dashboard sections: overview / activity / feedback / users / costs
- AI Insights (this view) — Claude-driven daily analysis with bilingual output

WORKER ARCHITECTURE
- Single Cloudflare Worker (~2k LOC TypeScript)
- KV-only state (no D1, no Durable Objects)
- WAF layer rejects bot UAs at the edge
- Three-layer rate limit: per-IP/hour, per-device/day, per-account-token entitlement
- Three-layer cost defense: Anthropic Spend Limit \$20/mo + cost-cross alert + per-tier model selection (Haiku for free/pack, Sonnet single-shot was the old Pro path, now Haiku-agent for Pro)

═════════════════════════════════════════════════════
NOT YET SHIPPED (candidates for recommendations)
═════════════════════════════════════════════════════

USER-FACING
- Push notifications (any kind)
- Apple Watch app or home-screen Widget
- Live Activity / Dynamic Island for analysis progress
- Anomaly detection ("weight dropped 8% in 7 days")
- Health alerts / digest emails
- Vet directory or vet referral
- Multi-cat cross-comparison view
- Family sharing (multiple iCloud users editing one cat)
- Apple HealthKit integration
- Annual subscription plan / discount
- Referral / invite-friend incentives
- ask_user mid-agent interactivity (deferred from Phase 2)

GROWTH
- Marketing landing page (current netlify support page is bare-bones)
- App Store screenshot localization beyond zh+en
- TestFlight public link / external testers
- Press kit / launch posts

ENGINEERING
- Eval pipeline / regression test suite for prompt changes
- A/B test framework for prompt or UX variants
- Cohort retention dashboards (D1/D7/D30)
- Per-cohort LTV
- Sandbox-vs-production Apple API endpoint detection (currently sandbox
  receipt verification fails because Worker only hits production endpoint)

LOCALIZED UI
- Only zh-Hans + en have actual .strings files; other 28 supported
  languages render English UI with localized AI output

═════════════════════════════════════════════════════
DELIBERATE NON-GOALS (do NOT recommend these)
═════════════════════════════════════════════════════

- Social / community feed (kills the privacy-first positioning)
- Third-party analytics SDKs (same)
- In-app advertising (never)
- Selling user data to brokers (never)
- Account-required usage (the Skip option is intentional)

═════════════════════════════════════════════════════
KEY POSITIONING + CONSTRAINTS
═════════════════════════════════════════════════════

- Solo founder. Engineering bandwidth is the bottleneck.
- North star: ROI = monthly revenue ÷ Anthropic cost.
- Target market: cat owners wanting gentle AI-aided check-ins.
- Tone: cute, kitty-themed. Don't recommend voice-of-app changes that go corporate.
- App Store rejection just resolved (1.5/3.1.2/5.1.2 — privacy + EULA).
  v1.0 currently in re-review. Avoid recommending changes that would
  trigger another rejection cycle.
`.trim();
