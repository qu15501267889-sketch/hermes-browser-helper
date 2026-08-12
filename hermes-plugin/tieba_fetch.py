"""贴吧全量楼层拉取 —— 匿名调用官方移动端 API（c/f/pb/page + 签名）。

参考 hermes-browser-helper/scripts/site_fetch.py 的方案：
  - 接口: https://tieba.baidu.com/c/f/pb/page
  - 签名: 参数按 key 排序拼接 + 'tiebaclient!!!' 后 md5
  - 翻页: pn 参数，直到 page.has_more == 0
纯标准库实现（urllib），无需 curl_cffi。
"""
from __future__ import annotations

import hashlib
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://tieba.baidu.com/c/f/pb/page"
SECRET = "tiebaclient!!!"

UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)


def _make_sign(params: dict) -> str:
    s = "".join(f"{k}={params[k]}" for k in sorted(params)) + SECRET
    return hashlib.md5(s.encode("utf-8")).hexdigest()


def _build_params(tid: str, pn: int) -> dict:
    ts_ms = str(int(time.time() * 1000))
    ts = str(int(time.time()))
    params = {
        "kz": str(tid),
        "rdt": "1",
        "see_lz": "0",
        "_client_type": "2",
        "_client_version": "12.51.0.0",
        "_client_id": f"wapp_{ts_ms}",
        "_t": ts,
        "pn": str(pn),
    }
    params["sign"] = _make_sign(params)
    return params


def _request_page(tid: str, pn: int, timeout: int = 20) -> dict:
    url = API + "?" + urllib.parse.urlencode(_build_params(tid, pn))
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", errors="ignore"))


def _post_text(post: dict) -> str:
    content = post.get("content") or []
    parts = []
    for c in content:
        if not isinstance(c, dict):
            continue
        ctype = c.get("type")
        if ctype == 0:
            parts.append(str(c.get("text", "")))
        elif ctype == 1 or c.get("big_cdn_src") or c.get("cdn_src"):
            # 真实图片：保留 URL，模型/用户可查看
            url = c.get("big_cdn_src") or c.get("cdn_src") or ""
            parts.append(f"[图片]({url})")
        elif ctype == 2:
            # 表情：用可读名称（c 字段）或占位
            name = c.get("c") or c.get("text") or "表情"
            parts.append(f"[{name}]")
        else:
            text = str(c.get("text", ""))
            if text:
                parts.append(text)
    return "".join(parts).strip()


_IMG_RE = None

def _extract_images(post: dict) -> list:
    """提取楼层里的图片 URL（type=1 或带 cdn_src 的真实图片）。"""
    urls = []
    for c in post.get("content") or []:
        if not isinstance(c, dict):
            continue
        if c.get("type") == 1 or c.get("big_cdn_src") or c.get("cdn_src"):
            url = c.get("big_cdn_src") or c.get("cdn_src") or ""
            if url:
                urls.append(url)
    return urls


def _download_image(url: str, save_dir, timeout: int = 30) -> str | None:
    """下载图片到 save_dir，返回本地路径（失败返回 None）。带 Referer 过图床防盗链。"""
    try:
        import re as _re
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Referer": "https://tieba.baidu.com/",
        })
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = resp.read()
        if not data:
            return None
        ext = "jpg"
        ctype = resp.headers.get("Content-Type", "")
        if "png" in ctype:
            ext = "png"
        elif "gif" in ctype:
            ext = "gif"
        save_dir.mkdir(parents=True, exist_ok=True)
        name = f"{_re.sub(r'[^0-9a-zA-Z]', '_', url.split('/')[-1].split('?')[0])[:40]}.{ext}"
        path = save_dir / name
        path.write_bytes(data)
        return str(path)
    except Exception:
        return None


def _parse_post(post: dict, user_map: dict | None = None) -> dict:
    ts = post.get("time")
    # 作者：post_list 无 author_name，作者名在响应顶层 user_list（按 author_id 映射）
    author = ""
    uid = post.get("author_id")
    if user_map and uid is not None:
        author = user_map.get(uid) or ""
    if not author:
        author = (post.get("author_name") or post.get("name") or "").strip()
    return {
        "type": "floor",
        "floor": post.get("floor") or 0,
        "author": author,
        "time": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts)) if ts else "",
        "text": _post_text(post)[:8000],
    }


def extract_tid(url_or_id: str) -> str | None:
    """从贴吧 URL 或纯 id 提取帖子 id。"""
    s = str(url_or_id).strip()
    m = __import__("re").search(r"/(?:p|t)/(\d+)", s)
    if m:
        return m.group(1)
    if s.isdigit():
        return s
    return None


def fetch_thread(tid: str, max_pages: int = 100, delay: float = 0.1,
                 download_images: bool = True, images_dir=None) -> dict:
    """拉取贴吧帖子全部楼层。

    参数:
      tid            帖子 id
      max_pages      最大翻页数
      delay          每页间隔（秒）
      download_images 是否下载图片到本地（默认 True，主楼+所有楼层图片）
      images_dir     图片保存目录（默认 <插件目录>/state/images/<tid>/）

    返回: {success, tid, title, reply_count, total_pages, floors: [...]}
    失败: {success: False, error: str}
    """
    floors = []
    page = None
    title = ""
    reply_count = 0
    pages = 0
    user_map = {}
    seen_floors = set()
    if images_dir is None:
        images_dir = Path(__file__).resolve().parent / "state" / "images" / str(tid)
    downloaded = 0
    try:
        for pn in range(1, max_pages + 1):
            data = _request_page(tid, pn)
            if data.get("error_code") not in (0, None):
                return {"success": False, "error": data.get("error_msg") or f"error_code={data.get('error_code')}"}
            page = data.get("page") or {}
            plist = data.get("post_list") or []
            if pn == 1:
                title = page.get("title") or (plist[0].get("title") if plist else "") or ""
                reply_count = page.get("total_num") or 0
            # 作者名映射：user_list 每项 {id, name/name_show}
            for u in data.get("user_list") or []:
                uid = u.get("id")
                if uid is not None and uid not in user_map:
                    user_map[uid] = u.get("name") or u.get("name_show") or ""
            plist = data.get("post_list") or []
            for p in plist:
                parsed = _parse_post(p, user_map)
                floor_no = parsed["floor"]
                if floor_no and floor_no not in seen_floors:
                    seen_floors.add(floor_no)
                    # 图片：提取 URL + 下载到本地
                    img_urls = _extract_images(p)
                    if img_urls:
                        parsed["images"] = img_urls
                        if download_images:
                            local = []
                            for u in img_urls:
                                path = _download_image(u, images_dir)
                                if path:
                                    local.append(path)
                                    downloaded += 1
                            if local:
                                parsed["images_local"] = local
                    floors.append(parsed)
            pages = pn
            if not page.get("has_more"):
                break
            if delay:
                time.sleep(delay)
        floors.sort(key=lambda f: f["floor"] or 0)
        return {
            "success": True,
            "tid": tid,
            "title": title,
            "reply_count": reply_count,
            "total_pages": pages,
            "images_downloaded": downloaded,
            "images_dir": str(images_dir) if downloaded else "",
            "floors": floors,
        }
    except Exception as exc:
        return {"success": False, "error": f"{type(exc).__name__}: {exc}"}


