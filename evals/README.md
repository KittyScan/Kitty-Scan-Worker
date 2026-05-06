# KittyScan Eval Pipeline

Offline regression eval for the `/analyze` endpoint. Run before merging
prompt changes; diff results against the previous baseline to catch
regressions in accuracy / safety / latency / cost.

```
evals/
├── cases/        # one .json per test case (hand-curated)
├── images/       # cat photos referenced by cases (NOT in git, see below)
├── reports/      # output: .json + .html per run
├── runner.ts     # entry point (npx tsx evals/runner.ts)
├── judge.ts      # LLM-as-judge using Opus 4
├── report.ts     # HTML report generator
└── types.ts      # shared TypeScript types
```

## What this does

For each test case:
1. Reads the image, base64-encodes it, POSTs to the live `/analyze`.
2. Captures the report + Worker-side metrics (latency, tokens, USD cost).
3. Runs hand-coded structural checks (score in range, must-contain, warnings array length, etc.).
4. Runs an Opus 4 judge **3×** with majority-vote on per-criterion verdicts and median on overall — gives stable scoring under model variance.
5. Aggregates into a single `EvalReport` (JSON + standalone HTML).

A case **passes** only if every structural check passes AND the median Opus
score is ≥ 3.5. Anything less is a regression.

## Running

```bash
# install once
npm install

# Required env vars (put in .env or export)
export ANTHROPIC_API_KEY=sk-ant-…   # your raw Anthropic key for the judge
export ADMIN_TOKEN=…                # same one the dashboard uses

# All cases (default: Sonnet judge × 1 run, with /analyze caching)
npx tsx evals/runner.ts

# Single case
npx tsx evals/runner.ts 02-eye-discharge

# Smoke mode — run only the first case (~$0.02) for fast iteration
npx tsx evals/runner.ts --smoke

# High-stakes regression gate — Opus judge × 3 with majority vote
JUDGE_MODEL=claude-opus-4-7 JUDGE_RUNS=3 npx tsx evals/runner.ts

# Force fresh /analyze (skip cache)
NO_CACHE=1 npx tsx evals/runner.ts

# Custom prompt-version label (shows up in the report)
PROMPT_VERSION=v3.2-trial npx tsx evals/runner.ts
```

Open the resulting `evals/reports/<timestamp>.html` in a browser.

## Adding test cases

1. Drop a cat photo into `evals/images/` — name it `<id>.jpg`.
2. Create `evals/cases/<id>.json` (use the existing files as templates).
3. Re-run `npx tsx evals/runner.ts <id>` to verify it loads + makes sense.

The case JSON has three required pieces:

- **`context`** — mock cat profile + history + diary fed to the prompt.
- **`expectations`** — programmatic checks the runner enforces. Six types:
  - `score_range` — assert a numeric field is within [min, max]
  - `must_contain` / `must_not_contain` — substring search in a string field
  - `array_min` / `array_max` — assert array length bound
  - `equals` — exact value match
- **`qualitative_criteria_*`** — free-form criteria the LLM judge evaluates.

Put **structural** facts in expectations (the runner's deterministic; no
flake). Put **judgmental** facts in qualitative criteria (the judge handles
the fuzziness).

## Why a 3× judge run

Opus 4 grades the same report differently each invocation (~0.5-1.0 std on
the 0-5 scale). Three runs + median collapses that variance enough that
single-point regressions are real, not random.

For an even better cross-evaluation: swap `JUDGE_MODEL` in `judge.ts` to
GPT-5 or Gemini 2.5 Pro (different family). v1 stays inside Anthropic
to keep credentials simple.

## Why images aren't in git

The cat photos are bigger than the test case definitions and not strictly
needed for prompt regression review. Keep them local. To bootstrap a fresh
clone, drop the same image filenames into `evals/images/`.

## Reading a report

`reports/<UTC-timestamp>.html` opens directly in any browser:

- **Hero stats** — pass rate, judge median, P50/P95 latency, total cost,
  safety violations, hallucinations.
- **Per-case rows** — click to expand. Shows every expectation pass/fail
  with the actual value, the judge's per-criterion vote, the
  hallucinations the judge flagged, and the raw report JSON.

Two reports side-by-side in a browser is a perfectly serviceable diff
view. A native diff command (`evals/diff.ts`) is on the roadmap.

## Cost

Default config (Sonnet judge × 1 run, /analyze cached when image+prompt
unchanged):

| Step | Cold (no cache) | Warm (cached) |
|---|---|---|
| /analyze (Sonnet 4) × 5 cases | ~\$0.05 | \$0 |
| Judge (Sonnet 4) × 5 | ~\$0.02 | ~\$0.02 |
| **Total** | **~\$0.07** | **~\$0.02** |

50 cases cold ≈ \$0.70/run. Iterating on the judge prompt (cache hits
on every analyze) ≈ \$0.20/run.

For high-stakes regression gates, escalate via env vars:

```bash
JUDGE_MODEL=claude-opus-4-7 JUDGE_RUNS=3 npx tsx evals/runner.ts
```

That's ~\$0.35/run for 5 cases — the original cost — used only when you
need cross-tier judging + variance reduction (e.g. before merging a
prompt PR).

## Cost-cutting knobs

| Env / flag | Default | What it does |
|---|---|---|
| `JUDGE_MODEL` | `claude-sonnet-4-6` | Set to `claude-opus-4-7` for cross-tier judging (~3× cost). |
| `JUDGE_RUNS` | `1` | Bump to `3` for median-vote variance reduction (~3× judge cost). |
| `NO_CACHE=1` | unset | Skip `/analyze` cache — forces a fresh model call. |
| `--smoke` flag | off | Run only the first case for a fast cost-bounded check. |

The `/analyze` cache lives in `evals/.cache/` keyed by image hash + case
id + full prompt. Change the case context (e.g. update `expectations`)
and the cached report is re-graded **without** re-spending on `/analyze`.

## CI integration (TODO)

Wire `runner.ts` into a GitHub Action that runs on PR with paths matching
`prompts/**` or `agents/**`. Gate merge on:

- structural pass rate ≥ baseline-5%
- judge median ≥ baseline-0.3
- P95 latency ≤ baseline+20%
- safety violations: 0

`evals/diff.ts` will land alongside.
