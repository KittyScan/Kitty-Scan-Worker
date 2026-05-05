/**
 * Tiny admin dashboard for the feedback ledger.
 *
 * Renders an HTML page summarizing every `fb:*` row in KV — the per-report
 * 👍/👎 ratings AND the bug/feature/billing/general bug-report flow share
 * this prefix, so one screen covers all user feedback.
 *
 * Auth: query-string `?token=<ADMIN_TOKEN>` matched against the Worker
 * secret (`wrangler secret put ADMIN_TOKEN`). Without a valid token the
 * endpoint returns 403 — this is the only thing standing between random
 * passers-by and your users' feedback, so set a long random token.
 *
 * Filters (optional): `&category=rating|bug|feature|billing|general`
 * Limit:   `&limit=200` (default 200, max 1000 — KV cursor caps it anyway)
 */

import type { Env } from '../index';

interface FeedbackRow {
  receivedAt?: string;
  category?: string;
  text?: string;
  accountToken?: string | null;
  appVersion?: string | null;
  appBuild?: string | null;
  iosVersion?: string | null;
  language?: string | null;
  ip?: string | null;
  country?: string | null;
}

export async function handleAdminFeedback(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') ?? '';
  const adminToken = (env as unknown as { ADMIN_TOKEN?: string }).ADMIN_TOKEN ?? '';
  if (!adminToken) {
    return new Response('admin token not configured (set ADMIN_TOKEN secret)',
                        { status: 503 });
  }
  if (token !== adminToken) {
    return new Response('forbidden', { status: 403 });
  }

  const filterCat = url.searchParams.get('category') ?? '';
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '200', 10), 1000);

  const list = await env.RATE_KV.list({ prefix: 'fb:', limit });
  const rows: FeedbackRow[] = [];
  // Fetch values concurrently — KV reads are cheap and this keeps the
  // page render under a second even for a few hundred rows.
  const values = await Promise.all(list.keys.map((k) => env.RATE_KV.get(k.name)));
  for (const raw of values) {
    if (!raw) continue;
    try {
      const row = JSON.parse(raw) as FeedbackRow;
      if (filterCat && row.category !== filterCat) continue;
      rows.push(row);
    } catch {
      // Skip malformed rows rather than 500 the whole dashboard.
    }
  }

  // ----- aggregate stats -----
  const ratingRows = rows.filter((r) => r.category === 'rating');
  const thumbsUp   = ratingRows.filter((r) => (r.text ?? '').startsWith('👍')).length;
  const thumbsDown = ratingRows.filter((r) => (r.text ?? '').startsWith('👎')).length;
  const ratingTotal = thumbsUp + thumbsDown;
  const csat = ratingTotal === 0 ? '—' :
               `${Math.round((thumbsUp / ratingTotal) * 100)}% (${thumbsUp}/${ratingTotal})`;

  // 👎 reason breakdown
  const reasons: Record<string, number> = {};
  for (const r of ratingRows) {
    const t = r.text ?? '';
    if (!t.startsWith('👎')) continue;
    const reason = t.slice(2).trim() || '(no reason)';
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  const reasonRows = Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`)
    .join('');

  // Category counts
  const categoryCounts: Record<string, number> = {};
  for (const r of rows) {
    const c = r.category ?? 'unknown';
    categoryCounts[c] = (categoryCounts[c] ?? 0) + 1;
  }
  const categoryRows = Object.entries(categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`)
    .join('');

  // Newest-first table
  const tableRows = rows
    .slice()
    .sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''))
    .map((r) => {
      const when = (r.receivedAt ?? '').replace('T', ' ').slice(0, 16);
      const cat = r.category ?? '';
      const catColor =
        cat === 'rating' ? ((r.text ?? '').startsWith('👍') ? '#d4edda' : '#f8d7da')
                         : cat === 'bug'    ? '#fff3cd'
                         : cat === 'feature' ? '#d1ecf1'
                         : '#e2e3e5';
      const tokenShort = (r.accountToken ?? '').slice(0, 8);
      return `<tr>
        <td class="when">${esc(when)}</td>
        <td><span class="cat" style="background:${catColor}">${esc(cat)}</span></td>
        <td class="text">${esc(r.text ?? '')}</td>
        <td class="meta">${esc(r.appVersion ?? '?')} (${esc(r.appBuild ?? '?')}) · ${esc(r.iosVersion ?? '?')} · ${esc(r.language ?? '?')} · ${esc(r.country ?? '?')}</td>
        <td class="token">${esc(tokenShort)}</td>
      </tr>`;
    })
    .join('');

  const filters = ['', 'rating', 'bug', 'feature', 'billing', 'general']
    .map((c) => {
      const label = c || 'all';
      const active = c === filterCat ? 'active' : '';
      const href = c
        ? `?token=${encodeURIComponent(token)}&category=${c}&limit=${limit}`
        : `?token=${encodeURIComponent(token)}&limit=${limit}`;
      return `<a class="filter ${active}" href="${href}">${esc(label)} (${categoryCounts[c] ?? (c === '' ? rows.length : 0)})</a>`;
    })
    .join(' ');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KittyScan · Feedback</title>
