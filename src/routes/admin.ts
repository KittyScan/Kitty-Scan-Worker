/**
 * Admin dashboard. Single endpoint, multiple sections via ?section=.
 * All views share the same ADMIN_TOKEN auth — set via:
 *   echo -n "<token>" | wrangler secret put ADMIN_TOKEN
 * (the interactive prompt has been observed to drop the value silently).
 *
 * Sections:
 *   overview  — high-level stats: users, analyses, costs, CSAT
 *   feedback  — every fb:* row with category filter
 *   users     — entitlement-ledger breakdown by tier
 *   activity  — log:* per-call analytics: latency P50/P95, model/route split
 *   costs     — monthly cost trend from cost:YYYY-MM
 *
 * Querystring:
 *   ?token=<ADMIN_TOKEN>          required
 *   &section=overview|feedback|users|activity|costs   default overview
 *   &category=...                 (feedback only)
 *   &limit=<n>                    default 200, capped at 1000 by KV
 */

import type { Env } from '../index';
import { percentile } from '../lib/analytics';

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

interface LogRow {
  ts?: string;
  route?: string;
  status?: string;
  model?: string;
  tier?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  tokenShort?: string;
  deviceShort?: string;
  country?: string;
}

interface EntRow {
  tier: 'free' | 'pack' | 'sub';
  packBalance?: number;
  subActiveUntil?: number;
  subAnalyzeUsed?: number;
  subChatUsed?: number;
  lastUpdatedAt?: number;
}

