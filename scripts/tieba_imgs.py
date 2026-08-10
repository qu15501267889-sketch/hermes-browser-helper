#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""提取贴吧帖子里的所有图片（含楼主/观众区分）"""
import sys, re, time, json, hashlib
try:
    from curl_cffi import requests as curl_requests
except ImportError:
    curl_requests = None

API_URL = "https://tieba.baidu.com/c/f/pb/page"
SIGN_KEY = "tiebaclient!!!"

def get_sign(params):
    s = "".join(f"{k}={params[k]}" for k in sorted(params)) + SIGN_KEY
    return hashlib.md5(s.encode("utf-8")).hexdigest()

def make_params(tid, pn, see_lz=False):
    params = {
        "kz": tid, "pn": str(pn), "rdt": "1",
        "see_lz": "1" if see_lz else "0",
        "_client_type": "2", "_client_version": "12.51.0.0",
        "_client_id": "wapp_%d" % int(time.time()*1000),
        "_t": str(int(time.time())),
    }
    params["sign"] = get_sign(params)
    return params

def extract_imgs(tid, see_lz=False, max_pages=500):
    if curl_requests is None:
        raise RuntimeError("缺少 curl_cffi")
    session = curl_requests.Session()
    lz_author_id = None
    all_imgs = []
    seen = set()
    total_posts = 0

    for pn in range(1, max_pages+1):
        r = session.get(API_URL, params=make_params(tid, pn, see_lz), impersonate="chrome124", timeout=15)
        j = r.json()
        posts = j.get("post_list") or []
        if not posts:
            break
        total_posts += len(posts)
        if lz_author_id is None:
            for p in posts:
                if p.get("floor") == 1:
                    lz_author_id = p.get("author_id")
                    break
        for p in posts:
            floor = p.get("floor")
            is_lz = (p.get("author_id") == lz_author_id)
            for c in (p.get("content") or []):
                if c.get("type") == 3:  # type=3 是图片，type=2 是表情
                    url = c.get("cdn_src") or c.get("big_cdn_src") or c.get("origin_src") or ""
                    if not url:
                        continue
                    key = url.split("?")[0]
                    if key in seen:
                        continue
                    seen.add(key)
                    all_imgs.append({
                        "floor": floor, "is_lz": is_lz,
                        "cdn": c.get("cdn_src") or "",
                        "big": c.get("big_cdn_src") or "",
                        "origin": c.get("origin_src") or "",
                        "size": c.get("bsize") or "",
                        "pic_id": c.get("pic_id"),
                    })
        has_more = (j.get("page") or {}).get("has_more", 0)
        if not has_more:
            break
        time.sleep(0.08)
    return {"tid": tid, "total_posts": total_posts, "img_count": len(all_imgs),
            "lz_img_count": sum(1 for i in all_imgs if i["is_lz"]),
            "imgs": all_imgs}

def main():
    target = sys.argv[1] if len(sys.argv) > 1 else None
    if not target:
        print("用法: python tieba_imgs.py <帖子ID或URL> [--see-lz]")
        return
    m = re.search(r"tieba\.baidu\.com/p/(\d+)", target)
    tid = m.group(1) if m else target
    see_lz = "--see-lz" in sys.argv
    result = extract_imgs(tid, see_lz)
    print(f"帖子 {tid}: {result['total_posts']} 条回复, 共 {result['img_count']} 张图片 (楼主 {result['lz_img_count']} 张)")
    # 输出到系统临时目录（用户在意磁盘整洁，不在技能目录留产物）
    import tempfile, os
    out = os.path.join(tempfile.gettempdir(), f"tieba_imgs_{tid}.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print(f"清单已保存: {out}")

if __name__ == "__main__":
    main()
