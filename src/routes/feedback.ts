import type { Env } from '../index';
import { json } from '../lib/http';

/**
 * In-app feedback collection.
 *
 * iOS app POSTs free-text feedback here; we write it to KV with a timestamp
 * prefix so the dev can list/read recent entries via `wrangler kv` commands
 * (or a tiny admin endpoint added later).
 *
 * Why KV and not email? Two reasons:
 *   1. Email-from-Workers needs an external sender (Resend, Postmark, etc.)
 *      with another API key to manage. KV needs zero new credentials.
 *   2. The dev's personal email is intentionally NOT in the app binary,
 *      iOS source, or this Worker. Anything that flows through email gets
 *      one more place to leak.
 *
 * Read the queue from your laptop:
 *   wrangler kv key list --namespace-id=<RATE_KV_ID> --prefix="fb:" | head
 *   wrangler kv key get  --namespace-id=<RATE_KV_ID> "fb:<timestamp>"
 */

const FEEDBACK_RETENTION_DAYS = 180;
const MAX_TEXT_LENGTH = 2000;

interface FeedbackBody {
  category?: string;       // bug | feature | billing | general
  text?: string;
  appVersion?: string;
  appBuild?: string;
  iosVersion?: string;
  language?: string;
}

const ALLOWED_CATEGORIES = new Set(['bug', 'feature', 'billing', 'general']);

export async function handleFeedback(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  let body: FeedbackBody;
  try { body = (await request.json()) as FeedbackBody; }
  catch { return json({ error: 'invalid_json' }, 400); }

  // ---- input validation ----
  // Min 2 chars (matches FeedbackView.minChars on iOS). 2 covers the
  // shortest valid Chinese feedback ("卡了" / "崩了" / "好的"). Anything
  // shorter is almost certainly a mis-tap.
  const text = (body.text ?? '').trim();
  if (text.length < 2)              return json({ error: 'too_short' },     400);
  if (text.length > MAX_TEXT_LENGTH) return json({ error: 'too_long' },     413);

  const category = (body.category ?? 'general').trim();
  if (!ALLOWED_CATEGORIES.has(category)) {
    return json({ error: 'invalid_category' }, 400);
  }

  // ---- abuse prevention: per-token rate limit on feedback (20 / day) ----
  // Raised from 5 to 20: real users debugging an issue often submit several
  // feedbacks in quick succession ("oh wait, also this..."), and 5 is too
  // tight for that. 20 is still a hard ceiling against a runaway script.
  const token = request.headers.get('X-Account-Token');
  if (token) {
    const dayKey = `fblim:${token}:${dayBucket()}`;
    const cur = parseInt((await env.RATE_KV.get(dayKey)) ?? '0', 10);
    if (cur >= 20) {
      return json({ error: 'rate_limited', detail: 'too_many_feedback_today' }, 429);
    }
    await env.RATE_KV.put(dayKey, String(cur + 1), { expirationTtl: 60 * 60 * 26 });
  }

  // ---- write to ledger ----
  // Key format: fb:<reverse-timestamp>:<random-suffix>
  // Reverse timestamp keeps newest-first when listing. Suffix prevents
  // collision when two feedback messages arrive in the same millisecond.
  const now = Date.now();
  const reverseTs = String(Number.MAX_SAFE_INTEGER - now).padStart(20, '0');
  const suffix = Math.random().toString(36).slice(2, 8);
  const key = `fb:${reverseTs}:${suffix}`;

  const record = {
    receivedAt:   new Date(now).toISOString(),
    category,
    text,                                                  // user message
    accountToken: token ?? null,                           // for cross-ref with entitlement
    appVersion:   body.appVersion ?? null,
    appBuild:     body.appBuild ?? null,
    iosVersion:   body.iosVersion ?? null,
    language:     body.language ?? null,
    ip:           request.headers.get('CF-Connecting-IP') ?? null,
    country:      request.headers.get('CF-IPCountry') ?? null,
  };

  await env.RATE_KV.put(key, JSON.stringify(record), {
    expirationTtl: 60 * 60 * 24 * FEEDBACK_RETENTION_DAYS,
  });

  // Best-effort email forward via Resend. Not blocking the response — if it
  // fails, the KV record is still our source of truth. If RESEND_API_KEY or
  // FEEDBACK_EMAIL aren't configured, this is a no-op.
  if (env.RESEND_API_KEY && env.FEEDBACK_EMAIL) {
    _ctx.waitUntil(forwardByEmail(env.RESEND_API_KEY, env.FEEDBACK_EMAIL, record));
  }

  return json({ ok: true }, 200);
}

/** Send a plaintext digest of one feedback record via Resend.
 *
 *  Resend free tier: 3000/month. Sender uses Resend's onboarding sender
 *  domain (`onboarding@resend.dev`) — works without a verified domain, but
 *  recipients in your Resend account must be verified once via Resend's UI. */
async function forwardByEmail(
  apiKey: string,
  to: string,
  record: { receivedAt: string; category: string; text: string;
            accountToken: string | null; appVersion: string | null;
            appBuild: string | null; iosVersion: string | null;
            language: string | null; ip: string | null; country: string | null; },
): Promise<void> {
  const body = [
    `Received: ${record.receivedAt}`,
    `Category: ${record.category}`,
    `Account: ${record.accountToken ?? '(anonymous)'}`,
    `App: ${record.appVersion ?? '?'} (build ${record.appBuild ?? '?'})`,
    `iOS: ${record.iosVersion ?? '?'} · lang=${record.language ?? '?'} · country=${record.country ?? '?'}`,
    '',
    '---',
    '',
    record.text,
  ].join('\n');

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Carmel Feedback <onboarding@resend.dev>',
        to: [to],
        subject: 'anything you want to share with our team',
        text: body,
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      console.warn('[feedback] Resend send failed', resp.status, detail.slice(0, 200));
    }
  } catch (err) {
    console.warn('[feedback] Resend fetch threw', err instanceof Error ? err.message : err);
  }
}

function dayBucket(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}
