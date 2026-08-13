#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
hermes链接浏览器助手 - 一键部署脚本（agent 可直接执行）

做什么：
  1. 检测环境（Python、Edge/Chrome）
  2. 启动本地服务（server/ensure-server-running.py）
  3. 验证服务就绪（127.0.0.1:4399）
  4. 用 --load-extension 启动浏览器并加载扩展
  5. 提示手动确认（首次需开开发者模式）

用法：
  python install.py                # 自动检测浏览器
  python install.py --browser edge # 指定 Edge
  python install.py --browser chrome
  python install.py --no-browser   # 只启动服务，不打开浏览器

注意：--load-extension 是浏览器官方允许的加载方式，扩展在当次会话有效；
浏览器重启后需重跑本脚本（或手动在扩展管理页加载一次）。
"""
import argparse
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

SERVER_PORT = 4399
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
EXTENSION_DIR = os.path.join(BASE_DIR, "extension")
SERVER_SCRIPT = os.path.join(BASE_DIR, "server", "ensure-server-running.py")

BROWSER_CMDS = {
    "edge": [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        "msedge",
    ],
    "chrome": [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        "chrome",
    ],
}


def step(msg):
    print(f"[hermes-browser-helper] {msg}")


def find_browser(name):
    for cand in BROWSER_CMDS.get(name, []):
        if os.path.sep in cand:  # 绝对路径
            if os.path.exists(cand):
                return cand
        else:  # PATH 命令
            if shutil.which(cand):
                return cand
    return None


def is_server_running():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(1)
        s.connect(("127.0.0.1", SERVER_PORT))
        s.close()
        return True
    except Exception:
        return False


def start_server():
    step("启动本地服务...")
    subprocess.run([sys.executable, SERVER_SCRIPT], timeout=30)
    for _ in range(20):
        if is_server_running():
            step(f"服务已就绪: http://127.0.0.1:{SERVER_PORT}")
            return True
        time.sleep(0.5)
    step("警告: 服务未就绪，请检查 Python 环境")
    return False


def open_browser_with_extension(browser_name):
    exe = find_browser(browser_name)
    if not exe:
        step(f"未找到 {browser_name} 浏览器，跳过（可手动加载扩展）")
        return False
    step(f"用 {browser_name} 启动并加载扩展: {EXTENSION_DIR}")
    try:
        subprocess.Popen(
            [exe,
             f"--load-extension={EXTENSION_DIR}",
             f"--disable-extensions-except={EXTENSION_DIR}",
             "https://www.bing.com"],
            creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
        )
        return True
    except Exception as e:
        step(f"启动浏览器失败: {e}")
        return False


def manual_tips():
    print()
    print("=" * 56)
    print("  首次使用请手动确认一次（约 30 秒）:")
    print("  1. 浏览器地址栏输入 edge://extensions (或 chrome://extensions)")
    print("  2. 打开右上角「开发人员模式」")
    print("  3. 点「加载解压缩的扩展」，选择本目录下的 extension/ 文件夹")
    print("  4. 固定扩展图标，插件即可自动捕获网页")
    print("=" * 56)
    print()
    print("  之后每次使用: 直接运行 python install.py")
    print("  （或双击 setup.bat；浏览器重启后扩展需重新加载一次）")
    print()


def main():
    ap = argparse.ArgumentParser(description="hermes链接浏览器助手 一键部署")
    ap.add_argument("--browser", choices=["edge", "chrome", "auto"], default="auto")
    ap.add_argument("--no-browser", action="store_true", help="只启动服务，不打开浏览器")
    args = ap.parse_args()

    step("开始部署 hermes链接浏览器助手")
    if not os.path.isdir(EXTENSION_DIR):
        step(f"错误: 找不到扩展目录 {EXTENSION_DIR}")
        sys.exit(1)

    ok = start_server()

    if not args.no_browser:
        if args.browser == "auto":
            loaded = False
            for name in ("edge", "chrome"):
                if open_browser_with_extension(name):
                    loaded = True
                    break
            if not loaded:
                step("未找到 Edge/Chrome，请手动加载扩展")
        else:
            open_browser_with_extension(args.browser)

    manual_tips()
    if ok:
        step("部署完成 ✅")
    else:
        step("部署部分完成 ⚠️ 服务未就绪")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
