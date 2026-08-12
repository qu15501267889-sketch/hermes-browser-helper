"""browser-bridge tool schemas — 模型可见的工具定义。"""

PAGE_STATUS_SCHEMA = {
    "name": "page_status",
    "description": (
        "查看浏览器扩展最近抓取的页面快照的元信息（URL、标题、站点、"
        "抓取时间、内容块数）。若用户问当前浏览器页面/帖子内容，先调用它确认快照状态。"
    ),
    "parameters": {"type": "object", "properties": {}},
}

PAGE_CONTENT_SCHEMA = {
    "name": "page_content",
    "description": (
        "读取浏览器扩展抓取的页面正文。按块（楼层/段落）返回，可用 block_start/block_end "
        "分段读取、keyword 过滤。长页面请分多次读取，不要一次拉全量。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "block_start": {"type": "integer", "description": "起始块序号（0 起），默认 0"},
            "block_end": {"type": "integer", "description": "结束块序号（不含），默认到末尾"},
            "max_chars": {"type": "integer", "description": "单次返回最大字符数，默认 6000，最小 500"},
            "keyword": {"type": "string", "description": "可选，只返回文本包含该关键词的块"},
        },
    },
}

PAGE_REFRESH_SCHEMA = {
    "name": "page_refresh",
    "description": (
        "重新抓取当前页面快照：贴吧会通过官方 API 重新全量拉取全部楼层，"
        "小黑盒重新下载图片。无需用户在浏览器里操作，直接调用即可。"
    ),
    "parameters": {"type": "object", "properties": {}},
}

TOOLS = (
    ("page_status", PAGE_STATUS_SCHEMA, "📄"),
    ("page_content", PAGE_CONTENT_SCHEMA, "📃"),
    ("page_refresh", PAGE_REFRESH_SCHEMA, "🔄"),
)
