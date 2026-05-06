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
  const t = JSON.stringify(token);
  return `
    <div id="insights-controls" class="panel" style="display:flex;align-items:center;gap:14px;padding:10px 14px;flex-wrap:wrap">
      <strong style="color:var(--title);font-size:14px">🧠 AI 分析师 · AI Analyst</strong>
      <div style="flex:1"></div>
      <div class="lang-toggle">
        <button id="btn-zh" class="lang-btn active">中文</button>
        <button id="btn-en" class="lang-btn">EN</button>
      </div>
      <a href="#" id="refresh-btn" style="font-size:12px;color:var(--link)">↻</a>
    </div>
    <div id="insights-loading" class="panel" style="text-align:center;padding:48px">
      <div style="font-size:32px">🧠</div>
      <div style="margin-top:8px;font-weight:600;color:var(--title);"><span class="zh-only">AI 在读你的数据…</span><span class="en-only">AI reading your data…</span></div>
      <div style="font-size:12px;opacity:.6;margin-top:6px"><span class="zh-only">首次 ~10-15 秒 · 缓存 1 小时</span><span class="en-only">~10-15s first time · cached 1 hour</span></div>
    </div>
    <div id="insights-root" style="display:none"></div>
    <script>
    (function() {
      const TOKEN = ${t};
      const loading = document.getElementById('insights-loading');
      const root    = document.getElementById('insights-root');
      const refresh = document.getElementById('refresh-btn');
      const btnZh = document.getElementById('btn-zh');
      const btnEn = document.getElementById('btn-en');

      let currentLang = localStorage.getItem('insights-lang') || 'zh';
      function applyLang(l) {
        currentLang = l;
        localStorage.setItem('insights-lang', l);
        document.body.classList.toggle('lang-zh', l === 'zh');
        document.body.classList.toggle('lang-en', l === 'en');
        btnZh.classList.toggle('active', l === 'zh');
        btnEn.classList.toggle('active', l === 'en');
      }
      btnZh.addEventListener('click', function() { applyLang('zh'); });
      btnEn.addEventListener('click', function() { applyLang('en'); });
      applyLang(currentLang);

      function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, c => ({
          '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"
        }[c]));
      }
      function bi(zh, en) {
        return '<span class="zh-only">'+esc(zh)+'</span><span class="en-only">'+esc(en)+'</span>';
      }
      function trendIcon(t) { return t === 'up' ? '📈' : t === 'down' ? '📉' : '→'; }
      function trendColor(t) { return t === 'up' ? '#2e7d32' : t === 'down' ? '#c62828' : '#6e4e32'; }
      function priorityColor(p) {
        return p === 'P0' ? '#c62828' :
               p === 'P1' ? '#ed6c02' :
               p === 'P2' ? '#1976d2' : '#6e6e6e';
      }

      function renderTLDR(s) {
        if (!s) return '';
        const numCards = (s.key_numbers || []).map(n =>
          '<div class="kpi">' +
            '<div class="kpi-label">'+bi(n.label_zh, n.label_en)+'</div>' +
            '<div class="kpi-value">'+esc(n.value)+'</div>' +
            '<div class="kpi-delta">'+bi(n.delta_zh, n.delta_en)+'</div>' +
          '</div>'
        ).join('');
        return '<div class="panel hero">' +
          '<div class="hero-tag">'+bi('📰 今日总结', '📰 Today')+'</div>' +
          '<div class="hero-headline">'+bi(s.headline_zh, s.headline_en)+'</div>' +
          (numCards ? '<div class="kpi-grid">'+numCards+'</div>' : '') +
          '<div class="hero-action">' +
            '<span class="hero-action-label">' + bi('🎯 今天就做这一件事', '🎯 The one thing today') + '</span>' +
            '<div class="hero-action-text">' + bi(s.one_thing_today_zh, s.one_thing_today_en) + '</div>' +
          '</div>' +
        '</div>';
      }

      function renderROI(r) {
        if (!r) return '';
        return '<div class="panel"><h3>⭐ ' + bi('北极星指标 · ROI', 'North Star · ROI') + '</h3>' +
          '<div class="roi-row">' +
            '<div class="roi-big" style="color:'+trendColor(r.trend)+'">'+esc(r.current_value)+' '+trendIcon(r.trend)+'</div>' +
            '<div class="roi-text">' +
              '<div class="roi-label">' + bi('收入 ÷ 成本', 'Revenue ÷ cost') + '</div>' +
              '<div class="roi-diag">' + bi(r.diagnosis_zh, r.diagnosis_en) + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="roi-drag">' +
            '<em>' + bi('🪨 最大拖累:', '🪨 Biggest drag:') + '</em> ' +
            bi(r.biggest_drag_zh, r.biggest_drag_en) +
          '</div>' +
        '</div>';
      }

      function renderFunnel(f) {
        if (!f || !f.stages) return '';
        const max = Math.max(1, ...(f.stages.map(s => s.count || 0)));
        const rows = f.stages.map((s, i) => {
          const pct = i === 0 ? 100 : (s.conversion_pct || 0);
          const widthPct = ((s.count || 0) / max) * 100;
          const dropoff = i > 0 && pct < 50 ? '<span class="drop">↓ '+(100-pct)+'% '+bi('流失','drop')+'</span>' : '';
          return '<div class="funnel-row">' +
            '<div class="funnel-label">' + bi(s.name_zh, s.name_en) + '</div>' +
            '<div class="funnel-bar"><div class="funnel-fill" style="width:'+widthPct+'%"></div></div>' +
            '<div class="funnel-count">'+esc(s.count)+'</div>' +
            '<div class="funnel-pct">'+ (i === 0 ? '—' : pct + '%') +'</div>' +
            dropoff +
          '</div>';
        }).join('');
        return '<div class="panel"><h3>📊 ' + bi('转化漏斗', 'Conversion funnel') + '</h3>' +
          '<div class="funnel">'+rows+'</div>' +
          '<div class="funnel-summary">' +
            '<div><em>' + bi('🚨 最大流失:', '🚨 Biggest drop-off:') + '</em> ' + bi(f.biggest_drop_off_zh, f.biggest_drop_off_en) + '</div>' +
            '<div><em>' + bi('🔧 怎么修:', '🔧 How to fix:') + '</em> ' + bi(f.fix_zh, f.fix_en) + '</div>' +
          '</div>' +
        '</div>';
      }

      function renderPlaybook(plays) {
        if (!plays || plays.length === 0) return '';
        const items = plays.map((p, idx) =>
          '<div class="play">' +
            '<div class="play-header">' +
              '<span class="play-num">' + (idx+1) + '</span>' +
              '<strong>' + bi(p.tactic_zh, p.tactic_en) + '</strong>' +
            '</div>' +
            '<div class="play-why">' +
              '<em>' + bi('为什么:', 'Why:') + '</em> ' + bi(p.why_zh, p.why_en) +
            '</div>' +
            '<div class="play-how">' +
              '<em>' + bi('怎么做:', 'How:') + '</em>' +
              '<ol>' +
                (p.how_zh || []).map((step, i) =>
                  '<li class="zh-only">' + esc(step) + '</li>' +
                  '<li class="en-only">' + esc((p.how_en || [])[i] || '') + '</li>'
                ).join('') +
              '</ol>' +
            '</div>' +
            '<div class="play-expect">' +
              '<em>' + bi('💡 预期结果:', '💡 Expected:') + '</em> ' + bi(p.expected_zh, p.expected_en) +
            '</div>' +
          '</div>'
        ).join('');
        return '<div class="panel"><h3>📘 ' + bi('提升续费 / 转化的剧本', 'Conversion / renewal playbook') + '</h3>' +
          items + '</div>';
      }

      function renderRoadmap(items) {
        if (!items || items.length === 0) return '';
        const groups = { P0: [], P1: [], P2: [], P3: [] };
        for (const it of items) (groups[it.priority] || groups.P3).push(it);
        const renderGroup = (label_zh, label_en, p, list) => {
          if (list.length === 0) return '';
          const cardsHtml = list.map(it =>
            '<div class="rm-card">' +
              '<div class="rm-head">' +
                '<span class="prio-tag" style="background:'+priorityColor(p)+'">'+p+'</span>' +
                '<strong class="rm-title">' + bi(it.title_zh, it.title_en) + '</strong>' +
                '<span class="rm-when">' + bi(it.timeline_zh, it.timeline_en) + '</span>' +
              '</div>' +
              '<div class="rm-row"><em>' + bi('📊 为什么:', '📊 Why:') + '</em> ' + bi(it.why_zh, it.why_en) + '</div>' +
              '<div class="rm-row"><em>' + bi('🎯 是什么:', '🎯 What:') + '</em> ' + bi(it.what_zh, it.what_en) + '</div>' +
              '<div class="rm-row"><em>' + bi('🛠 怎么做:', '🛠 How:') + '</em>' +
                '<ol>' +
                  (it.how_steps_zh || []).map((step, i) =>
                    '<li class="zh-only">' + esc(step) + '</li>' +
                    '<li class="en-only">' + esc((it.how_steps_en || [])[i] || '') + '</li>'
                  ).join('') +
                '</ol>' +
              '</div>' +
              '<div class="rm-row"><em>' + bi('📈 预期影响:', '📈 Expected impact:') + '</em> ' + bi(it.expected_impact_zh, it.expected_impact_en) + '</div>' +
            '</div>'
          ).join('');
          return '<div class="rm-group">' +
            '<h4 class="rm-group-title" style="color:'+priorityColor(p)+'">' + bi(label_zh, label_en) + '</h4>' +
            cardsHtml +
          '</div>';
        };
        return '<div class="panel"><h3>🗺 ' + bi('Feature 路线图', 'Feature roadmap') + '</h3>' +
          renderGroup('🔥 P0 — 本周必做(阻塞 ROI)', '🔥 P0 — must ship this week (ROI-blocking)', 'P0', groups.P0) +
          renderGroup('⚡ P1 — 本月做 (新 ROI 杠杆)',  '⚡ P1 — this month (new ROI lever)',         'P1', groups.P1) +
          renderGroup('🧹 P2 — 本季度做 (产品卫生)',   '🧹 P2 — this quarter (hygiene)',             'P2', groups.P2) +
          renderGroup('📋 P3 — Backlog',               '📋 P3 — Backlog',                            'P3', groups.P3) +
        '</div>';
      }

      function render(data) {
        root.innerHTML =
          renderTLDR(data.daily_summary) +
          renderROI(data.north_star_roi) +
          renderFunnel(data.funnel) +
          renderPlaybook(data.conversion_playbook) +
          renderRoadmap(data.feature_roadmap);
        loading.style.display = 'none';
        root.style.display = 'block';
      }

      function renderError(msg) {
        loading.innerHTML = '<div style="color:#c62828;font-weight:600">' +
                            bi('加载失败', 'Failed to load') + '</div>' +
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
  /* Bilingual toggle — body class flips which spans show. */
  body.lang-zh .en-only,
  body.lang-en .zh-only { display: none; }
  .lang-toggle{display:inline-flex;background:rgba(0,0,0,.04);border-radius:10px;padding:3px;gap:2px}
  .lang-btn{border:0;background:transparent;color:var(--body);font-size:12px;font-weight:600;
    padding:5px 12px;border-radius:8px;cursor:pointer}
  .lang-btn.active{background:var(--link);color:white}
  /* Compact AI insight cards */
  .ai-card{background:rgba(0,0,0,.02);border-radius:11px;padding:11px 13px;margin-bottom:9px}
  .ai-card.act{background:rgba(168,90,26,.05)}
  .ai-card-row{display:flex;align-items:center;gap:8px;margin-bottom:5px}
  .ai-icon{font-size:16px;line-height:1}
  .ai-title{flex:1;font-size:13.5px;color:var(--title);font-weight:600;line-height:1.35}
  .ai-detail{font-size:12.5px;color:var(--body);line-height:1.5;margin-top:2px}
  .ai-meta{font-size:11.5px;color:var(--body);opacity:.85;margin-top:5px;line-height:1.4}
  .ai-meta em{font-style:normal;font-weight:600;opacity:.65;margin-right:3px}
  .effort{font-size:10px;padding:1px 7px}
  .empty{opacity:.5;font-size:13px;padding:6px 0}
  /* Health hero */
  .health-card{background:linear-gradient(135deg,#fffaf2,#fdf3e3)}
  .health-row{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
  .health-score{font-size:54px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1}
  .health-text{flex:1;min-width:200px}
  .health-label{font-size:11px;opacity:.55;text-transform:uppercase;letter-spacing:.6px}
  .health-summary{font-size:14px;color:var(--title);font-weight:500;margin-top:3px;line-height:1.5}
  .health-meta{font-size:11px;opacity:.6;text-align:right;line-height:1.6}
  /* Hero TL;DR */
  .hero{background:linear-gradient(135deg,#fffaf2,#fff3df)}
  .hero-tag{font-size:11px;text-transform:uppercase;letter-spacing:.6px;opacity:.6;color:var(--title);margin-bottom:6px}
  .hero-headline{font-size:18px;font-weight:600;color:var(--title);line-height:1.4;margin-bottom:14px}
  .kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:14px}
  .kpi{background:rgba(255,255,255,.6);border-radius:10px;padding:10px 12px;text-align:center}
  .kpi-label{font-size:10px;opacity:.6;text-transform:uppercase;letter-spacing:.4px}
  .kpi-value{font-size:22px;font-weight:700;color:var(--title);font-variant-numeric:tabular-nums;line-height:1.1;margin:3px 0}
  .kpi-delta{font-size:11px;opacity:.7}
  .hero-action{background:rgba(168,90,26,.12);border-radius:11px;padding:12px 14px;border-left:3px solid var(--link)}
  .hero-action-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--link)}
  .hero-action-text{font-size:14px;color:var(--title);font-weight:500;margin-top:4px;line-height:1.5}
  /* ROI block */
  .roi-row{display:flex;align-items:center;gap:18px;padding:8px 0}
  .roi-big{font-size:36px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1}
  .roi-text{flex:1}
  .roi-label{font-size:11px;opacity:.55;text-transform:uppercase;letter-spacing:.5px}
  .roi-diag{font-size:13px;color:var(--title);margin-top:3px;line-height:1.5}
  .roi-drag{margin-top:8px;font-size:12.5px;color:var(--body);background:rgba(0,0,0,.03);padding:8px 11px;border-radius:8px}
  .roi-drag em{font-style:normal;font-weight:600;opacity:.7}
  /* Funnel */
  .funnel{margin:6px 0}
  .funnel-row{display:grid;grid-template-columns:120px 1fr 50px 50px auto;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid rgba(74,47,24,.05)}
  .funnel-label{font-size:13px;color:var(--title);font-weight:500}
  .funnel-bar{height:18px;background:rgba(74,47,24,.06);border-radius:9px;overflow:hidden}
  .funnel-fill{height:100%;background:linear-gradient(90deg,#e89556,var(--link));border-radius:9px}
  .funnel-count{font-size:13px;font-weight:600;color:var(--title);font-variant-numeric:tabular-nums;text-align:right}
  .funnel-pct{font-size:11px;opacity:.7;text-align:right;font-variant-numeric:tabular-nums}
  .drop{font-size:10px;background:#ffe5e5;color:#c62828;padding:2px 7px;border-radius:9px;font-weight:600}
  .funnel-summary{display:flex;flex-direction:column;gap:6px;margin-top:12px;font-size:12.5px;color:var(--body)}
  .funnel-summary em{font-style:normal;font-weight:600;opacity:.7}
  /* Playbook */
  .play{background:rgba(168,90,26,.04);border-left:3px solid var(--accent);border-radius:8px;padding:12px 14px;margin-bottom:10px}
  .play-header{display:flex;align-items:center;gap:10px;margin-bottom:8px}
  .play-num{background:var(--accent);color:white;width:24px;height:24px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0}
  .play-header strong{font-size:14.5px;color:var(--title)}
  .play-why,.play-expect{font-size:12.5px;color:var(--body);margin:6px 0;line-height:1.5}
  .play-why em,.play-expect em,.play-how em{font-style:normal;font-weight:600;opacity:.7;margin-right:4px}
  .play-how{font-size:12.5px;color:var(--body);margin:6px 0}
  .play-how ol{margin:6px 0 0 0;padding-left:24px;line-height:1.6}
  .play-how li{margin:2px 0}
  /* Roadmap */
  .rm-group{margin-bottom:18px}
  .rm-group-title{font-size:13px;font-weight:700;margin:0 0 10px;text-transform:uppercase;letter-spacing:.5px}
  .rm-card{background:rgba(0,0,0,.02);border-radius:10px;padding:12px 14px;margin-bottom:10px}
  .rm-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
  .prio-tag{color:white;font-size:11px;font-weight:700;padding:3px 8px;border-radius:8px}
  .rm-title{flex:1;font-size:14px;color:var(--title)}
  .rm-when{font-size:11px;opacity:.6;background:rgba(0,0,0,.05);padding:2px 8px;border-radius:8px}
  .rm-row{font-size:12.5px;color:var(--body);margin:5px 0;line-height:1.5}
  .rm-row em{font-style:normal;font-weight:600;opacity:.7;margin-right:4px}
  .rm-row ol{margin:4px 0 0 0;padding-left:24px;line-height:1.55}
  .rm-row li{margin:1px 0}
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
