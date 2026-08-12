// browser-bridge popup 逻辑（M3 正式版：贴吧 API 分页全量抓取）
const btn = document.getElementById("btn");
const status = document.getElementById("status");
const detail = document.getElementById("detail");

// 默认配置；用户可在 popup 设置里覆盖（存 chrome.storage）
const DEFAULTS = { host: "http://127.0.0.1:4399", token: "" };

function setStatus(text, color) {
  status.textContent = text;
  status.style.color = color || "#666";
}

async function getBridgeConfig() {
  const saved = await chrome.storage.local.get("bridgeConfig");
  return { ...DEFAULTS, ...(saved.bridgeConfig || {}) };
}

async function pushToHermes(page) {
  const cfg = await getBridgeConfig();
  const resp = await fetch(`${cfg.host}/api/page`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bridge-Token": cfg.token },
    body: JSON.stringify(page),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Hermes server 返回 ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

btn.addEventListener("click", async () => {
  btn.disabled = true;
  setStatus("正在抓取并推送…", "#4a6cf7");
  detail.textContent = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("没有找到当前标签页");
    const url = tab.url || "";
    if (!/tieba\.baidu\.com|xiaoheihe\.cn/.test(url)) {
      throw new Error("当前页面不是贴吧或小黑盒，不抓取。");
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPage,
      world: "MAIN",
    });
    const page = results?.[0]?.result;
    if (!page) throw new Error("抓取脚本没有返回内容");
    const resp = await pushToHermes(page);
    setStatus(`✅ 已推送 ${page.content?.length ?? 0} 个内容块`, "#2e7d32");
    detail.textContent = url;
    await chrome.storage.local.set({
      lastResult: { ok: true, blocks: page.content?.length ?? 0, url, at: Date.now() },
    });
  } catch (err) {
    const msg = String(err?.message || err);
    setStatus(`❌ ${msg}`, "#c62828");
    await chrome.storage.local.set({ lastResult: { ok: false, error: msg, at: Date.now() } });
  } finally {
    btn.disabled = false;
  }
});

// ================= M3 正式抓取器：贴吧 API 分页全量 =================
// 注意：executeScript 的 func 会被序列化注入页面，全部辅助函数必须内联在 extractPage 内部。

