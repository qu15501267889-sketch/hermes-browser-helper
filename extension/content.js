// content.js — 通用网页抓取引擎
// 自动适配多种抓取策略，覆盖绝大多数网站

// ========== 1. API 拦截器（注入页面世界） ==========
// 在无 CSP 的网站上拦截 fetch/XHR，拿到原始 API 数据

const INJECTOR_URL = chrome.runtime.getURL('injector.js');
let interceptorInjected = false;
let apiRecords = [];
let jsonpRecords = [];  // JSONP 捕获的数据（贴吧等 script 加载的站点）
let pageGlobals = null;  // 页面主世界内嵌JSON（SPA数据源）

function injectInterceptor() {
  if (interceptorInjected) return;
  interceptorInjected = true;
  try {
    const script = document.createElement('script');
    script.src = INJECTOR_URL;
    const parent = document.head || document.documentElement;
    parent.appendChild(script);
  } catch (e) {
    // CSP 拦截是正常情况，不报错
  }
}

// 监听来自页面世界的 API 拦截消息
window.addEventListener('message', (event) => {
  if (event.data?.source === 'hermes-api-interceptor') {
    // 页面全局数据（SPA内嵌JSON）
    if (event.data.type === 'globals') {
      pageGlobals = event.data.data;
      return;
    }
    // JSONP 数据（script 加载，静默捕获）
    if (event.data.type === 'jsonp') {
      jsonpRecords.push({
        url: (event.data.url || '').slice(0, 300),
        callback: event.data.callback || '',
        data: (event.data.data || '').slice(0, 500000),
        timestamp: Date.now(),
      });
      if (jsonpRecords.length > 30) jsonpRecords = jsonpRecords.slice(-15);
      return;
    }
    const url = event.data.url || '';
    const isDataApi = url.includes('/statQuery') || url.includes('/material') || url.includes('roi2_material') || url.includes('link/tree');
    apiRecords.push({
      url: url.slice(0, 300),
      method: event.data.method || '',
      status: event.data.status || 0,
      contentType: (event.data.contentType || '').slice(0, 100),
      requestBody: (event.data.requestBody || '').slice(0, 2000),
      responseBody: (event.data.responseBody || '').slice(0, isDataApi ? 500000 : 10000),
    });
    if (apiRecords.length > 200) apiRecords = apiRecords.slice(-100);
  }
});

// ========== 2. 页面类型检测 ==========

function detectPageType() {
  const url = window.location.href;
  const host = window.location.hostname;
  if (host.includes('bilibili') || host.includes('b23.tv')) {
    return url.includes('/video/') ? 'bilibili_video' : url.includes('/read/') ? 'bilibili_article' : 'bilibili';
  }
  if (host.includes('tieba.baidu.com')) return 'tieba';
  if (host.includes('xiaoheihe')) return 'xiaoheihe';
  if (host.includes('zhihu')) return 'zhihu';
  if (host.includes('douban')) return 'douban';
  if (host.includes('weibo')) return 'weibo';
  if (host.includes('jinritemai') || host.includes('douyin')) return 'douyin_biz';
  if (host.includes('youtube')) return 'youtube';
  if (host.includes('reddit')) return 'reddit';
  if (host.includes('github')) return 'github';
  if (host.includes('twitter') || host.includes('x.com')) return 'twitter';
  return 'general';
}

// ========== 3. 多种抓取策略 ==========

// 策略A: 全文提取（所有网站保底）
function extractFullText() {
  const clone = document.body?.cloneNode(true);
  if (!clone) return '';
  clone.querySelectorAll('script, style, noscript, iframe, svg, canvas').forEach(el => el.remove());
  return clone.textContent.trim().slice(0, 200000);
}

// 策略B: 提取 HTML 关键区域
function extractKeyHtml() {
  const targets = [];
  document.querySelectorAll('article, main, [role="main"], table, [role="grid"], [role="table"], [class*="data-table"], [class*="table-wrap"]').forEach(el => {
    if (el.textContent.length > 50) targets.push(el);
  });
  if (targets.length === 0) {
    // 回退：找最大内容块
    const all = document.querySelectorAll('div, section');
    let maxEl = null, maxLen = 0;
    all.forEach(el => {
      if (el.textContent.length > maxLen && el.textContent.length < 500000) {
        maxLen = el.textContent.length;
        maxEl = el;
      }
    });
    if (maxEl) targets.push(maxEl);
  }
  return targets.slice(0, 5).map(el => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    classes: Array.from(el.classList).join(' ').slice(0, 100),
    html: el.outerHTML.slice(0, 80000),
  }));
}

