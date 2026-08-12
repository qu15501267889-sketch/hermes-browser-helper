"""browser-bridge plugin — 浏览器内容桥接。

浏览器扩展（Edge/Chrome）把用户当前浏览的页面快照推送到本地 HTTP server，
本插件缓存快照并提供 page_status / page_content / page_refresh 工具，
让模型能读取用户正在看的贴吧/小黑盒页面的完整内容。
"""
from __future__ import annotations

import logging

from . import server
from .schemas import TOOLS
from .tools import (
    _handle_page_content,
    _handle_page_refresh,
    _handle_page_status,
)

logger = logging.getLogger(__name__)

_HANDLERS = {
    "page_status": _handle_page_status,
    "page_content": _handle_page_content,
    "page_refresh": _handle_page_refresh,
}


def register(ctx) -> None:
    """插件入口：启动本地 server 并注册工具。"""
    # 启动时恢复上次快照，再起 HTTP 服务
    server.load_state_from_disk()
    server.start_server()

    for name, schema, emoji in TOOLS:
        ctx.register_tool(
            name=name,
            toolset="browser_bridge",
            schema=schema,
            handler=_HANDLERS[name],
            emoji=emoji,
            description=schema["description"],
        )
    logger.info("browser-bridge: 已注册 %d 个工具", len(TOOLS))
