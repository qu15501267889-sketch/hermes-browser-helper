"""browser-bridge server — 本地 HTTP 接收端。

浏览器扩展把页面快照 POST 到 http://127.0.0.1:PORT/api/page，
本模块校验 token 后存入内存 + 磁盘，供 tools.py 读取。

配置：优先读 config.json（token 首次运行自动生成随机值），
可环境变量覆盖 BRIDGE_HOST / BRIDGE_PORT / BRIDGE_TOKEN。
零第三方依赖（纯标准库）。
"""
from __future__ import annotations

import json
import logging
import os
import secrets
import socket
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

CONFIG_DIR = Path(__file__).resolve().parent
CONFIG_FILE = CONFIG_DIR / "config.json"
STATE_DIR = CONFIG_DIR / "state"
STATE_FILE = STATE_DIR / "latest_page.json"

_DEFAULTS = {
    "host": "127.0.0.1",
    "port": 4399,
    "token": "",  # 空 = 自动生成随机 token 并保存
}


def load_config() -> dict:
    """加载配置；token 为空时自动生成随机值并持久化。"""
    cfg = dict(_DEFAULTS)
    try:
        if CONFIG_FILE.exists():
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                cfg.update({k: data[k] for k in _DEFAULTS if k in data})
    except Exception as exc:
        logger.warning("browser-bridge: 读取 config.json 失败: %s", exc)

    if not cfg.get("token"):
        cfg["token"] = secrets.token_hex(16)
        try:
            CONFIG_FILE.write_text(
                json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except Exception as exc:
            logger.warning("browser-bridge: 保存 config.json 失败: %s", exc)

    # 环境变量覆盖
    cfg["host"] = os.environ.get("BRIDGE_HOST", cfg["host"])
    cfg["port"] = int(os.environ.get("BRIDGE_PORT", cfg["port"]))
    cfg["token"] = os.environ.get("BRIDGE_TOKEN", cfg["token"])
    return cfg


CONFIG = load_config()
HOST = CONFIG["host"]
PORT = CONFIG["port"]
TOKEN = CONFIG["token"]

# 内存中的当前页面状态（单页，新推送覆盖旧的）
_state: dict = {}
_state_lock = threading.Lock()
_server: ThreadingHTTPServer | None = None


# ---------------------------------------------------------------------------
# 状态读写
# ---------------------------------------------------------------------------

def _ts_epoch(page: dict) -> float:
    """从快照取时间戳（优先 received_at_epoch，回退解析 received_at）。"""
    ep = page.get("received_at_epoch")
    if isinstance(ep, (int, float)):
        return float(ep)
    return 0.0


def get_state() -> dict:
    """返回当前页面快照的深拷贝（空 dict 表示还没有推送）。

    多进程场景（Hermes Studio 桌面版 gateway + bridge 双进程均绑定 4399，
    推送可能落在任一进程）：内存 state 可能与磁盘不一致 —— 以磁盘为准
    （磁盘由收到推送的进程写入，始终是最新）。比较用 epoch 数值时间戳。
    """
    with _state_lock:
        mem = json.loads(json.dumps(_state))
    try:
        if STATE_FILE.exists():
            disk = json.loads(STATE_FILE.read_text(encoding="utf-8"))
            if isinstance(disk, dict) and disk:
                mem_ts = _ts_epoch(mem)
                disk_ts = _ts_epoch(disk)
                # 磁盘更新的数据优先（多进程下磁盘是权威）
                if not mem or disk_ts >= mem_ts:
                    return disk
    except Exception as exc:
        logger.warning("browser-bridge: get_state 读磁盘失败: %s", exc)
    return mem


def _atomic_write_json(path: Path, data: dict) -> None:
    """原子写 JSON：临时文件 + rename，避免多进程读到半截内容。"""
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _cleanup_images(keep: int = 3) -> None:
    """图片只保留最近 N 个帖子（按目录 mtime 排序），更早的删除。

    规则：永远保留最近 3 个帖子（当前、上一个、上上个），第 4 个出现时删最老的。
    """
    try:
        images_root = STATE_DIR / "images"
        if not images_root.exists():
            return
        dirs = [d for d in images_root.iterdir() if d.is_dir()]
        if len(dirs) <= keep:
            return
        # 按 mtime 从新到旧排序，删除 keep 之后的所有目录
        dirs.sort(key=lambda d: d.stat().st_mtime, reverse=True)
        for old in dirs[keep:]:
            import shutil
            shutil.rmtree(old, ignore_errors=True)
            logger.info("browser-bridge: 清理旧帖子图片: %s", old.name)
    except Exception as exc:
        logger.warning("browser-bridge: 图片清理失败: %s", exc)


def set_state(page: dict) -> None:
    """存入新快照：内存 + 磁盘持久化（原子写）+ 图片保留最近 3 帖。"""
    page["received_at_epoch"] = time.time()
    with _state_lock:
        _state.clear()
        _state.update(page)
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        _atomic_write_json(STATE_FILE, page)
        _cleanup_images(keep=3)
    except Exception as exc:  # 磁盘失败不阻塞接收
        logger.warning("browser-bridge: 状态落盘失败: %s", exc)


def load_state_from_disk() -> None:
    """启动时尝试恢复上次的页面快照。"""
    global _state
    try:
        if STATE_FILE.exists():
            data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data:
                with _state_lock:
                    _state = data
    except Exception as exc:
        logger.warning("browser-bridge: 恢复状态失败: %s", exc)


def refresh_state() -> dict:
    """重新抓取当前快照（供 page_refresh 工具调用）。

    返回: {ok: bool, url, blocks, fetch_mode} 或 {ok: False, error}
    """
    state = get_state()
    if not state:
        return {"ok": False, "error": "还没有页面快照可刷新"}
    page = json.loads(json.dumps(state))
    page["received_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    try:
        _fetch_site_content(page)
        set_state(page)
        return {
            "ok": True,
            "url": page["url"],
            "blocks": len(page.get("content") or []),
            "fetch_mode": page.get("fetch_mode"),
        }
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


# ---------------------------------------------------------------------------
# 站点内容拉取（贴吧 API 全量 / 小黑盒图片下载）—— POST /api/page 与
# GET /api/refresh 共用。修复：多进程下 import 用绝对路径（BUG v3.2.3），
# 小黑盒图片命名序号去重（BUG-6 同款逻辑）。
# ---------------------------------------------------------------------------

def _fetch_site_content(page: dict) -> dict:
    """根据 page['url'] 拉取站点内容，原地更新 page。返回 page。"""
    url = page.get("url", "")
    # 贴吧帖子：自动匿名 API 全量拉取楼层（免滚动）
    if "tieba.baidu.com" in url and "/p/" in url:
        try:
            import importlib.util
            _tf_path = Path(__file__).resolve().parent / "tieba_fetch.py"
            _spec = importlib.util.spec_from_file_location("bb_tieba_fetch", _tf_path)
            tf = importlib.util.module_from_spec(_spec)
            _spec.loader.exec_module(tf)
        except Exception as exc:
            logger.warning("browser-bridge: 加载 tieba_fetch 失败: %s", exc)
            tf = None
        tid = tf.extract_tid(url) if tf else None
        if tid:
            try:
                result = tf.fetch_thread(tid)
                if result.get("success"):
                    page["title"] = result.get("title") or page.get("title", "")
                    page["content"] = result.get("floors") or []
                    page["fetch_mode"] = "tieba_api"
                    page["fetch_meta"] = {
                        "tid": tid,
                        "reply_count": result.get("reply_count"),
                        "total_pages": result.get("total_pages"),
                        "floors": len(result.get("floors") or []),
                        "images_downloaded": result.get("images_downloaded", 0),
                    }
            except Exception as exc:
                page.setdefault("fetch_meta", {})["error"] = f"{type(exc).__name__}: {exc}"
    # 小黑盒：下载 content 里 post 块的 images 到本地（图床带 Referer 可匿名拉）
    # 【固定规范】每次拉取，帖子正文图片必须一并下载纳入分析（见 README 图片处理章节）
    elif "xiaoheihe.cn" in url and "/link/" in url:
        try:
            import re as _re
            xhh_dir = Path(__file__).resolve().parent / "state" / "images" / (
                _re.search(r"/link/(\d+)", url).group(1)
                if _re.search(r"/link/(\d+)", url) else "xhh"
            )
            xhh_dir.mkdir(parents=True, exist_ok=True)
            downloaded = 0
            for blk in page.get("content") or []:
                urls = blk.get("images") or []
                if not urls:
                    continue
                local = []
                for u in urls:
                    try:
                        req = urllib.request.Request(u, headers={
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0",
                            "Referer": "https://xiaoheihe.cn/",
                        })
                        with urllib.request.urlopen(req, timeout=30) as resp:
                            data = resp.read()
                        if not data:
                            continue
                        ext = "jpg"
                        ctype = resp.headers.get("Content-Type", "")
                        if "png" in ctype:
                            ext = "png"
                        elif "gif" in ctype:
                            ext = "gif"
                        # 用 URL 路径中的唯一片段命名（小黑盒 URL 尾部相同，需取中间哈希段）
                        path_part = u.split("?")[0]
                        segs = [s for s in path_part.split("/") if s]
                        name_base = segs[-1] if segs else "img"
                        if name_base.endswith((".jpg", ".png", ".gif", ".jpeg")):
                            name_base = name_base.rsplit(".", 1)[0]
                        name = f"{_re.sub(r'[^0-9a-zA-Z]', '_', name_base)[:40]}_{downloaded}.{ext}"
                        path = xhh_dir / name
                        path.write_bytes(data)
                        local.append(str(path))
                        downloaded += 1
                    except Exception:
                        continue
                if local:
                    blk["images_local"] = local
            page.setdefault("fetch_meta", {})["images_downloaded"] = downloaded
        except Exception as exc:
            page.setdefault("fetch_meta", {})["img_error"] = f"{type(exc).__name__}: {exc}"
    return page


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class _BridgeHandler(BaseHTTPRequestHandler):
    """处理扩展的推送请求。

    端点：
      GET  /health     → 存活检查（扩展用它探测 server 是否在跑）
      POST /api/page   → 接收页面快照（需 X-Bridge-Token 头）
    """

    def log_message(self, fmt, *args):  # 静默，避免刷日志
        pass

    def _send_json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # 允许浏览器扩展页面跨域调用（MV3 扩展 fetch 本地端口）
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Bridge-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        self._send_json(200, {"ok": True})

    def _check_token(self) -> bool:
        token = self.headers.get("X-Bridge-Token", "")
        return token == TOKEN

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            self._send_json(200, {"ok": True, "service": "browser-bridge"})
        elif self.path == "/api/refresh":
            # 重新抓取当前快照的 URL（贴吧走 API 全量，小黑盒仅重推）
            if not self._check_token():
                self._send_json(403, {"error": "bad token"})
                return
            state = get_state()
            if not state:
                self._send_json(404, {"error": "no snapshot to refresh"})
                return
            page = json.loads(json.dumps(state))
            page["received_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
            _fetch_site_content(page)
            set_state(page)
            self._send_json(200, {
                "ok": True,
                "url": page["url"],
                "blocks": len(page.get("content") or []),
                "fetch_mode": page.get("fetch_mode"),
            })
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path != "/api/page":
            self._send_json(404, {"error": "not found"})
            return
        if not self._check_token():
            self._send_json(403, {"error": "bad token"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length > 0 else b""
            page = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            self._send_json(400, {"error": f"bad payload: {exc}"})
            return
        if not isinstance(page, dict) or not page.get("url"):
            self._send_json(400, {"error": "payload must be a dict with 'url'"})
            return
        page.setdefault("received_at", time.strftime("%Y-%m-%dT%H:%M:%S%z"))
        # 站点内容拉取（贴吧 API 全量 / 小黑盒图片下载）—— 共用函数
        _fetch_site_content(page)
        set_state(page)
        self._send_json(200, {"ok": True, "url": page["url"], "blocks": len(page.get("content") or [])})


# ---------------------------------------------------------------------------
# 生命周期
# ---------------------------------------------------------------------------

def start_server() -> bool:
    """启动本地 HTTP server（线程内，daemon）。返回是否成功。

    多进程防护：Windows 上多个 Hermes 进程（桌面版 gateway + bridge）都会
    加载本插件并尝试绑定 4399。若端口已被占用，说明另一个进程已在服务——
    本进程不再重复绑定，仅保留内存读盘能力（get_state 回退磁盘保证一致性）。
    """
    global _server
    if _server is not None:
        return True
    try:
        # 预检端口是否已被占用（Windows 允许 SO_REUSEADDR 重复绑定，需主动检测）
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        probe.settimeout(1)
        result = probe.connect_ex((HOST, PORT))
        probe.close()
        if result == 0:
            logger.info("browser-bridge: 端口 %d 已被其他进程占用，跳过重复绑定（仅保留读盘模式）", PORT)
            return True
        server = ThreadingHTTPServer((HOST, PORT), _BridgeHandler)
        server.daemon_threads = True
        _server = server
        t = threading.Thread(target=server.serve_forever, daemon=True, name="browser-bridge-http")
        t.start()
        logger.info("browser-bridge: 本地服务已启动 http://%s:%d", HOST, PORT)
        return True
    except Exception as exc:
        logger.warning("browser-bridge: 启动失败（端口被占用?）: %s", exc)
        return False


def stop_server() -> None:
    """停止本地 HTTP server（插件卸载/会话结束时调用）。"""
    global _server
    if _server is not None:
        try:
            _server.shutdown()
            _server.server_close()
        except Exception:
            pass
        _server = None


