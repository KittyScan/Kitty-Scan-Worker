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
import { PRODUCT_CONTEXT } from '../lib/product-context';

const INSIGHTS_CACHE_KEY  = 'insights:cache:v4';   // bump on schema change
const INSIGHTS_CACHE_TTL  = 60 * 60;   // 1h
const INSIGHTS_LIST_LIMIT = 1000;
// Haiku 4.5 — Sonnet's analytical edge isn't worth the 524 Cloudflare
// timeouts on the larger structured output we're now requesting. Haiku
// completes the same JSON in ~15-25s comfortably under the Worker
// subrequest cap, with no meaningful quality drop on this format-bounded
// task (the heavy lifting is JSON shape compliance, not novel reasoning).
const ANALYST_MODEL       = 'claude-haiku-4-5-20251001';

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
  /** TL;DR hero. The one screen the founder reads on phone between meetings. */
  daily_summary: {
    headline_zh: string; headline_en: string;     // ≤ 1 sentence
    key_numbers: Array<{
      label_zh: string; label_en: string;
      value: string;                              // "12", "$0.42", "67%"
      delta_zh: string; delta_en: string;        // "+3 vs 昨天" / "+3 vs yesterday"
    }>;
    one_thing_today_zh: string; one_thing_today_en: string;  // single most important action
  };
  /** North star: ROI = revenue / Anthropic cost. */
  north_star_roi: {
    current_value: string;                        // "3.2:1" or "—"
    trend: 'up'|'down'|'flat';
    diagnosis_zh: string; diagnosis_en: string;
    biggest_drag_zh: string; biggest_drag_en: string;
  };
  /** Step-by-step funnel. Counts at each stage + drop-off diagnosis. */
  funnel: {
    stages: Array<{
      name_zh: string; name_en: string;
      count: number;
      conversion_pct: number;                      // % of previous stage
    }>;
    biggest_drop_off_zh: string; biggest_drop_off_en: string;
    fix_zh: string; fix_en: string;                // one-sentence fix proposal
  };
  /** Plays to run THIS WEEK to lift conversion / renewal. Step-by-step. */
  conversion_playbook: Array<{
    tactic_zh: string; tactic_en: string;
    why_zh: string; why_en: string;
    how_zh: string[]; how_en: string[];           // 3-5 numbered steps
    expected_zh: string; expected_en: string;     // what you'll see
  }>;
  /** Feature backlog ranked P0/P1/P2/P3. Each item readable by non-PM. */
  feature_roadmap: Array<{
    priority: 'P0'|'P1'|'P2'|'P3';
    title_zh: string; title_en: string;
    why_zh: string; why_en: string;
    what_zh: string; what_en: string;
    how_steps_zh: string[]; how_steps_en: string[];   // 3-6 plain-English steps
    timeline_zh: string; timeline_en: string;
    expected_impact_zh: string; expected_impact_en: string;
  }>;
  rawDigest?: Record<string, unknown>;
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
You are KittyScan's growth-side product analyst, embedded with a solo
founder who is NOT a product manager. Your job is to translate raw
telemetry into a daily action plan a non-product person can execute.

NORTH STAR: ROI = monthly revenue / Anthropic cost. Every recommendation
must point at this number.

GROUNDING — non-negotiable:
- The user message starts with a "CURRENT PRODUCT STATE" section. Treat
  it as ground truth. It lists every feature that ALREADY EXISTS.
- NEVER recommend something already in the SHIPPED list. If the data
  suggests a shipped feature is broken, frame it as "fix/improve <existing
  feature>", not "build it".
- Recommendations should target the NOT YET SHIPPED list, OR propose
  concrete improvements to existing features (cite the file or feature
  name from the SHIPPED list).
- Respect DELIBERATE NON-GOALS — never suggest analytics SDKs, ads, social
  feed, etc.
- Respect KEY POSITIONING — don't suggest changes that would break the
  privacy-first / kitty-themed / solo-founder constraints.

OUTPUT: ONE JSON object — no markdown fences, no prose around it.
Every text field has BOTH _zh and _en. Each natural in its language.

WRITING STYLE — read like a recipe, not a strategy memo:
- "Open settings page" beats "review configuration"
- "Add a note saying X" beats "consider X-related messaging"
- 短句, 每句 ≤ 25 字. No 行业 jargon.
- For "how" steps: imperative verbs, numbered, what-to-click level detail.
- Reference shipped feature names by their actual name from the context
  (e.g. "the Phase 2 agent loop", "the Diary tab", "the 👍/👎 footer").

LENGTH CAPS (hard — break and you fail):
- headline / title / tactic / action / step:  ≤ 10 words / 15 字
- why / details / diagnosis / expected:        ≤ 20 words / 28 字
- how_steps_* items:                            ≤ 15 words / 22 字 each, MAX 4 steps

ARRAY SIZE CAPS (hard):
- daily_summary.key_numbers:  exactly 4 items
- conversion_playbook:        3 items, no more
- feature_roadmap:            5-6 items total across all priorities
- funnel.stages:              exactly the 6 stages defined below

