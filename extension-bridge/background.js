// browser-bridge background service worker
// 职责：接收 popup 的"拉取"请求，向当前 tab 注入抓取脚本，
// 把结果 POST 到本地 Hermes server。

const DEFAULTS = { host: "http://127.0.0.1:4399", token: "" };

async function getBridgeConfig() {
  const saved = await chrome.storage.local.get("bridgeConfig");
  return { ...DEFAULTS, ...(saved.bridgeConfig || {}) };
}

async function pushToHermes(page) {
  const cfg = await getBridgeConfig();
  const resp = await fetch(`${cfg.host}/api/page`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bridge-Token": cfg.token,
    },
    body: JSON.stringify(page),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Hermes server 返回 ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "PING") {
    // 扩展是否存活
    sendResponse({ ok: true, name: "browser-bridge-ext" });
    return false;
  }

  if (msg?.type === "FETCH_PAGE") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("没有找到当前标签页");
      const url = tab.url || "";
      if (!/tieba\.baidu\.com|(^|\.)xiaoheihe\.cn/.test(url)) {
        throw new Error("当前页面不是贴吧或小黑盒，不抓取。");
      }
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractPage,
      });
      const page = results?.[0]?.result;
      if (!page) throw new Error("抓取脚本没有返回内容");
      const resp = await pushToHermes(page);
      const out = { ok: true, pushed: resp, url, blocks: page.content?.length ?? 0 };
      await chrome.storage.local.set({ lastResult: { ...out, at: Date.now() } });
      sendResponse(out);
    })().catch(async (err) => {
      const out = { ok: false, error: String(err?.message || err) };
      await chrome.storage.local.set({ lastResult: { ...out, at: Date.now() } });
      sendResponse(out);
    });
    return true; // 异步响应
  }

  return false;
});

// 在目标页面上下文执行的抓取函数（M2 简化版：抓可见 DOM 文本；
// M3 换贴吧 API 全量抓取）。
function extractPage() {
  const url = location.href;
  const title = document.title || "";
  const site = /tieba\.baidu\.com/.test(url) ? "tieba" : "xiaoheihe";

  // 通用文本提取：去掉 script/style/nav，拿正文
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll("script,style,noscript,iframe,nav,header,footer").forEach((n) => n.remove());
  const text = (clone.innerText || "").replace(/\n{3,}/g, "\n\n").trim();

  const blocks = [];
  if (site === "tieba") {
    // 贴吧：按楼层容器切块
    document.querySelectorAll(".d_post_content").forEach((el, i) => {
      blocks.push({
        type: "floor",
        floor: i + 1,
        author: el.closest(".l_post")?.getAttribute("data-field")
          ? "未知"
          : "未知",
        text: (el.innerText || "").trim(),
      });
    });
  }
  if (!blocks.length) {
    blocks.push({ type: "text", floor: 0, author: "", text: text.slice(0, 30000) });
  }

  return {
    site,
    url,
    title,
    fetched_at: new Date().toISOString(),
    content: blocks,
  };
}
