// 复盘 · 运营学习闭环 — 可交互设计稿逻辑（确定性模拟数据：30 天 148 帖）
const mulberry32 = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const rnd = mulberry32(20260730);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const fmt = (n) => Math.round(n).toLocaleString('zh-CN');

const PLATFORMS = [
  { id: 'x', name: 'X', cls: 'x', color: '#e9ebf3', viewsFactor: 0.7 },
  { id: 'xhs', name: '小红书', cls: 'xhs', color: '#f04a5e', viewsFactor: 1.5 },
  { id: 'wx', name: '公众号', cls: 'wx', color: '#3fb575', viewsFactor: 1.0 }
];
const FORMATS = [
  { id: 'image', name: '图文', factor: 1.2 }, { id: 'video', name: '视频', factor: 1.6 },
  { id: 'text', name: '文字', factor: 0.75 }, { id: 'article', name: '文章', factor: 1.0 }
];
const TOPICS = [
  { id: 'tools', name: 'AI 工具实测', bmFactor: 2.0, titles: ['年中盘点：12 个真正留下来的 AI 工具', '实测 7 天：这个 Skill 把我的调研时间砍半', '三个被低估的开源 Agent 工具'] },
  { id: 'industry', name: '行业观察', bmFactor: 1.0, titles: ['大模型价格战打到尽头了吗', 'MCP 数量破万后的检索困境', 'Agent 产品正在重复 SaaS 的错误'] },
  { id: 'side', name: '副业接单', bmFactor: 1.2, titles: ['AI 接单报价：我踩过的 5 个坑', '副业第一个万元单的完整复盘', '甲方真正愿意付钱的 AI 交付物'] },
  { id: 'build', name: '产品开发记录', bmFactor: 1.1, titles: ['给自己的终端加上知识画布的第 30 天', 'WMB 发布链路重构手记', '我让 AI 接管了每日情报扫描'] },
  { id: 'skill', name: 'Skill 工作流', bmFactor: 1.6, titles: ['把一本书蒸馏成 Skill 的全流程', '我的封面风格蒸馏工作流', '一个能自我复盘的 Skill 长什么样'] },
  { id: 'hot', name: '争议观点', bmFactor: 0.7, titles: ['别再迷信 AI 一键生成爆款了', '大多数 AI 副业教程都在骗你', 'Agent 不会取代你，但会用 Agent 的人会'] }
];
const KEEP_POOL = ['首图用真实截图而非设计图', '标题先给结论再给背景', '工具实测帖保留「踩坑」小节', '晚间 21 点前后发布', '视频前 3 秒直接抛结论', '盘点类时间节点选题'];
const STOP_POOL = ['正文堆 6 个以上工具名', '深夜 0 点后发布', '封面堆大段文字', '标题党式夸张承诺'];
const CHANGE_POOL = ['工具类改为「1 主角 + 2 配角」结构', '发布时间从深夜改到 21:00 前后', '公众号长文拆出小红书图文版', '把高收藏帖扩成系列'];

// ===== 数据生成：埋入三个真实模式（截图×2.4 收藏、21 点档×1.4 阅读、工具实测×2.0 收藏） =====
const posts = [];
for (let i = 0; i < 148; i++) {
  const platform = rnd() < 0.5 ? PLATFORMS[0] : rnd() < 0.6 ? PLATFORMS[1] : PLATFORMS[2];
  const format = platform.id === 'wx' ? FORMATS[3] : platform.id === 'xhs' ? pick([FORMATS[0], FORMATS[1]]) : pick([FORMATS[0], FORMATS[1], FORMATS[2]]);
  const topic = pick(TOPICS);
  const daysAgo = Math.floor(rnd() * 30);
  const hour = Math.floor(rnd() * 24);
  const screenshot = format.id === 'image' && rnd() < 0.45;
  const hit = rnd() < 0.08;
  let views = 320 * (0.35 + rnd() * 1.5) * format.factor * platform.viewsFactor;
  if (hour >= 20 && hour <= 23) views *= 1.4;
  if (hit) views *= 6;
  const g1 = 1.8 + rnd() * 1.2, g2 = 1.6 + rnd() * 1.1, g3 = 1.15 + rnd() * 0.5;
  const snaps = [1, 6, 24, 72].map((h, wi) => {
    const v = views * (wi === 0 ? 1 : wi === 1 ? g1 : wi === 2 ? g1 * g2 : g1 * g2 * g3);
    const likeRate = 0.055 * (0.5 + rnd());
    const bmRate = 0.018 * (0.5 + rnd()) * (screenshot ? 2.4 : 1) * topic.bmFactor;
    return { h, views: v, likes: v * likeRate, bookmarks: v * bmRate, replies: v * 0.007 * (0.5 + rnd()) };
  });
  const reviewed = daysAgo > 3 ? rnd() < 0.85 : rnd() < 0.35;
  posts.push({
    id: `p${i}`, title: pick(topic.titles), platform, format, topic, screenshot, hit,
    daysAgo, hour, snaps, reviewed,
    keep: reviewed && rnd() < 0.9 ? [pick(KEEP_POOL), ...(rnd() < 0.35 ? [pick(KEEP_POOL)] : [])] : [],
    stop: reviewed && rnd() < 0.55 ? [pick(STOP_POOL)] : [],
    change: reviewed && rnd() < 0.7 ? [pick(CHANGE_POOL)] : []
  });
}
let findings = [
  { t: '盘点类内容要用真实截图', v: 9, r: 0, u: 5, verdict: 'ok' },
  { t: '视频前 3 秒先给结论', v: 6, r: 1, u: 3, verdict: 'ok' },
  { t: 'AI 工具实测的收藏率高于观点帖', v: 5, r: 1, u: 4, verdict: 'watch' },
  { t: '21 点档发布的 24h 阅读更高', v: 4, r: 2, u: 2, verdict: 'watch' },
  { t: '标题带具体数字就能提升点击', v: 2, r: 3, u: 1, verdict: 'bad' }
];

