/**
 * One-shot quota decrement. Called by the iOS agent loop (and any future
 * flow that wants to decouple "do work" from "charge for it").
 *
 * Why this is its own endpoint:
 *   • The /agent loop runs N turns, but only the *whole* loop should
 *     count as one analysis against the user's pack/sub quota. Doing
 *     consume on the last /agent turn forces a wasted "ok" round just
 *     to flip the consume flag — pure tax for the user.
 *   • Splitting it out lets the agent run unmetered (rate-limited only)
 *     and the client charges itself once at the end on success.
 *
 * Failure modes the iOS client must handle:
 *   • Network drops between agent success and consume call → user keeps
 *     the analysis, server quota stays unchanged. We accept this as a
 *     low-cost edge case (one freebie per dropped network call). A
 *     future hardening pass could persist a pending-consume queue.
 */

import type { Env } from '../index';
import { json } from '../lib/http';
import {
  isValidToken,
  loadEntitlement,
  saveEntitlement,
  consumeAnalyze,
  canAnalyze,
  getFreeUsed,
  incrementFreeUsed,
} from '../lib/entitlement';

export async function handleConsumeAnalysis(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const accountToken = request.headers.get('X-Account-Token');
  if (!isValidToken(accountToken)) {
    return json({ error: 'missing_or_invalid_account_token' }, 400);
  }

  const ent = await loadEntitlement(accountToken, env.RATE_KV);
  const freeUsed = await getFreeUsed(accountToken, env.RATE_KV);
  const gate = canAnalyze(ent, freeUsed);
  if (!gate.allowed) {
    // Stale client — they ran the agent loop but quota is gone (race
    // with another device, or a refund). Surface so the client can show
    // the paywall instead of silently dropping the analysis.
    return json({ error: 'quota_exhausted', reason: gate.reason, tier: ent.tier }, 402);
  }

  if (ent.tier === 'free') {
    await incrementFreeUsed(accountToken, env.RATE_KV);
  } else {
    consumeAnalyze(ent);
    await saveEntitlement(accountToken, ent, env.RATE_KV);
  }
  return json({ ok: true, tier: ent.tier }, 200);
}
