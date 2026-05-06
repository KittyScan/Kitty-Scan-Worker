/**
 * AI-powered analytics — the dashboard tab that *thinks for you*.
 *
 * What it does:
 *   1. Aggregates everything in KV (feedback themes, log:* activity,
 *      ent:* tier funnel, cost trend) into a compact JSON digest.
 *   2. Sends the digest to Claude with a senior-product-analyst system
 *      prompt asking for: health summary, anomalies, feature
 *      recommendations (with priority + rationale + expected impact),
 *      optimization opportunities, and concrete action items.
 *   3. Caches the result in KV for 1 hour (`insights:cache`) so a
 *      reload doesn't re-bill the analyst call.
 *
 * Why Claude vs. rule-based heuristics:
 *   • Claude can spot patterns across data axes (e.g. "all 👎 came from
 *     iOS 18.1") that hand-coded rules would miss.
 *   • Output adapts as the product evolves — no rule maintenance.
 *   • Pairs naturally with the existing /agent infra (same Anthropic
 *     credentials, same Worker bundle, no new dependency).
 *
 * Cost: one Sonnet call per refresh, ~3000 in / 1500 out tokens =
 * ~$0.03 each. Even hammering the refresh button 10 times costs $0.30 —
 * negligible for the value (replaces a contracted product analyst).
 */

import type { Env } from '../index';
import { callAnthropicMessages } from '../lib/anthropic';

const INSIGHTS_CACHE_KEY  = 'insights:cache:v2';   // bump on schema change
const INSIGHTS_CACHE_TTL  = 60 * 60;   // 1h
const INSIGHTS_LIST_LIMIT = 1000;
const ANALYST_MODEL       = 'claude-sonnet-4-6';

interface FeedbackRow {
  receivedAt?: string; category?: string; text?: string;
  appVersion?: string | null; iosVersion?: string | null;
  language?: string | null; country?: string | null;
  accountToken?: string | null;
}
interface LogRow {
  ts?: string; route?: string; status?: string; model?: string;
  tier?: string; durationMs?: number;
  inputTokens?: number; outputTokens?: number;
  tokenShort?: string; deviceShort?: string; country?: string;
}
interface EntRow {
  tier: 'free' | 'pack' | 'sub';
  packBalance?: number; subActiveUntil?: number;
  subAnalyzeUsed?: number; subChatUsed?: number;
  lastUpdatedAt?: number;
}

export interface Insights {
  generatedAt: string;
  dataWindow: { fbCount: number; logCount: number; entCount: number; months: number };
  // Bilingual fields — every text key is duplicated as _zh + _en. Renderer
  // hides the inactive language via a CSS class on the <body>; toggling
  // the active language is a CSS class flip, no re-render.
  health: { score: number; summary_zh: string; summary_en: string };
  concerns: Array<{
    severity: 'high'|'medium'|'low';
    title_zh: string; title_en: string;
    details_zh: string; details_en: string;
  }>;
  recommendations: Array<{
    priority: number;
    title_zh: string; title_en: string;
    rationale_zh: string; rationale_en: string;
    expectedImpact_zh: string; expectedImpact_en: string;
    effort: 'small'|'medium'|'large';
  }>;
  optimizations: Array<{
    area: 'cost'|'latency'|'quality'|'retention'|'conversion'|'other';
    suggestion_zh: string; suggestion_en: string;
    expectedGain_zh: string; expectedGain_en: string;
  }>;
  actions: Array<{
    category: 'fix'|'build'|'investigate'|'experiment';
    action_zh: string; action_en: string;
    evidence_zh: string; evidence_en: string;
  }>;
  rawDigest?: Record<string, unknown>;  // optional, for debugging
}

// ===========================================================================
// Public entry
// ===========================================================================

