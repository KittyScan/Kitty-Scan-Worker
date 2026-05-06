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

  // PWA manifest — served inline from the same Worker so installing to
  // home screen on iOS gets a proper standalone-app launch with our icon
  // and color. Token is required to fetch the manifest itself so a random
  // crawler can't enumerate the dashboard.
  if (url.pathname === '/admin/manifest.json') {
    const manifest = {
      name: 'KittyScan Admin',
      short_name: 'KittyScan',
      description: 'Internal analytics dashboard',
      start_url: `/admin?token=${encodeURIComponent(token)}`,
      scope: '/admin',
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#fddc9f',
      theme_color: '#fddc9f',
      icons: [
        {
          src: 'data:image/svg+xml;utf8,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
            '<rect width="512" height="512" rx="100" fill="#fddc9f"/>' +
            '<text x="50%" y="56%" font-size="320" text-anchor="middle" dominant-baseline="middle">🐾</text>' +
            '</svg>'),
          sizes: '512x512',
          type: 'image/svg+xml',
          purpose: 'any maskable',
        },
      ],
    };
    return new Response(JSON.stringify(manifest), {
      status: 200,
      headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' },
    });
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

  // Group KPIs by category so the eye can scan them: who / money /
  // performance / voice. Bilingual labels on every stat.
  const bugCount = fbRows.filter((r) => r.category === 'bug').length;
  return `
    <h3 class="section-title">👥 ${bi('用户', 'Users')}</h3>
    <div class="stats">
      ${biStat(entRows.length,           '总账号',     'total accounts')}
      ${biStat(tierCounts.sub ?? 0,      'Pro 订阅',   'Pro subscribers')}
      ${biStat(tierCounts.pack ?? 0,     'Pack 用户',  'pack users')}
      ${biStat(tierCounts.free ?? 0,     '免费用户',   'free users')}
    </div>
    <h3 class="section-title">💰 ${bi('收入与成本', 'Revenue & cost')}</h3>
    <div class="stats">
      ${biStat(`$${costMtd.toFixed(2)}`, `本月成本 (${monthKey})`, `cost MTD (${monthKey})`)}
      ${biStat(total,                    '30 天调用数', 'analyses (30d log)')}
    </div>
    <h3 class="section-title">⚡ ${bi('性能', 'Performance')}</h3>
    <div class="stats">
      ${biStat(okRate,                              '成功率',    'success rate')}
      ${biStat(`${percentile(latencies, 50)}ms`,    'P50 延迟',  'P50 latency')}
      ${biStat(`${percentile(latencies, 95)}ms`,    'P95 延迟',  'P95 latency')}
    </div>
    <h3 class="section-title">💬 ${bi('用户声音', 'User voice')}</h3>
    <div class="stats">
      ${biStat(csat,            'CSAT (👍/总)',     'CSAT (👍 / total)')}
      ${biStat(ratings.length,  '评分总数',         'ratings collected')}
      ${biStat(bugCount,        '反馈 / Bug 数',    'bug reports')}
    </div>
    <div class="hint">${bi(
      '所有数字基于 Cloudflare KV 实时数据 · 调用数据 30 天滚动 · 切换上方 tab 查看深度数据',
      'Live from Cloudflare KV · 30-day rolling activity window · use tabs above for detail',
    )}</div>
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

  // Card layout instead of a table — mobile horizontal-scroll on a 5-col
  // table was a UX disaster. Each entry is now a self-contained card with
  // the actual feedback text prominent, metadata as small secondary line.
  const feedbackCards = filtered
    .slice()
    .sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''))
    .map((r) => {
      const when = (r.receivedAt ?? '').replace('T', ' ').slice(0, 16);
      const cat = r.category ?? '';
      const isThumbsUp   = cat === 'rating' && (r.text ?? '').startsWith('👍');
      const isThumbsDown = cat === 'rating' && (r.text ?? '').startsWith('👎');
      const accent = isThumbsUp   ? '#2e7d32'
                  : isThumbsDown ? '#c62828'
                  : cat === 'bug' ? '#ed6c02'
                  : cat === 'feature' ? '#1976d2'
                  : '#9e9e9e';
      const meta = [r.appVersion, r.iosVersion, r.language, r.country].filter(Boolean).join(' · ');
      return `<div class="fb-card" style="border-left-color:${accent}">
        <div class="fb-card-head">
          <span class="fb-cat" style="background:${accent}20;color:${accent}">${esc(cat)}</span>
          <span class="fb-when">${esc(when)} UTC</span>
        </div>
        <div class="fb-text">${esc(r.text ?? '')}</div>
        <div class="fb-meta">${esc(meta || '—')}</div>
      </div>`;
    })
    .join('');

  return `
    <h3 class="section-title">💬 ${bi('用户声音', 'User voice')}</h3>
    <div class="stats">
      ${biStat(rows.length,        '总反馈',   'total feedback')}
      ${biStat(ratingRows.length,  '评分总数', 'ratings')}
      ${biStat(up,                 '👍 有用',  '👍 helpful')}
      ${biStat(down,               '👎 不准',  '👎 off')}
    </div>
    <div class="row">
      <div class="panel"><h3>👎 ${bi('差评原因', 'Reasons')}</h3>
        <table><thead><tr><th>${bi('原因', 'Reason')}</th><th class="num">${bi('数', 'Count')}</th></tr></thead>
        <tbody>${reasonRows || `<tr><td colspan="2" style="opacity:.5">${bi('暂无 👎', 'no 👎 yet')}</td></tr>`}</tbody></table>
      </div>
      <div class="panel"><h3>${bi('按类别', 'By category')}</h3>
        <table><thead><tr><th>${bi('类别', 'Category')}</th><th class="num">${bi('数', 'Count')}</th></tr></thead>
        <tbody>${Object.entries(categoryCounts).sort((a,b) => b[1]-a[1]).map(([k,v]) => `<tr><td>${esc(k)}</td><td class="num">${v}</td></tr>`).join('') || `<tr><td colspan="2" style="opacity:.5">${bi('暂无数据', 'no data')}</td></tr>`}</tbody></table>
      </div>
    </div>
    <div class="filters">${filters}</div>
    <div class="panel">
      <h3>${bi('反馈明细', 'Feedback entries')}</h3>
      <div class="fb-list">${feedbackCards || `<div style="opacity:.5;padding:20px;text-align:center">${bi('暂无反馈', 'No feedback yet')}</div>`}</div>
    </div>
  `;
}

async function renderUsers(env: Env, limit: number): Promise<string> {
  const rows = await listAndParseWithKey<EntRow>(env, 'ent:', limit);
  const tierCounts: Record<string, number> = { free: 0, pack: 0, sub: 0 };
  for (const { value } of rows) tierCounts[value.tier] = (tierCounts[value.tier] ?? 0) + 1;

  const total = rows.length || 1;
  // Funnel: free → pack → sub. Each row's bar width is its share of total.
  const funnelRow = (zh: string, en: string, count: number, color: string) => {
    const pct = (count / total) * 100;
    return `<div class="funnel-row">
      <div class="funnel-label">${bi(zh, en)}</div>
      <div class="funnel-bar"><div class="funnel-fill" style="width:${pct}%;background:${color}"></div></div>
      <div class="funnel-count">${count}</div>
      <div class="funnel-pct">${total === 0 ? '—' : Math.round(pct) + '%'}</div>
      <div></div>
    </div>`;
  };

  const subRows = rows
    .filter(({ value }) => value.tier === 'sub')
    .map(({ key, value }) => ({
      token: key.replace(/^ent:/, '').slice(0, 8),
      until: value.subActiveUntil ? new Date(value.subActiveUntil).toISOString().slice(0, 10) : '?',
      analyzeUsed: value.subAnalyzeUsed ?? 0,
      chatUsed: value.subChatUsed ?? 0,
      analyzePct: ((value.subAnalyzeUsed ?? 0) / 50) * 100,
    }))
    .sort((a, b) => b.analyzePct - a.analyzePct)
    .map((s) => {
      const color = s.analyzePct >= 80 ? '#c62828' : s.analyzePct >= 50 ? '#ed6c02' : '#2e7d32';
      const risk = s.analyzePct >= 80 ? `<span class="risk-tag">⚠️ ${bi('快用完', 'near limit')}</span>` : '';
      return `<tr>
        <td class="token">${esc(s.token)}</td>
        <td class="when">${esc(s.until)}</td>
        <td><strong style="color:${color}">${s.analyzeUsed}</strong> / 50</td>
        <td>${s.chatUsed} / 30</td>
        <td>${risk}</td>
      </tr>`;
    })
    .join('');

  const packs = rows
    .filter(({ value }) => value.tier === 'pack')
    .map(({ key, value }) => ({
      token: key.replace(/^ent:/, '').slice(0, 8),
      bal: value.packBalance ?? 0,
    }))
    .sort((a, b) => b.bal - a.bal)
    .map((p) => {
      const color = p.bal === 0 ? '#c62828' : p.bal <= 5 ? '#ed6c02' : '#2e7d32';
      return `<tr>
        <td class="token">${esc(p.token)}</td>
        <td><strong style="color:${color}">${p.bal}</strong> ${bi('次', 'left')}</td>
      </tr>`;
    })
    .join('');

  return `
    <h3 class="section-title">📊 ${bi('用户分布', 'Distribution')}</h3>
    <div class="panel">
      <div class="funnel">
        ${funnelRow('🆓 免费', '🆓 Free', tierCounts.free ?? 0, '#9e9e9e')}
        ${funnelRow('📦 Pack', '📦 Pack', tierCounts.pack ?? 0, '#e89556')}
        ${funnelRow('👑 Pro 订阅', '👑 Pro', tierCounts.sub ?? 0, 'var(--link)')}
      </div>
      <div class="hint" style="margin-top:10px">${bi(
        `共 ${rows.length} 个账号 · 付费率 ${total === 0 ? '—' : Math.round(((tierCounts.pack ?? 0) + (tierCounts.sub ?? 0)) / total * 100) + '%'}`,
        `${rows.length} accounts total · pay rate ${total === 0 ? '—' : Math.round(((tierCounts.pack ?? 0) + (tierCounts.sub ?? 0)) / total * 100) + '%'}`,
      )}</div>
    </div>

    <div class="row">
      <div class="panel"><h3>👑 ${bi('Pro 订阅用户 (按本月使用量排序)', 'Pro subscribers (sorted by month usage)')}</h3>
        <table>
          <thead><tr>
            <th>${bi('Token', 'Token')}</th>
            <th>${bi('到期', 'Until')}</th>
            <th>${bi('本月分析', 'Analyses')}</th>
            <th>${bi('本月 Chat', 'Chats')}</th>
            <th></th>
          </tr></thead>
          <tbody>${subRows || `<tr><td colspan="5" style="opacity:.5">${bi('还没有 Pro 用户', 'no Pro users yet')}</td></tr>`}</tbody>
        </table>
      </div>
      <div class="panel"><h3>📦 ${bi('Pack 余额', 'Pack balances')}</h3>
        <table>
          <thead><tr><th>${bi('Token', 'Token')}</th><th>${bi('剩余', 'Balance')}</th></tr></thead>
          <tbody>${packs || `<tr><td colspan="2" style="opacity:.5">${bi('还没有 pack 用户', 'no pack users')}</td></tr>`}</tbody>
        </table>
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

  const tableRow = (label: string, count: number) => {
    const pct = total === 0 ? 0 : (count/total) * 100;
    return `<tr>
      <td>${esc(label)}</td>
      <td><div class="mini-bar"><div class="mini-bar-fill" style="width:${pct}%"></div></div></td>
      <td class="num">${count}</td>
      <td class="num">${total === 0 ? '—' : Math.round(pct)+'%'}</td>
    </tr>`;
  };

  const sectionTable = (titleZh: string, titleEn: string, m: Record<string, number>) => `
    <div class="panel"><h3>${bi(titleZh, titleEn)}</h3>
      <table><thead><tr><th>${bi('值', 'Value')}</th><th></th><th class="num">${bi('数', '#')}</th><th class="num">${bi('占比', 'Share')}</th></tr></thead>
      <tbody>${Object.entries(m).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,v])=>tableRow(k,v)).join('') || `<tr><td colspan="4" style="opacity:.5">${bi('暂无数据', 'no data')}</td></tr>`}</tbody></table>
    </div>`;

  const recentRows = rows
    .slice(0, 30)
    .map((r) => {
      const dur = r.durationMs ?? 0;
      const durColor = dur > 5000 ? '#c62828' : dur > 2000 ? '#ed6c02' : '#2e7d32';
      const statusOk = (r.status ?? '') === 'ok';
      return `<tr>
        <td class="when">${esc((r.ts ?? '').replace('T',' ').slice(5,16))}</td>
        <td><span class="route-badge">${esc(r.route ?? '')}</span></td>
        <td>${esc(r.tier ?? '')}</td>
        <td class="model-cell">${esc((r.model ?? '').replace(/^claude-/, '').replace(/-\d{8}$/, ''))}</td>
        <td class="num" style="color:${durColor};font-weight:600">${dur}ms</td>
        <td class="num">${(r.inputTokens ?? 0)}/${(r.outputTokens ?? 0)}</td>
        <td>${statusOk ? '✅' : '❌ ' + esc(r.status ?? '')}</td>
        <td>${esc(r.country ?? '')}</td>
      </tr>`;
    })
    .join('');

  return `
    <h3 class="section-title">📊 ${bi('30 天概览', '30-day overview')}</h3>
    <div class="stats">
      ${biStat(total,                                     '总调用',   'total calls')}
      ${biStat(`${total === 0 ? '—' : Math.round((okCount/total)*100)+'%'}`, '成功率', 'success rate')}
      ${biStat(`${percentile(latencies, 50)}ms`,          'P50 延迟', 'P50 latency')}
      ${biStat(`${percentile(latencies, 95)}ms`,          'P95 延迟', 'P95 latency')}
      ${biStat(totalIn.toLocaleString(),                  '输入 token', 'input tokens')}
      ${biStat(totalOut.toLocaleString(),                 '输出 token', 'output tokens')}
    </div>
    <div class="row">
      ${sectionTable('按路径', 'By route',   split('route'))}
      ${sectionTable('按模型', 'By model',   split('model'))}
    </div>
    <div class="row">
      ${sectionTable('按用户层级', 'By tier',    split('tier'))}
      ${sectionTable('按国家', 'By country', split('country'))}
    </div>
    <div class="panel">
      <h3>${bi('最近 30 次调用', '30 most recent calls')}</h3>
      <table>
        <thead><tr><th>${bi('时间', 'When')}</th><th>${bi('路径', 'Route')}</th><th>${bi('层级', 'Tier')}</th><th>${bi('模型', 'Model')}</th><th class="num">${bi('耗时', 'Time')}</th><th class="num">In/Out</th><th>${bi('状态', 'Status')}</th><th>${bi('国家', 'Country')}</th></tr></thead>
        <tbody>${recentRows || `<tr><td colspan="8" style="opacity:.5;padding:20px;text-align:center">${bi('暂无调用记录', 'No calls logged yet')}</td></tr>`}</tbody>
      </table>
    </div>
  `;
}

