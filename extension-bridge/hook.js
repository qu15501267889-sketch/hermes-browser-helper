// browser-bridge hook —— document_start 注入，hook 页面自身的网络请求。
// 目标：捕获 tieba page_pc 接口的完整响应（楼层 JSON），存到 window.__bridgeCache。
// 页面自己发的请求带正确 sign + cookie，我们只负责"旁听"。

(() => {
  if (window.__bridgeCache) return; // 防止重复注入
  const cache = { pagePc: null, lastUrl: location.href };
  window.__bridgeCache = cache;

  // 拦截 fetch
  const origFetch = window.fetch;
  window.fetch = async (...args) => {
    const resp = await origFetch.apply(window, args);
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
    if (/\/c\/f\/pb\/page_pc/.test(url) && resp.ok) {
      try {
        const clone = resp.clone();
        const json = await clone.json();
        cache.pagePc = json;
        cache.lastUrl = url;
      } catch (e) {
        /* 非 JSON 或解析失败，忽略 */
      }
    }
    return resp;
  };

  // 拦截 XMLHttpRequest（旧代码路径）
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__bridgeUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", () => {
      try {
        const url = this.__bridgeUrl || "";
        if (/\/c\/f\/pb\/page_pc/.test(url) && this.status === 200) {
          const json = JSON.parse(this.responseText);
          cache.pagePc = json;
          cache.lastUrl = url;
        }
      } catch (e) {
        /* 忽略 */
      }
    });
    return origSend.apply(this, args);
  };
})();
