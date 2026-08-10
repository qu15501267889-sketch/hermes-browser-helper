# 适配新网站：三步教程

本项目的通用性设计目标：**新增一个网站，尽量不改核心代码**。

## 两条适配路线

| 路线 | 适用场景 | 工作量 |
|---|---|---|
| **A. 服务器端配置**（`scripts/sites/`） | 网站有公开/可调用接口，匿名或带签名可访问 | 写一个 JSON 配置 |
| **B. 插件端拦截**（`extension/`） | 接口有风控（需要浏览器 cookie/环境），或纯前端渲染 | 改几行 URL 标记 + 可选解析器 |

---

## 路线 A：服务器端配置拉取（推荐先试）

### 第 1 步：抓接口

浏览器 DevTools → Network，找到返回帖子/评论数据的 JSON 接口，记录：
- 完整 URL 模板（哪些参数是 ID、页码、时间戳）
- 请求头（UA、Referer、签名）

### 第 2 步：写配置

在 `scripts/sites/` 新建 `<站点名>.json`：

```json
{
  "name": "示例站",
  "base_url": "https://api.example.com/thread",
  "impersonate": "chrome124",
  "params": {
    "id": "{id}",
    "page": "{page}",
    "ts": "{ts}",
    "device": "wapp_{ts_ms}",
    "token": "{rand}"
  },
  "sign": {
    "key": "签名密钥或算法参数",
    "style": "md5_concat"
  },
  "pagination": {
    "param": "page",
    "start": 1,
    "has_more": "data.has_more",
    "total_pages": "data.total_page"
  },
  "items": "data.list",
  "fields": {
    "floor": { "path": "floor" },
    "author": { "path": "user.name" },
    "content": { "path": "content_list", "join": "text" }
  }
}
```

**占位符**：`{id}` 帖子ID、`{page}` 页码、`{ts}` 秒时间戳、`{ts_ms}` 毫秒时间戳、`{rand}` 随机数
**签名风格**：`md5_concat` = 参数按 key 排序拼接 `k=v` + key，整体 MD5（贴吧即此风格）

### 第 3 步：测试

```bash
uv run --with curl_cffi python scripts/site_fetch.py 示例站 123456
```

---

## 路线 B：插件端拦截

### 第 1 步：确认插件能拦到

打开目标页面，等自动捕获，读取本地数据看 `apiRecords` 是否包含目标接口。

### 第 2 步：标记为数据接口（保留完整响应）

`extension/content.js` 中，接收拦截消息的地方：

```js
const isDataApi = url.includes('/statQuery') || ... || url.includes('<你的接口特征>');
```

`extension/injector.js` 的 `isDataApi()` 同步加。

> 默认响应体只保留 10KB，数据接口保留 500KB。

### 第 3 步（可选）：写站点解析器

页面数据量大或需结构化时，仿照 `fetchXiaoheiheComments()`（小黑盒评论）在 `content.js` 加一个拉取函数，并在 `capturePage`/`captureQuick` 的 `detectSite()` 分支里调用。

---

## 已踩过的坑（省时间）

1. **签名必须覆盖全部发送参数**——包括页码！先加页码再算签名，否则服务端校验失败（贴吧 110001）
2. **时间戳要动态**——`_t`/`_client_id` 用固定值会被风控
3. **TLS 指纹**——裸 curl/requests 被 403 时，用 `curl_cffi` + `impersonate='chrome124'`
4. **接口有风控（如小黑盒 show_captcha）**——不要自己 fetch，改读页面真实请求的拦截记录（借浏览器 cookie）
5. **虚拟滚动站点（贴吧新版）**——DOM 只渲染视口附近，滚动收集是兜底；优先找 API
6. **响应体截断**——injector → content.js → background 三层都有截断，数据接口要三层都标记
