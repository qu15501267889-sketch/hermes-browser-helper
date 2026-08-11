// background.js — 通用网页抓取引擎后台
// 监听页面变化，调用 content script 捕获数据，发送到本地服务

const LOCAL_SERVER = 'http://127.0.0.1:8765';

// 默认配置（可从 storage 覆盖）
const DEFAULT_CONFIG = {
  autoCapture: false,       // V2.1: 默认手动模式（只有用户点 popup 按钮才捕获）；打开开关可恢复自动
  serverUrl: LOCAL_SERVER,
  captureDelay: 4000,      // 延迟 4 秒等 JS 渲染
  deepCapture: true,
};

async function getConfig() {
  const stored = await chrome.storage.local.get('hermes_config');
  return { ...DEFAULT_CONFIG, ...(stored.hermes_config || {}) };
}

function isWorthSaving(url) {
  if (!url) return false;
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')
    || url.startsWith('edge://') || url.startsWith('about:')
    || url.startsWith('devtools://') || url.startsWith('file://')
    || url.startsWith('moz-extension://')) return false;
  return true;
}

// 发送数据到本地服务
async function sendToServer(data) {
  const config = await getConfig();
  try {
    const resp = await fetch(`${config.serverUrl}/api/page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (resp.ok) console.log('[Hermes] 已发送:', data.title?.slice(0, 40));
  } catch (e) {
    // 服务未启动是正常情况
  }
}

// 存扩展 storage
async function saveToStorage(data) {
  try {
    await chrome.storage.local.set({ hermes_latest_page: { data, timestamp: Date.now() } });
  } catch (e) {}
}

// 精简数据
function trimData(raw) {
  return {
    timestamp: raw.timestamp,
    url: raw.url,
    title: raw.title,
    pageType: raw.pageType,
    site: raw.site || 'generic',
    mainText: (raw.mainText || '').slice(0, 100000),
    images: (raw.images || []).slice(0, 50),
    layout: raw.layout,
    siteSpecific: raw.siteSpecific || {},
    tables: (raw.tables || []).slice(0, 5),
    virtualRows: (raw.virtualRows || []).slice(0, 200),
    keyHtml: (raw.keyHtml || []).slice(0, 3),
    inlineScripts: (raw.inlineScripts || []).slice(0, 15),
    repeatedBlocks: (raw.repeatedBlocks || []).slice(0, 10),
    tiebaFloors: (raw.tiebaFloors || []).slice(0, 500),
    tiebaApi: raw.tiebaApi || null,
    xiaoheiheApi: raw.xiaoheiheApi || null,
    scrollInfo: raw.scrollInfo || null,
    scrollTrace: raw.scrollTrace || null,
    screenshotPath: raw.screenshotPath || null,  // 截图文件路径（深度捕获时附带）
    apiRecords: (raw.apiRecords || []).slice(-30).map(r => {
      const u = r.url || '';
      const isDataApi = u.includes('/statQuery') || u.includes('/material') || u.includes('roi2_material') || u.includes('link/tree');
      return {
        url: u.slice(0, 300),
        method: r.method,
        status: r.status,
        requestBody: (r.requestBody || '').slice(0, 2000),
        responseBody: (r.responseBody || '').slice(0, isDataApi ? 500000 : 2000),
      };
    }),
    jsonpRecords: (raw.jsonpRecords || []).slice(-10),
    pageGlobals: raw.pageGlobals || null,  // 页面主世界内嵌JSON
    qianchuanApiData: raw.qianchuanApiData || null,
  };
}

// 捕获标签页
// force=true 表示手动触发（popup 按钮），绕过 autoCapture 开关；自动触发（onUpdated/onActivated/spaRouteChanged）受开关控制
async function captureTab(tabId, isDeep = false, force = false) {
  const config = await getConfig();
  if (!config.autoCapture && !force) return;

  // 跳过内部页
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !isWorthSaving(tab.url)) return;
  } catch (e) { return; }

  // 自动捕获 = 快速模式（不滚动页面，避免打扰用户浏览）
  // 深度捕获 = 手动触发（滚动+延迟+API调用）
  const delay = isDeep ? config.captureDelay : 300;
  await new Promise(r => setTimeout(r, delay));

  try {
    const action = isDeep ? 'capture' : 'captureQuick';
    const raw = await chrome.tabs.sendMessage(tabId, { action });
    if (!raw || !raw.title) return;

    // 轻量心跳（内容无变化）：不覆盖历史，跳过发送
    if (raw.unchanged) {
      console.log('[Hermes] 内容无变化，跳过:', raw.url?.slice(0, 40));
      return;
    }

    const data = trimData(raw);

    // 截图（深度捕获时自动附带）：POST 到 server /api/screenshot，单独存 PNG 文件，
    // 避免 dataURL 撑爆 latest_page.json；pageData 只留路径标记供 agent 读取
    if (isDeep) {
      try {
        const screenshot = await chrome.tabs.captureVisibleTab(tabId, { format: 'png', quality: 70 });
        const config2 = await getConfig();
        const shotResp = await fetch(`${config2.serverUrl}/api/screenshot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            imageDataUrl: screenshot,
            title: data.title,
            url: data.url,
            site: data.site,
            timestamp: data.timestamp,
          }),
        });
        // server 返回实际保存路径（如 ~/Downloads/hermes-browser-page/screenshot.png）
        const shotJson = await shotResp.json().catch(() => ({}));
        data.screenshotPath = shotJson.path || '';
      } catch (e) {
        console.log('[Hermes] 截图失败:', e.message?.slice(0, 60));
      }
    }

    await sendToServer(data);
    await saveToStorage(data);
  } catch (e) {
    console.log('[Hermes] 捕获状态:', e.message?.slice(0, 60) || 'ok');
  }
}

// 监听标签页切换和加载
// 贴吧帖子页：只走 onUpdated 的深度捕获（静默滚动收集楼层），快速捕获跳过（避免覆盖深度结果）
chrome.tabs.onActivated.addListener((info) => {
  maybeCapture(info.tabId, false);
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' && tab.url && isWorthSaving(tab.url)) {
    const isTieba = tab.url.includes('tieba.baidu.com/p/');
    maybeCapture(tabId, isTieba);
  }
});

async function maybeCapture(tabId, isDeep) {
  try {
    const tab = await chrome.tabs.get(tabId);
    // 贴吧帖子页的快速捕获一律跳过（内容由深度捕获负责，避免覆盖深度结果）
    if (!isDeep && tab.url && tab.url.includes('tieba.baidu.com/p/')) return;
  } catch (e) {}
  captureTab(tabId, isDeep);
}

// 监听消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getStatus') {
    sendResponse({ ok: true });
  }
  if (request.action === 'saveCapture') {
    sendToServer(request.data);
    saveToStorage(request.data);
    sendResponse({ ok: true });
  }
  if (request.action === 'triggerCapture') {
    // 手动触发：深度/快速捕获（force=true 绕过 autoCapture 开关）
    captureTab(request.tabId || sender.tab?.id, !!request.deep, true);
    sendResponse({ ok: true });
  }
  if (request.action === 'spaRouteChanged') {
    // SPA 路由变化（pushState/replaceState/popstate）：延迟等新路由渲染后重新捕获
    const tabId = sender.tab?.id;
    if (tabId) {
      const isTieba = (request.url || '').includes('tieba.baidu.com/p/');
      setTimeout(() => captureTab(tabId, isTieba), isTieba ? 2500 : 800);  // captureTab 内部检查 autoCapture
    }
    sendResponse({ ok: true });
  }
  return true;
});