#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
site_fetch.py — 通用站点内容拉取器（配置驱动）

设计目标：新增一个网站 = 在 sites/ 下加一个 JSON 配置文件，无需改代码。

用法：
  python site_fetch.py tieba <帖子ID或URL> [--out out.json] [--text out.txt]
  python site_fetch.py --list            # 列出所有已配置站点

配置字段说明（见 sites/tieba.json 示例）：
  base_url      接口地址
  params        固定/模板参数（值支持 {id} {page} 占位符）
  sign          签名算法: {key, style: "md5_concat"} 参数排序拼接+key 后 MD5
  pagination    翻页: {param, start, has_more(点分路径), total_pages(点分路径)}
  items         列表字段的点分路径
  fields        每条记录的字段映射: {输出名: {path, join(可选,数组拼接子字段)}}
  headers       附加请求头（可选）

依赖: curl_cffi (pip install curl_cffi 或 uv run --with curl_cffi python site_fetch.py ...)
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time

try:
    from curl_cffi import requests as curl_requests
except ImportError:
    curl_requests = None

SITES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sites")


def get_path(obj, path):
    """按点分路径取值: 'page.total_page' -> obj['page']['total_page']"""
    cur = obj
    for part in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        elif isinstance(cur, list) and part.isdigit():
            cur = cur[int(part)]
        else:
            return None
        if cur is None:
            return None
    return cur


def make_sign(params, sign_cfg):
    style = sign_cfg.get("style", "md5_concat")
    key = sign_cfg.get("key", "")
    if style == "md5_concat":
        s = "".join(f"{k}={params[k]}" for k in sorted(params)) + key
        return hashlib.md5(s.encode("utf-8")).hexdigest()
    raise ValueError(f"不支持的签名风格: {style}")


def build_params(site, id_, page, page_param=None):
    import random
    ts_ms = str(int(time.time() * 1000))
    ts = str(int(time.time()))
    params = {}
    for k, v in site.get("params", {}).items():
        v = str(v)
        v = v.replace("{id}", str(id_)).replace("{page}", str(page))
        v = v.replace("{ts_ms}", ts_ms).replace("{ts}", ts).replace("{rand}", str(random.randint(100000, 999999)))
        params[k] = v
    if page_param:
        params[page_param] = str(page)
    sign = site.get("sign")
    if sign:
        params["sign"] = make_sign(params, sign)
    return params


def parse_item(raw, fields):
    out = {}
    for out_name, fcfg in fields.items():
        val = get_path(raw, fcfg["path"])
        if isinstance(val, list) and "join" in fcfg:
            val = "".join(
                str(x.get(fcfg["join"], "")) for x in val if isinstance(x, dict)
            )
        out[out_name] = val
    return out


def fetch_site(site_name, id_, max_pages=500, delay=0.1):
    if curl_requests is None:
        raise RuntimeError("缺少 curl_cffi，请先: pip install curl_cffi")
    cfg_path = os.path.join(SITES_DIR, f"{site_name}.json")
    with open(cfg_path, encoding="utf-8") as f:
        site = json.load(f)

    session = curl_requests.Session()
    headers = site.get("headers", {})
    items = []
    page_cfg = site.get("pagination", {})
    page_param = page_cfg.get("param", "pn")
    start = page_cfg.get("start", 1)

    for page in range(start, start + max_pages):
        params = build_params(site, id_, page, page_param)
        resp = session.get(site["base_url"], params=params, headers=headers,
                           impersonate=site.get("impersonate", "chrome124"), timeout=15)
        data = resp.json()
        item_list = get_path(data, site["items"]) or []
        if not item_list:
            break
        for it in item_list:
            items.append(parse_item(it, site["fields"]))
        # 翻页判断
        has_more = get_path(data, page_cfg.get("has_more", ""))
        total_pages = get_path(data, page_cfg.get("total_pages", ""))
        if has_more is not None and not has_more:
            break
        if total_pages and page >= int(total_pages):
            break
        if delay:
            time.sleep(delay)
    return {"site": site_name, "id": id_, "count": len(items), "items": items}


def main():
    ap = argparse.ArgumentParser(description="通用站点内容拉取器（配置驱动）")
    ap.add_argument("site", nargs="?", help="站点名（sites/ 下的配置文件名）")
    ap.add_argument("target", nargs="?", help="帖子ID或URL")
    ap.add_argument("--list", action="store_true", help="列出所有已配置站点")
    ap.add_argument("--out", default="", help="输出JSON文件")
    ap.add_argument("--text", default="", help="输出纯文本文件")
    ap.add_argument("--max-pages", type=int, default=500)
    args = ap.parse_args()

    if args.list or not args.site:
        print("已配置站点:")
        for fn in sorted(os.listdir(SITES_DIR)):
            if fn.endswith(".json"):
                with open(os.path.join(SITES_DIR, fn), encoding="utf-8") as f:
                    meta = json.load(f)
                print(f"  - {fn[:-5]}: {meta.get('name', '')} ({meta.get('base_url', '')[:60]})")
        return

    # 从 URL 提取 ID（通用：找数字串，优先 /xxx/ 形式）
    id_ = args.target
    m = re.search(r"/(\d+)(?:[?/]|$)", args.target)
    if m:
        id_ = m.group(1)
    if not id_ or not str(id_).isdigit():
        print(f"无法识别ID: {args.target}")
        sys.exit(1)

    print(f"拉取 {args.site} id={id_} ...")
    result = fetch_site(args.site, id_, args.max_pages)
    print(f"完成: {result['count']} 条")

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=1)
        print(f"JSON已保存: {args.out}")
    if args.text:
        with open(args.text, "w", encoding="utf-8") as f:
            for it in result["items"]:
                f.write(str(it) + "\n")
        print(f"文本已保存: {args.text}")
    if not args.out and not args.text:
        for it in result["items"][:10]:
            print(str(it)[:120])


if __name__ == "__main__":
    main()
