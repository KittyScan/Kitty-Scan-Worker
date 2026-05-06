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
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestCase, CaseResult, EvalReport, Expectation } from './types';
import { runJudge } from './judge';
import { renderReportHtml } from './report';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = __dirname;

// Cost per million tokens — kept in sync with the production cost ledger.
const COST_INPUT_PER_M  = 3;
const COST_OUTPUT_PER_M = 15;

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const adminToken = process.env.ADMIN_TOKEN;
  const workerUrl = process.env.WORKER_URL || 'https://carmel-worker.8fn98bvpdb.workers.dev';
  if (!apiKey)     throw new Error('ANTHROPIC_API_KEY env var is required (for the Opus judge)');
  if (!adminToken) throw new Error('ADMIN_TOKEN env var is required (or pass via .env)');

  const onlyId = process.argv[2];
  const cases = await loadCases(onlyId);
  console.log(`Loaded ${cases.length} test case${cases.length === 1 ? '' : 's'}` +
              (onlyId ? ` (filtered to ${onlyId})` : ''));

  const results: CaseResult[] = [];
  let skipped = 0;
  for (const c of cases) {
    const present = await fileExists(join(EVAL_DIR, c.image));
    if (!present) {
      console.warn(`[skip] ${c.id} — image not found at ${c.image}`);
      skipped++;
      continue;
    }
    console.log(`\n→ ${c.id}`);
    const result = await runCase(c, workerUrl, adminToken);
    if (result.ok && result.report) {
      console.log(`  /analyze ok · ${result.metrics.latencyMs}ms · $${result.metrics.usdCost.toFixed(4)}`);
      try {
        result.judge = await runJudge(c, result.report, apiKey, 3);
        console.log(`  judge ${result.judge.overall}/5 · halluc=${result.judge.hallucinations.length}`);
      } catch (e) {
        console.warn(`  judge failed: ${(e as Error).message}`);
      }
    } else {
      console.warn(`  /analyze failed: ${result.error}`);
    }
    results.push(result);
  }

  const report = aggregate(results, skipped, workerUrl);
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
): Promise<CaseResult> {
  const imagePath = join(EVAL_DIR, c.image);
  const imageBuf = await fs.readFile(imagePath);
  const imageB64 = imageBuf.toString('base64');

  const prompt = buildPrompt(c);

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
    body: JSON.stringify({
      prompt,
      image_base64: imageB64,
      max_tokens: 1500,
    }),
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

  return {
    caseId: c.id,
    ok: !!report,
    report,
    checks,
    metrics: { latencyMs, inputTokens: inTok, outputTokens: outTok, usdCost: usd },
    error: report ? undefined : 'report unparseable from /analyze response',
  };
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
    `Analyze the photo and return strict JSON with: breed, furColor, personality, ` +
    `subScores {eyes, fur, posture, energy} (0-100 ints), eyesCondition, furCondition, ` +
    `postureCondition, suggestions (array), warnings (array), parentBreeds (array), ` +
    `lifestyleTag (water|food|exercise), lifestyleDetail, summary. ` +
    `JSON only, no markdown fences.`;
}

// =========================================================
// Aggregation
// =========================================================

function aggregate(results: CaseResult[], skipped: number, workerUrl: string): EvalReport {
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
      judgeModel: 'claude-opus-4-7',
      judgeRuns: 3,
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
