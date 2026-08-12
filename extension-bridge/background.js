// browser-bridge background service worker
// 职责：存活探测（PING）。实际抓取流程由 popup.js 直接执行
// （executeScript + push），本文件不再承载抓取逻辑。
// 保留的原因：MV3 manifest 需要 service_worker；PING 供调试/状态检查。

const DEFAULTS = { host: "http://127.0.0.1:4399", token: "" };

async function getBridgeConfig() {
  const saved = await chrome.storage.local.get("bridgeConfig");
  return { ...DEFAULTS, ...(saved.bridgeConfig || {}) };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "PING") {
    sendResponse({ ok: true, name: "browser-bridge-ext" });
    return false;
  }
  if (msg?.type === "GET_CONFIG") {
    (async () => {
      sendResponse({ ok: true, config: await getBridgeConfig() });
    })();
    return true;
  }
  return false;
});
