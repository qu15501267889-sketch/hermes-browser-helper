#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
卸载：停止本地服务 + 移除开机自启 + 提示删除扩展
"""
import os
import re
import socket
import subprocess
import sys

SERVER_PORT = 8765


def stop_server():
    """找到监听端口的进程并结束"""
    try:
        out = subprocess.run(
            ["netstat", "-ano"], capture_output=True, text=True, timeout=15
        ).stdout
        pids = set()
        for line in out.splitlines():
            if f":{SERVER_PORT}" in line and "LISTENING" in line:
                m = re.search(r"(\d+)\s*$", line.strip())
                if m:
                    pids.add(m.group(1))
        for pid in pids:
            subprocess.run(["taskkill", "/f", "/pid", pid], capture_output=True)
            print(f"[卸载] 已停止服务进程 PID={pid}")
        if not pids:
            print("[卸载] 服务未在运行")
    except Exception as e:
        print(f"[卸载] 停止服务失败: {e}")


def remove_autostart():
    try:
        import winreg
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Run",
            0, winreg.KEY_SET_VALUE | winreg.KEY_QUERY_VALUE,
        )
        # 删除所有与 hermes 相关的自启项
        try:
            i = 0
            removed = []
            while True:
                name, _, _ = winreg.EnumValue(key, i)
                if "hermes" in name.lower() or "browser-page" in name.lower():
                    winreg.DeleteValue(key, name)
                    removed.append(name)
                else:
                    i += 1
        except OSError:
            pass
        winreg.CloseKey(key)
        if removed:
            print(f"[卸载] 已移除开机自启: {removed}")
        else:
            print("[卸载] 无开机自启项")
    except Exception as e:
        print(f"[卸载] 移除自启失败: {e}")


def main():
    print("hermes链接浏览器助手 - 卸载")
    stop_server()
    remove_autostart()
    print()
    print("请在浏览器扩展管理页手动移除扩展：")
    print("  edge://extensions  或  chrome://extensions")
    print("  删除「Hermes 网页助手」")
    print()
    print("卸载完成 ✅")


if __name__ == "__main__":
    main()
