import { handleAnalyze } from './routes/analyze';
import { handleAgent } from './routes/agent';
import { handleConsumeAnalysis } from './routes/consume';
import { handleAdminFeedback } from './routes/admin';
import { handleVerifyReceipt } from './routes/verify-receipt';
import { handleAppleWebhook } from './routes/apple-webhook';
import { handleFeedback } from './routes/feedback';
import { inspect as wafInspect } from './lib/waf';
import { corsHeaders, json } from './lib/http';

export interface Env {
  RATE_KV: KVNamespace;
  ANTHROPIC_KEY: string;
  ALERT_WEBHOOK?: string;
  MODEL: string;
  DAY_LIMIT: string;
  MONTH_LIMIT: string;
  COST_ALERT_USD: string;
  ENVIRONMENT: string;

  // Optional — for forwarding in-app feedback to the dev's email via Resend.
  // Both go through `wrangler secret put` so the email address never lives
  // in source code. If unset, feedback still lands in KV (queryable via
  // `wrangler kv key list --prefix="fb:"`).
  RESEND_API_KEY?: string;
  FEEDBACK_EMAIL?: string;

  // Auth for the /admin/feedback dashboard. Set via:
  //   wrangler secret put ADMIN_TOKEN
  ADMIN_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight (so a browser dashboard can hit us without friction)
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // -------- Layer-1 WAF: bot UA / missing-header rejection --------
    // Runs before any KV reads or downstream forwarding so blocked traffic
    // costs us nothing. Forwards a deliberately vague 403 — we don't want
    // to leak which exact rule caught the request.
    const waf = wafInspect(request, url.pathname);
    if (!waf.allowed) {
      console.log('[WAF] blocked', url.pathname, waf.reason);
      return json({ error: 'forbidden' }, 403);
    }

    try {
      if (url.pathname === '/health') {
        return json({ ok: true, env: env.ENVIRONMENT }, 200);
      }

      if (url.pathname === '/analyze' && request.method === 'POST') {
        return await handleAnalyze(request, env, ctx);
      }

      // Multi-turn agent loop. iOS owns the loop; this just brokers a single
      // Claude call per turn. Decoupled from quota — the iOS client calls
      // /consume-analysis once after the loop completes successfully.
      if (url.pathname === '/agent' && request.method === 'POST') {
        return await handleAgent(request, env, ctx);
      }

      // One-shot quota decrement. Pairs with /agent (and any future flow
      // that wants to decouple "do work" from "charge for it").
      if (url.pathname === '/consume-analysis' && request.method === 'POST') {
        return await handleConsumeAnalysis(request, env, ctx);
      }

      if (url.pathname === '/verify-receipt' && request.method === 'POST') {
        return await handleVerifyReceipt(request, env, ctx);
      }

      // Apple App Store Server Notifications V2 — register this URL in
      // App Store Connect (both Production and Sandbox).
      if (url.pathname === '/webhook/apple' && request.method === 'POST') {
        return await handleAppleWebhook(request, env, ctx);
      }

      // In-app feedback / bug reports. Body lands in KV under "fb:" prefix.
      if (url.pathname === '/feedback' && request.method === 'POST') {
        return await handleFeedback(request, env, ctx);
      }

      // Admin dashboard. Multi-section (overview / activity / feedback /
      // users / costs) — pick via ?section=. Auth via ?token=<ADMIN_TOKEN>
      // matched against a Worker secret. /admin/feedback kept as an alias
      // for the original bookmark.
      if ((url.pathname === '/admin' || url.pathname === '/admin/feedback')
          && request.method === 'GET') {
        return await handleAdminFeedback(request, env, ctx);
      }

      return json({ error: 'not_found' }, 404);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      return json({ error: 'internal', detail: msg }, 500);
    }
  },
};