async function renderCosts(env: Env): Promise<string> {
  const [costMap, logs, ents] = await Promise.all([
    listCostMap(env),
    listAndParse<LogRow>(env, 'log:', 1000),
    listAndParse<EntRow>(env, 'ent:', 1000),
  ]);

  const sorted = Object.entries(costMap).sort((a, b) => b[0].localeCompare(a[0]));
  const total = sorted.reduce((s, [, v]) => s + v, 0);
  const monthKey = new Date().toISOString().slice(0, 7);
  const mtd = costMap[monthKey] ?? 0;

  // Cost-per-user calc using count of paid accounts. Indicative only —
  // we don't track per-call attribution to a specific user yet.
  const paidUsers = ents.filter((e) => e.tier === 'pack' || e.tier === 'sub').length;
  const costPerPaidUser = paidUsers === 0 ? 0 : mtd / paidUsers;

  // Estimate forecast: linear projection from current MTD to end-of-month.
  const now = new Date();
  const dom = now.getUTCDate();
  const totalDaysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
  const forecast = dom === 0 ? 0 : (mtd / dom) * totalDaysInMonth;

  // Per-route + per-model split (approximate — log entries don't carry
  // per-call cost; we count calls and assume tokens roughly proportional).
  const splitCount = (field: keyof LogRow): Record<string, number> => {
    const m: Record<string, number> = {};
    for (const l of logs) {
      const k = (l[field] as string | undefined) ?? '?';
      m[k] = (m[k] ?? 0) + 1;
    }
    return m;
  };
  const byRoute = splitCount('route');
  const byModel = splitCount('model');
  const totalCalls = logs.length || 1;

  const breakdownRow = (label: string, count: number) => {
    const share = (count / totalCalls) * 100;
    const estCost = mtd * (count / totalCalls);
    return `<tr>
      <td>${esc(label)}</td>
      <td><div class="mini-bar"><div class="mini-bar-fill" style="width:${share}%"></div></div></td>
      <td class="num">${count}</td>
      <td class="num">$${estCost.toFixed(3)}</td>
    </tr>`;
  };

  const max = sorted.length === 0 ? 1 : Math.max(...sorted.map(([, v]) => v));
  const bars = sorted
    .map(([month, cost]) => `
      <div class="bar-row">
        <div class="bar-label">${esc(month)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(cost / max) * 100}%"></div></div>
        <div class="bar-value">$${cost.toFixed(2)}</div>
      </div>`)
    .join('');

  return `
    <h3 class="section-title">💰 ${bi('成本概况', 'Cost overview')}</h3>
    <div class="stats">
      ${biStat(`$${mtd.toFixed(2)}`,        `本月成本 (${monthKey})`, `MTD cost (${monthKey})`)}
      ${biStat(`$${forecast.toFixed(2)}`,   '本月预测', 'forecast EOM')}
      ${biStat(`$${total.toFixed(2)}`,      '累计成本', 'all-time cost')}
      ${biStat(`$${costPerPaidUser.toFixed(3)}`, '每付费用户成本/月', 'cost / paid user / mo')}
    </div>
    <div class="panel"><h3>📊 ${bi('月度趋势', 'Monthly trend')}</h3>
      <div class="bars">${bars || `<div style="opacity:.5">${bi('暂无成本数据', 'No cost data yet')}</div>`}</div>
    </div>
    <div class="row">
      <div class="panel"><h3>${bi('按路径估算', 'Estimated by route')}</h3>
        <table>
          <thead><tr><th>${bi('路径', 'Route')}</th><th></th><th class="num">${bi('调用', 'Calls')}</th><th class="num">${bi('估算成本', 'Est. cost')}</th></tr></thead>
          <tbody>${Object.entries(byRoute).sort((a,b)=>b[1]-a[1]).map(([k,v])=>breakdownRow(k,v)).join('') || `<tr><td colspan="4" style="opacity:.5">${bi('暂无数据', 'no data')}</td></tr>`}</tbody>
        </table>
      </div>
      <div class="panel"><h3>${bi('按模型估算', 'Estimated by model')}</h3>
        <table>
          <thead><tr><th>${bi('模型', 'Model')}</th><th></th><th class="num">${bi('调用', 'Calls')}</th><th class="num">${bi('估算成本', 'Est. cost')}</th></tr></thead>
          <tbody>${Object.entries(byModel).sort((a,b)=>b[1]-a[1]).map(([k,v])=>breakdownRow(k.replace(/^claude-/, '').replace(/-\d{8}$/, ''), v)).join('') || `<tr><td colspan="4" style="opacity:.5">${bi('暂无数据', 'no data')}</td></tr>`}</tbody>
        </table>
      </div>
    </div>
    <div class="hint">${bi(
      '⚠️ 路径/模型成本是按调用次数比例估算 — 不是真实 token 成本归因。每次调用的真实 token 用量在 Activity tab。',
      '⚠️ Route/model breakdowns are call-share estimates, not exact token attribution. See Activity tab for per-call token usage.',
    )}</div>
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
    <div id="insights-loading">
      <div style="display:flex;align-items:center;gap:10px;padding:8px 4px 14px;font-size:13px;opacity:.7">
        <span class="spinner"></span>
        <span class="zh-only">AI 在读你的数据… 首次 ~10-15 秒，之后缓存 1 小时</span>
        <span class="en-only">AI reading your data… ~10-15s first time, cached 1 hour after</span>
      </div>
      <div class="panel hero">
        <div class="sk sk-line" style="width:30%"></div>
        <div class="sk sk-line" style="width:80%;height:22px;margin-top:10px"></div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:14px">
          <div class="sk sk-block"></div><div class="sk sk-block"></div><div class="sk sk-block"></div>
        </div>
        <div class="sk sk-block" style="margin-top:14px;height:60px"></div>
      </div>
      <div class="panel"><div class="sk sk-line" style="width:25%"></div><div class="sk sk-block" style="margin-top:10px"></div></div>
      <div class="panel"><div class="sk sk-line" style="width:20%"></div><div class="sk sk-block" style="margin-top:10px;height:140px"></div></div>
      <div class="panel"><div class="sk sk-line" style="width:30%"></div>
        <div class="sk sk-block" style="margin-top:10px"></div>
        <div class="sk sk-block" style="margin-top:8px"></div>
      </div>
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

      function renderVerdict(data) {
        const kpis = (data.kpi || []).slice(0, 3).map(n =>
          '<div class="kpi">' +
            '<div class="kpi-label">'+bi(n.label_zh, n.label_en)+'</div>' +
            '<div class="kpi-value" style="color:'+trendColor(n.trend)+'">' +
              esc(n.value)+' <span class="kpi-trend">'+trendIcon(n.trend)+'</span>' +
            '</div>' +
          '</div>'
        ).join('');
        return '<div class="panel verdict">' +
          '<div class="verdict-text">' + bi(data.verdict_zh, data.verdict_en) + '</div>' +
          (kpis ? '<div class="kpi-grid">'+kpis+'</div>' : '') +
        '</div>';
      }

      function renderFunnel(stages) {
        if (!stages || stages.length === 0) return '';
        const max = Math.max(1, ...stages.map(s => s.count || 0));
        const rows = stages.map((s, i) => {
          const pct = i === 0 ? 100 : (s.pct || 0);
          const w = ((s.count || 0) / max) * 100;
          const drop = i > 0 && pct < 50;
          return '<div class="funnel-row'+(drop ? ' funnel-row-drop' : '')+'">' +
            '<div class="funnel-label">' + bi(s.label_zh, s.label_en) + '</div>' +
            '<div class="funnel-bar"><div class="funnel-fill" style="width:'+w+'%"></div></div>' +
            '<div class="funnel-count">'+esc(s.count)+'</div>' +
            '<div class="funnel-pct">'+ (i === 0 ? '—' : pct + '%') +'</div>' +
          '</div>';
        }).join('');
        return '<div class="panel"><h3>📊 ' + bi('漏斗', 'Funnel') + '</h3>' +
          '<div class="funnel">'+rows+'</div></div>';
      }

      function renderActions(actions) {
        if (!actions || actions.length === 0) return '';
        const cards = actions.map(it =>
          '<div class="act-card" style="border-left-color:'+priorityColor(it.priority)+'">' +
            '<div class="act-head">' +
              '<span class="prio-tag" style="background:'+priorityColor(it.priority)+'">'+it.priority+'</span>' +
              '<strong class="act-title">' + bi(it.title_zh, it.title_en) + '</strong>' +
            '</div>' +
            '<div class="act-why">' + bi(it.why_zh, it.why_en) + '</div>' +
            '<div class="act-do">' +
              '<span class="act-do-tag">' + bi('做', 'Do') + '</span> ' +
              bi(it.do_zh, it.do_en) +
            '</div>' +
          '</div>'
        ).join('');
        return '<div class="panel"><h3>🎯 ' + bi('要做的事', 'What to do') + '</h3>' +
          '<div class="act-list">'+cards+'</div></div>';
      }

      function render(data) {
        root.innerHTML =
          renderVerdict(data) +
          renderFunnel(data.funnel) +
          renderActions(data.actions);
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

/** Server-side bilingual helper. Wraps zh + en in spans the body-class
 *  CSS toggle hides one of. Pairs with the client-side `bi()` in the
 *  insights page — same render pattern, different render time. */
function bi(zh: string, en: string): string {
  return `<span class="zh-only">${esc(zh)}</span><span class="en-only">${esc(en)}</span>`;
}

/** Bilingual stat — same as stat() but the label has zh + en. */
function biStat(value: string | number, zh: string, en: string): string {
  return `<div class="stat"><div class="n">${esc(String(value))}</div><div class="l">${bi(zh, en)}</div></div>`;
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
  // Tab labels are bilingual — server-rendered with .zh-only / .en-only
  // spans so the body-class CSS toggle hides one. Same trick the
  // insights page uses; lifted here so it works on every section.
  const tabLabels: Record<string, { zh: string; en: string }> = {
    overview:  { zh: '总览',     en: 'Overview' },
    insights:  { zh: 'AI 分析 ✨', en: 'Insights ✨' },
    activity:  { zh: '调用',     en: 'Activity' },
    feedback:  { zh: '反馈',     en: 'Feedback' },
    users:     { zh: '用户',     en: 'Users' },
    costs:     { zh: '成本',     en: 'Costs' },
  };
  const tabs = Object.keys(tabLabels)
    .map((s) => {
      const active = s === section ? 'active' : '';
      const lbl = tabLabels[s]!;
      return `<a class="tab ${active}" href="?token=${encodeURIComponent(token)}&section=${s}">` +
             `<span class="zh-only">${esc(lbl.zh)}</span><span class="en-only">${esc(lbl.en)}</span>` +
             `</a>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-Hans">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>KittyScan · Admin · ${esc(section)}</title>
<!-- PWA: install to iOS home screen via Safari → Share → Add to Home Screen.
     Once installed it launches full-screen with no browser chrome,
     indistinguishable from a native app for our internal use. -->
<link rel="manifest" href="/admin/manifest.json?token=${encodeURIComponent(token)}">
<meta name="theme-color" content="#fddc9f">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="KittyScan Admin">
<!-- Inline-SVG paw icon as the home-screen glyph. No file to host. -->
<link rel="apple-touch-icon" href="data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180">' +
  '<rect width="180" height="180" rx="40" fill="#fddc9f"/>' +
  '<text x="50%" y="56%" font-size="120" text-anchor="middle" dominant-baseline="middle">🐾</text>' +
  '</svg>'
)}">
<link rel="icon" href="data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
  '<rect width="64" height="64" rx="14" fill="#fddc9f"/>' +
  '<text x="50%" y="56%" font-size="44" text-anchor="middle" dominant-baseline="middle">🐾</text>' +
  '</svg>'
)}">
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
  /* Verdict hero — one sentence + 3 KPI tiles */
  .verdict{background:linear-gradient(135deg,#fffaf2,#fff3df)}
  .verdict-text{font-size:18px;font-weight:600;color:var(--title);line-height:1.45;margin-bottom:12px}
  .kpi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
  .kpi{background:rgba(255,255,255,.6);border-radius:10px;padding:10px 12px;text-align:center}
  .kpi-label{font-size:10px;opacity:.6;text-transform:uppercase;letter-spacing:.4px}
  .kpi-value{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.1;margin-top:3px}
  .kpi-trend{font-size:13px;margin-left:2px}
  /* Funnel — counts + bars only, no prose */
  .funnel{margin:6px 0}
  .funnel-row{display:grid;grid-template-columns:120px 1fr 50px 50px;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid rgba(74,47,24,.05)}
  .funnel-row-drop .funnel-pct{color:#c62828;font-weight:600}
  .funnel-label{font-size:13px;color:var(--title);font-weight:500}
  .funnel-bar{height:16px;background:rgba(74,47,24,.06);border-radius:8px;overflow:hidden}
  .funnel-fill{height:100%;background:linear-gradient(90deg,#e89556,var(--link));border-radius:8px}
  .funnel-count{font-size:13px;font-weight:600;color:var(--title);font-variant-numeric:tabular-nums;text-align:right}
  .funnel-pct{font-size:11px;opacity:.7;text-align:right;font-variant-numeric:tabular-nums}
  /* Action cards — exactly 3, P0/P1/P2, title + why + do (one line each) */
  .act-list{display:flex;flex-direction:column;gap:10px}
  .act-card{background:rgba(0,0,0,.02);border-left:3px solid #9e9e9e;border-radius:10px;padding:12px 14px}
  .act-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
  .prio-tag{color:white;font-size:11px;font-weight:700;padding:2px 8px;border-radius:7px}
  .act-title{flex:1;font-size:14px;color:var(--title);font-weight:600}
  .act-why{font-size:13px;color:var(--body);line-height:1.5;margin-bottom:6px}
  .act-do{font-size:13px;color:var(--title);background:rgba(168,90,26,.08);padding:7px 10px;border-radius:7px;line-height:1.5}
  .act-do-tag{font-size:10px;font-weight:700;text-transform:uppercase;color:var(--link);letter-spacing:.5px;margin-right:4px}
  /* Header row + global lang toggle */
  .header-row{display:flex;align-items:center;gap:14px;margin-bottom:6px}
  .header-row h1{flex:1;margin:0}
  .section-title{font-size:13px;color:var(--title);font-weight:700;margin:18px 0 8px;text-transform:uppercase;letter-spacing:.5px;opacity:.85}
  .section-title:first-of-type{margin-top:0}
  /* Mini-bar inside table cells (used in activity + cost breakdowns) */
  .mini-bar{height:8px;background:rgba(74,47,24,.06);border-radius:4px;overflow:hidden;min-width:60px}
  .mini-bar-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--link));border-radius:4px}
  /* Right-aligned numeric cells */
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  /* Inline route + risk badges */
  .route-badge{display:inline-block;padding:1px 7px;border-radius:7px;background:rgba(168,90,26,.14);color:var(--link);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.3px}
  .risk-tag{display:inline-block;padding:2px 7px;border-radius:9px;background:#ffe5e5;color:#c62828;font-size:10px;font-weight:600}
  .model-cell{font-family:'SF Mono',monospace;font-size:11px;opacity:.8}

  /* Feedback card layout — replaces the 5-column table that was unreadable
     on phone. Each card is self-contained: colored left border per category,
     prominent text, metadata as small grey line. */
  .fb-list{display:flex;flex-direction:column;gap:10px}
  .fb-card{background:rgba(0,0,0,.02);border-left:3px solid #9e9e9e;border-radius:8px;
           padding:11px 13px}
  .fb-card-head{display:flex;align-items:center;justify-content:space-between;
                gap:8px;margin-bottom:6px;flex-wrap:wrap}
  .fb-cat{display:inline-block;padding:2px 9px;border-radius:9px;
          font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px}
  .fb-when{font-size:11px;opacity:.6;font-variant-numeric:tabular-nums;white-space:nowrap}
  .fb-text{font-size:14px;color:var(--title);line-height:1.5;word-break:break-word;margin-bottom:5px}
  .fb-meta{font-size:11px;opacity:.55;font-family:'SF Mono',monospace}

  /* Skeleton placeholder used by the Insights tab while Claude generates.
     Beats showing a blank panel for 30s — gives the eye something to land on. */
  @keyframes skeleton-pulse {
    0%,100% { opacity:.4 }
    50%     { opacity:.7 }
  }
  .sk{background:rgba(74,47,24,.1);border-radius:6px;animation:skeleton-pulse 1.4s ease-in-out infinite}
  .sk-line{height:14px;margin:6px 0}
  .sk-block{height:80px;margin:8px 0}
  @keyframes spin { to { transform: rotate(360deg) } }
  .spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(74,47,24,.2);
           border-top-color:var(--title);border-radius:50%;animation:spin .8s linear infinite}

  /* ─────────────────────────────────────────────────────────────────
     Mobile / PWA standalone-mode tweaks. Most laptop layouts already
     fluid; phone needs targeted help around tables (too many columns)
     and dense header rows.
     ───────────────────────────────────────────────────────────────── */
  /* Honor the iOS notch when launched as PWA standalone. */
  body{padding:env(safe-area-inset-top,24px) env(safe-area-inset-right,16px) env(safe-area-inset-bottom,24px) env(safe-area-inset-left,16px)}
  /* Allow tab bar to scroll horizontally on phones — there are 6 tabs. */
  .tabs{overflow-x:auto;flex-wrap:nowrap;-webkit-overflow-scrolling:touch;scrollbar-width:none}
  .tabs::-webkit-scrollbar{display:none}
  .tab{flex-shrink:0}
  /* Wide tables (Activity recent calls, etc.) → horizontal scroll on phones
     instead of trying to wrap. Keeps every column visible without breaking
     the row's reading order. */
  .panel table{display:block;overflow-x:auto;white-space:nowrap;-webkit-overflow-scrolling:touch}
  .panel table thead,.panel table tbody,.panel table tr{display:table;width:100%;table-layout:fixed}

  @media (max-width:760px) {
    body{padding:max(12px,env(safe-area-inset-top)) 12px max(20px,env(safe-area-inset-bottom)) 12px}
    h1{font-size:22px}
    .header-row{margin-bottom:4px}
    .sub{font-size:12px}
    .tabs{gap:4px;margin-bottom:14px}
    .tab{padding:7px 12px;font-size:12px}
    .stats{grid-template-columns:repeat(2,1fr);gap:8px}
    .stat{padding:11px 12px}
    .stat .n{font-size:18px}
    .stat .l{font-size:10px}
    .row{grid-template-columns:1fr;gap:10px}
    .panel{padding:12px;border-radius:11px}
    .panel h3{font-size:13px}
    /* Funnel gets cramped at narrow widths — shrink label column. */
    .funnel-row{grid-template-columns:80px 1fr 38px 38px;font-size:12px;gap:6px}
    .funnel-label{font-size:12px}
    .verdict-text{font-size:15px}
    .kpi-grid{grid-template-columns:repeat(3,1fr);gap:5px}
    .kpi{padding:8px 6px}
    .kpi-value{font-size:17px}
    .kpi-label{font-size:9px}
    .act-card{padding:10px 12px}
    .act-title{font-size:13px}
    .act-why,.act-do{font-size:12px}
    .health-score{font-size:38px}
    /* Lang toggle on phone: shrink. */
    .lang-toggle{padding:2px;gap:1px}
    .lang-btn{padding:4px 9px;font-size:11px}
    /* Cost bars: shrink the label column so phone numbers like $12.34 fit. */
    .bar-row{grid-template-columns:60px 1fr 60px;gap:7px}
    .bar-label{font-size:10px}
    .bar-value{font-size:11px}
    /* Mini-bar inside table cells: a bit narrower at this size. */
    .mini-bar{min-width:40px}
  }
</style>
</head>
<body class="lang-zh">
<div class="wrap">
  <div class="header-row">
    <h1>🐾 KittyScan · Admin</h1>
    <div class="lang-toggle">
      <button id="lang-zh-btn" class="lang-btn active">中文</button>
      <button id="lang-en-btn" class="lang-btn">EN</button>
    </div>
  </div>
  <div class="sub"><span class="zh-only">来自 Cloudflare KV 的实时数据,刷新即更新</span><span class="en-only">Live data from Cloudflare KV — refresh to update</span></div>
  <div class="tabs">${tabs}</div>
  ${body}
</div>
<script>
  // Persistent bilingual toggle. State in localStorage so it survives
  // page reloads + crosses every admin section. Body class flip is the
  // only thing that hides/shows .zh-only / .en-only spans (CSS rule
  // already in the stylesheet).
  (function() {
    const KEY = 'admin-lang';
    const zhBtn = document.getElementById('lang-zh-btn');
    const enBtn = document.getElementById('lang-en-btn');
    function apply(l) {
      document.body.classList.toggle('lang-zh', l === 'zh');
      document.body.classList.toggle('lang-en', l === 'en');
      zhBtn.classList.toggle('active', l === 'zh');
      enBtn.classList.toggle('active', l === 'en');
      localStorage.setItem(KEY, l);
      // Also update insights-page localStorage key for backward compat.
      localStorage.setItem('insights-lang', l);
    }
    zhBtn.addEventListener('click', function() { apply('zh'); });
    enBtn.addEventListener('click', function() { apply('en'); });
    apply(localStorage.getItem(KEY) || localStorage.getItem('insights-lang') || 'zh');
  })();
</script>
</body>
</html>`;
}