// ===== 状态 =====
const state = { pf: '', fmt: '', tab: 'scatter', chartMode: 'abs', heroFinal: false, selected: null };
const filtered = () => posts.filter((p) => (!state.pf || p.platform.id === state.pf) && (!state.fmt || p.format.id === state.fmt));
const $ = (sel) => document.querySelector(sel);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };

// ===== 顶栏统计 / 筛选 =====
function renderStats() {
  const list = filtered();
  const reviewed = list.filter((p) => p.reviewed).length;
  const refs = findings.reduce((s, f) => s + f.u, 0);
  const pending = list.filter((p) => !p.reviewed && p.daysAgo >= 3).length;
  $('#statStrip').innerHTML = [
    [`${list.length}`, '本周期发布'], [`${reviewed}`, '已复盘', reviewed === list.length],
    [`${findings.length}`, '方法库结论'], [`${refs}`, '结论被方案引用', true], [`${pending}`, '待复盘', false, pending > 0]
  ].map(([b, s, hi, warn]) => `<div class="cell${hi ? ' hi' : ''}"><b class="num" ${warn ? 'style="color:var(--amber)"' : ''}>${b}</b><span>${s}</span></div>`).join('');
}
function renderChips() {
  const mk = (wrap, items, cur, fn) => {
    wrap.querySelectorAll('.chip').forEach((c) => c.remove());
    [{ id: '', name: '全部' }, ...items].forEach((it) => {
      const b = el(`<button class="chip${cur === it.id ? ' on' : ''}">${it.name}</button>`);
      b.onclick = () => fn(it.id); wrap.appendChild(b);
    });
  };
  mk($('#pfChips'), PLATFORMS, state.pf, (id) => { state.pf = id; state.selected = null; renderAll(); });
  mk($('#fmtChips'), FORMATS, state.fmt, (id) => { state.fmt = id; state.selected = null; renderAll(); });
}

