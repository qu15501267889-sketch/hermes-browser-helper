#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tieba_fetch.py — 贴吧帖子完整楼层拉取（免滚动、免浏览器）
原理：贴吧官方 JSON 接口 c/f/pb/page，签名 key 为 'tiebaclient!!!'（2026 年仍有效）
用法：
  python tieba_fetch.py <帖子ID或URL> [--see-lz] [--out out.json]
示例：
  python tieba_fetch.py 10931183662
  python tieba_fetch.py https://tieba.baidu.com/p/10931183662 --see-lz
依赖：curl_cffi（TLS 指纹模拟，绕过 403）
  pip install curl_cffi  或  uv run --with curl_cffi python tieba_fetch.py ...
"""

import sys
import re
import json
import time
import hashlib
import argparse
from urllib.parse import urlparse, parse_qs

try:
    from curl_cffi import requests as curl_requests
except ImportError:
    curl_requests = None

API_URL = "https://tieba.baidu.com/c/f/pb/page"
SIGN_KEY = "tiebaclient!!!"


def get_sign(params: dict) -> str:
    """贴吧 API 签名：参数按 key 排序拼接 + 固定 key，MD5"""
    s = "".join(f"{k}={params[k]}" for k in sorted(params)) + SIGN_KEY
    return hashlib.md5(s.encode("utf-8")).hexdigest()


def make_params(tid: str, pn: int, see_lz: bool = False) -> dict:
    params = {
        "kz": tid,
        "pn": str(pn),
        "rdt": "1",
        "see_lz": "1" if see_lz else "0",
        "_client_type": "2",          # android
        "_client_version": "12.51.0.0",
        "_client_id": "wapp_%d" % int(time.time() * 1000),
        "_t": str(int(time.time())),
    }
    params["sign"] = get_sign(params)
    return params


def extract_tid(arg: str) -> str:
    m = re.search(r"tieba\.baidu\.com/p/(\d+)", arg)
    if m:
        return m.group(1)
    if arg.isdigit():
        return arg
    raise ValueError(f"无法识别帖子ID: {arg}")


def parse_post(p: dict) -> dict:
    """楼层 JSON -> 结构化 dict"""
    # content 是 [{text, type}] 数组，拼接文本
    content = ""
    for c in p.get("content") or []:
        if isinstance(c, dict):
            content += c.get("text", "")
    # 作者
    author = (p.get("author_name") or p.get("name") or p.get("author") or "").strip()
    return {
        "floor": p.get("floor"),
        "author": author or None,
        "time": p.get("time"),
        "agree": p.get("agree"),
        "sub_post_number": p.get("sub_post_number", 0),
        "content": content,
    }


def fetch_page(tid: str, pn: int, see_lz: bool = False, session=None) -> dict:
    params = make_params(tid, pn, see_lz)
    sess = session or curl_requests
    r = sess.get(API_URL, params=params, impersonate="chrome124", timeout=15)
    j = r.json()
    if j.get("error_code") not in (0, None):
        raise RuntimeError(f"API错误: {j.get('error_code')} {j.get('error_msg')}")
    return j


def fetch_all(tid: str, see_lz: bool = False, max_pages: int = 500, delay: float = 0.1) -> dict:
    """拉取全部楼层"""
    if curl_requests is None:
        raise RuntimeError("缺少 curl_cffi，请先: pip install curl_cffi")
    session = curl_requests.Session()
    all_floors = []
    page_info = {}
    seen_floors = set()

    for pn in range(1, max_pages + 1):
        j = fetch_page(tid, pn, see_lz, session)
        page_info = j.get("page") or {}
        posts = j.get("post_list") or []
        if not posts:
            break
        for p in posts:
            parsed = parse_post(p)
            # 按楼号去重（广告楼等可能重复）
            if parsed["floor"] and parsed["floor"] not in seen_floors:
                seen_floors.add(parsed["floor"])
                all_floors.append(parsed)
        # 分页判断
        has_more = page_info.get("has_more", 0)
        total_page = page_info.get("total_page") or page_info.get("new_total_page")
        if not has_more:
            break
        if total_page and pn >= total_page:
            break
        if delay:
            time.sleep(delay)

    all_floors.sort(key=lambda f: f["floor"] or 0)
    return {"tid": tid, "total_num": page_info.get("total_num"), "total_page": page_info.get("total_page"),
            "floor_count": len(all_floors), "floors": all_floors}


def to_text(result: dict) -> str:
    lines = [f"帖子 tid={result['tid']} | 共 {result.get('total_num')} 楼 | 拉到 {result['floor_count']} 条"]
    for f in result["floors"]:
        author = f["author"] or "匿名"
        lines.append(f"\n【第{f['floor']}楼】{author}：\n{f['content']}")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description="贴吧帖子完整楼层拉取（免滚动）")
    ap.add_argument("target", help="帖子ID或URL")
    ap.add_argument("--see-lz", action="store_true", help="只看楼主")
    ap.add_argument("--out", default="", help="输出JSON文件路径")
    ap.add_argument("--text", default="", help="输出纯文本文件路径")
    ap.add_argument("--max-pages", type=int, default=500)
    args = ap.parse_args()

    tid = extract_tid(args.target)
    print(f"拉取帖子 {tid} ...")
    result = fetch_all(tid, args.see_lz, args.max_pages)
    print(f"完成: 共 {result.get('total_num')} 楼, 拉到 {result['floor_count']} 条, {result.get('total_page')} 页")

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=1)
        print(f"JSON已保存: {args.out}")
    if args.text:
        with open(args.text, "w", encoding="utf-8") as f:
            f.write(to_text(result))
        print(f"文本已保存: {args.text}")
    if not args.out and not args.text:
        # 打印前 10 楼预览
        for f in result["floors"][:10]:
            print(f"[{f['floor']}] {f['content'][:50]}")


if __name__ == "__main__":
    main()
