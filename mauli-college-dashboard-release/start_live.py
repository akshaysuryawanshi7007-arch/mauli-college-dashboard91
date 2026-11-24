#!/usr/bin/env python3
"""
Mauli College Dashboard - Live Deployment & Tunnel Launcher
Starts the backend database server and creates a secure, public HTTPS link
via Cloudflare Tunnel so anyone on any device can access it instantly.
"""

import os
import sys
import time
import re
import socket
import subprocess
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
DATA_DIR = BASE_DIR / "data"
CLOUDFLARED = BASE_DIR / "cloudflared.exe"
LIVE_URL_FILE = BASE_DIR / "live_url.txt"
PORT = int(os.environ.get("PORT", 3000))

def get_lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

def find_node() -> str | None:
    # 1. Check PATH
    try:
        subprocess.run(["node", "-v"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        return "node"
    except Exception:
        pass
    # 2. Check cursor helper path
    cursor_node = Path(r"C:\Users\aksha\AppData\Local\Programs\cursor\resources\app\resources\helpers\node.exe")
    if cursor_node.exists():
        return str(cursor_node)
    return None

def main():
    print("=" * 72)
    print("  MAULI COLLEGE OF ENGINEERING & TECHNOLOGY, SHEGAON")
    print("  AI-Powered Centralized Management Dashboard")
    print("  Starting Backend Server & Live Internet Cloudflare Tunnel...")
    print("=" * 72)

    env = os.environ.copy()
    env["SUPERADMIN_PASSWORD"] = env.get("SUPERADMIN_PASSWORD", "SuperAdmin@123")
    env["INITIAL_PASSWORD"] = env.get("INITIAL_PASSWORD", "Welcome@123")
    env["PORT"] = str(PORT)
    env["DATA_DIR"] = str(DATA_DIR)

    # 1. Start Server (prefer node.exe if available with DatabaseSync, fallback to server.py)
    node_path = find_node()
    server_cmd = None
    if node_path and (BASE_DIR / "server.js").exists():
        server_cmd = [node_path, str(BASE_DIR / "server.js")]
        print(f"[*] Starting backend using Node.js runtime ({node_path})...")
    else:
        server_cmd = [sys.executable, str(BASE_DIR / "server.py")]
        print(f"[*] Starting backend using Python 3 runtime ({sys.executable})...")

    server_proc = subprocess.Popen(server_cmd, cwd=str(BASE_DIR), env=env)
    time.sleep(1.5)

    # 2. Check if server process is running
    if server_proc.poll() is not None:
        print("[!] Backend server failed to start. Switching to Python server.py...")
        server_cmd = [sys.executable, str(BASE_DIR / "server.py")]
        server_proc = subprocess.Popen(server_cmd, cwd=str(BASE_DIR), env=env)
        time.sleep(1.5)

    # 3. Start Cloudflare Tunnel for Live Public Access
    cf_proc = None
    live_url = None

    if CLOUDFLARED.exists():
        print("[*] Launching Cloudflare Tunnel for live public access...")
        cf_cmd = [str(CLOUDFLARED), "tunnel", "--url", f"http://127.0.0.1:{PORT}"]
        cf_proc = subprocess.Popen(
            cf_cmd,
            cwd=str(BASE_DIR),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1
        )

        start_time = time.time()
        url_pattern = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")
        
        while time.time() - start_time < 20:
            line = cf_proc.stdout.readline()
            if not line:
                if cf_proc.poll() is not None:
                    break
                time.sleep(0.1)
                continue
            match = url_pattern.search(line)
            if match:
                live_url = match.group(0)
                break

    lan_ip = get_lan_ip()

    print("\n" + "=" * 72)
    print("  APPLICATION IS LIVE & READY FOR USE ACROSS ALL DEVICES!")
    print("=" * 72)
    if live_url:
        print(f"\n  >>> 🌐 GLOBAL LIVE INTERNET LINK (Accessible to anyone, anywhere):\n      {live_url}\n")
        try:
            with open(LIVE_URL_FILE, "w", encoding="utf-8") as f:
                f.write(live_url + "\n")
        except Exception:
            pass
    else:
        print("\n  [!] Public tunnel initialization timed out or offline.")

    print(f"  >>> 📱 Campus Wi-Fi / Local Network Link:\n      http://{lan_ip}:{PORT}\n")
    print(f"  >>> 💻 This Machine Link:\n      http://localhost:{PORT}\n")
    print("-" * 72)
    print("  DEFAULT CREDENTIALS:")
    print(f"    • Super Admin Password : {env['SUPERADMIN_PASSWORD']}")
    print(f"    • Starting User Password: {env['INITIAL_PASSWORD']} (required to choose own password on 1st login)")
    print("=" * 72)
    print("  Press Ctrl+C to stop the server.\n")

    try:
        while True:
            time.sleep(1)
            if server_proc.poll() is not None:
                print("[!] Backend server stopped unexpectedly.")
                break
    except KeyboardInterrupt:
        print("\nStopping services...")
    finally:
        if cf_proc and cf_proc.poll() is None:
            cf_proc.terminate()
        if server_proc and server_proc.poll() is None:
            server_proc.terminate()
        print("Done. Have a great day!")

if __name__ == "__main__":
    main()
