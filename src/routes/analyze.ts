import type { Env } from '../index';
import { json } from '../lib/http';
import { checkAndIncrement, checkAndIncrementIp } from '../lib/ratelimit';
import { callAnthropic } from '../lib/anthropic';
import { trackAndMaybeAlert } from '../lib/costs';
import {
  isValidToken,
  loadEntitlement,
  saveEntitlement,
  consumeAnalyze,
  canAnalyze,
  getFreeUsed,
  incrementFreeUsed,
} from '../lib/entitlement';

interface AnalyzeBody {
  image_base64?: string;
  prompt?: string;
  max_tokens?: number;
}

const DEVICE_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

export async function handleAnalyze(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const deviceId = request.headers.get('X-Device-Id');
  if (!deviceId || !DEVICE_ID_RE.test(deviceId)) {
    return json({ error: 'missing_or_invalid_device_id' }, 400);
  }

  // IP-level rate limit first — cheap check, stops fresh-device-id abuse.
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipRl = await checkAndIncrementIp(ip, env.RATE_KV);
  if (!ipRl.allowed) {
    return json({ error: 'rate_limited', reason: 'ip_hourly', count: ipRl.count }, 429);
  }

  const dayLimit = parseInt(env.DAY_LIMIT || '3', 10);
  const monthLimit = parseInt(env.MONTH_LIMIT || '10', 10);

  // Entitlement-aware gate: when the iOS client carries `X-Account-Token`,
  // we use the entitlement ledger as the source of truth. The device-id
  // rate limit still runs as a backstop (catches misbehaving clients before
  // they reach the ledger), with the day/month numbers from wrangler.toml
  // generous enough that any *paid* user stays under them.
  const accountToken = request.headers.get('X-Account-Token');
  let useEntitlement = false;
  if (isValidToken(accountToken)) {
    const ent = await loadEntitlement(accountToken, env.RATE_KV);
    const freeUsed = await getFreeUsed(accountToken, env.RATE_KV);
    const gate = canAnalyze(ent, freeUsed);
    if (!gate.allowed) {
      return json(
        { error: 'quota_exhausted', reason: gate.reason, tier: ent.tier },
        402,  // Payment Required — distinct from 429 device-rate-limit
      );
    }
    useEntitlement = true;
  }

  const rl = await checkAndIncrement(deviceId, env.RATE_KV, dayLimit, monthLimit);
  if (!rl.allowed) {
    return json(
      {
        error: 'rate_limited',
        reason: rl.reason,
        resetAt: rl.resetAt,
        limits: { day: dayLimit, month: monthLimit },
      },
      429,
      {
        'X-Rate-Day': String(rl.dayCount),
        'X-Rate-Month': String(rl.monthCount),
        'X-Rate-Reset': String(rl.resetAt ?? 0),
      },
    );
  }

  let body: AnalyzeBody;
  try {
    body = (await request.json()) as AnalyzeBody;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  if (!body.prompt || typeof body.prompt !== 'string') {
    return json({ error: 'missing_prompt' }, 400);
  }
  if (body.image_base64 !== undefined && typeof body.image_base64 !== 'string') {
    return json({ error: 'invalid_image_base64' }, 400);
  }
  // Guard against pathological sizes (Claude will reject ~5MB+ anyway, but fail fast here).
  if (body.image_base64 && body.image_base64.length > 8_000_000) {
    return json({ error: 'image_too_large' }, 413);
  }

  // Tier-based model selection. Free + pack users go to Haiku 4.5 (~6×
  // cheaper); Pro subscribers get Sonnet 4.6 for the accuracy upgrade.
  // Header `X-Tier` is set by the iOS client based on `subs.isSubscribed`.
  // Default to economy if missing — costs us less by default.
  const tier = (request.headers.get('X-Tier') ?? 'economy').toLowerCase();
  const model = tier === 'premium'
    ? (env.MODEL || 'claude-sonnet-4-6')
    : 'claude-haiku-4-5-20251001';

  const result = await callAnthropic(
    { image_base64: body.image_base64, prompt: body.prompt, max_tokens: body.max_tokens },
    env.ANTHROPIC_KEY,
    model,
  );

  if (!result.ok) {
    return json({ error: 'upstream', status: result.status, detail: result.detail }, result.status);
  }

  // Track cost async — we don't want cost bookkeeping to slow response.
  ctx.waitUntil(
    trackAndMaybeAlert(
      result.usage,
      env.RATE_KV,
      parseFloat(env.COST_ALERT_USD || '15'),
      env.ALERT_WEBHOOK,
      env.ENVIRONMENT,
    ),
  );

  // Decrement entitlement ledger now that the call succeeded. This must
  // come AFTER the upstream call: if Anthropic errored, we don't want to
  // count it against the user's quota. (We still let the rate-limit count
  // tick — that's a pure defense-in-depth signal.)
  if (useEntitlement && isValidToken(accountToken)) {
    ctx.waitUntil((async () => {
      const ent = await loadEntitlement(accountToken, env.RATE_KV);
      if (ent.tier === 'free') {
        await incrementFreeUsed(accountToken, env.RATE_KV);
      } else {
        consumeAnalyze(ent);
        await saveEntitlement(accountToken, ent, env.RATE_KV);
      }
    })());
  }

  return json(result.data, 200, {
    'X-Rate-Day': String(rl.dayCount),
    'X-Rate-Month': String(rl.monthCount),
  });
}
