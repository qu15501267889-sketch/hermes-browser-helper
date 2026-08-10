// injector.js — 独立注入文件
// 通过 <script src="..."> 方式注入，绕过千川 CSP 对内联脚本的限制
// 由 content script 通过 chrome.runtime.getURL 获取此文件路径

(function() {
  if (window.__HERMES_API_INTERCEPTED) return;
  window.__HERMES_API_INTERCEPTED = true;

  const seenUrls = new Set();
  const MAX_RECORDS = 100;

  function sendToContent(data) {
    window.postMessage({
      source: 'hermes-api-interceptor',
      type: data.type,
      url: data.url,
      method: data.method,
      status: data.status,
      responseBody: data.responseBody,
      contentType: data.contentType,
      requestBody: data.requestBody || '',
      timestamp: Date.now(),
    }, '*');
  }

  // 判断是否为数据接口（千川 statQuery / 小黑盒 link/tree 评论）
  function isDataApi(url) {
    return url.includes('/statQuery') || url.includes('/material-analysis')
      || url.includes('/material') || url.includes('/data/v1')
      || url.includes('roi2_material') || url.includes('link/tree');
  }

  // 响应体长度限制：数据接口保留完整，其他限制
  function getBodyLimit(url) {
    return isDataApi(url) ? 1000000 : 100000;
  }

  // 拦截 fetch
  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    const url = (typeof input === 'string') ? input : (input.url || '');
    const method = (init && init.method) || 'GET';
    let requestBody = '';
    try {
      if (init && init.body) {
        requestBody = (typeof init.body === 'string') ? init.body.slice(0, 5000) : '';
      }
    } catch(e) {}

    return origFetch.apply(this, arguments).then(async (response) => {
      const ct = response.headers.get('content-type') || '';
      if (ct.includes('application/json') || ct.includes('text/plain') || ct.includes('text/html')) {
        const limit = getBodyLimit(url);
        if (!seenUrls.has(url)) {
          seenUrls.add(url);
          if (seenUrls.size > MAX_RECORDS) seenUrls.clear();
          const clone = response.clone();
          try {
            const text = await clone.text();
            if (text.length < limit) {
              sendToContent({
                type: 'fetch',
                url: url,
                method: method,
                status: response.status,
                contentType: ct,
                requestBody: requestBody,
                responseBody: text,
              });
            }
          } catch(e) {}
        }
      }
      return response;
    }).catch((err) => {
      return origFetch.apply(this, arguments);
    });
  };

  // 拦截 XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this._hermesUrl = (typeof url === 'string') ? url : (url ? url.toString() : '');
    this._hermesMethod = method;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    this._hermesBody = (typeof body === 'string') ? body.slice(0, 5000) : '';
    if (this._hermesUrl) {
      this.addEventListener('load', function() {
        const ct = this.getResponseHeader('content-type') || '';
        if (ct.includes('application/json') || ct.includes('text/')) {
          const limit = getBodyLimit(this._hermesUrl);
          if (!seenUrls.has(this._hermesUrl)) {
            seenUrls.add(this._hermesUrl);
            if (seenUrls.size > MAX_RECORDS) seenUrls.clear();
            try {
              const text = this.responseText || '';
              if (text.length < limit) {
                sendToContent({
                  type: 'xhr',
                  url: this._hermesUrl,
                  method: this._hermesMethod,
                  status: this.status,
                  contentType: ct,
                  requestBody: this._hermesBody,
                  responseBody: text,
                });
              }
            } catch(e) {}
          }
        }
      });
    }
    return origSend.apply(this, arguments);
  };

  // ===== Hermes 附加：提取页面主世界全局数据（贴吧等SPA站点的内嵌JSON） =====
  // 框架内部数据探测：Vue __vue__ / React fiber 树（页面主世界才能访问）
  function extractFrameworkData() {
    const result = { vue: null, react: null };
    try {
      const app = document.getElementById('app') || document.querySelector('#app, .app, [data-v-app]');
      if (!app) return result;
      // Vue 2/3
      try {
        const vueInstance = app.__vue__ || (app.__vue_app__ && app.__vue_app__._instance && app.__vue_app__._instance.proxy);
        if (vueInstance) {
          const store = vueInstance.$store;
          if (store && store.state) {
            const s = JSON.stringify(store.state);
            if (s && s.length > 100) result.vue = { type: 'vueStore', size: s.length, data: s.slice(0, 500000) };
          } else {
            const d = JSON.stringify(vueInstance.$data || vueInstance._data || {});
            if (d && d.length > 100) result.vue = { type: 'vueData', size: d.length, data: d.slice(0, 500000) };
          }
        }
      } catch (e) {}
      // React：找 fiber 根节点，向上遍历拿 memoizedState
      try {
        const keys = Object.keys(app);
        const fiberKey = keys.find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$') || k.startsWith('__reactContainer$'));
        if (fiberKey) {
          let fiber = app[fiberKey];
          let best = null;
          const visited = new Set();
          for (let i = 0; i < 200 && fiber; i++) {
            if (visited.has(fiber)) break;
            visited.add(fiber);
            try {
              if (fiber.memoizedState) {
                const s = JSON.stringify(fiber.memoizedState);
                if (s && s.length > 5000 && (!best || s.length > best.size)) {
                  best = { size: s.length, data: s.slice(0, 500000) };
                }
              }
            } catch (e) {}
            // 也检查 hooks 链表
            try {
              let hook = fiber.memoizedState;
              let depth = 0;
              while (hook && depth < 10) {
                if (hook.memoizedState && typeof hook.memoizedState === 'object') {
                  const s = JSON.stringify(hook.memoizedState);
                  if (s && s.length > 5000 && (!best || s.length > best.size)) {
                    best = { size: s.length, data: s.slice(0, 500000) };
                  }
                }
                hook = hook.next;
                depth++;
              }
            } catch (e) {}
            fiber = fiber.return;
          }
          if (best) result.react = best;
        }
      } catch (e) {}
    } catch (e) {}
    return result;
  }

  function extractPageGlobals() {
    const result = { candidates: {}, scan: [] };
    // 常见SPA全局数据变量名
    const names = ['__INITIAL_STATE__', '__data', 'PageData', 'pageData', '__TIEBA__', 'initialData', '__NUXT__', '__APP_DATA__', '__PRELOADED_STATE__', 'INITIAL_STATE'];
    for (const n of names) {
      try {
        const v = window[n];
        if (v !== undefined && v !== null) {
          const s = JSON.stringify(v);
          if (s && s.length > 300) {
            result.candidates[n] = { size: s.length, data: s.slice(0, 500000) };
          }
        }
      } catch (e) {}
    }
    // 兜底：扫描 window 上所有大对象（>1KB，放宽阈值防止小数据漏掉）
    try {
      const keys = Object.keys(window);
      for (const k of keys) {
        try {
          const v = window[k];
          if (v && typeof v === 'object') {
            const s = JSON.stringify(v);
            if (s && s.length > 1000) result.scan.push({ key: k, size: s.length });
          }
        } catch (e) {}
      }
      result.scan.sort((a, b) => b.size - a.size);
      result.scan = result.scan.slice(0, 30);
    } catch (e) {}
    return result;
  }

  // ===== JSONP 捕获：静默拿数据源（贴吧等用 <script> 加载数据的站点） =====
  // 原理：JSONP 通过 <script src="...?callback=xxx"> 加载，响应 JS 调用全局回调。
  // 在 src 设置时包装全局回调函数，捕获传给回调的数据，页面无任何视觉变化。
  function hookJsonp() {
    try {
      const origCreate = document.createElement.bind(document);
      document.createElement = function(tag, options) {
        const el = origCreate(tag, options);
        if (tag.toLowerCase() === 'script') {
          let src = '';
          try {
            const origDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
            Object.defineProperty(el, 'src', {
              get() { return src; },
              set(v) {
                src = v;
                try {
                  const m = String(v).match(/[?&](?:callback|cb|jsonp|_callback|cd_cb)=([^&]+)/);
                  if (m && m[1]) wrapJsonpCallback(m[1], String(v));
                } catch (e) {}
                if (origDesc && origDesc.set) return origDesc.set.call(this, v);
                return true;
              },
              configurable: true,
            });
          } catch (e) {}
        }
        return el;
      };
    } catch (e) {}
  }

  function wrapJsonpCallback(cbName, url) {
    try {
      const orig = window[cbName];
      window[cbName] = function() {
        try {
          const args = Array.prototype.slice.call(arguments);
          const data = args[0];
          const s = JSON.stringify(data);
          if (s && s.length > 50) {
            window.postMessage({
              source: 'hermes-api-interceptor',
              type: 'jsonp',
              url: url.slice(0, 300),
              callback: cbName,
              data: s.slice(0, 500000),
              timestamp: Date.now(),
            }, '*');
          }
        } catch (e) {}
        if (typeof orig === 'function') return orig.apply(this, arguments);
      };
    } catch (e) {}
  }

  hookJsonp();

  // 等页面JS跑完再探测（3秒后页面数据通常已就绪）
  setTimeout(function() {
    try {
      const g = extractPageGlobals();
      // 框架内部数据（Vue/React）一并带回
      g.framework = extractFrameworkData();
      if (Object.keys(g.candidates).length > 0 || (g.scan && g.scan.length > 0) || g.framework.vue || g.framework.react) {
        window.postMessage({
          source: 'hermes-api-interceptor',
          type: 'globals',
          data: g,
          timestamp: Date.now(),
        }, '*');
        console.log('[Hermes] 已提取页面全局数据, candidates:', Object.keys(g.candidates).length, 'scan:', g.scan.length, 'framework:', g.framework.vue ? 'vue' : (g.framework.react ? 'react' : 'none'));
      }
    } catch (e) {}
  }, 3000);

  console.log('[Hermes] API拦截器已注入:', window.location.href);
})();