// ===== Pi 周期复盘 hero =====
function renderHero() {
  const list = filtered();
  const best = [...list].sort((a, b) => b.snaps[2].views - a.snaps[2].views)[0];
  const agg = aggregateActions();
  $('#hero').innerHTML = `
    <div class="hero-head">
      <div class="who"><span class="dot"></span><b>Pi 周期复盘草案</b><span class="state-pill ${state.heroFinal ? 'final' : 'draft'}">${state.heroFinal ? '已定稿 ✓' : '草案 · 待人定稿'}</span></div>
      <div><button class="btn ghost" id="heroDiscuss">和 Pi 讨论</button> <button class="btn primary" id="heroFinal" ${state.heroFinal ? 'disabled' : ''}>${state.heroFinal ? '已定稿 ✓' : '定稿本周复盘'}</button></div>
    </div>
    <div class="hero-points">
      <div class="pt"><b>① 本周最强内容</b><p>《${best?.title ?? '—'}》24h 阅读 <span class="num">${fmt(best?.snaps[2].views ?? 0)}</span>，是中位水平的 <span class="num">${best ? (best.snaps[2].views / Math.max(1, median(list.map((p) => p.snaps[2].views)))).toFixed(1) : '—'}×</span>。</p></div>
      <div class="pt"><b>② 最稳的模式</b><p>真实截图首图的图文笔记，收藏率中位数是非截图的 <span class="num" id="heroRatio">—</span>，连续 3 周成立。</p></div>
      <div class="pt"><b>③ 需要警惕</b><p>争议观点类本周发布偏多但收藏率垫底，流量高、资产沉淀少。</p></div>
    </div>
    <div class="hero-ksc">
      <span class="k"><b>✓ 保留</b>${agg.keep[0]?.txt ?? '—'}</span>
      <span class="s"><b>✕ 停止</b>${agg.stop[0]?.txt ?? '—'}</span>
      <span class="c"><b>↻ 改变</b>${agg.change[0]?.txt ?? '—'}</span>
    </div>`;
  const img = list.filter((p) => p.format.id === 'image');
  const ratio = bmRateOf(img.filter((p) => p.screenshot)) / Math.max(0.0001, bmRateOf(img.filter((p) => !p.screenshot)));
  $('#heroRatio').textContent = `${ratio.toFixed(1)}×`;
  $('#heroFinal').onclick = () => { state.heroFinal = true; renderHero(); };
  $('#heroDiscuss').onclick = () => alert('设计稿：此处唤起 Pi 停靠栏，围绕本周期数据讨论复盘草案。');
}
const bmRateOf = (arr) => median(arr.map((p) => p.snaps[2].bookmarks / Math.max(1, p.snaps[2].views)));

// ===== 组合形态图：散点（默认,规模可读） / 增长带（纯聚合,不画单帖线） / 热图 =====
const W = 780, H = 380, M = { l: 56, r: 96, t: 14, b: 36 };
const HOURS = [1, 6, 24, 72];
const segDist = (px, py, x1, y1, x2, y2) => {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};
function renderChart() {
  const list = filtered();
  if (state.selected) {
    const post = posts.find((x) => x.id === state.selected);
    if (post) return renderDrill(post, list);
    state.selected = null;
  }
  if (state.tab === 'heat') return renderHeatmap(list);
  if (state.tab === 'curve') return renderBands(list);
  return renderScatter(list);
}
const drillInto = (p) => { state.selected = p.id; renderChart(); };
const axisAndGrid = (ys, yTicks, xLabels) => `
  ${yTicks.map((v) => `<line class="grid-line" x1="${M.l}" x2="${W - M.r}" y1="${ys(v)}" y2="${ys(v)}"/><text x="${M.l - 8}" y="${ys(v) + 3}" text-anchor="end">${v >= 10 ? fmt(v) : '×' + fmt(v)}</text>`).join('')}
  <line class="axis" x1="${M.l}" x2="${M.l}" y1="${M.t}" y2="${H - M.b}"/><line class="axis" x1="${M.l}" x2="${W - M.r}" y1="${H - M.b}" y2="${H - M.b}"/>
  ${xLabels}`;
const frame = (inner, yTicks, ys, xLabels) => `<svg id="chart" viewBox="0 0 ${W} ${H}">${axisAndGrid(ys, yTicks, xLabels)}${inner}<g id="hl"></g><rect id="hitzone" x="${M.l}" y="${M.t}" width="${W - M.l - M.r}" height="${H - M.t - M.b}" fill="transparent"/></svg>`;
const trackPointer = (onMove, onPick) => {
  const svg = $('#chart'), hl = $('#hl'), tooltip = $('#tooltip');
  let nearest = null;
  $('#hitzone').addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    nearest = onMove((e.clientX - rect.left) * W / rect.width, (e.clientY - rect.top) * H / rect.height);
    if (!nearest) { hl.innerHTML = ''; tooltip.style.display = 'none'; return; }
    const p = nearest.post;
    hl.innerHTML = nearest.hl;
    tooltip.innerHTML = `<b>《${p.title}》</b><span>${p.platform.name} · ${p.format.name} · ${p.daysAgo} 天前 ${p.hour}:00</span><br/><span>+1h ${fmt(p.snaps[0].views)} → +24h ${fmt(p.snaps[2].views)} → +72h ${fmt(p.snaps[3].views)}</span>`;
    tooltip.style.display = 'block';
    tooltip.style.left = `${e.clientX + 14}px`; tooltip.style.top = `${e.clientY + 10}px`;
  });
  $('#hitzone').addEventListener('mouseleave', () => { hl.innerHTML = ''; tooltip.style.display = 'none'; nearest = null; });
  $('#hitzone').addEventListener('click', () => { if (nearest) { tooltip.style.display = 'none'; onPick(nearest.post); } });
};

