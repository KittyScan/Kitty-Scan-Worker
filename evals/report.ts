/**
 * HTML report generator. Open the file directly in a browser — no server.
 *
 * Layout (top to bottom):
 *   1. Hero with pass rate, judge median, P95 latency, total cost.
 *   2. Per-case table — id, structural ✓/✗, judge score, latency, cost.
 *   3. Click a case to expand: full expectations vs actual, judge verdict,
 *      raw report JSON.
 */

import type { EvalReport, CaseResult } from './types';

export function renderReportHtml(r: EvalReport): string {
  const passRate = r.totalCases === 0 ? 0 : (r.passed / r.totalCases) * 100;
  const passColor = passRate >= 90 ? '#2e7d32'
                  : passRate >= 70 ? '#ed6c02'
                  : '#c62828';

  const cases = r.cases.map((c, i) => caseRow(c, i)).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>KittyScan Eval · ${esc(r.generatedAt.slice(0, 16))}</title>
<style>
  :root{--title:#4a2f18;--body:#6e4e32;--card:#fffaf2;--bg-top:#fddc9f;--bg-bot:#f5c382;--link:#a85a1a}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,"SF Pro","Helvetica Neue",sans-serif;
       background:linear-gradient(180deg,var(--bg-top),var(--bg-bot));color:var(--body);
       min-height:100vh;padding:24px}
  .wrap{max-width:1100px;margin:0 auto}
  h1{margin:0 0 8px;color:var(--title)}
  .meta{font-size:12px;opacity:.65;margin-bottom:18px}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:18px}
  .stat{background:var(--card);border-radius:14px;padding:14px;box-shadow:0 2px 8px rgba(74,47,24,.06)}
  .stat .n{font-size:24px;font-weight:700;color:var(--title);font-variant-numeric:tabular-nums;line-height:1.1}
  .stat .l{font-size:11px;opacity:.6;margin-top:4px}
  .panel{background:var(--card);border-radius:14px;padding:16px;box-shadow:0 2px 8px rgba(74,47,24,.06);margin-bottom:14px}
  .panel h3{margin:0 0 10px;font-size:14px;color:var(--title)}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid rgba(74,47,24,.08);vertical-align:top}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.5px;opacity:.6}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  details{cursor:pointer}
  details summary{outline:none;list-style:none}
  details summary::-webkit-details-marker{display:none}
  .case-row{padding:11px 12px;border-bottom:1px solid rgba(74,47,24,.06)}
  .case-head{display:grid;grid-template-columns:30px 1fr 80px 70px 80px 80px;align-items:center;gap:10px}
  .case-id{font-weight:600;color:var(--title);font-size:13.5px}
  .case-desc{font-size:11px;opacity:.7;margin-top:2px}
  .pill{display:inline-block;padding:2px 8px;border-radius:9px;font-size:10px;font-weight:700;text-align:center}
  .pass{background:#d4edda;color:#1b5e20}
  .fail{background:#f8d7da;color:#b71c1c}
  .skip{background:#e2e3e5;color:#444}
  .num-cell{font-variant-numeric:tabular-nums;text-align:right;font-size:12px}
  .case-detail{margin-top:12px;padding:14px;background:rgba(0,0,0,.03);border-radius:10px}
  .check{padding:6px 0;border-bottom:1px dotted rgba(74,47,24,.08);font-size:12.5px}
  .check:last-child{border-bottom:0}
  .check-pass{color:#2e7d32}
  .check-fail{color:#c62828}
  .check-rationale{opacity:.65;font-size:11px;margin-left:8px}
  .judge-block{margin-top:12px;padding:10px 12px;background:rgba(168,90,26,.06);border-left:3px solid var(--link);border-radius:7px}
  .judge-row{font-size:12.5px;margin:4px 0}
  pre{background:#1c1c1c;color:#e0e0e0;padding:10px;border-radius:6px;font-size:11px;overflow-x:auto;max-height:320px}
</style>
</head>
<body>
<div class="wrap">
  <h1>🐾 KittyScan Eval Report</h1>
  <div class="meta">${esc(r.generatedAt)} · prompt=${esc(r.promptVersion)} · judge=${esc(r.config.judgeModel)} (${r.config.judgeRuns}× runs) · worker=${esc(r.config.workerUrl)}</div>

  <div class="stats">
    <div class="stat" style="background:linear-gradient(135deg,${passColor}20,${passColor}10)">
      <div class="n" style="color:${passColor}">${r.passed}/${r.totalCases}</div>
      <div class="l">cases passed (${passRate.toFixed(0)}%)</div>
    </div>
    <div class="stat"><div class="n">${r.metrics.judgeMedian.toFixed(1)}/5</div><div class="l">judge median</div></div>
    <div class="stat"><div class="n">${(r.metrics.structuralPassRate * 100).toFixed(0)}%</div><div class="l">structural checks pass</div></div>
    <div class="stat"><div class="n">${r.metrics.p50LatencyMs}ms</div><div class="l">P50 latency</div></div>
    <div class="stat"><div class="n">${r.metrics.p95LatencyMs}ms</div><div class="l">P95 latency</div></div>
    <div class="stat"><div class="n">$${r.metrics.totalUsd.toFixed(4)}</div><div class="l">total cost</div></div>
    <div class="stat"><div class="n">${r.metrics.safetyViolations}</div><div class="l">safety violations</div></div>
    <div class="stat"><div class="n">${r.metrics.hallucinationCount}</div><div class="l">hallucinations spotted</div></div>
  </div>

  ${r.totalSkipped > 0 ? `<div class="panel" style="background:#fff7e0"><strong>⚠ ${r.totalSkipped} case(s) skipped</strong> — image file missing in evals/images/. Add the images and re-run.</div>` : ''}

  <div class="panel">
    <h3>Cases</h3>
    ${cases || '<div style="opacity:.6">No cases ran.</div>'}
  </div>
</div>
</body>
</html>`;
}

function caseRow(c: CaseResult, idx: number): string {
  const allChecks = c.checks.length;
  const passedChecks = c.checks.filter((x) => x.passed).length;
  const allOk = allChecks > 0 && passedChecks === allChecks;
  const judgeOk = (c.judge?.overall ?? 0) >= 3.5;
  const overallPass = c.ok && allOk && judgeOk;

  const checks = c.checks.map((ch) => {
    const cls = ch.passed ? 'check-pass' : 'check-fail';
    return `<div class="check ${cls}">
      ${ch.passed ? '✓' : '✗'} <code>${esc(ch.expectation.type)}</code>
      <code>${esc(ch.expectation.field ?? '')}</code>
      → actual: <code>${esc(JSON.stringify(ch.actual))}</code>
      <span class="check-rationale">${esc(ch.expectation.rationale)}</span>
    </div>`;
  }).join('');

  const judgeBlock = c.judge ? `
    <div class="judge-block">
      <div class="judge-row"><strong>Judge ${c.judge.overall}/5</strong> — ${esc(c.judge.notes)}</div>
      ${c.judge.criteria.map((cr) =>
        `<div class="judge-row">${cr.passed ? '✓' : '✗'} ${esc(cr.criterion)} <span class="check-rationale">${esc(cr.reasoning)}</span></div>`
      ).join('')}
      ${c.judge.hallucinations.length ? `<div class="judge-row"><strong>Hallucinations:</strong> ${c.judge.hallucinations.map((h) => esc(h)).join('; ')}</div>` : ''}
    </div>` : '';

  return `<details class="case-row" ${idx === 0 ? 'open' : ''}>
    <summary>
      <div class="case-head">
        <span class="pill ${overallPass ? 'pass' : c.ok ? 'fail' : 'skip'}">${overallPass ? 'PASS' : c.ok ? 'FAIL' : 'ERR'}</span>
        <div>
          <div class="case-id">${esc(c.caseId)}</div>
          <div class="case-desc">${passedChecks}/${allChecks} checks · judge ${c.judge?.overall ?? '—'}/5${c.judge?.hallucinations.length ? ' · ' + c.judge.hallucinations.length + ' halluc' : ''}</div>
        </div>
        <div class="num-cell">${c.metrics.latencyMs}ms</div>
        <div class="num-cell">${c.metrics.inputTokens}/${c.metrics.outputTokens}</div>
        <div class="num-cell">$${c.metrics.usdCost.toFixed(4)}</div>
        <div class="num-cell" style="opacity:.5">▾</div>
      </div>
    </summary>
    <div class="case-detail">
      ${c.error ? `<div style="color:#c62828;font-weight:600;margin-bottom:8px">Error: ${esc(c.error)}</div>` : ''}
      <strong>Structural checks</strong>${checks || '<div style="opacity:.6">no checks defined</div>'}
      ${judgeBlock}
      ${c.report ? `<details style="margin-top:10px"><summary><strong>Raw report JSON</strong></summary><pre>${esc(JSON.stringify(c.report, null, 2))}</pre></details>` : ''}
    </div>
  </details>`;
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]!);
}
