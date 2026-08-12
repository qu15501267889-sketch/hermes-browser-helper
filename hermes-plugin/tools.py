"""browser-bridge tools — 模型侧读取页面快照的接口。

三个工具：
  page_status()     → 当前页面元信息（URL/标题/站点/抓取时间/内容概况）
  page_content()    → 读取结构化正文（按楼层范围/字数限制）
  page_refresh()    → 提示用户点击扩展按钮重新抓取（扩展侧未实现时）
"""
from __future__ import annotations

import re
from typing import Any

from tools.registry import tool_error, tool_result

from . import server

# 站点判断
_TIEBA_RE = re.compile(r"tieba\.baidu\.com")
_XHH_RE = re.compile(r"xiaoheihe\.cn")


def _detect_site(url: str) -> str:
    if _TIEBA_RE.search(url):
        return "tieba"
    if _XHH_RE.search(url):
        return "xiaoheihe"
    return "unknown"


def _page_summary(page: dict) -> dict:
    """从快照生成内容概况（供 page_status 返回，避免全量塞给模型）。"""
    content = page.get("content") or []
    total_chars = 0
    if isinstance(content, list):
        total_chars = sum(len(str(item.get("text", ""))) for item in content)
    return {
        "blocks": len(content) if isinstance(content, list) else 0,
        "total_chars": total_chars,
        "first_text": (
            content[0].get("text", "")[:200] if isinstance(content, list) and content else ""
        ),
    }


def _handle_page_status(args: dict, **kw) -> str:
    state = server.get_state()
    if not state:
        return tool_result(
            success=False,
            message="还没有页面快照。请先在你的浏览器（Edge）里打开贴吧/小黑盒页面，"
                    "点击 browser-bridge 扩展的「拉取」按钮抓取当前页面。",
        )
    summary = _page_summary(state)
    return tool_result(
        success=True,
        url=state.get("url", ""),
        site=state.get("site", _detect_site(state.get("url", ""))),
        title=state.get("title", ""),
        fetched_at=state.get("received_at") or state.get("fetched_at", ""),
        summary=summary,
    )


def _handle_page_content(args: dict, **kw) -> str:
    """读取页面内容。

    参数：
      block_start: int  起始块序号（0 起），默认 0
      block_end:   int  结束块序号（不含），默认到末尾
      max_chars:   int  单次返回的最大字符数，默认 6000
      keyword:     str  可选，只返回文本中包含该关键词的块
    """
    state = server.get_state()
    if not state:
        return tool_result(
            success=False,
            message="还没有页面快照。请先在浏览器里点击 browser-bridge 扩展的「拉取」按钮。",
        )

    content = state.get("content") or []
    if not isinstance(content, list) or not content:
        return tool_result(success=False, message="快照里没有内容块（可能页面是空的或抓取失败）。")

    try:
        start = max(0, int(args.get("block_start", 0)))
    except (TypeError, ValueError):
        start = 0
    try:
        end = int(args.get("block_end", len(content)))
    except (TypeError, ValueError):
        end = len(content)
    end = min(max(end, start), len(content))

    max_chars = 6000
    try:
        max_chars = max(500, int(args.get("max_chars", 6000)))
    except (TypeError, ValueError):
        pass

    keyword = str(args.get("keyword", "") or "").strip()

    blocks = content[start:end]
    if keyword:
        blocks = [b for b in blocks if keyword in str(b.get("text", ""))]

    out_blocks = []
    used = 0
    for b in blocks:
        text = str(b.get("text", ""))
        if used + len(text) > max_chars and out_blocks:
            break
        out_blocks.append(b)
        used += len(text)

    return tool_result(
        success=True,
        url=state.get("url", ""),
        title=state.get("title", ""),
        block_start=start,
        returned=len(out_blocks),
        total_blocks=len(content),
        truncated=len(out_blocks) < len(blocks),
        blocks=out_blocks,
    )


def _handle_page_refresh(args: dict, **kw) -> str:
    """请求重新抓取当前页面。

    当前实现：提示用户手动点击扩展按钮（扩展侧的自动重抓在 M2 之后接入）。
    """
    return tool_result(
        success=False,
        message="自动重抓还未接入。请切换到你的浏览器，点击 browser-bridge 扩展的「拉取」按钮，"
                "抓取完成后再问我。",
    )

