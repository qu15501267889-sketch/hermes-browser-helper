"""
browser-page-server.py — 本地小服务
接收浏览器插件发来的网页数据，供 Hermes 读取。

用法：python browser-page-server.py [端口]
默认端口 8765，访问 http://localhost:8765/api/page 查看最新页面数据
"""

import http.server
import json
import sys
import time
import os
from urllib.parse import urlparse

# 存储最新页面数据
latest_page = {
    "data": None,
    "updated_at": None,
    "count": 0,
}

# 存储历史（最多 50 条）
history = []

# 存储最新截图
latest_screenshot = {
    "data": None,
    "updated_at": None,
}


class PageHandler(http.server.BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self._set_cors()
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path

        if path == "/api/page" or path == "/api/page/latest":
            self._send_json(latest_page)
        elif path == "/api/pages":
            self._send_json({"pages": history, "total": len(history)})
        elif path == "/api/screenshot":
            self._send_json({"status": "ok", "latest": latest_screenshot})
        elif path == "/api/health":
            self._send_json({"status": "ok", "uptime": time.time() - start_time})
        elif path == "/":
            self._send_html("""
            <html><head><meta charset="utf-8"><title>Hermes 网页助手 - 本地服务</title>
            <style>body{font-family:sans-serif;max-width:800px;margin:40px auto;padding:0 20px}
            pre{background:#f5f5f5;padding:12px;border-radius:6px;overflow:auto;max-height:500px}
            </style></head>
            <body>
            <h1>Hermes 网页助手</h1>
            <p>状态：运行中</p>
            <p>最新页面：<span id="title">-</span></p>
            <p>捕获次数：<span id="count">0</span></p>
            <pre id="data">无数据</pre>
            <script>
            setInterval(async () => {
                const r = await fetch('/api/page');
                const d = await r.json();
                document.getElementById('title').textContent = d.data?.title || '-';
                document.getElementById('count').textContent = d.count;
                document.getElementById('data').textContent = JSON.stringify(d.data, null, 2);
            }, 2000);
            </script>
            </body></html>
            """)
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b'{"error":"not found"}')

    def do_POST(self):
        path = urlparse(self.path).path

        if path == "/api/page":
            content_len = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_len)
            try:
                data = json.loads(body)
                global latest_page, history
                latest_page = {
                    "data": data,
                    "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "count": latest_page["count"] + 1,
                }
                # 保存到本地文件（供 Hermes 直接读取）
                save_path = os.path.join(os.path.expanduser("~"), "Downloads", "hermes-browser-page", "latest_page.json")
                os.makedirs(os.path.dirname(save_path), exist_ok=True)
                with open(save_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)

                # 保存历史
                history.insert(0, {
                    "title": data.get("title", ""),
                    "url": data.get("url", ""),
                    "timestamp": latest_page["updated_at"],
                })
                if len(history) > 50:
                    history.pop()

                self._send_json({"status": "ok", "id": latest_page["count"]})
            except json.JSONDecodeError:
                self._send_json({"status": "error", "message": "invalid json"}, 400)
        elif path == "/api/screenshot":
            content_len = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_len)
            try:
                data = json.loads(body)
                global latest_screenshot
                latest_screenshot = {
                    "data": {
                        "title": data.get("title", ""),
                        "url": data.get("url", ""),
                        "site": data.get("site", ""),
                        "timestamp": data.get("timestamp", ""),
                    },
                    "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                }
                # 保存截图文件
                save_path = os.path.join(os.path.expanduser("~"), "Downloads", "hermes-browser-page", "screenshot.png")
                import base64
                os.makedirs(os.path.dirname(save_path), exist_ok=True)
                # 从 data URL 提取 base64 数据
                image_b64 = data.get("imageDataUrl", "")
                if image_b64.startswith("data:image/png;base64,"):
                    image_data = base64.b64decode(image_b64.split(",")[1])
                    with open(save_path, "wb") as f:
                        f.write(image_data)
                self._send_json({"status": "ok", "path": save_path})
            except Exception as e:
                self._send_json({"status": "error", "message": str(e)}, 400)
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b'{"error":"not found"}')

    def _set_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, data, status=200):
        self.send_response(status)
        self._set_cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))

    def _send_html(self, html):
        self.send_response(200)
        self._set_cors()
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(html.encode("utf-8"))

    def log_message(self, format, *args):
        if "/api/health" not in args[0]:
            print(f"[Hermes服务] {args[0]}")


start_time = time.time()

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = http.server.HTTPServer(("127.0.0.1", port), PageHandler)
    print(f"\n🚀 Hermes 网页助手 - 本地服务已启动")
    print(f"   http://localhost:{port}/")
    print(f"   http://localhost:{port}/api/page  (GET=查询, POST=接收)")
    print(f"   按 Ctrl+C 停止\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止")
        server.server_close()