// --- 表现散点：x=发布时间, y=24h 阅读(对数), 每日中位轨迹 ---
function renderScatter(list) {
  const xs = (day) => M.l + (1 - day / 29) * (W - M.l - M.r);
  const allV = list.map((p) => p.snaps[2].views);
  const lo = Math.log10(Math.max(10, Math.min(...allV))), hi = Math.log10(Math.max(...allV));
  const ys = (v) => M.t + (1 - (Math.log10(Math.max(10, v)) - lo) / Math.max(0.01, hi - lo)) * (H - M.t - M.b);
  const yTicks = [0.15, 0.5, 0.85].map((f) => Math.pow(10, lo + f * (hi - lo)));
  const xLabels = [28, 21, 14, 7, 0].map((d) => `<text x="${xs(d)}" y="${H - M.b + 18}" text-anchor="middle">${d === 0 ? '今天' : `${d} 天前`}</text>`).join('');
  const medPts = [...Array(30).keys()].map((d) => {
    const vs = list.filter((p) => p.daysAgo === d).map((p) => p.snaps[2].views);
    return vs.length ? [xs(d), ys(median(vs))] : null;
  });
  const medSegs = [];
  for (let i = 0; i < 29; i++) if (medPts[i] && medPts[i + 1]) medSegs.push(`M${medPts[i][0]},${medPts[i][1]} L${medPts[i + 1][0]},${medPts[i + 1][1]}`);
  const dots = list.map((p) => ({ p, x: xs(p.daysAgo), y: ys(p.snaps[2].views) }));
  $('#chartWrap').innerHTML = frame(
    medSegs.map((d) => `<path d="${d}" fill="none" stroke="#a495ff" stroke-width="2"/>`).join('') +
    medPts.filter(Boolean).map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3" fill="#a495ff"/>`).join('') +
    dots.map((d) => `<circle cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="4" fill="${d.p.platform.color}" opacity=".72"/>`).join(''),
    yTicks, ys, xLabels);
  $('#chartLegend').innerHTML = [
    ...PLATFORMS.map((p) => `<span><i style="background:${p.color}"></i>${p.name}</span>`),
    `<span><i style="background:#a495ff;height:2.5px"></i>每日中位轨迹</span>`,
    `<span style="margin-left:auto">每个点 = 一条内容的 24h 阅读 · 吸附查看 · 点击钻取</span>`
  ].join('');
  trackPointer((px, py) => {
    let best = null, bd = 1e9;
    for (const d of dots) { const dist = Math.hypot(px - d.x, py - d.y); if (dist < bd) { bd = dist; best = d; } }
    if (!best) return null;
    return { post: best.p, hl: `<circle cx="${best.x}" cy="${best.y}" r="7" fill="none" stroke="${best.p.platform.color}" stroke-width="2"/><circle cx="${best.x}" cy="${best.y}" r="4" fill="${best.p.platform.color}"/>` };
  }, drillInto);
}