// 策略C: 提取虚拟表格行（DataItem / role=gridcell）
function extractVirtualTable() {
  const rows = [];
  // 方法1: role="row" 或 role="gridcell"
  document.querySelectorAll('[role="row"], [role="gridcell"], [role="dataitem"], [class*="data-row"], [class*="table-row"]').forEach(el => {
    const text = el.textContent.trim();
    if (text.length > 10) rows.push(text.slice(0, 500));
  });
  // 方法2: 连续的 DataItem 元素
  if (rows.length === 0) {
    document.querySelectorAll('[role="dataitem"], [class*="DataItem"], [class*="data-item"]').forEach(el => {
      const text = el.textContent.trim();
      if (text.length > 10) rows.push(text.slice(0, 500));
    });
  }
  return rows.slice(0, 500);
}

// 策略D: 提取 HTML 表格
function extractHtmlTables() {
  const tables = [];
  document.querySelectorAll('table').forEach(table => {
    const data = [];
    table.querySelectorAll('tr').forEach(tr => {
      const cells = [];
      tr.querySelectorAll('th, td').forEach(td => cells.push(td.textContent.trim()));
      if (cells.length > 0) data.push(cells);
    });
    if (data.length > 0) tables.push({ rows: data.slice(0, 200), count: data.length });
  });
  return tables;
}

// 策略E: 提取布局结构
function extractLayout() {
  const headings = [];
  document.querySelectorAll('h1, h2, h3, h4').forEach(h => {
    headings.push({ level: h.tagName, text: h.textContent.trim().slice(0, 200) });
  });
  const sections = [];
  document.querySelectorAll('article, main, section, div[class*="content"], div[class*="article"], div[class*="post"], div[class*="comment"], div[class*="reply"], div[class*="recommend"]').forEach(el => {
    const t = el.textContent.trim();
    if (t.length > 20) {
      sections.push({
        tag: el.tagName.toLowerCase(),
        classes: Array.from(el.classList).join(' ').slice(0, 80),
        preview: t.slice(0, 80),
        textLength: el.textContent.length,
      });
    }
  });
  return {
    meta: {
      title: document.title,
      url: window.location.href,
      hostname: window.location.hostname,
      type: detectPageType(),
      description: document.querySelector('meta[name="description"]')?.content || '',
      keywords: document.querySelector('meta[name="keywords"]')?.content || '',
    },
    headings: headings.slice(0, 30),
    sections: sections.slice(0, 30),
    stats: {
      textLength: document.body?.textContent?.length || 0,
      imageCount: document.querySelectorAll('img[src]').length,
      linkCount: document.querySelectorAll('a[href]').length,
    },
  };
}

// 策略F: 提取图片
function extractImages() {
  const imgs = [];
  const seen = new Set();
  document.querySelectorAll('img[src]').forEach(img => {
    const src = img.src;
    if (src.startsWith('data:') || src.startsWith('blob:') || seen.has(src)) return;
    seen.add(src);
    imgs.push({ src: src.slice(0, 500), alt: (img.alt || '').slice(0, 100) });
  });
  return imgs.slice(0, 100);
}