OUTPUT SCHEMA:
{
  "daily_summary": {
    "headline_zh": "…", "headline_en": "…",
    "key_numbers": [
      { "label_zh":"…","label_en":"…","value":"…","delta_zh":"…","delta_en":"…" }
    ],
    "one_thing_today_zh": "…", "one_thing_today_en": "…"
  },
  "north_star_roi": {
    "current_value": "<X.X:1 or — if no revenue>",
    "trend": "up"|"down"|"flat",
    "diagnosis_zh":"…","diagnosis_en":"…",
    "biggest_drag_zh":"…","biggest_drag_en":"…"
  },
  "funnel": {
    "stages": [
      { "name_zh":"…","name_en":"…","count":<int>,"conversion_pct":<int 0-100> }
    ],
    "biggest_drop_off_zh":"…","biggest_drop_off_en":"…",
    "fix_zh":"…","fix_en":"…"
  },
  "conversion_playbook": [
    {
      "tactic_zh":"…","tactic_en":"…",
      "why_zh":"…","why_en":"…",
      "how_zh":["1. 打开设置页","2. 加一句…","3. 测一下"],
      "how_en":["1. Open settings","2. Add line that…","3. Test it"],
      "expected_zh":"…","expected_en":"…"
    }
  ],
  "feature_roadmap": [
    {
      "priority":"P0"|"P1"|"P2"|"P3",
      "title_zh":"…","title_en":"…",
      "why_zh":"…","why_en":"…",
      "what_zh":"…","what_en":"…",
      "how_steps_zh":["1. ……","2. ……","3. ……"],
      "how_steps_en":["1. …","2. …","3. …"],
      "timeline_zh":"本周|本月|本季|backlog",
      "timeline_en":"this week|this month|this quarter|backlog",
      "expected_impact_zh":"…","expected_impact_en":"…"
    }
  ]
}

PRIORITY DEFINITIONS (use these exactly):
- P0: blocks ROI right now. Ship this week. No exceptions.
- P1: unlocks a new ROI lever (more conversions, higher LTV, lower CAC). Ship this month.
- P2: hygiene / quality-of-life. Ship this quarter when no P0/P1 in flight.
- P3: backlog / 'maybe never'.

FUNNEL STAGES (use these labels exactly, in this order):
1. App 安装 / Install
2. 首次打开 / First open
3. 完成首次分析 / First analysis complete
4. 购买 Pack / Pack purchase
5. 升级 Pro / Upgrade to Pro
6. Pro 续费 / Pro renewal
Compute each count and the % conversion from the previous stage.

ROADMAP DISTRIBUTION:
- 5-6 roadmap items total (no more — noise)
- At least one P0 if anything is blocking ROI
- If truly no P0, say so explicitly in one_thing_today

ROI CALCULATION HINTS:
- Revenue: Pro ($6.99/mo each), 30-pack ($6.99 one-time), 10-pack ($2.99 one-time).
  Use entitlement counts to estimate.
- Cost: cost.mtd is monthly Anthropic spend in USD.
- If revenue is zero, current_value = "—" and explain in diagnosis why.

Always emit the JSON even if data is sparse — empty arrays OK, but you
should still emit at least one P0 if anything is blocking ROI.
`.trim();

async function runAnalyst(
  digest: DataDigest,
  apiKey: string,
): Promise<Pick<Insights, 'daily_summary'|'north_star_roi'|'funnel'|'conversion_playbook'|'feature_roadmap'>> {
  // Two halves to the user message:
  //   1. PRODUCT_CONTEXT — what's already shipped, what's deliberately
  //      not, key constraints. Without this, Claude keeps recommending
  //      features that have been live for weeks.
  //   2. The raw telemetry digest.
  // System prompt enforces 'never recommend something in the shipped list'.
  const userMsg =
    `## CURRENT PRODUCT STATE (authoritative — do NOT recommend rebuilding what's already shipped)\n\n` +
    PRODUCT_CONTEXT + `\n\n` +
    `## TELEMETRY DIGEST (last ${digest.window.months} months)\n\n` +
    '```json\n' + JSON.stringify(digest) + '\n```\n\n' +
    `Output the analysis JSON.`;

  const resp = await callAnthropicMessages(
    {
      system: ANALYST_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: [{ type: 'text', text: userMsg }] },
      ],
      max_tokens: 8000,
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
    const parsed = JSON.parse(cleaned) as Partial<Insights>;
    return {
      daily_summary: parsed.daily_summary ?? {
        headline_zh: '暂无数据', headline_en: 'No data yet',
        key_numbers: [],
        one_thing_today_zh: '—', one_thing_today_en: '—',
      },
      north_star_roi: parsed.north_star_roi ?? {
        current_value: '—', trend: 'flat',
        diagnosis_zh: '暂无数据', diagnosis_en: 'no data',
        biggest_drag_zh: '—', biggest_drag_en: '—',
      },
      funnel: parsed.funnel ?? {
        stages: [], biggest_drop_off_zh: '—', biggest_drop_off_en: '—',
        fix_zh: '—', fix_en: '—',
      },
      conversion_playbook: Array.isArray(parsed.conversion_playbook) ? parsed.conversion_playbook : [],
      feature_roadmap:    Array.isArray(parsed.feature_roadmap)    ? parsed.feature_roadmap    : [],
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

function fallback(kind: string, detail: string): Pick<Insights, 'daily_summary'|'north_star_roi'|'funnel'|'conversion_playbook'|'feature_roadmap'> {
  return {
    daily_summary: {
      headline_zh: `分析器暂时不可用 (${kind})`,
      headline_en: `Analyst unavailable (${kind})`,
      key_numbers: [],
      one_thing_today_zh: '检查 Worker 日志',
      one_thing_today_en: 'Check Worker logs',
    },
    north_star_roi: {
      current_value: '—', trend: 'flat',
      diagnosis_zh: detail, diagnosis_en: detail,
      biggest_drag_zh: '—', biggest_drag_en: '—',
    },
    funnel: { stages: [], biggest_drop_off_zh: '—', biggest_drop_off_en: '—', fix_zh: '—', fix_en: '—' },
    conversion_playbook: [],
    feature_roadmap: [],
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