// --- 增长形态：纯分位带 + 中位线 + Top3 标注;单帖曲线只在吸附时临时出现 ---
function renderBands(list) {
  const norm = state.chartMode === 'norm';
  const valOf = (p, wi) => norm ? p.snaps[wi].views / p.snaps[0].views : p.snaps[wi].views;
  const xs = (h) => M.l + (Math.log10(h) / Math.log10(72)) * (W - M.l - M.r);
  const allV = list.flatMap((p) => p.snaps.map((_, wi) => valOf(p, wi)));
  const lo = Math.log10(Math.max(norm ? 1 : 10, Math.min(...allV))), hi = Math.log10(Math.max(...allV));
  const ys = (v) => M.t + (1 - (Math.log10(Math.max(norm ? 1 : 10, v)) - lo) / Math.max(0.01, hi - lo)) * (H - M.t - M.b);
  const q = (wi, qq) => { const s = list.map((p) => valOf(p, wi)).sort((a, b) => a - b); return s[Math.floor(s.length * qq)] ?? 0; };
  const bandPath = (qa, qb) => {
    const top = HOURS.map((h, wi) => [xs(h), ys(q(wi, qb))]);
    const bot = HOURS.map((h, wi) => [xs(h), ys(q(wi, qa))]).reverse();
    return `M${[...top, ...bot].map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L')} Z`;
  };
  const medPath = `M${HOURS.map((h, wi) => `${xs(h).toFixed(1)},${ys(q(wi, 0.5)).toFixed(1)}`).join(' L')}`;
  const top3 = [...list].sort((a, b) => b.snaps[2].views - a.snaps[2].views).slice(0, 3);
  const yTicks = [0.15, 0.5, 0.85].map((f) => Math.pow(10, lo + f * (hi - lo)));
  const xLabels = HOURS.map((h) => `<text x="${xs(h)}" y="${H - M.b + 18}" text-anchor="middle">+${h}h</text>`).join('');
  $('#chartWrap').innerHTML = `<div class="chart-opts">
    <div class="tabs mini">
      <button data-mode="abs" class="${norm ? '' : 'on'}">绝对阅读</button>
      <button data-mode="norm" class="${norm ? 'on' : ''}">增速形态</button>
    </div>
    <span class="show-all">${list.length} 条内容聚合成带 · 吸附可还原单条曲线</span>
  </div>` + frame(
    `<path d="${bandPath(0.1, 0.9)}" fill="rgba(139,124,255,.07)"/>
    <path d="${bandPath(0.25, 0.75)}" fill="rgba(139,124,255,.17)"/>
    ${top3.map((p) => `<polyline points="${HOURS.map((_, wi) => `${xs(HOURS[wi]).toFixed(1)},${ys(valOf(p, wi)).toFixed(1)}`).join(' ')}" fill="none" stroke="${p.platform.color}" stroke-width="1.8" opacity=".9"/><text class="end-label" x="${W - M.r + 6}" y="${ys(valOf(p, 3)) + 3}" fill="${p.platform.color}">${p.title.slice(0, 9)}…</text>`).join('')}
    <path d="${medPath}" fill="none" stroke="#a495ff" stroke-width="2.5"/>
    ${HOURS.map((h, wi) => `<circle cx="${xs(h)}" cy="${ys(q(wi, 0.5))}" r="3.2" fill="#a495ff"/>`).join('')}`,
    yTicks, ys, xLabels);
  $('#chartLegend').innerHTML = [
    `<span><i style="background:#a495ff;height:2.5px"></i>中位数</span>`,
    `<span><i style="background:rgba(139,124,255,.35);height:8px"></i>P25–P75</span>`,
    `<span><i style="background:rgba(139,124,255,.15);height:8px"></i>P10–P90</span>`,
    ...PLATFORMS.map((p) => `<span><i style="background:${p.color}"></i>${p.name} Top</span>`),
    `<span style="margin-left:auto">移动鼠标吸附还原单条曲线 · 点击钻取</span>`
  ].join('');
  trackPointer((px, py) => {
    let best = null, bd = 1e9;
    for (const p of list) {
      const pts = p.snaps.map((s, wi) => [xs(s.h), ys(valOf(p, wi))]);
      for (let i = 0; i < 3; i++) { const d = segDist(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]); if (d < bd) { bd = d; best = p; } }
    }
    if (!best) return null;
    const pts = best.snaps.map((s, wi) => `${xs(s.h).toFixed(1)},${ys(valOf(best, wi)).toFixed(1)}`).join(' ');
    return { post: best, hl: `<polyline points="${pts}" fill="none" stroke="${best.platform.color}" stroke-width="2.4"/>${best.snaps.map((s, wi) => `<circle cx="${xs(s.h)}" cy="${ys(valOf(best, wi))}" r="3.4" fill="${best.platform.color}"/>`).join('')}` };
  }, drillInto);
  document.querySelectorAll('.chart-opts [data-mode]').forEach((b) => b.addEventListener('click', () => { state.chartMode = b.dataset.mode; renderChart(); }));
}