export async function handleAdminFeedback(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') ?? '';
  const adminToken = env.ADMIN_TOKEN ?? '';
  if (!adminToken) {
    return new Response('admin token not configured (set ADMIN_TOKEN secret via stdin pipe)',
                        { status: 503 });
  }
  if (token !== adminToken) {
    return new Response('forbidden', { status: 403 });
  }

  const section = url.searchParams.get('section') ?? 'overview';
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '200', 10), 1000);

  // Section dispatcher — each helper renders its own <main> body, the
  // shell wraps it with header + nav.
  let body: string;
  switch (section) {
    case 'feedback': body = await renderFeedback(env, url, token, limit); break;
    case 'users':    body = await renderUsers(env, limit);                break;
    case 'activity': body = await renderActivity(env, limit);             break;
    case 'costs':    body = await renderCosts(env);                       break;
    case 'insights': body = renderInsights(token);                        break;
    default:         body = await renderOverview(env, limit);             break;
  }

  return new Response(shell(body, section, token), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// ===========================================================================
// Sections
// ===========================================================================

async function renderOverview(env: Env, limit: number): Promise<string> {
  // Pull what we need across prefixes — done in parallel since they're
  // independent. KV reads are cheap enough that listing + parsing a few
  // hundred rows is sub-second.
  const [fbRows, logRows, entRows, costMap] = await Promise.all([
    listAndParse<FeedbackRow>(env, 'fb:', limit),
    listAndParse<LogRow>(env, 'log:', limit),
    listAndParse<EntRow>(env, 'ent:', limit),
    listCostMap(env),
  ]);

  // CSAT: % thumbs-up over rating-category feedback rows.
  const ratings = fbRows.filter((r) => r.category === 'rating');
  const up = ratings.filter((r) => (r.text ?? '').startsWith('👍')).length;
  const csat = ratings.length === 0 ? '—' : `${Math.round((up / ratings.length) * 100)}%`;

  // Tier counts from entitlement ledger.
  const tierCounts: Record<string, number> = { free: 0, pack: 0, sub: 0 };
  for (const e of entRows) tierCounts[e.tier] = (tierCounts[e.tier] ?? 0) + 1;

  // Cost MTD — current YYYY-MM bucket.
  const monthKey = new Date().toISOString().slice(0, 7);
  const costMtd = costMap[monthKey] ?? 0;

  // Activity in the log window (~30 days).
  const total = logRows.length;
  const okCount = logRows.filter((r) => r.status === 'ok').length;
  const okRate = total === 0 ? '—' : `${Math.round((okCount / total) * 100)}%`;
  const latencies = logRows
    .map((r) => r.durationMs ?? 0)
    .filter((n) => n > 0);

  return `
    <div class="stats">
      ${stat(entRows.length, 'total accounts')}
      ${stat(tierCounts.sub ?? 0, 'Pro subscribers')}
      ${stat(tierCounts.pack ?? 0, 'pack users')}
      ${stat(tierCounts.free ?? 0, 'free users')}
      ${stat(`$${costMtd.toFixed(2)}`, `cost MTD (${monthKey})`)}
      ${stat(total, 'analyses (30d log)')}
      ${stat(okRate, 'success rate')}
      ${stat(csat, 'CSAT (👍 / total)')}
      ${stat(`${percentile(latencies, 50)}ms`, 'latency P50')}
      ${stat(`${percentile(latencies, 95)}ms`, 'latency P95')}
      ${stat(ratings.length, 'ratings collected')}
      ${stat(fbRows.filter((r) => r.category === 'bug').length, 'bug reports')}
    </div>
    <div class="hint">Numbers above reflect everything currently in KV. Activity / cost windows are bounded by the 30-day log retention and monthly cost buckets.</div>
  `;
}

async function renderFeedback(env: Env, url: URL, token: string, limit: number): Promise<string> {
  const filterCat = url.searchParams.get('category') ?? '';
  const rows = await listAndParse<FeedbackRow>(env, 'fb:', limit);

  const filtered = filterCat ? rows.filter((r) => r.category === filterCat) : rows;
  const ratingRows = rows.filter((r) => r.category === 'rating');
  const up = ratingRows.filter((r) => (r.text ?? '').startsWith('👍')).length;
  const down = ratingRows.length - up;

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

  const categoryCounts: Record<string, number> = {};
  for (const r of rows) categoryCounts[r.category ?? 'unknown'] = (categoryCounts[r.category ?? 'unknown'] ?? 0) + 1;

  const filters = ['', 'rating', 'bug', 'feature', 'billing', 'general']
    .map((c) => {
      const label = c || 'all';
      const active = c === filterCat ? 'active' : '';
      const href = c
        ? `?token=${encodeURIComponent(token)}&section=feedback&category=${c}&limit=${limit}`
        : `?token=${encodeURIComponent(token)}&section=feedback&limit=${limit}`;
      const count = c === '' ? rows.length : (categoryCounts[c] ?? 0);
      return `<a class="filter ${active}" href="${href}">${esc(label)} (${count})</a>`;
    })
    .join(' ');

  const tableRows = filtered
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

  return `
    <div class="stats">
      ${stat(rows.length, 'total feedback')}
      ${stat(ratingRows.length, 'ratings')}
      ${stat(up, '👍 helpful')}
      ${stat(down, '👎 off')}
    </div>
    <div class="row">
      <div class="panel"><h3>👎 reasons</h3>
        <table><thead><tr><th>Reason</th><th>Count</th></tr></thead>
        <tbody>${reasonRows || '<tr><td colspan="2" style="opacity:.5">no 👎 yet</td></tr>'}</tbody></table>
      </div>
      <div class="panel"><h3>By category</h3>
        <table><thead><tr><th>Category</th><th>Count</th></tr></thead>
        <tbody>${Object.entries(categoryCounts).sort((a,b) => b[1]-a[1]).map(([k,v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('') || '<tr><td colspan="2" style="opacity:.5">no data</td></tr>'}</tbody></table>
      </div>
    </div>
    <div class="filters">${filters}</div>
    <div class="panel">
      <table>
        <thead><tr><th>When (UTC)</th><th>Category</th><th>Text</th><th>Client</th><th>Token</th></tr></thead>
        <tbody>${tableRows || '<tr><td colspan="5" style="opacity:.5;padding:20px;text-align:center">No feedback yet</td></tr>'}</tbody>
      </table>
    </div>
  `;
}

async function renderUsers(env: Env, limit: number): Promise<string> {
  const rows = await listAndParseWithKey<EntRow>(env, 'ent:', limit);
  const tierCounts: Record<string, number> = { free: 0, pack: 0, sub: 0 };
  for (const { value } of rows) tierCounts[value.tier] = (tierCounts[value.tier] ?? 0) + 1;

  const subWindow = rows
    .filter(({ value }) => value.tier === 'sub')
    .map(({ key, value }) => ({
      token: key.replace(/^ent:/, '').slice(0, 8),
      until: value.subActiveUntil ? new Date(value.subActiveUntil).toISOString().slice(0, 16) : '?',
      analyzeUsed: value.subAnalyzeUsed ?? 0,
      chatUsed: value.subChatUsed ?? 0,
    }))
    .sort((a, b) => a.until.localeCompare(b.until))
    .map((s) => `<tr><td class="token">${esc(s.token)}</td><td class="when">${esc(s.until)}</td><td>${s.analyzeUsed} / 50</td><td>${s.chatUsed} / 30</td></tr>`)
    .join('');

  const packs = rows
    .filter(({ value }) => value.tier === 'pack')
    .map(({ key, value }) => ({
      token: key.replace(/^ent:/, '').slice(0, 8),
      bal: value.packBalance ?? 0,
    }))
    .sort((a, b) => b.bal - a.bal)
    .map((p) => `<tr><td class="token">${esc(p.token)}</td><td>${p.bal}</td></tr>`)
    .join('');

  return `
    <div class="stats">
      ${stat(rows.length, 'total accounts')}
      ${stat(tierCounts.sub ?? 0, 'Pro')}
      ${stat(tierCounts.pack ?? 0, 'Pack')}
      ${stat(tierCounts.free ?? 0, 'Free')}
    </div>
    <div class="row">
      <div class="panel"><h3>Pro subscribers (period end + usage)</h3>
        <table><thead><tr><th>Token</th><th>Until (UTC)</th><th>Analyze</th><th>Chat</th></tr></thead>
        <tbody>${subWindow || '<tr><td colspan="4" style="opacity:.5">no Pro yet</td></tr>'}</tbody></table>
      </div>
      <div class="panel"><h3>Pack balances</h3>
        <table><thead><tr><th>Token</th><th>Credits</th></tr></thead>
        <tbody>${packs || '<tr><td colspan="2" style="opacity:.5">no pack users</td></tr>'}</tbody></table>
      </div>
    </div>
  `;
}

async function renderActivity(env: Env, limit: number): Promise<string> {
  const rows = await listAndParse<LogRow>(env, 'log:', limit);

  const total = rows.length;
  const okCount = rows.filter((r) => r.status === 'ok').length;
  const latencies = rows.map((r) => r.durationMs ?? 0).filter((n) => n > 0);
  const totalIn  = rows.reduce((s, r) => s + (r.inputTokens  ?? 0), 0);
  const totalOut = rows.reduce((s, r) => s + (r.outputTokens ?? 0), 0);

  const split = (key: keyof LogRow): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const r of rows) {
      const k = (r[key] as string) ?? '?';
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };

  const tableRow = (label: string, count: number) =>
    `<tr><td>${esc(label)}</td><td>${count}</td><td>${total === 0 ? '—' : `${Math.round((count/total)*100)}%`}</td></tr>`;

  const sectionTable = (title: string, m: Record<string, number>) => `
    <div class="panel"><h3>${title}</h3>
      <table><thead><tr><th>Value</th><th>Count</th><th>Share</th></tr></thead>
      <tbody>${Object.entries(m).sort((a,b)=>b[1]-a[1]).map(([k,v])=>tableRow(k,v)).join('') || '<tr><td colspan="3" style="opacity:.5">no data</td></tr>'}</tbody></table>
    </div>`;

  const recentRows = rows
    .slice(0, 50)   // already newest-first because of reverse-ts key
    .map((r) => `<tr>
      <td class="when">${esc((r.ts ?? '').replace('T',' ').slice(0,16))}</td>
      <td>${esc(r.route ?? '')}</td>
      <td>${esc(r.tier ?? '')}</td>
      <td>${esc((r.model ?? '').replace(/^claude-/, ''))}</td>
      <td>${r.durationMs ?? 0}ms</td>
      <td>${(r.inputTokens ?? 0)}/${(r.outputTokens ?? 0)}</td>
      <td>${esc(r.status ?? '')}</td>
      <td class="token">${esc(r.tokenShort ?? '')}</td>
      <td>${esc(r.country ?? '')}</td>
    </tr>`)
    .join('');

  return `
    <div class="stats">
      ${stat(total, 'calls (30d)')}
      ${stat(`${total === 0 ? '—' : Math.round((okCount/total)*100)+'%'}`, 'success rate')}
      ${stat(`${percentile(latencies, 50)}ms`, 'P50 latency')}
      ${stat(`${percentile(latencies, 95)}ms`, 'P95 latency')}
      ${stat(totalIn.toLocaleString(), 'input tokens')}
      ${stat(totalOut.toLocaleString(), 'output tokens')}
    </div>
    <div class="row">
      ${sectionTable('By route',   split('route'))}
      ${sectionTable('By model',   split('model'))}
    </div>
    <div class="row">
      ${sectionTable('By tier',    split('tier'))}
      ${sectionTable('By country', split('country'))}
    </div>
    <div class="panel">
      <h3>Recent calls (50 latest)</h3>
      <table>
        <thead><tr><th>When</th><th>Route</th><th>Tier</th><th>Model</th><th>Duration</th><th>In/Out</th><th>Status</th><th>Token</th><th>Country</th></tr></thead>
        <tbody>${recentRows || '<tr><td colspan="9" style="opacity:.5;padding:20px;text-align:center">No calls logged yet</td></tr>'}</tbody>
      </table>
    </div>
  `;
}

