# hermes链接浏览器助手

> 浏览器插件 + 本地服务 + Hermes 插件 + 站点拉取脚本，把网页内容（正文、评论区、API 数据）结构化地喂给 Hermes AI 分析。

支持 **Edge / Chrome**。**当前适配情况：**
- **Hermes 插件（`hermes-plugin/`，V3.2.1 新增的重构组件）**：仅适配 **百度贴吧（✅ 完整，含图片）** 和 **小黑盒（✅ 完整，含图片）**，**未适配巨量千川**
- **原浏览器扩展（`extension/`）**：百度贴吧、小黑盒、巨量千川（✅ 数据接口）

（其他网站不保证可用，详见[已适配站点](#已适配站点当前仅适配以下站点其他网站不保证)）。

**当前版本：V3.3.1**（[Release 下载](https://github.com/qu15501267889-sketch/hermes-browser-helper/releases)）

## V3.3.1 变更（10 个 BUG 修复，全量验收通过）

- **修复 page_refresh 工具永远失败**：现在真正触发重新抓取（贴吧匿名 API 重新全量拉取），无需用户手动操作浏览器
- **修复贴吧 JSON 路径作者名缺失**：user_list 映射（此前 post_list 只有 author_id，作者名全空）
- **修复多进程状态竞态**：磁盘原子写（tmp+rename）+ epoch 数值时间戳比较，多进程读盘一致性
- **修复贴吧图片命名碰撞**：多图加序号不再互相覆盖
- **清理死代码**：background.js 精简、popup.js 删除 3 个死函数（fetchTiebaPage/fetchPagePc/probeSelectors）、删死变量
- **补 manifest 权限**：host_permissions 与 content_scripts 增加 api.xiaoheihe.cn
- 重构：server 站点拉取抽为共用函数 `_fetch_site_content`（POST /api/page 与 /api/refresh 共用）

## V3.2.1 变更

- **小黑盒完整适配**：Hermes 插件 + 配套扩展 `extension-bridge/` 完整支持小黑盒——帖子正文 + 全量评论（含楼中楼，自动翻页）+ 帖子图片下载，走 `link/tree` 接口（借浏览器 cookie 过风控）
- **明确适配范围**：重构后的 Hermes 插件（`hermes-plugin/`）**仅适配百度贴吧和小黑盒，未适配巨量千川**（千川数据接口仅在原 `extension/` 扩展中支持）
- **图片下载修复**：小黑盒图床图片去重命名（多图不再互相覆盖），贴吧/小黑盒正文图片均自动下载到 `state/images/`
- **小黑盒分页全量**：复用页面签名参数翻页（`page=2..N`），拉全所有评论

## V3.1.1 变更（重构）

- **新增 Hermes 插件组件 `hermes-plugin/`**：原浏览器扩展 + 本地服务方案之外，新增一条"插件直拉"路径 —— 浏览器扩展只负责传递当前页面 URL，Hermes 插件内置本地 HTTP 服务（127.0.0.1:4399）+ 贴吧 API 适配器，匿名拉取全量楼层
- **重构贴吧全量楼层抓取**：合并独立实现的 `tieba_fetch.py`（官方接口 `c/f/pb/page` + `tiebaclient!!!` 签名，匿名可调、免滚动、免浏览器），与 `scripts/` 下的抓取脚本形成双路径
- **图片自动下载**：每次拉取自动把主楼 + 全部楼层的图片下载到本地 `state/images/<帖子id>/`，楼层数据带 `images_local`（本地路径）与 `images`（原始 URL），供视觉分析或直接查看；表情转可读名称（如 `[笑眼]`）
- **配置本地化**：Hermes 插件的 host/port/token 抽到 `config.json`（token 首次运行自动生成随机值，可用环境变量 `BRIDGE_HOST/PORT/TOKEN` 覆盖）；扩展 popup 新增「⚙️ 连接设置」面板，无需改代码即可配置服务器地址与 Token
- **隐私防护**：`.gitignore` 排除 `config.json`、`state/`（含抓取数据与图片）、`__pycache__`，上传 GitHub 不泄漏本地数据

## V2.1.1 变更

- **快速捕获直拉贴吧全量楼层**：贴吧页面点「快速捕获」即调用官方 API（`c/f/pb/page` + 签名）拉取全部楼层，不再只有视口内容（实测 690 楼帖子一次拿 683 楼）
- **修复手动快速捕获被内容去重吞掉**：popup「快速捕获」走 `force=true` 绕过去重；`saveCapture` 不再写入心跳空数据

## V2.1 变更

- **默认手动模式**：自动捕获默认关闭，浏览页面零动作零滚动；需要时点 popup「快速捕获」（不滚动）或「深度捕获」，或手动打开「自动捕获」开关恢复自动
- **贴吧彻底免滚动**：贴吧捕获一律快速提取（不再触发静默滚动），完整楼层由 agent 端 `tieba_fetch.py` 拉官方 API
- **手动按钮绕过开关**：popup 手动按钮不再受「自动捕获」开关限制（修复隐藏 bug）

## V2.0 新特性

- **验证码页识别**：检测「安全验证/验证码」墙（如小黑盒 turing 验证码）→ 标记 `pageType:'captcha'`，不再把验证码壳当正文
- **SPA 路由自动捕获**：hook `history.pushState/replaceState/popstate`，贴吧「只看楼主」、千川切 tab 等内部跳转自动触发重捕获
- **内容去重心跳**：同 URL 正文无变化时发轻量心跳，不重复污染历史
- **深度捕获自动截图**：页面截图存本地 PNG，pageData 带 `screenshotPath`，供 agent 视觉分析

---

## 架构

```
路径 A（原有）：浏览器扩展 + 本地服务
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

路径 B（V3.1.1 新增，V3.2.1 完善）：Hermes 插件直拉（推荐）
┌─────────────┐   URL    ┌─────────────────────┐  匿名API   ┌──────────┐
│  浏览器扩展  │ ───────▶ │  hermes-plugin/      │ ─────────▶ │  贴吧官方  │
│  (仅传URL)  │          │  内置服务 127.0.0.1: │  全量楼层   │  c/f/pb/  │
└─────────────┘          │  4399 + tieba_fetch  │            │  page     │
                         └─────────────────────┘
```

**能力分层**：

| 层 | 位置 | 作用 | 依赖 |
|---|---|---|---|
| 浏览器插件 | `extension/` | 自动捕获页面 DOM + 拦截 API 响应；也用于给 Hermes 插件传 URL | 浏览器 |
| 本地服务 | `server/` | 接收插件数据，存 JSON 供读取 | Python 3.8+（标准库） |
| **Hermes 插件** | `hermes-plugin/` | **（V3.1.1 新增）** 内置本地服务 + 贴吧 API 全量拉取 + 图片下载，提供 page_status/page_content/page_refresh 工具 | Python 3.8+（标准库） |
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

## 已适配站点（当前仅适配以下站点，其他网站不保证）

> **说明**：本项目**只适配百度贴吧、小黑盒、巨量千川**三个站点。其他网站（B站、知乎、微博等）虽然插件有通用 fetch/XHR 拦截 + DOM 提取，但**未经适配、不保证能用**——它们不在支持范围内。

| 站点 | Hermes 插件（V3.2.1） | 浏览器扩展 | 脚本（服务器端） | 数据源 |
|---|---|---|---|---|
| **百度贴吧** | ✅ **全量楼层 + 图片下载**（`tieba_fetch.py`，匿名 API，免滚动） | ✅ 官方 API 直拉全量楼层（快速捕获即全量） | ✅ `site_fetch.py tieba`（匿名可调） | `c/f/pb/page` API |
| **小黑盒** | ✅ **帖子正文 + 全量评论（含楼中楼，自动翻页）+ 图片下载**（借浏览器 cookie 过风控） | ✅ 评论 API（借浏览器 cookie 过风控） | 需 cookie，暂服务器端不可用 | `link/tree` 拦截 |
| **巨量千川** | ❌ **未适配**（Hermes 插件不支持） | ✅ 数据接口（statQuery 等） | — | API 拦截 |
| 其他网站 | ❌ 不接入 | ⚠️ 仅通用拦截兜底，**不保证可用** | — | 见教程 |

### Hermes 插件使用（V3.2.1）

```bash
# 安装 Hermes 插件
cp -r hermes-plugin ~/.hermes/plugins/browser-bridge
hermes plugins enable browser-bridge

# 安装配套浏览器扩展（extension-bridge/，专为 Hermes 插件路径设计）
# 1. 打开 edge://extensions（或 chrome://extensions）
# 2. 开启"开发人员模式" → "加载解压缩的扩展" → 选 extension-bridge/ 目录
# 3. 固定到工具栏

# 使用
# 1. 浏览器打开贴吧帖子 → 点扩展「📥 拉取当前页面」
# 2. 回 Hermes 问："我刚看的帖子讲了什么"
```

插件提供 3 个工具：`page_status`（当前页面元信息）/ `page_content`（按块/关键词读正文）/ `page_refresh`（提示重新抓取）。
连接配置（host/port/token）在 `hermes-plugin/config.json`（token 自动生成），或扩展 popup「⚙️ 连接设置」里填写。

> 说明：`extension/`（原有）与 `extension-bridge/`（V3.1.1 新增）是两套独立扩展：
> - `extension/` → 配合 `server/`（8765）使用，多站点、自动捕获、深度捕获
> - `extension-bridge/` → 配合 `hermes-plugin/`（4399）使用，仅传递 URL，贴吧全量由插件 API 直拉

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