// 策略H: 提取内联 script 标签文本（SPA站点的初始数据通常藏在里面）
function extractInlineScripts() {
  const scripts = [];
  document.querySelectorAll('script:not([src])').forEach(s => {
    const t = s.textContent || '';
    if (t.length > 300) {
      // 找像JSON赋值的片段（window.xxx= 或 "xxx":{）
      const hasJson = /window\.[A-Za-z_$][\w$]*\s*=|=[{[]|"thread"|"floor"|"post"/.test(t);
      scripts.push({
        size: t.length,
        hasJson: hasJson,
        preview: t.slice(0, 150).replace(/\s+/g, ' '),
      });
    }
  });
  scripts.sort((a, b) => b.size - a.size);
  return scripts.slice(0, 15);
}

// 策略G: 站点专有解析
function extractSiteSpecific() {
  const type = detectPageType();
  const data = {};
  if (type === 'bilibili_video') {
    const t = document.querySelector('.video-title') || document.querySelector('h1');
    const u = document.querySelector('.up-name') || document.querySelector('[class*="up-name"]');
    data.videoTitle = t?.textContent?.trim() || '';
    data.upName = u?.textContent?.trim() || '';
  }
  if (type === 'tieba') {
    const t = document.querySelector('.core_title_txt') || document.querySelector('h1');
    data.threadTitle = t?.textContent?.trim() || '';
    data.replyCount = document.querySelectorAll('.l_post, .p_post, [class*="post"]').length;
  }
  if (type === 'douyin_biz') {
    // 千川数据：统计周期
    const m = document.body.textContent.match(/统计周期[：:]\s*([^\n]+)/);
    if (m) data.statPeriod = m[1].trim().slice(0, 50);
    // 总记录数
    const c = document.body.textContent.match(/共\s*(\d+)\s*条记录/);
    if (c) data.totalRecords = parseInt(c[1]);
  }
  return data;
}

// ========== 4. 滚动懒加载 ==========

async function scrollToLoad(maxSteps = 10) {
  const step = Math.max(window.innerHeight * 0.7, 400);
  const maxScroll = document.body.scrollHeight || document.documentElement.scrollHeight;
  let scrolled = 0;
  const limit = Math.min(maxScroll, step * maxSteps);
  while (scrolled < limit) {
    window.scrollBy(0, step);
    scrolled += step;
    await new Promise(r => setTimeout(r, 500));
  }
  window.scrollTo(0, 0);
}

// 找出所有可能滚动的容器（window / body / overflow容器）——顶层函数，供多个收集器共用
function findScrollContainers() {
  const found = [];
  const se = document.scrollingElement || document.documentElement;
  const isWindowScrollable = se && se.scrollHeight > se.clientHeight + 50;
  if (isWindowScrollable) found.push({ el: se, type: 'scrollingElement', sh: se.scrollHeight, ch: se.clientHeight });
  if (document.body && document.body !== se && document.body.scrollHeight > document.body.clientHeight + 50) {
    found.push({ el: document.body, type: 'body', sh: document.body.scrollHeight, ch: document.body.clientHeight });
  }
  // 检查 overflow 容器（只查大容器，避免性能问题）
  const all = document.querySelectorAll('div, main, section, ul, ol');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el.clientHeight < 150) continue;
    let cs = null;
    try { cs = getComputedStyle(el); } catch (e) { continue; }
    const oy = cs.overflowY || cs.overflow;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 100) {
      found.push({ el, type: 'container', sh: el.scrollHeight, ch: el.clientHeight, cls: String(el.className || el.id || '').slice(0, 50) });
    }
  }
  return found;
}

// 滚动分屏收集：对抗虚拟滚动（DOM回收视口外内容）
// 每滚一屏提取一次全文，最后按行去重合并，保证拿到所有懒加载出的楼层
async function collectScrolledText(maxSteps = 30) {
  const step = Math.max(window.innerHeight * 0.8, 500);
  const seenLines = new Set();
  const mergedLines = [];
  const scrollTrace = [];
  const scrollInfo = [];

  function snapshot() {
    const text = extractFullText();
    const lines = text.split('\n');
    for (const raw of lines) {
      const t = raw.trim();
      if (!t) continue;
      if (t.length < 2) continue;
      if (!seenLines.has(t)) {
        seenLines.add(t);
        mergedLines.push(t);
      }
    }
  }

  const containers = findScrollContainers();
  containers.forEach(c => scrollInfo.push({ type: c.type, scrollHeight: c.sh, clientHeight: c.ch, cls: c.cls || '' }));

  snapshot();  // 第一屏
  let guard = 0;
  let lastY = -1;
  while (guard < maxSteps) {
    guard++;
    // 方式1: 直接设置 scrollTop（绕过 scrollBy / scroll-behavior 限制）
    const se = document.scrollingElement || document.documentElement;
    try { se.scrollTop += step; } catch (e) {}
    try { document.body.scrollTop += step; } catch (e) {}
    // 方式2: 容器 scrollTop
    containers.forEach(c => { try { c.el.scrollTop += step; } catch (e) {} });
    // 方式3: 派发 wheel 事件（部分懒加载依赖真实滚轮事件）
    const mid = document.elementFromPoint(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight * 0.7));
    if (mid) {
      try { mid.dispatchEvent(new WheelEvent('wheel', { deltaY: step, bubbles: true, cancelable: true })); } catch (e) {}
    }
    await new Promise(r => setTimeout(r, 700));  // 等懒加载
    snapshot();

    const curY = se.scrollTop;
    const maxScrollTop = Math.max(se.scrollHeight, document.body.scrollHeight) - window.innerHeight;
    scrollTrace.push({ y: curY, sh: se.scrollHeight });

    // 到底了（window 或任何容器滚到底且高度不再增长）
    const bottomReached = curY >= maxScrollTop - 30;
    const containerBottom = containers.every(c => c.el.scrollTop + c.el.clientHeight >= c.el.scrollHeight - 30);
    if (bottomReached || (containers.length > 0 && containerBottom)) break;
    // 完全没滚动且没有内部容器 → 滚动可能被页面禁用，放弃
    if (curY === lastY && containers.length === 0) break;
    lastY = curY;
  }
  // 复位
  try { window.scrollTo(0, 0); } catch (e) {}
  try { document.body.scrollTop = 0; } catch (e) {}

  return { text: mergedLines.join('\n'), scrollTrace: scrollTrace, scrollInfo: scrollInfo };
}

