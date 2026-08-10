import os
import sys
import socket
import subprocess

"""
确保本地网页服务在运行。
- 自动探测脚本路径（不依赖本机硬编码路径）
- 优先使用 pythonw（无窗口），回退 python
"""

SERVER_PORT = 8765
SERVER_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "browser-page-server.py")


def is_server_running():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(1)
        s.connect(("127.0.0.1", SERVER_PORT))
        s.close()
        return True
    except Exception:
        return False


def find_pythonw():
    """优先当前解释器对应的 pythonw；否则在 PATH 里找"""
    exe = sys.executable or ""
    if exe.lower().endswith("pythonw.exe"):
        return exe
    if exe.lower().endswith("python.exe"):
        cand = exe[:-len("python.exe")] + "pythonw.exe"
        if os.path.exists(cand):
            return cand
    for name in ("pythonw.exe", "pythonw"):
        try:
            out = subprocess.run(["where", name], capture_output=True, text=True, timeout=5)
            line = (out.stdout or "").strip().splitlines()
            if line and os.path.exists(line[0]):
                return line[0]
        except Exception:
            pass
    return "pythonw"


def main():
    if is_server_running():
        return
    pythonw = find_pythonw()
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    try:
        subprocess.Popen([pythonw, SERVER_SCRIPT],
                         creationflags=flags,
                         stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)
        print("[Hermes] 网页服务已启动")
    except Exception as e:
        print(f"[Hermes] 启动失败: {e}")


if __name__ == "__main__":
    main()