async function extractPage() {
  const url = location.href;
  const title = document.title || "";
  const site = /tieba\.baidu\.com/.test(url) ? "tieba" : "xiaoheihe";
  const blocks = [];
  const meta = {};

  async function fetchXiaoheiheAll(baseJson, baseUrl) {
    // 基于拦截到的第一页 JSON + 完整 URL，翻页拉全所有评论。
    // 复用页面自己的签名参数（hkey/nonce/_time），只改 page 参数，避免触发风控。
    const allJson = baseJson;
    const result = allJson.result || {};
    const totalPage = result.total_page || 1;
    const pages = [];
    pages.push(allJson);
    for (let p = 2; p <= totalPage; p++) {
      let u = baseUrl;
      try {
        u = u.replace(/([?&])page=\d+/, `$1page=${p}`);
        const resp = await fetch(u, { credentials: "include", headers: { "Accept": "application/json" } });
        if (!resp.ok) break;
        const j = await resp.json();
        if (!j || j.status !== "ok" || !j.result) break;
        pages.push(j);
      } catch (e) {
        break;
      }
    }
    // 合并所有页的 comments
    const merged = { status: "ok", result: { ...result, comments: [] } };
    for (const p of pages) {
      const r = p.result || {};
      const grps = r.comments || [];
      for (const g of grps) {
        for (const c of g.comment || []) {
          merged.result.comments.push({ comment: [c] });
        }
      }
    }
    merged.result.total_page = totalPage;
    return merged;
  }

  function parseXiaoheihe(json) {
    // 小黑盒 link/tree JSON → 帖子 + 评论块
    const result = json.result || {};
    const blocks = [];
    const meta2 = {};
    const imageUrls = [];

    // 1. 帖子正文
    const link = result.link || {};
    let linkText = link.title ? `【${link.title}】\n` : "";
    let desc = link.description || "";
    let textRaw = link.text || "";
    // text 是 JSON 字符串：[{text, type, ...}]，type 含 image（图片）/ text（文字）
    if (typeof textRaw === "string" && textRaw.startsWith("[")) {
      try {
        const arr = JSON.parse(textRaw);
        const parts = [];
        const seenTypes = {};
        for (const x of arr) {
          const t = x.type ?? x.msg_type ?? "?";
          seenTypes[`${t}`] = (seenTypes[`${t}`] || 0) + 1;
          const url = x.origin_url || x.url || x.img_url || x.src || x.image_url || "";
          if (url) {
            imageUrls.push(url);
            parts.push(`[图片](${url})`);
          } else if (x.text) {
            parts.push(x.text);
          } else if (x.c && typeof x.c === "string") {
            parts.push(x.c);
          }
        }
        meta.xhhTextTypes = seenTypes;
        textRaw = parts.join("\n");
      } catch (e) { /* 保持原样 */ }
    }
    linkText += (desc + "\n" + textRaw).trim();
    if (linkText) {
      const postBlock = {
        type: "post", floor: 1,
        author: (link.user && (link.user.username || link.user.name)) || "",
        time: link.create_at ? new Date(link.create_at * 1000).toISOString() : "",
        text: linkText.slice(0, 12000),
      };
      if (imageUrls.length) {
        postBlock.images = imageUrls;
      }
      blocks.push(postBlock);
    }

    // 2. 评论（comments[].comment[] 每层）
    for (const grp of result.comments || []) {
      for (const c of grp.comment || []) {
        const u = c.user || {};
        blocks.push({
          type: "comment",
          floor: c.floor_num || 0,
          author: u.username || u.name || "",
          time: c.create_at ? new Date(c.create_at * 1000).toISOString() : "",
          text: (c.text || "").slice(0, 8000),
        });
      }
    }

    meta2.totalFloors = result.total_floor_num || blocks.length;
    meta2.hasMore = result.has_more_floors || 0;
    meta2.totalPage = result.total_page || 1;
    return { blocks, meta2 };
  }

  function parseFloorItems(doc, sel) {
    const items = sel ? doc.querySelectorAll(sel) : doc.querySelectorAll(".pb-comment-item");
    const out = [];
    items.forEach((el) => {
      const head = el.querySelector(".head-line");
      const author = head?.querySelector(".head-name")?.innerText?.trim() || "";
      let text = (el.innerText || "").trim();
      if (head) text = text.replace((head.innerText || "").trim(), "").trim();
      text = text.replace(/\n{3,}/g, "\n\n").trim();
      out.push({ type: "floor", floor: 0, author, text: text.slice(0, 8000) });
    });
    return out;
  }

  async function fetchTiebaPage(tid, pn) {
    const u = `https://tieba.baidu.com/p/${tid}?pn=${pn}`;
    const resp = await fetch(u, { credentials: "include", headers: { "X-Requested-With": "XMLHttpRequest" } });
    if (!resp.ok) throw new Error(`分页请求失败 pn=${pn}: HTTP ${resp.status}`);
    const html = await resp.text();
    return new DOMParser().parseFromString(html, "text/html");
  }

  function parsePcJson(json) {
    // 解析 page_pc JSON：first_floor + post_list → 楼层块
    const posts = [];
    if (json.first_floor) posts.push(json.first_floor);
    if (Array.isArray(json.post_list)) posts.push(...json.post_list);
    return posts.map((p) => {
      let text = "";
      if (Array.isArray(p.content)) {
        text = p.content.map((c) => (c && (c.text || c.cd_post)) || "").join("");
      } else if (typeof p.content === "string") {
        text = p.content;
      }
      const ts = p.time ? new Date(p.time * 1000).toISOString() : "";
      return {
        type: "floor",
        floor: p.floor || 0,
        author: p.author_name || p.name || "",
        time: ts,
        text: (text || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 8000),
      };
    });
  }

  async function fetchPagePc(pagePcUrl) {
    // 重放页面自己请求过的 page_pc 接口（含正确 sign + cookie）
    const resp = await fetch(pagePcUrl, { credentials: "include" });
    if (!resp.ok) throw new Error(`page_pc 请求失败: HTTP ${resp.status}`);
    return resp.json();
  }

  function probeSelectors(doc, sels) {
    const counts = {};
    for (const s of sels) {
      try { counts[s] = doc.querySelectorAll(s).length; } catch (e) { counts[s] = -1; }
    }
    return counts;
  }

  function probeNetworkApis() {
    // 页面加载时请求过的接口（找楼层 JSON API 的真实地址）
    try {
      const all = performance.getEntriesByType("resource").map((e) => e.name);
      const pagePc = all.find((u) => u.includes("/c/f/pb/page_pc"));
      const apiList = all
        .filter((u) => /tieba\.baidu\.com\/(c\/|mo\/)/i.test(u))
        .slice(0, 10);
      return { pagePcUrl: pagePc || null, apiList };
    } catch (e) {
      return { pagePcUrl: null, apiList: [] };
    }
  }

  function detectFloorItems(doc) {
    // 多候选选择器：新版客户端 / SSR 结构 / 旧版结构
    const candidates = [
      ".pb-comment-item",
      ".pb-comment-list .thread-container > div",
      ".post-item",
      ".l_post",
      ".d_post_content",
      "[data-field]",
      "li.j_thread_list",
      ".pb-reply-item",
    ];
    for (const sel of candidates) {
      const els = doc.querySelectorAll(sel);
      if (els.length > 1) return { sel, els };
    }
    return { sel: null, els: [] };
  }

  if (site === "tieba") {
    // 从 URL 提取帖子 id
    const m = url.match(/\/p\/(\d+)/);
    if (!m) throw new Error("无法从 URL 解析贴吧帖子 id");
    const tid = m[1];

    // 第 1 页：从当前已渲染 DOM 取（SSR 首屏），同时拿总页数信息
    const firstProbe = detectFloorItems(document);
    meta.firstProbe = firstProbe.sel;
    meta.firstCount = firstProbe.els.length;
    // 第一页的楼层（用探测到的真实选择器）
    const firstFloors = firstProbe.sel ? parseFloorItems(document, firstProbe.sel) : [];
    blocks.push(...firstFloors);

    // 从页面取总楼层/总页数（若有），否则边抓边判断
    const replyCountEl = document.querySelector(".pc-pb-reply-top, .pb-reply-top");
    meta.replyInfo = (replyCountEl?.innerText || "").replace(/\s+/g, " ").slice(0, 100);
    const net = probeNetworkApis();
    meta.pagePcUrl = net.pagePcUrl ? net.pagePcUrl.slice(0, 300) : null;
    meta.networkApis = net.apiList;

    // 优先走 JSON API：读 hook 捕获的 page_pc 完整响应（页面自己请求的，带正确 sign+cookie）
    const bridgeCache = window.__bridgeCache;
    if (bridgeCache && bridgeCache.pagePc) {
      const json = bridgeCache.pagePc;
      meta.jsonKeys = Object.keys(json).slice(0, 15);
      meta.jsonErr = json.error_msg || null;
      const jsonBlocks = parsePcJson(json);
      if (jsonBlocks.length) {
        blocks.length = 0; // 清掉 DOM 提取的结果，用 JSON 的
        blocks.push(...jsonBlocks);
        meta.jsonBlocks = jsonBlocks.length;
        meta.jsonFirst = jsonBlocks[0]?.author + ": " + (jsonBlocks[0]?.text || "").slice(0, 50);
        meta.jsonLast = jsonBlocks[jsonBlocks.length - 1]?.author + ": " + (jsonBlocks[jsonBlocks.length - 1]?.text || "").slice(0, 50);
      } else {
        meta.jsonBlocks = 0;
        meta.jsonSample = JSON.stringify(json).slice(0, 800);
      }
    }

    // 循环抓后续页：直到某页没有新楼层
    let pn = 2;
    let emptyStreak = 0;
    let usedSel = null;
    let ssrSample = "";
    while (emptyStreak < 2 && pn <= 50) {
      let doc;
      try {
        doc = await fetchTiebaPage(tid, pn);
      } catch (e) {
        meta.paginationError = `${e.message}`;
        break;
      }
      if (pn === 2) {
        // 记录 SSR 页面的结构样本 + 各选择器命中数（用于调试/适配）
        ssrSample = (doc.body?.innerText || "").replace(/\s+/g, " ").slice(0, 200);
        meta.ssrProbe = probeSelectors(doc, [
          ".pb-comment-item", ".pb-comment-list", ".thread-container", ".post-item",
          ".l_post", ".d_post_content", "[data-field]", ".pb-reply-item",
        ]);
      }
      // 用探测到的选择器提取楼层
      let floors = [];
      const probe = detectFloorItems(doc);
      if (probe.sel && !usedSel) usedSel = probe.sel;
      if (probe.sel) {
        floors = [...probe.els].map((el) => {
          const author = el.querySelector(".head-name")?.innerText?.trim() || "";
          let text = (el.innerText || "").trim();
          const head = el.querySelector(".head-line");
          if (head) text = text.replace((head.innerText || "").trim(), "").trim();
          text = text.replace(/\n{3,}/g, "\n\n").trim();
          return { type: "floor", floor: 0, author, text: text.slice(0, 8000) };
        });
      }
      if (!floors.length) {
        emptyStreak += 1;
      } else {
        emptyStreak = 0;
        blocks.push(...floors);
      }
      pn += 1;
    }
    meta.pagesFetched = pn - 1;
    meta.totalBlocks = blocks.length;
    meta.usedSel = usedSel;
    meta.ssrSample = ssrSample;
  } else {
    // 小黑盒：读 hook 拦截的 link/tree 完整响应（页面自带 cookie，能过风控）
    const bridgeCache = window.__bridgeCache;
    if (bridgeCache && bridgeCache.xiaoheihe) {
      const json = bridgeCache.xiaoheihe;
      meta.xhhStatus = json.status || null;
      meta.xhhUrl = bridgeCache.xiaoheiheUrl ? bridgeCache.xiaoheiheUrl.slice(0, 400) : null;
      // 全量分页拉取（复用页面签名参数翻页）
      let merged = json;
      if (bridgeCache.xiaoheiheUrl) {
        try {
          merged = await fetchXiaoheiheAll(json, bridgeCache.xiaoheiheUrl);
        } catch (e) {
          meta.xhhPageError = `${e.message}`;
        }
      }
      const { blocks: xhhBlocks, meta2: xhhMeta } = parseXiaoheihe(merged);
      meta.xhhBlocks = xhhBlocks.length;
      meta.xhhHasMore = xhhMeta.hasMore;
      meta.xhhTotalFloors = xhhMeta.totalFloors;
      meta.xhhTotalPage = xhhMeta.totalPage;
      blocks.push(...xhhBlocks);
    } else {
      meta.xhhCache = false;
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll("script,style,noscript,iframe,nav,header,footer").forEach((n) => n.remove());
      const text = (clone.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
      blocks.push({ type: "text", floor: 0, author: "", text: text.slice(0, 30000) });
    }
  }

  return { site, url, title, fetched_at: new Date().toISOString(), content: blocks, meta };
}

// 打开时显示上次结果（便于调试）
chrome.storage.local.get("lastResult").then(({ lastResult }) => {
  if (!lastResult) return;
  const t = new Date(lastResult.at || Date.now()).toLocaleTimeString();
  if (lastResult.ok) {
    detail.textContent = `上次(${t}): 已推送 ${lastResult.blocks} 块 → ${lastResult.url}`;
  } else {
    detail.textContent = `上次(${t}): ❌ ${lastResult.error}`;
    detail.style.color = "#c62828";
  }
});

// ---- 连接设置 ----
const cfgHost = document.getElementById("cfgHost");
const cfgToken = document.getElementById("cfgToken");
const btnSave = document.getElementById("btnSave");
const cfgMsg = document.getElementById("cfgMsg");

(async () => {
  const cfg = await getBridgeConfig();
  cfgHost.value = cfg.host;
  cfgToken.value = cfg.token;
})();

btnSave.addEventListener("click", async () => {
  const cfg = {
    host: cfgHost.value.trim() || DEFAULTS.host,
    token: cfgToken.value.trim(),
  };
  await chrome.storage.local.set({ bridgeConfig: cfg });
  cfgMsg.textContent = "✅ 已保存";
  setTimeout(() => { cfgMsg.textContent = ""; }, 1500);
});