// ===== 静默瞬移滚动：scrollTop 大跳（无滚轮动画），快速完成，视觉干扰最小 =====
// 页面加载早期执行，用户刚打开页面时已跑完
async function silentScrollCollect(maxSteps = 80) {
  const step = Math.max(Math.min(window.innerHeight * 0.7, 800), 400);  // 700-800px/步，别跳太快
  const seenLines = new Set();
  const mergedLines = [];
  const scrollInfo = [];
  const floorMap = new Map();  // 楼号 -> 楼层数据（累积，防虚拟滚动回收丢失）

  function snapshot() {
    const text = extractFullText();
    const lines = text.split('\n');
    for (const raw of lines) {
      const t = raw.trim();
      if (!t || t.length < 2) continue;
      if (!seenLines.has(t)) {
        seenLines.add(t);
        mergedLines.push(t);
      }
    }
    // 同时累积结构化楼层（每次快照都提取，按楼号去重合并）
    try {
      const floors = extractTiebaFloors();
      for (const f of floors) {
        if (f.floor && !floorMap.has(f.floor)) floorMap.set(f.floor, f);
      }
    } catch (e) {}
  }

  const se = document.scrollingElement || document.documentElement;
  const allContainers = findScrollContainers();
  // 排除右侧栏/侧边栏等辅助容器（不参与滚动和到底判断，避免误判提前结束）
  const mainContainers = allContainers.filter(c => !/right|aside|side/.test(c.cls || ''));
  const containers = mainContainers.length > 0 ? mainContainers : allContainers;
  allContainers.forEach(c => scrollInfo.push({ type: c.type, scrollHeight: c.sh, clientHeight: c.ch, cls: c.cls || '' }));

  snapshot();
  let guard = 0;
  let idleRounds = 0;  // 到底后多试几轮，触发"到底加载下一页"
  while (guard < maxSteps) {
    guard++;
    try { se.scrollTop += step; } catch (e) {}
    try { document.body.scrollTop += step; } catch (e) {}
    containers.forEach(c => { try { c.el.scrollTop += step; } catch (e) {} });
    // 派发 wheel 事件到主滚动容器（部分懒加载依赖真实滚轮事件）
    const target = containers[0] ? containers[0].el : document.elementFromPoint(Math.floor(window.innerWidth / 2), Math.floor(window.innerHeight * 0.7));
    if (target) {
      try { target.dispatchEvent(new WheelEvent('wheel', { deltaY: step, bubbles: true, cancelable: true })); } catch (e) {}
    }
    await new Promise(r => setTimeout(r, 400));  // 400ms 让懒加载跟上
    snapshot();

    // 到底判断（window 可滚时才判 window；主容器为准）
    const windowScrollable = se.scrollHeight > se.clientHeight + 50;
    const windowBottom = windowScrollable && (se.scrollTop + window.innerHeight >= se.scrollHeight - 30);
    const containerBottom = containers.length > 0 && containers.every(c => c.el.scrollTop + c.el.clientHeight >= c.el.scrollHeight - 30);
    const atBottom = windowBottom || containerBottom;
    if (atBottom) {
      idleRounds++;
      // 到底后多等几轮（懒加载可能延迟），高度增长则继续滚
      await new Promise(r => setTimeout(r, 500));
      snapshot();
      if (idleRounds >= 4) break;
    } else {
      idleRounds = 0;
    }
  }
  try { se.scrollTop = 0; } catch (e) {}
  try { document.body.scrollTop = 0; } catch (e) {}
  containers.forEach(c => { try { c.el.scrollTop = 0; } catch (e) {} });

  const floors = [...floorMap.values()].sort((a, b) => (a.floor || 0) - (b.floor || 0));
  return { text: mergedLines.join('\n'), scrollInfo: scrollInfo, floors: floors };
}