// --- 单帖钻取:原位把图表区变换为该帖曲线,同期分位带淡化为背景参照 ---
function renderDrill(p, cohort) {
  const xs = (h) => M.l + (Math.log10(h) / Math.log10(72)) * (W - M.l - M.r);
  const base = cohort.length ? cohort : [p];
  const allV = [...base.flatMap((c) => c.snaps.map((s) => s.views)), ...p.snaps.map((s) => s.views)];
  const lo = Math.log10(Math.max(10, Math.min(...allV))), hi = Math.log10(Math.max(...allV));
  const ys = (v) => M.t + (1 - (Math.log10(Math.max(10, v)) - lo) / Math.max(0.01, hi - lo)) * (H - M.t - M.b);
  const q = (wi, qq) => { const s = base.map((c) => c.snaps[wi].views).sort((a, b) => a - b); return s[Math.floor(s.length * qq)] ?? 0; };
  const bandPath = (qa, qb) => {
    const top = HOURS.map((h, wi) => [xs(h), ys(q(wi, qb))]);
    const bot = HOURS.map((h, wi) => [xs(h), ys(q(wi, qa))]).reverse();
    return `M${[...top, ...bot].map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L')} Z`;
  };
  const yTicks = [0.15, 0.5, 0.85].map((f) => Math.pow(10, lo + f * (hi - lo)));
  const xLabels = HOURS.map((h) => `<text x="${xs(h)}" y="${H - M.b + 18}" text-anchor="middle">+${h}h</text>`).join('');
  const line = p.snaps.map((s) => `${xs(s.h).toFixed(1)},${ys(s.views).toFixed(1)}`).join(' ');
  $('#chartWrap').innerHTML = `<div class="chart-opts drill-head">
    <button class="mini-btn" id="backToAgg">← 返回总览</button>
    <span class="drill-title">《${p.title}》</span>
    <span class="drill-sub">${p.platform.name} · ${p.format.name} · ${p.topic.name}${p.screenshot ? ' · 真实截图首图' : ''} · ${p.daysAgo} 天前 ${String(p.hour).padStart(2, '0')}:00 发布</span>
  </div>
  <svg id="chart" viewBox="0 0 ${W} ${H}">${axisAndGrid(ys, yTicks, xLabels)}
    <path d="${bandPath(0.1, 0.9)}" fill="rgba(139,124,255,.05)"/>
    <path d="${bandPath(0.25, 0.75)}" fill="rgba(139,124,255,.11)"/>
    <polyline points="${line}" fill="none" stroke="${p.platform.color}" stroke-width="2.4"/>
    ${p.snaps.map((s) => `<circle cx="${xs(s.h)}" cy="${ys(s.views)}" r="3.6" fill="${p.platform.color}"/><text x="${xs(s.h)}" y="${ys(s.views) - 9}" text-anchor="middle" fill="var(--t2)">${fmt(s.views)}</text>`).join('')}
  </svg>
  <div class="drill-detail">
    <div><p class="eyebrow" style="margin-bottom:8px">指标快照 · 字段状态</p>
    <table class="d-table"><thead><tr><th>窗口</th><th>阅读</th><th>点赞</th><th>收藏</th><th>评论</th><th>状态</th></tr></thead><tbody>
      ${p.snaps.map((s) => `<tr><td>+${s.h}h</td><td>${fmt(s.views)}</td><td>${fmt(s.likes)}</td><td>${fmt(s.bookmarks)}</td><td>${fmt(s.replies)}</td><td style="color:var(--green)">全部有值</td></tr>`).join('')}
    </tbody></table></div>
    <div><p class="eyebrow" style="margin-bottom:8px">复盘</p>
    ${p.reviewed ? `<div class="d-ksc">
      <div class="row k"><b>✓ 保留</b><span>${p.keep.join('；') || '—'}</span></div>
      <div class="row s"><b>✕ 停止</b><span>${p.stop.join('；') || '—'}</span></div>
      <div class="row c"><b>↻ 改变</b><span>${p.change.join('；') || '—'}</span></div>
    </div>` : `<div class="empty-note">这条内容还没有复盘。<br/><br/><button class="btn primary" id="drillPi">让 Pi 复盘</button></div>`}
    </div>
  </div>`;
  $('#chartLegend').innerHTML = [
    `<span><i style="background:${p.platform.color};height:2.5px"></i>该内容实测曲线</span>`,
    `<span><i style="background:rgba(139,124,255,.3);height:8px"></i>同期 P25–P75 背景</span>`,
    `<span style="margin-left:auto">淡色带 = 当前筛选下全部内容的分布参照</span>`
  ].join('');
  $('#backToAgg').onclick = () => { state.selected = null; renderChart(); };
  const piBtn = $('#drillPi');
  if (piBtn) piBtn.onclick = () => { p.reviewed = true; p.keep = [pick(KEEP_POOL)]; p.change = [pick(CHANGE_POOL)]; renderAll(); };
}