async function renderCosts(env: Env): Promise<string> {
  const map = await listCostMap(env);
  const sorted = Object.entries(map).sort((a, b) => b[0].localeCompare(a[0]));
  const total = sorted.reduce((s, [, v]) => s + v, 0);

  const rows = sorted
    .map(([month, cost]) => `<tr><td class="when">${esc(month)}</td><td>$${cost.toFixed(4)}</td></tr>`)
    .join('');

  // Bar-chart with inline divs — no chart lib needed.
  const max = sorted.length === 0 ? 1 : Math.max(...sorted.map(([,v]) => v));
  const bars = sorted
    .map(([month, cost]) => `
      <div class="bar-row">
        <div class="bar-label">${esc(month)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(cost / max) * 100}%"></div></div>
        <div class="bar-value">$${cost.toFixed(2)}</div>
      </div>`)
    .join('');

  return `
    <div class="stats">
      ${stat(`$${total.toFixed(2)}`, 'total cost (all months)')}
      ${stat(sorted.length, 'months tracked')}
    </div>
    <div class="panel"><h3>Monthly cost</h3>
      <div class="bars">${bars || '<div style="opacity:.5">No cost data yet</div>'}</div>
      <table style="margin-top:14px">
        <thead><tr><th>Month</th><th>USD</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="2" style="opacity:.5">No cost data yet</td></tr>'}</tbody>
      </table>
    </div>
  `;
}