<style>
  :root {
    --bg-top:#fddc9f; --bg-bot:#f5c382; --title:#4a2f18;
    --body:#6e4e32; --card:#fffaf2; --link:#a85a1a;
  }
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,"SF Pro","Helvetica Neue",sans-serif;
       background:linear-gradient(180deg,var(--bg-top),var(--bg-bot));
       color:var(--body);min-height:100vh;padding:24px}
  .wrap{max-width:1200px;margin:0 auto}
  h1{color:var(--title);margin:0 0 8px;font-size:28px}
  .sub{opacity:.7;font-size:13px;margin-bottom:24px}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));
         gap:12px;margin-bottom:20px}
  .stat{background:var(--card);border-radius:14px;padding:16px;
        box-shadow:0 2px 8px rgba(74,47,24,.06)}
  .stat .n{font-size:26px;font-weight:700;color:var(--title)}
  .stat .l{font-size:12px;opacity:.7;margin-top:4px}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:20px}
  .panel{background:var(--card);border-radius:14px;padding:16px;
         box-shadow:0 2px 8px rgba(74,47,24,.06)}
  .panel h3{margin:0 0 10px;font-size:14px;color:var(--title)}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid rgba(74,47,24,.08);vertical-align:top}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.5px;opacity:.6}
  .cat{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;
       font-weight:600;color:#3a2516}
  .when{white-space:nowrap;font-variant-numeric:tabular-nums;opacity:.75}
  .text{max-width:380px;word-break:break-word}
  .meta{font-size:11px;opacity:.65;white-space:nowrap}
  .token{font-family:'SF Mono',monospace;font-size:11px;opacity:.5}
  .filters{margin-bottom:14px}
  .filter{display:inline-block;padding:6px 12px;margin-right:6px;
          border-radius:14px;background:var(--card);color:var(--link);
          text-decoration:none;font-size:13px}
  .filter.active{background:var(--link);color:white}
</style>
</head>
<body>
<div class="wrap">
  <h1>🐾 KittyScan · Feedback</h1>
  <div class="sub">Loaded ${rows.length} entries${filterCat ? ` · filter: ${esc(filterCat)}` : ''}</div>

  <div class="stats">
    <div class="stat"><div class="n">${rows.length}</div><div class="l">total entries</div></div>
    <div class="stat"><div class="n">${ratingTotal}</div><div class="l">ratings (👍 + 👎)</div></div>
    <div class="stat"><div class="n">${thumbsUp}</div><div class="l">👍 helpful</div></div>
    <div class="stat"><div class="n">${thumbsDown}</div><div class="l">👎 off</div></div>
    <div class="stat"><div class="n">${csat}</div><div class="l">CSAT (👍 / total)</div></div>
  </div>

  <div class="row">
    <div class="panel">
      <h3>By category</h3>
      <table><thead><tr><th>Category</th><th>Count</th></tr></thead><tbody>${categoryRows || '<tr><td colspan="2" style="opacity:.5">no data</td></tr>'}</tbody></table>
    </div>
    <div class="panel">
      <h3>👎 reasons</h3>
      <table><thead><tr><th>Reason</th><th>Count</th></tr></thead><tbody>${reasonRows || '<tr><td colspan="2" style="opacity:.5">no 👎 yet</td></tr>'}</tbody></table>
    </div>
  </div>

  <div class="filters">${filters}</div>

  <div class="panel">
    <table>
      <thead>
        <tr>
          <th>When (UTC)</th>
          <th>Category</th>
          <th>Text</th>
          <th>Client</th>
          <th>Token</th>
        </tr>
      </thead>
      <tbody>${tableRows || '<tr><td colspan="5" style="opacity:.5;padding:20px;text-align:center">No feedback yet</td></tr>'}</tbody>
    </table>
  </div>
</div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]!);
}