// ===== 形式 × 平台热图（单元格 = 帖数 + 中位 24h 阅读；点击下钻为筛选） =====
function renderHeatmap(list) {
  const maxV = Math.max(...FORMATS.flatMap((f) => PLATFORMS.map((pf) => median(list.filter((p) => p.format.id === f.id && p.platform.id === pf.id).map((p) => p.snaps[2].views)))), 1);
  $('#chartWrap').innerHTML = `<div class="heatmap">
    <div class="hm-row head"><span></span>${PLATFORMS.map((p) => `<span>${p.name}</span>`).join('')}</div>
    ${FORMATS.map((f) => `<div class="hm-row"><span>${f.name}</span>${PLATFORMS.map((pf) => {
      const cell = list.filter((p) => p.format.id === f.id && p.platform.id === pf.id);
      if (!cell.length) return `<div class="hm-cell" style="opacity:.35"><b>—</b><span>无内容</span></div>`;
      const v = median(cell.map((p) => p.snaps[2].views));
      const a = 0.08 + 0.5 * Math.log10(v + 1) / Math.log10(maxV + 1);
      return `<div class="hm-cell" data-pf="${pf.id}" data-fmt="${f.id}" style="background:rgba(139,124,255,${a.toFixed(2)})"><b>${fmt(v)}</b><span>${cell.length} 条 · 中位 24h 阅读</span></div>`;
    }).join('')}</div>`).join('')}
  </div>`;
  $('#chartLegend').innerHTML = `<span>颜色越深 = 该组合中位表现越强</span><span style="margin-left:auto">点击单元格 = 按该组合筛选曲线</span>`;
  $('#chartWrap').querySelectorAll('.hm-cell[data-pf]').forEach((c) => c.addEventListener('click', () => {
    state.pf = c.dataset.pf; state.fmt = c.dataset.fmt; state.tab = 'curve';
    $('#chartTabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === 'curve'));
    renderAll();
  }));
}

// ===== 模式发现（数值由模拟数据实时计算） =====
function renderPatterns() {
  const list = filtered();
  const img = list.filter((p) => p.format.id === 'image');
  const shot = img.filter((p) => p.screenshot), noShot = img.filter((p) => !p.screenshot);
  const r1 = bmRateOf(shot) / Math.max(0.0001, bmRateOf(noShot));
  const night = list.filter((p) => p.hour >= 20 && p.hour <= 23), other = list.filter((p) => !(p.hour >= 20 && p.hour <= 23));
  const r2 = median(night.map((p) => p.snaps[2].views)) / Math.max(1, median(other.map((p) => p.snaps[2].views)));
  const tools = list.filter((p) => p.topic.id === 'tools'), rest = list.filter((p) => p.topic.id !== 'tools');
  const r3 = bmRateOf(tools) / Math.max(0.0001, bmRateOf(rest));
  const patterns = [
    { t: '真实截图首图 → 收藏率显著更高', ratio: r1, d: '图文笔记中，真实截图首图的收藏/阅读中位数对比设计图首图。', n: shot.length, ok: r1 > 1.5 && shot.length >= 8 },
    { t: '21 点档发布 → 24h 阅读更高', ratio: r2, d: '20:00–23:00 发布的内容，24h 阅读中位数对比其他时段。', n: night.length, ok: r2 > 1.2 && night.length >= 8 },
    { t: 'AI 工具实测 → 收藏型资产', ratio: r3, d: '工具实测选题的收藏率中位数对比其他选题，适合沉淀系列。', n: tools.length, ok: r3 > 1.5 && tools.length >= 8 }
  ];
  $('#patterns').innerHTML = '';
  patterns.forEach((pt) => {
    const card = el(`<div class="pattern">
      <div class="top"><b>${pt.t}</b><span class="ratio num">${pt.ratio.toFixed(1)}×</span></div>
      <p>${pt.d}</p>
      <div class="foot"><span class="evi">证据 ${pt.n} 帖 · ${pt.ok ? '连续成立' : '样本积累中'}</span>
      <button class="mini-btn">${pt.ok ? '加入方法库' : '继续观察'}</button></div>
    </div>`);
    card.querySelector('.mini-btn').onclick = (e) => {
      if (!pt.ok) return alert('设计稿：样本不足时 Pi 不会建议固化为方法。');
      findings = [{ t: pt.t, v: 0, r: 0, u: 0, verdict: 'watch' }, ...findings];
      e.target.classList.add('done'); e.target.textContent = '已加入 ✓';
      renderFindings(); renderStats();
    };
    $('#patterns').appendChild(card);
  });
}

// ===== 方法库回摆 =====
function renderFindings() {
  const label = { ok: '已验证', watch: '观察中', bad: '被否定' };
  $('#findings').innerHTML = '';
  findings.forEach((f) => {
    const card = el(`<div class="finding">
      <div class="top"><b>${f.t}</b><span class="verdict ${f.verdict}">${label[f.verdict]}</span></div>
      <div class="bars"><span class="v">验证 ×${f.v}</span><span class="r">否定 ×${f.r}</span><span class="u">被方案引用 ×${f.u}</span>
      ${f.verdict === 'bad' ? '<button class="mini-btn" style="margin-left:auto">退役</button>' : ''}</div>
    </div>`);
    const retire = card.querySelector('.mini-btn');
    if (retire) retire.onclick = () => { findings = findings.filter((x) => x !== f); renderFindings(); renderStats(); };
    $('#findings').appendChild(card);
  });
}

// ===== 行动聚合（K/S/C + 闭环证据） =====
function aggregateActions() {
  const agg = { keep: new Map(), stop: new Map(), change: new Map() };
  filtered().filter((p) => p.reviewed).forEach((p) => {
    p.keep.forEach((t) => agg.keep.set(t, (agg.keep.get(t) ?? 0) + 1));
    p.stop.forEach((t) => agg.stop.set(t, (agg.stop.get(t) ?? 0) + 1));
    p.change.forEach((t) => agg.change.set(t, (agg.change.get(t) ?? 0) + 1));
  });
  const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([txt, n]) => ({ txt, n, adopted: Math.floor(n * (0.35 + ((txt.length * 7) % 10) / 18)) }));
  return { keep: top(agg.keep), stop: top(agg.stop), change: top(agg.change) };
}
function renderActions() {
  const agg = aggregateActions();
  const cols = [
    { key: 'keep', icon: '✓ 保留 Keep', cls: 'keep' },
    { key: 'stop', icon: '✕ 停止 Stop', cls: 'stop' },
    { key: 'change', icon: '↻ 改变 Change', cls: 'change' }
  ];
  $('#actionsGrid').innerHTML = cols.map((col) => {
    const items = agg[col.key];
    const total = items.reduce((s, i) => s + i.n, 0);
    return `<div class="action-col ${col.cls}"><h4>${col.icon}<span class="cnt num">${total} 条</span></h4>
      ${items.length ? items.map((i) => `<div class="action-item">
        <span class="txt">${i.txt}</span>
        <span class="meta"><span>×${i.n} 次复盘提出</span>${i.adopted > 0 ? `<span class="loop-ok">→ 已被 ${i.adopted} 个后续方案采用</span>` : '<span class="loop-no">→ 尚未进入方案</span>'}</span>
      </div>`).join('') : '<div class="action-item"><span class="txt" style="color:var(--t3)">本周期暂无</span></div>'}
    </div>`;
  }).join('');
}