// ===========================================================================
// Insights — client-side fetch of /admin/insights, AI-rendered analysis
// ===========================================================================

function renderInsights(token: string): string {
  // We render the shell + a tiny JS fetcher. The actual analysis is
  // fetched at view time so cache control + refresh button work
  // entirely client-side. Token is templated in (this page is already
  // gated on the same token, so no new exposure).
  const t = JSON.stringify(token);
  return `
    <div id="insights-loading" class="panel" style="text-align:center;padding:48px">
      <div style="font-size:32px">🧠</div>
      <div style="margin-top:8px;font-weight:600;color:var(--title)">Analyst is reading your data…</div>
      <div style="font-size:12px;opacity:.6;margin-top:6px">First load takes ~5-8 seconds (Claude). Cached for 1 hour after.</div>
    </div>
    <div id="insights-root" style="display:none"></div>
    <div class="hint" style="margin-top:18px">
      Powered by Claude Sonnet · refreshed at most once an hour to keep token spend minimal
      · <a href="#" id="refresh-btn" style="color:var(--link);text-decoration:underline">force refresh now</a>
    </div>
    <script>
    (function() {
      const TOKEN = ${t};
      const loading = document.getElementById('insights-loading');
      const root    = document.getElementById('insights-root');
      const refresh = document.getElementById('refresh-btn');

      function severityColor(s) {
        if (s === 'high')   return '#f8d7da';
        if (s === 'medium') return '#fff3cd';
        return '#e2e3e5';
      }
      function effortBadge(e) {
        if (e === 'large')  return '<span class="badge" style="background:#f8d7da">large</span>';
        if (e === 'medium') return '<span class="badge" style="background:#fff3cd">medium</span>';
        return '<span class="badge" style="background:#d4edda">small</span>';
      }
      function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({
          '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"
        }[c]));
      }

      function render(data) {
        const healthColor = data.health.score >= 80 ? '#2e7d32'
                          : data.health.score >= 60 ? '#ed6c02'
                          : '#c62828';
        const w = data.dataWindow || {};

        const concerns = (data.concerns || []).map(c => \`
          <div class="card" style="background:\${severityColor(c.severity)}">
            <div class="card-h">
              <span class="badge" style="background:rgba(0,0,0,.08)">\${esc(c.severity)}</span>
              <strong>\${esc(c.title)}</strong>
            </div>
            <div class="card-b">\${esc(c.details)}</div>
          </div>\`).join('') || '<div style="opacity:.5">No concerns flagged.</div>';

        const recs = (data.recommendations || []).map(r => \`
          <div class="card">
            <div class="card-h">
              <span class="prio">#\${r.priority}</span>
              <strong>\${esc(r.title)}</strong>
              \${effortBadge(r.effort)}
            </div>
            <div class="card-b"><em>Why:</em> \${esc(r.rationale)}</div>
            <div class="card-b"><em>Impact:</em> \${esc(r.expectedImpact)}</div>
          </div>\`).join('') || '<div style="opacity:.5">No feature recommendations yet.</div>';

        const opts = (data.optimizations || []).map(o => \`
          <div class="card">
            <div class="card-h">
              <span class="badge" style="background:rgba(168,90,26,.15);color:var(--link)">\${esc(o.area)}</span>
              <strong>\${esc(o.suggestion)}</strong>
            </div>
            <div class="card-b"><em>Expected gain:</em> \${esc(o.expectedGain)}</div>
          </div>\`).join('') || '<div style="opacity:.5">Nothing to optimize.</div>';

        const acts = (data.actions || []).map(a => \`
          <tr>
            <td><span class="badge" style="background:rgba(0,0,0,.06)">\${esc(a.category)}</span></td>
            <td><strong>\${esc(a.action)}</strong></td>
            <td class="meta">\${esc(a.evidence)}</td>
          </tr>\`).join('') || '<tr><td colspan="3" style="opacity:.5;padding:14px;text-align:center">No actions queued.</td></tr>';

        root.innerHTML = \`
          <div class="panel" style="background:linear-gradient(135deg,#fffaf2,#fdf3e3)">
            <div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap">
              <div style="font-size:48px;font-weight:700;color:\${healthColor};font-variant-numeric:tabular-nums;line-height:1">\${data.health.score}</div>
              <div style="flex:1;min-width:200px">
                <div style="font-size:12px;opacity:.6;text-transform:uppercase;letter-spacing:.5px">Health score</div>
                <div style="font-size:15px;color:var(--title);font-weight:500;margin-top:2px">\${esc(data.health.summary)}</div>
              </div>
              <div style="font-size:11px;opacity:.6;text-align:right">
                Generated \${esc((data.generatedAt || '').slice(0,16).replace('T',' '))} UTC<br>
                Window: \${w.fbCount||0} feedback · \${w.logCount||0} calls · \${w.entCount||0} accounts
              </div>
            </div>
          </div>

          <div class="row">
            <div class="panel"><h3>⚠️ Concerns</h3>\${concerns}</div>
            <div class="panel"><h3>🚀 Feature recommendations (priority order)</h3>\${recs}</div>
          </div>

          <div class="panel"><h3>⚡ Optimizations</h3>\${opts}</div>

          <div class="panel">
            <h3>✅ Action items (this week)</h3>
            <table>
              <thead><tr><th>Type</th><th>Action</th><th>Evidence</th></tr></thead>
              <tbody>\${acts}</tbody>
            </table>
          </div>
        \`;
        loading.style.display = 'none';
        root.style.display = 'block';
      }

      function renderError(msg) {
        loading.innerHTML = '<div style="color:#c62828;font-weight:600">Failed to load insights</div>' +
                            '<div style="font-size:12px;opacity:.7;margin-top:6px">' + esc(msg) + '</div>';
      }

      function load(refreshFlag) {
        loading.style.display = 'block';
        root.style.display = 'none';
        const url = '/admin/insights?token=' + encodeURIComponent(TOKEN) +
                    (refreshFlag ? '&refresh=1' : '');
        fetch(url)
          .then(r => r.ok ? r.json() : r.text().then(t => Promise.reject(new Error(t))))
          .then(render)
          .catch(e => renderError(e.message || String(e)));
      }

      refresh.addEventListener('click', function(e) {
        e.preventDefault();
        load(true);
      });
      load(false);
    })();
    </script>
  `;
}

