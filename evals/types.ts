/**
 * Shared types for the eval pipeline.
 *
 * Everything happens in three steps:
 *   1. Load TestCase[] from cases/*.json
 *   2. For each case: call /analyze on the live Worker, capture metrics
 *   3. Run LLM-as-judge to score qualitative properties
 *
 * Then aggregate into an EvalReport (JSON + HTML).
 */

// =========================================================
// Test case spec (source of truth — hand-crafted in cases/)
// =========================================================

export interface TestCase {
  id: string;
  description_zh: string;
  description_en: string;
  /** Path relative to evals/ (typically "images/<id>.jpg"). If the file
   *  doesn't exist on disk, the runner skips this case with a warning. */
  image: string;
  /** Mock cat profile + history + diary fed to the prompt builder. */
  context: {
    cat: {
      name: string;
      breed: string;
      age: string;
      sex?: string;
      neuter: boolean;
      knownIssues?: string[];
    };
    history?: Array<{ daysAgo: number; healthScore: number; summary: string }>;
    diary?: Array<{ daysAgo: number; meals: number; water: number; mood?: number; discomfort?: boolean; notes?: string }>;
    todayNote?: string;
  };
  /** Hard expectations the runner can check programmatically. */
  expectations: Expectation[];
  /** Free-form qualitative criteria for the LLM judge (e.g. "report should
   *  call out the eye discharge by name and recommend a vet visit"). */
  qualitative_criteria_zh?: string[];
  qualitative_criteria_en?: string[];
}

export type Expectation =
  | { type: 'score_range';      field: string; min: number; max: number; rationale: string }
  | { type: 'must_contain';     field: string; substrings: string[];     rationale: string }
  | { type: 'must_not_contain'; field: string; substrings: string[];     rationale: string }
  | { type: 'array_min';        field: string; min: number;              rationale: string }
  | { type: 'array_max';        field: string; max: number;              rationale: string }
  | { type: 'equals';           field: string; value: string | number;   rationale: string };

// =========================================================
// Runner output (one row per case)
// =========================================================

export interface CaseResult {
  caseId: string;
  ok: boolean;
  /** The raw HealthReport JSON the Worker returned (or null on error). */
  report: Record<string, unknown> | null;
  /** Structural check results — every Expectation maps to one of these. */
  checks: Array<{ expectation: Expectation; passed: boolean; actual: unknown; note?: string }>;
  /** LLM-as-judge verdict (Opus). Optional — populated only after judge runs. */
  judge?: JudgeVerdict;
  /** Worker-side metrics, captured per request. */
  metrics: { latencyMs: number; inputTokens: number; outputTokens: number; usdCost: number };
  /** Error message when ok=false. */
  error?: string;
}

export interface JudgeVerdict {
  /** 0-5 overall quality, median over N runs (default 3) for variance reduction. */
  overall: number;
  /** Per-criterion 0/1 score. */
  criteria: Array<{ criterion: string; passed: boolean; reasoning: string }>;
  /** Things the report claimed that aren't backed by the photo or context. */
  hallucinations: string[];
  notes: string;
}

// =========================================================
// Aggregated report shape
// =========================================================

export interface EvalReport {
  generatedAt: string;
  promptVersion: string;
  workerVersion?: string;
  totalCases: number;
  totalSkipped: number;
  /** Pass = every structural Expectation passed AND judge.overall >= 3.5. */
  passed: number;
  failed: number;
  /** Aggregate metrics — averaged over completed cases. */
  metrics: {
    structuralPassRate: number;       // % of expectations that passed
    judgeMedian: number;              // median overall score across cases
    p50LatencyMs: number;
    p95LatencyMs: number;
    avgUsd: number;
    totalUsd: number;
    safetyViolations: number;         // count of must_not_contain failures
    hallucinationCount: number;
  };
  cases: CaseResult[];
  config: {
    workerUrl: string;
    judgeModel: string;
    judgeRuns: number;
  };
}
