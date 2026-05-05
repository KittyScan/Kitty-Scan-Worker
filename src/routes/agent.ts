/**
 * Multi-turn agent endpoint. The iOS client owns the loop; this Worker
 * is a single-turn broker that:
 *
 *   • Authenticates the device + account-token.
 *   • Enforces per-IP / per-device rate limits (defense-in-depth on top
 *     of the entitlement ledger, identical to /analyze).
 *   • If `consume: true`, gates on entitlement and decrements once the
 *     Anthropic call succeeds. Intermediate tool-resolution rounds set
 *     `consume: false` so a 4-step agent run only costs the user 1 free
 *     analysis (or one Pro slot), not 4.
 *   • Forwards the messages array (with optional tools) to Claude.
 *     Supports both buffered JSON and SSE streaming — streaming is what
 *     the final synthesis turn uses so the report types in real-time.
 *   • Tracks token cost on every turn (we still pay Anthropic per turn
 *     even if the user is only billed once).
 *
 * Pro-only by design — the entitlement check rejects free + pack tiers
 * with HTTP 402 so the iOS client can surface the paywall. (Pack users
 * keep the existing single-shot /analyze flow — same cost, less drama.)
 */

import type { Env } from '../index';
import { json } from '../lib/http';
import { checkAndIncrement, checkAndIncrementIp } from '../lib/ratelimit';
import { callAnthropicMessages, callAnthropicMessagesStream } from '../lib/anthropic';
import { trackAndMaybeAlert } from '../lib/costs';
import {
  isValidToken,
  loadEntitlement,
  canAnalyze,
  getFreeUsed,
} from '../lib/entitlement';

interface AgentBody {
  messages?: unknown;
  tools?: unknown;
  max_tokens?: number;
  /** When `true` the response is `text/event-stream`. */
  stream?: boolean;
}

// Hard-coded to the cheaper Haiku 4.5 model. The agent's value comes from
// multi-turn tool use and history/diary integration, not raw vision depth —
// we trade a bit of single-call accuracy for ~3x lower per-token cost so
// Pro user economics stay in the same ballpark as the single-shot Sonnet
// /analyze flow. The user-visible upgrade is the agentic depth, not the
// underlying model.
const AGENT_MODEL = 'claude-haiku-4-5-20251001';

const DEVICE_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

export async function handleAgent(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const deviceId = request.headers.get('X-Device-Id');
  if (!deviceId || !DEVICE_ID_RE.test(deviceId)) {
    return json({ error: 'missing_or_invalid_device_id' }, 400);
  }

  // Same defensive layers as /analyze — we don't want a malicious agent
  // session to bypass abuse defenses.
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipRl = await checkAndIncrementIp(ip, env.RATE_KV);
  if (!ipRl.allowed) {
    return json({ error: 'rate_limited', reason: 'ip_hourly', count: ipRl.count }, 429);
  }

  const dayLimit = parseInt(env.DAY_LIMIT || '5', 10);
  const monthLimit = parseInt(env.MONTH_LIMIT || '80', 10);
  const rl = await checkAndIncrement(deviceId, env.RATE_KV, dayLimit, monthLimit);
  if (!rl.allowed) {
    return json(
      { error: 'rate_limited', reason: rl.reason, resetAt: rl.resetAt,
        limits: { day: dayLimit, month: monthLimit } },
      429,
    );
  }

  // Pro-only gating. We need the account token to check entitlement at all,
  // and once we have it, the tier check rejects everyone except active subs.
  // Quota is also checked on every turn (cheap KV read) so a 0-quota user
  // doesn't burn Worker time running 4 tool turns before being told no.
  // Actual decrement happens out-of-band via /consume-analysis, called by
  // the iOS client once after the loop ends successfully — that way a
  // 4-turn agent run still costs the user just one Pro analysis slot.
  const accountToken = request.headers.get('X-Account-Token');
  if (!isValidToken(accountToken)) {
    return json({ error: 'missing_or_invalid_account_token' }, 400);
  }
  const ent = await loadEntitlement(accountToken, env.RATE_KV);
  if (ent.tier !== 'sub') {
    return json({ error: 'pro_required', tier: ent.tier }, 402);
  }
  const freeUsed = await getFreeUsed(accountToken, env.RATE_KV);
  const gate = canAnalyze(ent, freeUsed);
  if (!gate.allowed) {
    return json({ error: 'quota_exhausted', reason: gate.reason, tier: ent.tier }, 402);
  }

  let body: AgentBody;
  try {
    body = (await request.json()) as AgentBody;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return json({ error: 'missing_messages' }, 400);
  }

  const sharedArgs = {
    messages: body.messages as Array<Record<string, unknown>>,
    tools: Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : undefined,
    max_tokens: body.max_tokens,
  };
  const model = AGENT_MODEL;

  // Streaming branch — for the final synthesis turn (lets the report type
  // out token-by-token). Intermediate tool turns are short and not worth
  // streaming (Claude usually responds with just a tool_use block).
  if (body.stream === true) {
    const sres = await callAnthropicMessagesStream(sharedArgs, env.ANTHROPIC_KEY, model);
    if (!sres.ok) {
      return json({ error: 'upstream', status: sres.status, detail: sres.detail }, sres.status);
    }
    ctx.waitUntil((async () => {
      try {
        const usage = await sres.usagePromise;
        await trackAndMaybeAlert(
          usage,
          env.RATE_KV,
          parseFloat(env.COST_ALERT_USD || '15'),
          env.ALERT_WEBHOOK,
          env.ENVIRONMENT,
        );
      } catch (e) {
        console.warn('[agent stream] cost tracking failed', e);
      }
    })());

    return new Response(sres.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Rate-Day': String(rl.dayCount),
        'X-Rate-Month': String(rl.monthCount),
        'Access-Control-Expose-Headers': 'X-Rate-Day, X-Rate-Month',
      },
    });
  }

  // Buffered branch — used by every tool-resolution turn. Returns Claude's
  // full response (which usually contains tool_use blocks for the iOS
  // client to resolve and feed back on the next turn).
  const result = await callAnthropicMessages(sharedArgs, env.ANTHROPIC_KEY, model);
  if (!result.ok) {
    return json({ error: 'upstream', status: result.status, detail: result.detail }, result.status);
  }
  ctx.waitUntil(
    trackAndMaybeAlert(
      result.usage,
      env.RATE_KV,
      parseFloat(env.COST_ALERT_USD || '15'),
      env.ALERT_WEBHOOK,
      env.ENVIRONMENT,
    ),
  );
  return json(result.data, 200, {
    'X-Rate-Day': String(rl.dayCount),
    'X-Rate-Month': String(rl.monthCount),
  });
}