// ===== 待复盘 =====
function renderPending() {
  const list = filtered().filter((p) => !p.reviewed && p.daysAgo >= 3).sort((a, b) => b.snaps[2].views - a.snaps[2].views);
  const wrap = $('#pendingList');
  if (!list.length) {
    wrap.innerHTML = '<div class="empty-note">本周期没有遗留未复盘内容。Pi 会在发布 72h 后自动把未复盘内容列到这里。</div>';
    return;
  }
  wrap.innerHTML = '';
  list.slice(0, 6).forEach((p) => {
    const row = el(`<div class="pending-row">
      <span class="pf-tag ${p.platform.cls}">${p.platform.name}</span>
      <span class="ttl">《${p.title}》</span>
      <span class="meta">${p.daysAgo} 天前 · 24h 阅读 ${fmt(p.snaps[2].views)}</span>
      <button class="mini-btn">让 Pi 复盘</button>
    </div>`);
    row.querySelector('.ttl').onclick = () => drillInto(p);
    row.querySelector('.mini-btn').onclick = () => { p.reviewed = true; p.keep = [pick(KEEP_POOL)]; p.change = [pick(CHANGE_POOL)]; renderAll(); };
    wrap.appendChild(row);
  });
  if (list.length > 6) wrap.appendChild(el(`<div class="empty-note">还有 ${list.length - 6} 条 · 可用右上角「让 Pi 全部复盘」批量生成草案</div>`));
}

// ===== 装配 =====
function renderAll() { renderStats(); renderChips(); renderHero(); renderChart(); renderPatterns(); renderFindings(); renderActions(); renderPending(); }
$('#chartTabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
  state.tab = b.dataset.tab;
  state.selected = null;
  $('#chartTabs').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  renderChart();
}));
$('#periodBtn').onclick = () => alert('设计稿：周期切换（今日 / 本周 / 本月 / 自定义区间），所有图表与聚合随周期重算。');
$('#piReviewAll').onclick = () => { posts.filter((p) => !p.reviewed && p.daysAgo >= 3).forEach((p) => { p.reviewed = true; p.keep = [pick(KEEP_POOL)]; p.change = [pick(CHANGE_POOL)]; }); renderAll(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.selected) { state.selected = null; renderChart(); } });
renderAll();