export async function handleAdminInsights(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') ?? '';
  const adminToken = env.ADMIN_TOKEN ?? '';
  if (!adminToken) return new Response('admin token not configured', { status: 503 });
  if (token !== adminToken) return new Response('forbidden', { status: 403 });

  const refresh = url.searchParams.get('refresh') === '1';

  // Cache hit (unless explicit refresh) — re-analyzing every page load
  // would waste Sonnet calls and the underlying data doesn't shift fast.
  if (!refresh) {
    const cached = await env.RATE_KV.get(INSIGHTS_CACHE_KEY);
    if (cached) {
      try { return jsonResponse(JSON.parse(cached) as Insights); }
      catch { /* fall through to recompute */ }
    }
  }

  const digest = await aggregateForAnalysis(env);
  const analysis = await runAnalyst(digest, env.ANTHROPIC_KEY);

  const out: Insights = {
    ...analysis,
    generatedAt: new Date().toISOString(),
    dataWindow: digest.window,
    rawDigest: refresh ? (digest as unknown as Record<string, unknown>) : undefined,
  };

  await env.RATE_KV.put(INSIGHTS_CACHE_KEY, JSON.stringify(out),
                        { expirationTtl: INSIGHTS_CACHE_TTL });

  return jsonResponse(out);
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

// ===========================================================================
// Aggregation — turn raw KV into a Claude-ready digest
// ===========================================================================

interface DataDigest {
  window: { fbCount: number; logCount: number; entCount: number; months: number };
  tiers: Record<string, number>;
  funnel: { free: number; pack: number; sub: number; payRate: number };
  cost: { months: Array<{ month: string; usd: number }>; mtd: number; trend: 'up'|'down'|'flat' };
  csat: { thumbsUp: number; thumbsDown: number; csatPct: number; sampleSize: number };
  topThumbsDownReasons: Array<{ reason: string; count: number }>;
  topBugSamples: string[];          // truncated text bodies
  topFeatureRequests: string[];     // ditto
  activity: {
    totalCalls: number;
    okRate: number;
    errors: Record<string, number>;
    byRoute: Record<string, number>;
    byModel: Record<string, number>;
    byTier: Record<string, number>;
    byCountry: Record<string, number>;
    byAppVersion: Record<string, number>;
    p50LatencyMs: number;
    p95LatencyMs: number;
    p99LatencyMs: number;
    medianTokensIn: number;
    medianTokensOut: number;
    callsPerDay: Record<string, number>;        // YYYY-MM-DD → count
    distinctTokens24h: number;
    distinctTokens7d: number;
  };
  retention: {
    repeatUsers7d: number;        // tokens with >1 call in last 7d
    onceAndDone7d: number;        // tokens with exactly 1 call
    powerUsers7d: number;         // tokens with >10 calls
  };
  proUsage: {
    nearQuotaPct: number;         // % of Pro users at >80% of monthly quota
    countAtRisk: number;
  };
  versions: Record<string, number>;             // app version split from feedback
}

async function aggregateForAnalysis(env: Env): Promise<DataDigest> {
  const [fb, logs, ents, costs] = await Promise.all([
    listAndParse<FeedbackRow>(env, 'fb:',  INSIGHTS_LIST_LIMIT),
    listAndParse<LogRow>     (env, 'log:', INSIGHTS_LIST_LIMIT),
    listAndParse<EntRow>     (env, 'ent:', INSIGHTS_LIST_LIMIT),
    listCostMap(env),
  ]);

  // ---- tier funnel ----
  const tiers: Record<string, number> = { free: 0, pack: 0, sub: 0 };
  for (const e of ents) tiers[e.tier] = (tiers[e.tier] ?? 0) + 1;
  const totalAcc = ents.length;
  const payRate = totalAcc === 0 ? 0
    : ((tiers.pack ?? 0) + (tiers.sub ?? 0)) / totalAcc;

  // ---- cost trend ----
  const costEntries = Object.entries(costs).sort((a, b) => a[0].localeCompare(b[0]));
  const monthlyArr = costEntries.map(([m, v]) => ({ month: m, usd: v }));
  const mtdKey = new Date().toISOString().slice(0, 7);
  const mtd = costs[mtdKey] ?? 0;
  let trend: 'up'|'down'|'flat' = 'flat';
  if (monthlyArr.length >= 2) {
    const prev = monthlyArr[monthlyArr.length - 2]?.usd ?? 0;
    const curr = monthlyArr[monthlyArr.length - 1]?.usd ?? 0;
    if (curr > prev * 1.15) trend = 'up';
    else if (curr < prev * 0.85) trend = 'down';
  }

  // ---- ratings + reasons ----
  const ratings = fb.filter((r) => r.category === 'rating');
  const up   = ratings.filter((r) => (r.text ?? '').startsWith('👍')).length;
  const down = ratings.length - up;
  const csatPct = ratings.length === 0 ? 0
    : Math.round((up / ratings.length) * 100);

  const reasons: Record<string, number> = {};
  for (const r of ratings) {
    const t = r.text ?? '';
    if (!t.startsWith('👎')) continue;
    const reason = t.slice(2).trim() || '(no reason)';
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  const topReasons = Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([reason, count]) => ({ reason, count }));

  const topBugSamples = fb
    .filter((r) => r.category === 'bug')
    .slice(0, 10)
    .map((r) => (r.text ?? '').slice(0, 200));
  const topFeatureRequests = fb
    .filter((r) => r.category === 'feature')
    .slice(0, 10)
    .map((r) => (r.text ?? '').slice(0, 200));

  // ---- log analytics ----
  const total = logs.length;
  const okCount = logs.filter((l) => l.status === 'ok').length;
  const okRate = total === 0 ? 1 : okCount / total;

  const errs: Record<string, number> = {};
  for (const l of logs) {
    if (l.status && l.status !== 'ok') errs[l.status] = (errs[l.status] ?? 0) + 1;
  }
  const splitBy = (field: keyof LogRow) => {
    const m: Record<string, number> = {};
    for (const l of logs) {
      const v = (l[field] as string | undefined) ?? '?';
      m[v] = (m[v] ?? 0) + 1;
    }
    return m;
  };

  const lats = logs.map((l) => l.durationMs ?? 0).filter((n) => n > 0).sort((a, b) => a - b);
  const inToks  = logs.map((l) => l.inputTokens  ?? 0).filter((n) => n > 0).sort((a, b) => a - b);
  const outToks = logs.map((l) => l.outputTokens ?? 0).filter((n) => n > 0).sort((a, b) => a - b);

  // ---- daily volume + cohort signals ----
  const callsPerDay: Record<string, number> = {};
  const tokens24h = new Set<string>();
  const tokens7d  = new Set<string>();
  const callsByToken: Record<string, number> = {};
  const now = Date.now();
  const day1 = now - 24 * 3600 * 1000;
  const day7 = now - 7 * 24 * 3600 * 1000;
  for (const l of logs) {
    const day = (l.ts ?? '').slice(0, 10);
    if (day) callsPerDay[day] = (callsPerDay[day] ?? 0) + 1;
    const t = l.tokenShort ?? '';
    if (t) {
      const ts = Date.parse(l.ts ?? '');
      if (!isNaN(ts)) {
        if (ts >= day1) tokens24h.add(t);
        if (ts >= day7) {
          tokens7d.add(t);
          callsByToken[t] = (callsByToken[t] ?? 0) + 1;
        }
      }
    }
  }
  const counts = Object.values(callsByToken);
  const repeatUsers7d = counts.filter((c) => c > 1).length;
  const onceAndDone7d = counts.filter((c) => c === 1).length;
  const powerUsers7d  = counts.filter((c) => c > 10).length;

  // ---- versions, from feedback ----
  const versions: Record<string, number> = {};
  for (const r of fb) {
    const v = r.appVersion ?? '?';
    versions[v] = (versions[v] ?? 0) + 1;
  }

  // ---- Pro users at-risk of running out ----
  const subs = ents.filter((e) => e.tier === 'sub');
  const SUB_QUOTA = 50;
  const atRisk = subs.filter((e) => (e.subAnalyzeUsed ?? 0) / SUB_QUOTA >= 0.8).length;
  const nearQuotaPct = subs.length === 0 ? 0 : Math.round((atRisk / subs.length) * 100);

  return {
    window: { fbCount: fb.length, logCount: logs.length, entCount: ents.length, months: monthlyArr.length },
    tiers,
    funnel: { free: tiers.free ?? 0, pack: tiers.pack ?? 0, sub: tiers.sub ?? 0, payRate: round(payRate, 3) },
    cost: { months: monthlyArr.slice(-6), mtd: round(mtd, 4), trend },
    csat: { thumbsUp: up, thumbsDown: down, csatPct, sampleSize: ratings.length },
    topThumbsDownReasons: topReasons,
    topBugSamples,
    topFeatureRequests,
    activity: {
      totalCalls: total,
      okRate: round(okRate, 3),
      errors: errs,
      byRoute: splitBy('route'),
      byModel: splitBy('model'),
      byTier: splitBy('tier'),
      byCountry: splitBy('country'),
      byAppVersion: versions,
      p50LatencyMs: percentileSorted(lats, 50),
      p95LatencyMs: percentileSorted(lats, 95),
      p99LatencyMs: percentileSorted(lats, 99),
      medianTokensIn:  percentileSorted(inToks, 50),
      medianTokensOut: percentileSorted(outToks, 50),
      callsPerDay,
      distinctTokens24h: tokens24h.size,
      distinctTokens7d:  tokens7d.size,
    },
    retention: { repeatUsers7d, onceAndDone7d, powerUsers7d },
    proUsage: { nearQuotaPct, countAtRisk: atRisk },
    versions,
  };
}

// ===========================================================================
// The analyst
// ===========================================================================

const ANALYST_SYSTEM_PROMPT = `
You are KittyScan's senior product analyst. Read the telemetry digest and
return ONE JSON object — nothing else, no markdown fences, no prose around it.

CRITICAL: Be BRUTALLY concise. The reader is the founder, glancing on a
phone between meetings. Long paragraphs get ignored.

Per-field length limits (HARD):
- title_*: max 8 words / 12 字
- summary_*: max 25 words / 35 字
- details_*: max 25 words / 35 字 — ONE sentence, with the data point
- rationale_*: max 20 words / 25 字
- expectedImpact_* / expectedGain_*: max 15 words / 20 字
- action_*: max 15 words / 20 字
- evidence_*: max 20 words / 25 字

Every text field MUST have BOTH _zh (Chinese) and _en (English) versions.
The two should convey the same information, not just translate verbatim —
each in its language's natural voice.

Operating principles:
- Cross-reference axes. A 👎 that clusters by app version is sharper than raw count.
- Skip restating the table. Surface the second-derivative.
- Justify with a specific data point.
- Don't pitch features that break privacy-first positioning.

Output JSON shape:
{
  "health": { "score": <0-100 int>, "summary_zh": "…", "summary_en": "…" },
  "concerns": [{
    "severity":"high"|"medium"|"low",
    "title_zh":"…","title_en":"…",
    "details_zh":"…","details_en":"…"
  }],
  "recommendations": [{
    "priority": <1=highest>,
    "title_zh":"…","title_en":"…",
    "rationale_zh":"…","rationale_en":"…",
    "expectedImpact_zh":"…","expectedImpact_en":"…",
    "effort":"small"|"medium"|"large"
  }],
  "optimizations": [{
    "area":"cost"|"latency"|"quality"|"retention"|"conversion"|"other",
    "suggestion_zh":"…","suggestion_en":"…",
    "expectedGain_zh":"…","expectedGain_en":"…"
  }],
  "actions": [{
    "category":"fix"|"build"|"investigate"|"experiment",
    "action_zh":"…","action_en":"…",
    "evidence_zh":"…","evidence_en":"…"
  }]
}

Rules: 3-5 items per array (more than 5 = noise). Priority 1,2,3,…
Health 90+ only if zero high-severity concerns. Always emit the JSON
even if data is sparse — empty arrays OK.
`.trim();

async function runAnalyst(
  digest: DataDigest,
  apiKey: string,
): Promise<Pick<Insights, 'health'|'concerns'|'recommendations'|'optimizations'|'actions'>> {
  // Compact the digest — pass system at the top level (Anthropic's
  // preferred slot) and only the data payload as the user turn so the
  // model parses the role/format instructions cleanly.
  const userMsg = `Production telemetry digest:\n` +
                  '```json\n' + JSON.stringify(digest) + '\n```\n' +
                  `Output the analysis JSON.`;

  const resp = await callAnthropicMessages(
    {
      system: ANALYST_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: [{ type: 'text', text: userMsg }] },
      ],
      max_tokens: 4000,
    },
    apiKey,
    ANALYST_MODEL,
  );

  if (!resp.ok) {
    return fallback('upstream_failed', `Anthropic returned ${resp.status}: ${resp.detail}`);
  }
  const data = resp.data as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  const cleaned = extractJson(text);
  if (!cleaned) {
    console.warn('[insights] no JSON in response. Raw text:', text.slice(0, 500));
    return fallback('parse_failed', `no JSON found · preview: ${text.slice(0, 200)}`);
  }
  try {
    const parsed = JSON.parse(cleaned) as Pick<Insights, 'health'|'concerns'|'recommendations'|'optimizations'|'actions'>;
    return {
      health: parsed.health ?? { score: 0, summary_zh: '解析失败', summary_en: 'unparseable' },
      concerns:        Array.isArray(parsed.concerns)        ? parsed.concerns        : [],
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
      optimizations:   Array.isArray(parsed.optimizations)   ? parsed.optimizations   : [],
      actions:         Array.isArray(parsed.actions)         ? parsed.actions         : [],
    };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.warn('[insights] JSON.parse failed.',
                 'error:', errMsg,
                 'cleaned preview:', cleaned.slice(0, 1000));
    return fallback('parse_failed',
      `${errMsg} · tail: ${cleaned.slice(-300)} · len=${cleaned.length}`);
  }
}

