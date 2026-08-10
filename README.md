# hermes链接浏览器助手

> 浏览器插件 + 本地服务 + 站点拉取脚本，把网页内容（正文、评论区、API 数据）结构化地喂给 Hermes AI 分析。

支持 **Edge / Chrome**。已适配 **百度贴吧、小黑盒、巨量千川**，并提供通用扩展机制（详见 [docs/SITE_ADAPTERS.md](docs/SITE_ADAPTERS.md)）。

**当前版本：V2.0.0**（[Release 下载](https://github.com/qu15501267889-sketch/hermes-browser-helper/releases)）

## V2.0 新特性

- **验证码页识别**：检测「安全验证/验证码」墙（如小黑盒 turing 验证码）→ 标记 `pageType:'captcha'`，不再把验证码壳当正文
- **SPA 路由自动捕获**：hook `history.pushState/replaceState/popstate`，贴吧「只看楼主」、千川切 tab 等内部跳转自动触发重捕获
- **内容去重心跳**：同 URL 正文无变化时发轻量心跳，不重复污染历史
- **深度捕获自动截图**：页面截图存本地 PNG，pageData 带 `screenshotPath`，供 agent 视觉分析

---

## 架构

```
┌─────────────┐  捕获   ┌──────────────┐  HTTP   ┌──────────────┐   读取   ┌─────────┐
│  浏览器插件  │ ──────▶ │  本地服务     │ ──────▶ │  localhost   │ ───────▶ │ Hermes  │
│  extension/ │ 页面DOM │  server/     │  8765   │ :8765/api/   │          │  AI     │
└──────┬──────┘  +API拦截 └──────────────┘         └──────────────┘          └─────────┘
       │
       │  fetch/XHR 拦截（通用）：任何网站的 API 响应都能捕获
       │  站点适配：贴吧(楼层解析) / 小黑盒(评论API) / 千川(数据接口)
       ▼
┌──────────────┐
│  服务器端脚本  │  scripts/site_fetch.py —— 配置驱动通用拉取器
│  scripts/    │  scripts/sites/*.json —— 每个站点一份配置
└──────────────┘
```

**三层能力**：

| 层 | 位置 | 作用 | 依赖 |
|---|---|---|---|
| 浏览器插件 | `extension/` | 自动捕获页面 DOM + 拦截 API 响应 | 浏览器 |
| 本地服务 | `server/` | 接收插件数据，存 JSON 供读取 | Python 3.8+（标准库） |
| 站点拉取脚本 | `scripts/` | 服务器端直拉（贴吧 API 签名方案等） | Python + curl_cffi |

## 快速开始

### 方式一：人（Windows）

```bat
双击 setup.bat
```

脚本会自动：检测 Python → 启动本地服务 → 用 `--load-extension` 打开浏览器加载扩展 → 提示手动确认（首次需在 `edge://extensions` 或 `chrome://extensions` 打开开发者模式，加载 `extension/` 文件夹，约 30 秒）。

> 说明：浏览器出于安全设计，命令行只能"当次会话"加载本地扩展。浏览器重启后重跑 `setup.bat` 即可；也可手动加载一次实现永久生效。

### 方式二：Agent（推荐给 Hermes 用户）

把本仓库交给你的 agent，让它执行：

```bash
python install.py            # 自动检测 Edge/Chrome
python install.py --browser edge
python install.py --no-browser   # 只启动服务
```

`install.py` 会输出明确的部署步骤，agent 可自主完成：环境检测 → 启动服务 → 验证 `127.0.0.1:8765` → 加载扩展。

### 卸载

```bat
双击 uninstall.bat
```

停止服务 + 移除开机自启；扩展请在浏览器扩展管理页手动移除。

## 站点拉取脚本用法

```bash
# 贴吧完整楼层（87 楼 = 3 个请求，2 秒）
uv run --with curl_cffi python scripts/site_fetch.py tieba <帖子ID或URL>

# 只看楼主
# （改 sites/tieba.json 的 see_lz 为 "1"）

# 图片提取
uv run --with curl_cffi python scripts/tieba_imgs.py <帖子ID>

# 列出所有已配置站点
python scripts/site_fetch.py --list
```

## 已适配站点

| 站点 | 插件（浏览器内） | 脚本（服务器端） | 数据源 |
|---|---|---|---|
| 百度贴吧 | 楼层 DOM 解析 | ✅ `site_fetch.py tieba`（官方接口+签名，匿名可调） | `c/f/pb/page` API |
| 小黑盒 | ✅ 评论 API（借浏览器 cookie 过风控） | 需 cookie，暂服务器端不可用 | `link/tree` 拦截 |
| 巨量千川 | ✅ 数据接口（statQuery 等） | — | API 拦截 |
| 其他网站 | ✅ 通用拦截（fetch/XHR + DOM 提取） | 配置即用 | 见教程 |

## 通用性设计

- **插件端**：fetch/XHR 拦截是通用的——任何网站的 API 响应都能捕获，只需在代码里标记"数据接口 URL"
- **脚本端**：`site_fetch.py` 配置驱动——新增站点 = 在 `scripts/sites/` 加一个 JSON 文件（接口、参数、签名、翻页、解析）
- **教程**：[docs/SITE_ADAPTERS.md](docs/SITE_ADAPTERS.md) 三步教会你适配新网站

## 隐私说明

- 本仓库不含任何凭据、token、用户私人数据
- 本地服务仅监听 `127.0.0.1`，数据不出本机
- 插件只在你浏览的页面运行，捕获内容仅保存在本地

## 许可

MIT License
