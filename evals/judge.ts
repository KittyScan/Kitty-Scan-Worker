/**
 * LLM-as-judge using Claude Opus 4.
 *
 * Why a different tier than the analyzer (Sonnet/Haiku):
 *   • Opus is a more capable judge — it can spot subtle hallucinations
 *     that a same-tier judge might wave through.
 *   • Different model class also reduces shared-failure-mode risk
 *     (Sonnet judging Sonnet has a tendency to validate its own
 *     style rather than the substance).
 *
 * For an even cleaner cross-evaluation we'd swap to GPT-5 / Gemini —
 * for v1 we stay inside the Anthropic family to keep credentials
 * simple. The interface below is deliberately model-agnostic so swapping
 * is a one-line change.
 *
 * Variance reduction: we run the judge N times (default 3) and take
 * the median overall score. Per-criterion verdicts use majority vote.
 */

import type { JudgeVerdict, TestCase } from './types';

// Defaults can be overridden by env at runtime — see runner.ts.
// Sonnet 4.6 (cheapest cross-tier-from-analyzer-when-analyzer-is-Haiku)
// is plenty for daily iteration. Bump to opus-4-7 for high-stakes
// regression gates by setting JUDGE_MODEL=claude-opus-4-7.
const DEFAULT_JUDGE_MODEL = 'claude-sonnet-4-6';

const JUDGE_SYSTEM_PROMPT = `
You are an evaluator for a cat-health AI report generator. You will see:
1. A test case (cat profile + context + image description)
2. Hard expectations the system has already automatically checked
3. The actual report the AI produced
4. A list of qualitative criteria specific to this case

Your job: grade the report independently. The auto-checks already
caught structural failures — you focus on:
  • Quality of qualitative criteria (does the report actually address them?)
  • Hallucinations: claims not supported by the photo or context
  • Coherence: does the analysis make sense, or is it generic boilerplate?
  • Tone: warm-friend voice (per product spec), not corporate

Output ONE JSON object — no markdown fences, no prose around it:
{
  "overall": <0-5 integer>,
  "criteria": [
    { "criterion": "<verbatim from input>", "passed": <bool>, "reasoning": "<≤30 words>" }
  ],
  "hallucinations": ["<thing the report claimed without basis>", "..."],
  "notes": "<≤40 words on the report's main strength + main weakness>"
}

Scoring rubric (overall):
  5 = report is sharp, specific, addresses all qualitative criteria, zero hallucinations
  4 = solid; minor stylistic gripe or one criterion partly missed
  3 = passable; some genericness but no factual errors
  2 = generic or wrong on a criterion
  1 = clearly off — either generic boilerplate or contradicts the case
  0 = unusable / nonsensical

Be strict. Don't reward effort, reward quality.
`.trim();

export interface JudgeConfig {
  workerUrl: string;       // e.g. https://carmel-worker.8fn98bvpdb.workers.dev
  adminToken: string;      // ADMIN_TOKEN — gates /admin/judge
}

export async function runJudge(
  testCase: TestCase,
  reportJson: unknown,
  cfg: JudgeConfig,
  runs: number = 1,
  model: string = DEFAULT_JUDGE_MODEL,
): Promise<JudgeVerdict> {
  const verdicts: JudgeVerdict[] = [];
  for (let i = 0; i < runs; i++) {
    const v = await runJudgeOnce(testCase, reportJson, cfg, model);
    if (v) verdicts.push(v);
  }
  if (verdicts.length === 0) {
    return { overall: 0, criteria: [], hallucinations: ['judge_unavailable'], notes: 'judge call failed all runs' };
  }
  return aggregate(verdicts);
}

async function runJudgeOnce(
  testCase: TestCase,
  reportJson: unknown,
  cfg: JudgeConfig,
  model: string,
): Promise<JudgeVerdict | null> {
  const userMsg = buildJudgePrompt(testCase, reportJson);
  // Route through the Worker's /admin/judge endpoint so we don't need a
  // local Anthropic key — the Worker reuses its own ANTHROPIC_KEY secret.
  const resp = await fetch(`${cfg.workerUrl}/admin/judge?token=${encodeURIComponent(cfg.adminToken)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'CatHealthApp/eval CFNetwork/1.0',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      system: JUDGE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: userMsg }] }],
    }),
  });
  if (!resp.ok) {
    console.warn(`[judge] ${testCase.id} HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    return null;
  }
  const data = await resp.json() as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  const cleaned = extractJson(text);
  if (!cleaned) return null;
  try {
    const parsed = JSON.parse(cleaned) as JudgeVerdict;
    return {
      overall: Number(parsed.overall) || 0,
      criteria: Array.isArray(parsed.criteria) ? parsed.criteria : [],
      hallucinations: Array.isArray(parsed.hallucinations) ? parsed.hallucinations : [],
      notes: typeof parsed.notes === 'string' ? parsed.notes : '',
    };
  } catch {
    return null;
  }
}

function buildJudgePrompt(c: TestCase, report: unknown): string {
  const criteria = (c.qualitative_criteria_en ?? []).join('\n  - ');
  return `## Test case
ID: ${c.id}
Description: ${c.description_en}
Cat: ${JSON.stringify(c.context.cat)}

## Qualitative criteria for this case
  - ${criteria || '(none specific — fall back to general report quality)'}

## Report the AI produced
\`\`\`json
${JSON.stringify(report, null, 2)}
\`\`\`

Grade the report against the criteria. Output the JSON verdict.`;
}

/**
 * Median of `overall`, majority vote on per-criterion `passed`,
 * union of `hallucinations` (so we don't miss any one judge spotted),
 * concatenated `notes`.
 */
function aggregate(vs: JudgeVerdict[]): JudgeVerdict {
  const overalls = vs.map((v) => v.overall).sort((a, b) => a - b);
  const median = overalls.length % 2 === 1
    ? overalls[Math.floor(overalls.length / 2)]!
    : Math.round((overalls[overalls.length / 2 - 1]! + overalls[overalls.length / 2]!) / 2);

  // Majority vote per criterion (criterion text used as key).
  const map = new Map<string, { yes: number; no: number; reasoning: string }>();
  for (const v of vs) {
    for (const c of v.criteria) {
      const e = map.get(c.criterion) ?? { yes: 0, no: 0, reasoning: '' };
      if (c.passed) e.yes++; else e.no++;
      if (!e.reasoning && c.reasoning) e.reasoning = c.reasoning;
      map.set(c.criterion, e);
    }
  }
  const criteria = Array.from(map.entries()).map(([criterion, e]) => ({
    criterion, passed: e.yes >= e.no, reasoning: e.reasoning,
  }));

  // Union of hallucinations — even one judge spotting it is signal.
  const hSet = new Set<string>();
  for (const v of vs) for (const h of v.hallucinations) hSet.add(h);

  return {
    overall: median,
    criteria,
    hallucinations: Array.from(hSet),
    notes: vs.map((v, i) => `[run ${i + 1}] ${v.notes}`).join(' | ').slice(0, 600),
  };
}

function extractJson(s: string): string | null {
  const stripped = s.replace(/```json/g, '').replace(/```/g, '');
  const first = stripped.indexOf('{');
  const last = stripped.lastIndexOf('}');
  if (first === -1 || last === -1 || first >= last) return null;
  return stripped.slice(first, last + 1);
}