function fallback(kind: string, detail: string): Pick<Insights, 'health'|'concerns'|'recommendations'|'optimizations'|'actions'> {
  return {
    health: {
      score: 0,
      summary_zh: `分析器无法响应 (${kind})。仅显示原始数据。`,
      summary_en: `Analyst unavailable (${kind}). Showing raw digest only.`,
    },
    concerns: [{
      severity: 'low',
      title_zh: '分析调用失败', title_en: 'Analyst call failed',
      details_zh: detail, details_en: detail,
    }],
    recommendations: [], optimizations: [], actions: [],
  };
}

function extractJson(s: string): string | null {
  const stripped = s.replace(/```json/g, '').replace(/```/g, '');
  const first = stripped.indexOf('{');
  const last  = stripped.lastIndexOf('}');
  if (first === -1 || last === -1 || first >= last) return null;
  return stripped.slice(first, last + 1);
}

// ===========================================================================
// Helpers (KV listing + math)
// ===========================================================================

async function listAndParse<T>(env: Env, prefix: string, limit: number): Promise<T[]> {
  const list = await env.RATE_KV.list({ prefix, limit });
  const values = await Promise.all(list.keys.map((k) => env.RATE_KV.get(k.name)));
  const out: T[] = [];
  for (const raw of values) {
    if (!raw) continue;
    try { out.push(JSON.parse(raw) as T); } catch { /* skip */ }
  }
  return out;
}

async function listCostMap(env: Env): Promise<Record<string, number>> {
  const list = await env.RATE_KV.list({ prefix: 'cost:', limit: 200 });
  const out: Record<string, number> = {};
  for (const k of list.keys) {
    const v = await env.RATE_KV.get(k.name);
    if (!v) continue;
    out[k.name.replace(/^cost:/, '')] = parseFloat(v);
  }
  return out;
}

function percentileSorted(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx] ?? 0);
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