// ===== 贴吧移动版接口直拉（带浏览器 cookie，同源请求，免滚动） =====
function getTiebaTid() {
  const m = window.location.href.match(/tieba\.baidu\.com\/p\/(\d+)/);
  return m ? m[1] : null;
}

// 探测：fetch 移动版接口，确认能否拿到完整楼层
async function probeTiebaApi(tid) {
  const results = [];
  const urls = [
    `https://tieba.baidu.com/mo/q/thread?tid=${tid}&pn=1`,
    `https://tieba.baidu.com/p/${tid}?see_lz=0&pn=1`,
  ];
  for (const url of urls) {
    try {
      const resp = await fetch(url, { headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
      const html = await resp.text();
      // 判断是否含楼层数据（楼层号/内容/下一页标记）
      const hasFloor = /第\d+楼|reply_content|d_post_content|floor_num|post_content|post_list|p_post/.test(html);
      results.push({
        url: url.slice(0, 80),
        status: resp.status,
        len: html.length,
        hasFloor: hasFloor,
        preview: html.slice(0, 200).replace(/\s+/g, ' '),
        sample: html.slice(0, 8000),  // 样本带回来分析结构
      });
    } catch (e) {
      results.push({ url: url.slice(0, 80), error: e.message });
    }
  }
  return results;
}

// ===== 小黑盒评论拉取（优先读页面真实请求的拦截记录；自己 fetch 会触发 show_captcha） =====
function findXiaoheiheTreeRecord() {
  for (const r of apiRecords) {
    const u = r.url || '';
    if (u.includes('/link/tree') && (r.responseBody || '').length > 500) {
      return r;
    }
  }
  return null;
}

async function fetchXiaoheiheComments() {
  try {
    // 1. 直接读拦截到的页面真实响应（完整评论 JSON）
    let rec = findXiaoheiheTreeRecord();
    if (!rec) {
      // 2. 等待页面响应到达（最多 8 秒）
      for (let attempt = 0; attempt < 16 && !rec; attempt++) {
        await new Promise(res => setTimeout(res, 500));
        rec = findXiaoheiheTreeRecord();
      }
    }
    if (rec) {
      try {
        const parsed = JSON.parse(rec.responseBody);
        if (parsed && parsed.result && (parsed.result.comments || parsed.result.topics)) return parsed;
      } catch (e) {}
    }
    // 3. 最后兜底：自己 fetch（大概率被风控，仅尝试）
    const m = window.location.href.match(/xiaoheihe\.cn\/app\/bbs\/link\/(\d+)/);
    if (!m) return null;
    const params = new URLSearchParams({
      app: 'heybox', os_type: 'web', x_app: 'heybox_website',
      x_client_type: 'web', x_os_type: 'Windows',
      client_type: 'web', web_version: '3.0',
      link_id: m[1],
    });
    const resp = await fetch(`https://api.xiaoheihe.cn/bbs/app/link/tree?${params}`, {
      headers: { 'Accept': 'application/json', 'Referer': window.location.href },
    });
    return await resp.json();
  } catch (e) {
    return { error: e.message };
  }
}

// ===== 通用列表/评论区检测：找 DOM 中重复结构的兄弟块（楼层、评论、卡片） =====
function detectRepeatedBlocks() {
  const result = [];
  const classCount = new Map();
  const all = document.querySelectorAll('div, li, article, section');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (el.children.length < 1) continue;
    const cls = typeof el.className === 'string' ? el.className.trim() : '';
    if (!cls || cls.length > 100) continue;
    const key = cls.split(/\s+/).filter(Boolean).sort().join('.');
    if (!classCount.has(key)) classCount.set(key, []);
    classCount.get(key).push(el);
  }
  for (const [key, els] of classCount) {
    if (els.length < 3) continue;
    const texts = els.slice(0, 6).map(e => (e.textContent || '').trim());
    const meaningful = texts.filter(t => t.length > 10);
    if (meaningful.length >= 3) {
      result.push({
        className: key.slice(0, 100),
        count: els.length,
        sample: meaningful.slice(0, 3).map(t => t.slice(0, 80)),
      });
    }
  }
  result.sort((a, b) => b.count - a.count);
  return result.slice(0, 10);
}

// 贴吧楼层解析：按贴吧新版组件的 class 精准提取已渲染楼层（配合滚动可拿全）
function extractTiebaFloors() {
  const floors = [];
  const descs = document.querySelectorAll('.comment-desc-left');
  for (const desc of descs) {
    try {
      // 楼层容器：从 desc 向上找最近的 comment/post 类祖先
      let container = desc;
      for (let i = 0; i < 6; i++) {
        const parent = container.parentElement;
        if (!parent) break;
        container = parent;
        const cls = String(parent.className || '');
        if (cls.includes('comment') || cls.includes('post') || cls.includes('floor')) break;
      }
      const text = (container ? container.textContent : desc.textContent) || '';
      const floorMatch = String(desc.textContent || '').match(/第(\d+)楼/);
      floors.push({
        floor: floorMatch ? parseInt(floorMatch[1]) : null,
        desc: (desc.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
        text: text.replace(/\s+/g, ' ').trim().slice(0, 2000),
      });
    } catch (e) {}
  }
  floors.sort((a, b) => (a.floor || 0) - (b.floor || 0));
  return floors;
}

// ===== 自动点击"加载更多/查看更多"按钮（MutationObserver 监听，通用分页） =====
function startLoadMoreClicker(maxMs = 15000) {
  if (window.__HERMES_LOAD_MORE_CLICKER) return;
  window.__HERMES_LOAD_MORE_CLICKER = true;
  const CLICKED = new Set();
  const TRIGGERS = ['加载更多', '查看更多', '展开更多', '点击加载', '继续加载', '显示更多', '查看全部回复', 'load more', '查看更多回复', '展开', '下一页'];
  let clicks = 0;
  const MAX_CLICKS = 20;

  function tryClick() {
    if (clicks >= MAX_CLICKS) return;
    const all = document.querySelectorAll('button, a, div, span, li');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (CLICKED.has(el)) continue;
      const t = (el.textContent || '').trim();
      if (!t || t.length > 15) continue;  // 只认短文本按钮
      if (!TRIGGERS.some(tr => t.includes(tr))) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) continue;  // 隐藏元素跳过
      CLICKED.add(el);
      clicks++;
      try { el.click(); } catch (e) {}
      break;  // 一次点一个，MutationObserver 会继续
    }
  }

  try {
    tryClick();
    const observer = new MutationObserver(() => { tryClick(); });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { try { observer.disconnect(); } catch (e) {} }, maxMs);
  } catch (e) {}
}

