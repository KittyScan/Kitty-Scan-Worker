/**
 * Eval runner — entry point.
 *
 * Usage (after `npm install`):
 *   npx tsx evals/runner.ts                 # run every case
 *   npx tsx evals/runner.ts <caseId>        # run a single case
 *
 * Required env:
 *   ANTHROPIC_API_KEY — for the Opus judge
 *   ADMIN_TOKEN       — same one the dashboard uses
 *   WORKER_URL        — defaults to the production carmel-worker URL
 *
 * Output:
 *   evals/reports/<UTC-timestamp>.json  (machine-readable)
 *   evals/reports/<UTC-timestamp>.html  (human-readable diff against baseline)
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestCase, CaseResult, EvalReport, Expectation } from './types';
import { runJudge } from './judge';
import { renderReportHtml } from './report';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = __dirname;
const CACHE_DIR = join(EVAL_DIR, '.cache');

// Cost per million tokens — kept in sync with the production cost ledger.
const COST_INPUT_PER_M  = 3;
const COST_OUTPUT_PER_M = 15;

async function main() {
  const adminToken = process.env.ADMIN_TOKEN;
  const workerUrl = process.env.WORKER_URL || 'https://carmel-worker.8fn98bvpdb.workers.dev';
  if (!adminToken) throw new Error('ADMIN_TOKEN env var is required (gates both /analyze and /admin/judge)');
  const judgeCfg = { workerUrl, adminToken };

  // Cost-cutting knobs. Defaults are tuned for daily iteration; bump
  // judgeRuns to 3 + judgeModel to opus for high-stakes regression gates.
  const judgeRuns  = parseInt(process.env.JUDGE_RUNS  || '1', 10);
  const judgeModel = process.env.JUDGE_MODEL || 'claude-sonnet-4-6';
  const noCache    = process.env.NO_CACHE === '1';
  const smoke      = process.argv.includes('--smoke');

  // Parse positional args — first non-flag argument is the case-id filter.
  const onlyId = process.argv.slice(2).find((a) => !a.startsWith('--'));

  // Smoke mode: run only the first case (sorted alphabetically) for a
  // fast cost-bounded sanity check (~$0.02). Use during prompt iteration.
  let cases = await loadCases(onlyId);
  if (smoke && cases.length > 1) {
    cases = [cases[0]!];
    console.log(`[smoke] running only ${cases[0]!.id} for fast feedback`);
  }
  console.log(`Loaded ${cases.length} test case${cases.length === 1 ? '' : 's'}` +
              (onlyId ? ` (filtered to ${onlyId})` : '') +
              ` · judge=${judgeModel} × ${judgeRuns} run${judgeRuns > 1 ? 's' : ''}` +
              (noCache ? ' · NO_CACHE' : ' · cache enabled'));

  await fs.mkdir(CACHE_DIR, { recursive: true });

  const results: CaseResult[] = [];
  // `skipped` is now reserved for true skips (e.g. config-disabled cases
  // in the future). Cases without images run in context-only mode and
  // count as completed.
  const skipped = 0;
  for (const c of cases) {
    const present = await fileExists(join(EVAL_DIR, c.image));
    if (!present) {
      console.log(`\n→ ${c.id} (context-only — no image yet)`);
    } else {
      console.log(`\n→ ${c.id}`);
    }
    const result = await runCase(c, workerUrl, adminToken, !noCache, present);
    if (result.ok && result.report) {
      const cacheNote = (result as { cached?: boolean }).cached ? ' · cached' : '';
      console.log(`  /analyze ok · ${result.metrics.latencyMs}ms · $${result.metrics.usdCost.toFixed(4)}${cacheNote}`);
      try {
        result.judge = await runJudge(c, result.report, judgeCfg, judgeRuns, judgeModel);
        console.log(`  judge ${result.judge.overall}/5 · halluc=${result.judge.hallucinations.length}`);
      } catch (e) {
        console.warn(`  judge failed: ${(e as Error).message}`);
      }
    } else {
      console.warn(`  /analyze failed: ${result.error}`);
    }
    results.push(result);
  }

  const report = aggregate(results, skipped, workerUrl, judgeModel, judgeRuns);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonPath = join(EVAL_DIR, 'reports', `${stamp}.json`);
  const htmlPath = join(EVAL_DIR, 'reports', `${stamp}.html`);
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2));
  await fs.writeFile(htmlPath, renderReportHtml(report));

  console.log(`\n=== Eval complete ===`);
  console.log(`  passed: ${report.passed}/${report.totalCases}`);
  console.log(`  skipped: ${report.totalSkipped}`);
  console.log(`  judge median: ${report.metrics.judgeMedian.toFixed(1)}/5`);
  console.log(`  P95 latency: ${report.metrics.p95LatencyMs}ms`);
  console.log(`  total cost: $${report.metrics.totalUsd.toFixed(4)}`);
  console.log(`\n  json: ${jsonPath}`);
  console.log(`  html: ${htmlPath}`);
}

// =========================================================
// Per-case
// =========================================================

async function runCase(
  c: TestCase,
  workerUrl: string,
  adminToken: string,
  cacheEnabled: boolean,
  hasImage: boolean,
): Promise<CaseResult & { cached?: boolean }> {
  // Context-only mode: image missing → run without image_base64. The
  // analyzer still gets the cat profile + history + diary + prompt,
  // which exercises the reasoning even if vision is unavailable.
  const imageBuf = hasImage ? await fs.readFile(join(EVAL_DIR, c.image)) : null;
  const imageB64 = imageBuf ? imageBuf.toString('base64') : null;

  const prompt = buildPrompt(c);

  // Cache key includes image bytes (or 'no-image' sentinel) so context-only
  // runs cache separately from image runs. Lets you add an image later
  // without polluting the cache.
  const cacheKey = createHash('sha256')
    .update(c.id)
    .update(prompt)
    .update(imageBuf ?? Buffer.from('no-image'))
    .digest('hex')
    .slice(0, 16);
  const cachePath = join(CACHE_DIR, `${c.id}-${cacheKey}.json`);

  if (cacheEnabled) {
    try {
      const cached = JSON.parse(await fs.readFile(cachePath, 'utf-8')) as CaseResult;
      // Re-evaluate expectations against the cached report (cheap, deterministic) —
      // a case-spec change since the cache was written should still re-grade
      // structural pass/fail without re-spending on /analyze.
      const checks = cached.report
        ? c.expectations.map((e) => ({ expectation: e, ...evaluate(e, cached.report!) }))
        : cached.checks;
      return { ...cached, checks, cached: true };
    } catch { /* miss — fall through to live call */ }
  }

  const t0 = Date.now();
  const resp = await fetch(`${workerUrl}/analyze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Id': `eval-runner-${process.platform}`,
      'X-Account-Token': '00000000-0000-4000-8000-000000000eva',  // synthetic eval token
      'X-Tier': 'premium',
      'User-Agent': 'CatHealthApp/eval CFNetwork/1.0',  // matches WAF allow-list
      'X-Eval-Run': '1',                                 // for /admin/insights to ignore eval traffic
    },
    body: JSON.stringify(
      imageB64
        ? { prompt, image_base64: imageB64, max_tokens: 1500 }
        : { prompt, max_tokens: 1500 },
    ),
  });
  const latencyMs = Date.now() - t0;

  if (!resp.ok) {
    return {
      caseId: c.id, ok: false, report: null, checks: [],
      metrics: { latencyMs, inputTokens: 0, outputTokens: 0, usdCost: 0 },
      error: `HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`,
    };
  }
  const data = await resp.json() as { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
  const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  const json = extractJson(text);
  let report: Record<string, unknown> | null = null;
  try { report = json ? JSON.parse(json) : null; } catch { report = null; }

  const inTok  = data.usage?.input_tokens  ?? 0;
  const outTok = data.usage?.output_tokens ?? 0;
  const usd = (inTok * COST_INPUT_PER_M + outTok * COST_OUTPUT_PER_M) / 1_000_000;

  const checks = report
    ? c.expectations.map((e) => ({
        expectation: e,
        ...evaluate(e, report),
      }))
    : c.expectations.map((e) => ({
        expectation: e, passed: false, actual: null, note: 'report unparseable',
      }));

  const result: CaseResult = {
    caseId: c.id,
    ok: !!report,
    report,
    checks,
    metrics: { latencyMs, inputTokens: inTok, outputTokens: outTok, usdCost: usd },
    error: report ? undefined : 'report unparseable from /analyze response',
  };

  // Persist the analyze response so the next run with the same image +
  // prompt skips the round-trip. Judge results are NOT cached — judging
  // is what we typically iterate on.
  if (cacheEnabled && result.ok) {
    try { await fs.writeFile(cachePath, JSON.stringify(result, null, 2)); }
    catch { /* cache write is best-effort */ }
  }

  return result;
}

// =========================================================
// Expectation evaluators (rule-based structural checks)
// =========================================================

function evaluate(e: Expectation, report: Record<string, unknown>): { passed: boolean; actual: unknown; note?: string } {
  const actual = readPath(report, e.field);
  switch (e.type) {
    case 'score_range': {
      const n = typeof actual === 'number' ? actual : NaN;
      return { passed: n >= e.min && n <= e.max, actual };
    }
    case 'must_contain': {
      const s = String(actual ?? '').toLowerCase();
      return { passed: e.substrings.every((sub) => s.includes(sub.toLowerCase())), actual };
    }
    case 'must_not_contain': {
      const s = String(actual ?? '').toLowerCase();
      return { passed: !e.substrings.some((sub) => s.includes(sub.toLowerCase())), actual };
    }
    case 'array_min': {
      const len = Array.isArray(actual) ? actual.length : 0;
      return { passed: len >= e.min, actual: len };
    }
    case 'array_max': {
      const len = Array.isArray(actual) ? actual.length : 0;
      return { passed: len <= e.max, actual: len };
    }
    case 'equals': {
      return { passed: actual === e.value, actual };
    }
  }
}

function readPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, key) => (acc && typeof acc === 'object' && key in acc) ? (acc as Record<string, unknown>)[key] : undefined,
    obj,
  );
}

// =========================================================
// Prompt builder — deliberately mirrors the iOS app's PromptBuilder
// for the "no cat profile" path. We don't import iOS code; this is a
// minimal port so the eval harness stays self-contained.
// =========================================================

function buildPrompt(c: TestCase): string {
  // Mirrors iOS PromptBuilder.analysisEN — same hard rules so the eval
  // measures the production behavior, not a stripped-down toy variant.
  // Whenever PromptBuilder changes, mirror the change here too.
  const cat = c.context.cat;
  const issues = (cat.knownIssues ?? []).join(', ');
  const history = (c.context.history ?? []).map(h =>
    `- ${h.daysAgo} days ago (score ${h.healthScore}): ${h.summary}`).join('\n');
  const diary = (c.context.diary ?? []).map(d =>
    `- ${d.daysAgo}d ago: meals=${d.meals} water=${d.water}` +
    (d.discomfort ? ' [unusual]' : '') +
    (d.notes ? ` (${d.notes})` : '')).join('\n');

  return `This is a check for ${cat.name}, a ${cat.age} ${cat.breed} cat, ${cat.neuter ? 'neutered' : 'intact'}` +
    (issues ? `, known issues: ${issues}` : '') + `.\n\n` +
    (history ? `History:\n${history}\n\n` : '') +
    (diary ? `Recent diary:\n${diary}\n\n` : '') +
    (c.context.todayNote ? `Today's note: ${c.context.todayNote}\n\n` : '') +
    `[STRUCTURED SCORING]
Grade four dimensions independently 0-100: eyes / fur / posture / energy.

[HARD RULES]
1. Find the weakest first: identify which dimension is weakest with a
   specific deduction (even minor). No cat scores ≥90 across all four.
2. At least ONE of the four sub-scores MUST be ≤ 79.
3. Every pair of sub-scores must differ by ≥ 4. Forbidden: 88-88-88-88
   or 90-89-91-90 — anti-cluster is mandatory.
4. History is only for trend comparison; do NOT anchor today's score
   on past values.
5. Text must match scores: "bright eyes" → ≥88, "coarse fur" → ≤78,
   "listless" → ≤65.

[SAFETY]
- No cat / blurry photo: breed="no-cat-detected", healthScore=0,
  summary asks owner to retake.
- Severe symptom (labored breathing, bleeding, seizure, abnormal
  pupils, severe dehydration): warning entry must START with [URGENT].
- Mild issues (small redness, etc.) must NOT trigger [URGENT].

[OUTPUT]
Two sections separated by a blank line:
1. 1-2 plain sentences naming the weakest dimension + its deduction.
2. One JSON object — no markdown fences, nothing after — with fields:
   breed, furColor, personality, subScores {eyes, fur, posture, energy},
   eyesCondition, furCondition, postureCondition, suggestions (array),
   warnings (array, each may start with [URGENT]), parentBreeds (array),
   lifestyleTag (water|food|exercise), lifestyleDetail, summary.

Final reminder: at least one sub-score ≤ 79, all pairs ≥ 4 apart.`;
}