// ===========================================================================
// Helpers
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

async function listAndParseWithKey<T>(
  env: Env, prefix: string, limit: number,
): Promise<Array<{ key: string; value: T }>> {
  const list = await env.RATE_KV.list({ prefix, limit });
  const values = await Promise.all(list.keys.map((k) => env.RATE_KV.get(k.name)));
  const out: Array<{ key: string; value: T }> = [];
  for (let i = 0; i < list.keys.length; i++) {
    const raw = values[i];
    const meta = list.keys[i];
    if (!raw || !meta) continue;
    try { out.push({ key: meta.name, value: JSON.parse(raw) as T }); } catch { /* skip */ }
  }
  return out;
}

async function listCostMap(env: Env): Promise<Record<string, number>> {
  const list = await env.RATE_KV.list({ prefix: 'cost:', limit: 200 });
  const out: Record<string, number> = {};
  for (const k of list.keys) {
    const v = await env.RATE_KV.get(k.name);
    if (!v) continue;
    const month = k.name.replace(/^cost:/, '');
    out[month] = parseFloat(v);
  }
  return out;
}

function stat(value: string | number, label: string): string {
  return `<div class="stat"><div class="n">${esc(String(value))}</div><div class="l">${esc(label)}</div></div>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]!);
}

// ===========================================================================
// Shell + nav
// ===========================================================================

function shell(body: string, section: string, token: string): string {
  const tabs = ['overview', 'insights', 'activity', 'feedback', 'users', 'costs']
    .map((s) => {
      const active = s === section ? 'active' : '';
      const star   = s === 'insights' ? ' ✨' : '';
      return `<a class="tab ${active}" href="?token=${encodeURIComponent(token)}&section=${s}">${s}${star}</a>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KittyScan · Admin · ${esc(section)}</title>
<style>
  :root {
    --bg-top:#fddc9f; --bg-bot:#f5c382; --title:#4a2f18;
    --body:#6e4e32; --card:#fffaf2; --link:#a85a1a; --accent:#e89556;
  }
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,"SF Pro","Helvetica Neue",sans-serif;
       background:linear-gradient(180deg,var(--bg-top),var(--bg-bot));
       color:var(--body);min-height:100vh;padding:24px}
  .wrap{max-width:1200px;margin:0 auto}
  h1{color:var(--title);margin:0 0 8px;font-size:28px}
  .sub{opacity:.7;font-size:13px;margin-bottom:18px}
  .tabs{display:flex;gap:6px;margin-bottom:20px;flex-wrap:wrap}
  .tab{padding:8px 16px;border-radius:14px;background:var(--card);
       color:var(--link);text-decoration:none;font-size:13px;text-transform:capitalize}
  .tab.active{background:var(--link);color:white}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));
         gap:12px;margin-bottom:20px}
  .stat{background:var(--card);border-radius:14px;padding:14px 16px;
        box-shadow:0 2px 8px rgba(74,47,24,.06)}
  .stat .n{font-size:22px;font-weight:700;color:var(--title)}
  .stat .l{font-size:11px;opacity:.7;margin-top:4px}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:20px}
  @media(max-width:760px){.row{grid-template-columns:1fr}}
  .panel{background:var(--card);border-radius:14px;padding:16px;
         box-shadow:0 2px 8px rgba(74,47,24,.06);margin-bottom:14px}
  .panel h3{margin:0 0 10px;font-size:14px;color:var(--title)}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:7px 10px;border-bottom:1px solid rgba(74,47,24,.08);vertical-align:top}
  th{font-size:10px;text-transform:uppercase;letter-spacing:.5px;opacity:.6}
  .cat{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;color:#3a2516}
  .when{white-space:nowrap;font-variant-numeric:tabular-nums;opacity:.75}
  .text{max-width:380px;word-break:break-word}
  .meta{font-size:11px;opacity:.65;white-space:nowrap}
  .token{font-family:'SF Mono',monospace;font-size:11px;opacity:.5}
  .filters{margin-bottom:14px}
  .filter{display:inline-block;padding:5px 11px;margin-right:6px;border-radius:13px;
          background:var(--card);color:var(--link);text-decoration:none;font-size:12px}
  .filter.active{background:var(--link);color:white}
  .hint{opacity:.6;font-size:12px;margin-top:8px;text-align:center}
  .bars{margin-top:6px}
  .bar-row{display:grid;grid-template-columns:80px 1fr 80px;align-items:center;gap:10px;margin:4px 0}
  .bar-label{font-size:11px;opacity:.7;font-variant-numeric:tabular-nums}
  .bar-track{height:14px;background:rgba(74,47,24,.08);border-radius:7px;overflow:hidden}
  .bar-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--link));border-radius:7px}
  .bar-value{font-size:12px;font-weight:600;text-align:right;font-variant-numeric:tabular-nums;color:var(--title)}
  .card{background:rgba(0,0,0,.02);border-radius:10px;padding:12px 14px;margin-bottom:10px}
  .card-h{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--title);margin-bottom:4px}
  .card-h strong{flex:1}
  .card-b{font-size:12px;color:var(--body);margin-top:4px;line-height:1.5}
  .card-b em{font-style:normal;font-weight:600;opacity:.7}
  .badge{display:inline-block;padding:2px 8px;border-radius:9px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.3px}
  .prio{background:var(--link);color:white;padding:2px 8px;border-radius:9px;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums}
</style>
</head>
<body>
<div class="wrap">
  <h1>🐾 KittyScan · Admin</h1>
  <div class="sub">Live data from Cloudflare KV. Refresh to update.</div>
  <div class="tabs">${tabs}</div>
  ${body}
</div>
</body>
</html>`;
}