// ========== 5. 主捕获函数 ==========

// 验证码/风控页检测：命中时标记 captcha，不采集正文（agent 端改走 computer_use 读已渲染页面）
const CAPTCHA_KEYWORDS = ['安全验证', '请输入验证码', '拖动滑块', '请完成验证', '尝试太多了', '人机验证', 'captcha', 'verify', '滑动验证'];
function detectCaptchaPage() {
  try {
    const text = (document.body?.textContent || '').slice(0, 20000);
    const hasCaptchaText = CAPTCHA_KEYWORDS.some(k => text.includes(k));
    if (!hasCaptchaText) return false;
    // 验证码关键词可能出现在正文里，需要辅助证据：验证码 iframe / 验证码元素 / 页面极短（纯验证码页）
    const hasCaptchaFrame = !!document.querySelector('iframe[src*="captcha"], iframe[src*="gtimg"], iframe[src*="geetest"], iframe[src*="verify"], iframe[src*="turing"]');
    const hasCaptchaEl = !!document.querySelector('[class*="captcha"], [class*="verify"], #captcha, [id*="captcha"], [class*="slider"]');
    return hasCaptchaFrame || hasCaptchaEl || text.length < 2000;
  } catch (e) { return false; }
}

async function capturePage() {
  // 注入 API 拦截器（document_start 时已尝试，这里再确保）
  injectInterceptor();
  
  // 等待页面稳定
  if (document.readyState !== 'complete') {
    await new Promise(r => window.addEventListener('load', r));
  }
  await new Promise(r => setTimeout(r, 500));

  // 验证码/风控页：不采集正文，标记 captcha 供 agent 判断
  if (detectCaptchaPage()) {
    return {
      timestamp: new Date().toISOString(),
      url: window.location.href,
      title: document.title,
      pageType: 'captcha',
      site: detectSite(),
      mainText: '',
      captcha: true,
    };
  }

  // 滚动触发懒加载（分屏收集，对抗虚拟滚动）
  // 按站点选择采集策略：贴吧一律免滚动（完整楼层由 agent 端 tieba_fetch.py 拉 API，插件不滚动避免打扰用户）
  const siteName = detectSite();
  let tiebaApi = null;
  let xiaoheiheApi = null;
  if (siteName === 'tieba') {
    const tid = getTiebaTid();
    if (tid) {
      // 探测移动版接口（仅记录结果供 agent 参考，不再决定是否滚动——贴吧 V2.1 起一律免滚动）
      tiebaApi = await probeTiebaApi(tid);
      startLoadMoreClicker();
    }
  }
  if (siteName === 'xiaoheihe') {
    xiaoheiheApi = await fetchXiaoheiheComments();
  }
  // 采集策略：贴吧一律免滚动快速提取（完整楼层由 agent 端 tieba_fetch.py 拉 API）；
  //          其他站点 → 通用滚动分屏收集
  let collected;
  if (siteName === 'tieba') {
    collected = { text: extractFullText(), scrollInfo: null, scrollTrace: null, floors: extractTiebaFloors() };
  } else {
    collected = await collectScrolledText(30);
  }
  const collectedText = collected.text;
  const scrollInfo = collected.scrollInfo || null;
  const scrollTrace = collected.scrollTrace || null;
  const tiebaFloors = collected.floors || (siteName === 'tieba' ? extractTiebaFloors() : []);

  // 尝试主动调用千川 API 拉全量数据
  let qianchuanData = null;
  try {
    qianchuanData = await callQianchuanApi();
  } catch(e) {}

  // 收集所有数据
  const pageData = {
    timestamp: new Date().toISOString(),
    url: window.location.href,
    title: document.title,
    pageType: detectPageType(),
    site: detectSite(),  // tieba / qianchuan / generic
    mainText: collectedText,
    images: extractImages(),
    layout: extractLayout(),
    siteSpecific: extractSiteSpecific(),
    tables: extractHtmlTables(),
    virtualRows: extractVirtualTable(),
    keyHtml: extractKeyHtml(),
    inlineScripts: extractInlineScripts(),
    repeatedBlocks: detectRepeatedBlocks(),  // 通用列表/评论区检测
    tiebaFloors: tiebaFloors,  // 贴吧楼层精准解析（累积去重）
    tiebaApi: tiebaApi,  // 贴吧移动版接口探测（免滚动拿完整楼层的关键）
    xiaoheiheApi: xiaoheiheApi,  // 小黑盒评论API（带cookie直拉）
    scrollInfo: scrollInfo,
    scrollTrace: scrollTrace,
    apiRecords: apiRecords.slice(-50),
    jsonpRecords: jsonpRecords.slice(-10),  // JSONP 静默捕获的数据
    pageGlobals: pageGlobals,  // 页面主世界内嵌JSON（SPA的完整数据源）
    qianchuanApiData: qianchuanData,  // 千川 API 全量数据
  };
  return pageData;
}

