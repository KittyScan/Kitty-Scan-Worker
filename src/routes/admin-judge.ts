/**
 * Admin-only Anthropic broker — used exclusively by the local eval runner
 * so it doesn't need its own ANTHROPIC_API_KEY. Auths via ADMIN_TOKEN
 * (the same one the dashboard uses) and forwards to Claude using the
 * Worker's existing ANTHROPIC_KEY secret.
 *
 * Why this exists: Cloudflare deliberately doesn't let you read secrets
 * back ('write-only by design'), so a local script can't reach the same
 * Anthropic credential the Worker uses. Routing through this endpoint
 * keeps a single source of truth for the credential and means the
 * developer doesn't need to provision a separate Anthropic key for evals.
 *
 * Cost note: every call here bills the same Anthropic account as
 * production traffic. The ADMIN_TOKEN gate is the only thing between an
 * attacker with the token and free Claude calls — keep the token strong.
 */

import type { Env } from '../index';
import { json } from '../lib/http';
import { callAnthropicMessages } from '../lib/anthropic';

interface JudgeBody {
  model?: string;
  system?: string;
  messages?: Array<Record<string, unknown>>;
  max_tokens?: number;
}

export async function handleAdminJudge(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') ?? request.headers.get('X-Admin-Token') ?? '';
  const adminToken = env.ADMIN_TOKEN ?? '';
  if (!adminToken) return new Response('admin token not configured', { status: 503 });
  if (token !== adminToken) return new Response('forbidden', { status: 403 });

  let body: JudgeBody;
  try { body = (await request.json()) as JudgeBody; }
  catch { return json({ error: 'invalid_json' }, 400); }

  if (!body.model || !Array.isArray(body.messages) || body.messages.length === 0) {
    return json({ error: 'missing_fields' }, 400);
  }

  const result = await callAnthropicMessages(
    {
      messages: body.messages,
      max_tokens: body.max_tokens ?? 1500,
      system: body.system,
    },
    env.ANTHROPIC_KEY,
    body.model,
  );
  if (!result.ok) {
    return json({ error: 'upstream', status: result.status, detail: result.detail }, result.status);
  }
  return json(result.data, 200);
}