// =========================================================
// Aggregation
// =========================================================

function aggregate(
  results: CaseResult[],
  skipped: number,
  workerUrl: string,
  judgeModel: string,
  judgeRuns: number,
): EvalReport {
  const completed = results.filter(r => r.ok && r.report);
  const lats = completed.map(r => r.metrics.latencyMs).sort((a, b) => a - b);
  const allChecks = results.flatMap(r => r.checks);
  const checksTotal = allChecks.length;
  const checksPassed = allChecks.filter(c => c.passed).length;

  const judgeOveralls = completed
    .map(r => r.judge?.overall ?? null)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
  const judgeMedian = judgeOveralls.length === 0
    ? 0
    : (judgeOveralls.length % 2 === 1
        ? judgeOveralls[Math.floor(judgeOveralls.length / 2)]!
        : (judgeOveralls[judgeOveralls.length / 2 - 1]! + judgeOveralls[judgeOveralls.length / 2]!) / 2);

  // Per-case pass: every structural expectation passed AND judge >= 3.5.
  let passed = 0, failed = 0;
  for (const r of results) {
    const allOk = r.checks.length > 0 && r.checks.every(c => c.passed);
    const judgeOk = (r.judge?.overall ?? 0) >= 3.5;
    if (r.ok && allOk && judgeOk) passed++;
    else failed++;
  }

  const safetyViolations = allChecks.filter(c =>
    c.expectation.type === 'must_not_contain' && !c.passed).length;
  const hallucinationCount = completed.reduce((s, r) =>
    s + (r.judge?.hallucinations.length ?? 0), 0);

  const usdAll = completed.map(r => r.metrics.usdCost);
  const totalUsd = usdAll.reduce((s, u) => s + u, 0);
  const avgUsd = usdAll.length === 0 ? 0 : totalUsd / usdAll.length;

  return {
    generatedAt: new Date().toISOString(),
    promptVersion: process.env.PROMPT_VERSION || 'eval-default',
    totalCases: results.length,
    totalSkipped: skipped,
    passed, failed,
    metrics: {
      structuralPassRate: checksTotal === 0 ? 0 : checksPassed / checksTotal,
      judgeMedian,
      p50LatencyMs: percentile(lats, 50),
      p95LatencyMs: percentile(lats, 95),
      avgUsd, totalUsd,
      safetyViolations, hallucinationCount,
    },
    cases: results,
    config: {
      workerUrl,
      judgeModel,
      judgeRuns,
    },
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx] ?? 0);
}

// =========================================================
// Helpers
// =========================================================

async function loadCases(onlyId?: string): Promise<TestCase[]> {
  const dir = join(EVAL_DIR, 'cases');
  const files = await fs.readdir(dir);
  const out: TestCase[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const raw = await fs.readFile(join(dir, f), 'utf-8');
    const c = JSON.parse(raw) as TestCase;
    if (onlyId && c.id !== onlyId) continue;
    out.push(c);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

function extractJson(s: string): string | null {
  const stripped = s.replace(/```json/g, '').replace(/```/g, '');
  const first = stripped.indexOf('{');
  const last = stripped.lastIndexOf('}');
  if (first === -1 || last === -1 || first >= last) return null;
  return stripped.slice(first, last + 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Force resolve unused-import warning (used at runtime but imports lazily resolved).
void resolve;