// 站点识别
function detectSite() {
  const u = window.location.href;
  if (u.includes('tieba.baidu.com/p/')) return 'tieba';
  if (u.includes('qianchuan.jinritemai.com')) return 'qianchuan';
  if (u.includes('bilibili.com')) return 'bilibili';
  if (u.includes('xiaoheihe.cn') || u.includes('api.xiaoheihe.cn')) return 'xiaoheihe';
  if (u.includes('douyin.com')) return 'douyin';
  return 'generic';
}

// ===== 内容去重：同 URL 正文无变化时发轻量心跳（省带宽、不污染历史） =====
let lastContentHash = null;  // 当前标签页上次捕获的正文 hash

function simpleHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return String(h >>> 0);
}

// 快速捕获（用于自动背景捕获）
async function captureQuick() {
  injectInterceptor();

  // 验证码/风控页：快速捕获同样跳过正文
  if (detectCaptchaPage()) {
    return {
      timestamp: new Date().toISOString(),
      url: window.location.href,
      title: document.title,
      pageType: 'captcha',
      site: detectSite(),
      mainText: '',
      captcha: true,
    };
  }

  // 内容去重：同一 URL 的 mainText 无变化 → 轻量心跳（background 不覆盖历史）
  const quickText = extractFullText();
  const hash = simpleHash(quickText.slice(0, 50000));
  if (lastContentHash !== null && lastContentHash === hash) {
    return {
      timestamp: new Date().toISOString(),
      url: window.location.href,
      title: document.title,
      pageType: detectPageType(),
      site: detectSite(),
      unchanged: true,
      contentHash: hash,
    };
  }
  lastContentHash = hash;

  const pageData = {
    timestamp: new Date().toISOString(),
    url: window.location.href,
    title: document.title,
    pageType: detectPageType(),
    site: detectSite(),
    mainText: quickText,
    layout: extractLayout(),
    siteSpecific: extractSiteSpecific(),
    tables: extractHtmlTables(),
    virtualRows: extractVirtualTable(),
    inlineScripts: extractInlineScripts(),
    repeatedBlocks: detectRepeatedBlocks(),
    tiebaFloors: detectSite() === 'tieba' ? extractTiebaFloors() : [],
    xiaoheiheApi: detectSite() === 'xiaoheihe' ? await fetchXiaoheiheComments() : null,
    apiRecords: apiRecords.slice(-20),
    jsonpRecords: jsonpRecords.slice(-10),
    pageGlobals: pageGlobals,
  };
  return pageData;
}

