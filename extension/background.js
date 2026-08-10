// background.js — 通用网页抓取引擎后台
// 监听页面变化，调用 content script 捕获数据，发送到本地服务

const LOCAL_SERVER = 'http://127.0.0.1:8765';

// 默认配置（可从 storage 覆盖）
const DEFAULT_CONFIG = {
  autoCapture: true,
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
async function captureTab(tabId, isDeep = false) {
  const config = await getConfig();
  if (!config.autoCapture) return;

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

    const data = trimData(raw);
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
    // 手动触发：深度捕获（滚动+延迟+API）
    captureTab(request.tabId || sender.tab?.id, !!request.deep);
    sendResponse({ ok: true });
  }
  return true;
});