// ========== 6. 主动调用千川数据 API ==========

async function callQianchuanApi() {
  // 从最近的 API 记录中拿到 statQuery 的请求体
  const statQueryRecord = apiRecords.find(r => r.url.includes('roi2_material') && r.url.includes('statQuery'));
  if (!statQueryRecord || !statQueryRecord.requestBody) return null;

  try {
    const reqBody = JSON.parse(statQueryRecord.requestBody);
    // 把 Limit 改成 500 一次性拉取
    reqBody.PageParams = { ...reqBody.PageParams, Limit: 500, Offset: 0 };
    
    const url = statQueryRecord.url.startsWith('http') 
      ? statQueryRecord.url 
      : window.location.origin + statQueryRecord.url;
    
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
    });
    const json = await resp.json();
    return json;
  } catch (e) {
    console.log('[Hermes] 主动调API失败:', e.message);
    return null;
  }
}

// ========== 7. 消息监听 ==========

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'capture') {
    capturePage().then(data => sendResponse(data));
    return true;
  }
  if (request.action === 'captureQuick') {
    captureQuick().then(data => sendResponse(data));
    return true;
  }
  return true;
});

// ========== 7. 初始化（document_start 时立即注入拦截器） ==========
injectInterceptor();

// 贴吧帖子页自动深度捕获由 background.js 驱动（onUpdated → captureTab(deep)）
// 此处不再自行调度，避免与 background 双跑
function isTiebaThreadPage() {
  const u = window.location.href;
  return u.includes('tieba.baidu.com/p/');
}

// ========== 8. SPA 路由切换检测（任务5：pushState/replaceState/popstate 触发重捕获） ==========
// SPA 站（贴吧只看楼主、千川切 tab 等）URL 变化不触发 tabs.onUpdated，
// 这里 hook history API，URL 变化后通知 background 重新捕获
(function hookSpaRouting() {
  let lastUrl = window.location.href;

  function notifyUrlChanged() {
    const url = window.location.href;
    if (url === lastUrl) return;
    lastUrl = url;
    try {
      chrome.runtime.sendMessage({ action: 'spaRouteChanged', url: url });
    } catch (e) {}
  }

  try {
    // hook pushState / replaceState（SPA 内部跳转主要走这里）
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function() {
      const ret = origPush.apply(this, arguments);
      setTimeout(notifyUrlChanged, 0);
      return ret;
    };
    history.replaceState = function() {
      const ret = origReplace.apply(this, arguments);
      setTimeout(notifyUrlChanged, 0);
      return ret;
    };
    // 浏览器前进/后退（popstate）与 hash 变化
    window.addEventListener('popstate', notifyUrlChanged);
    window.addEventListener('hashchange', notifyUrlChanged);
  } catch (e) {}
})();