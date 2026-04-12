#!/usr/bin/env python3
from __future__ import annotations

import http.server
import os
import socketserver
import threading
import webbrowser
from pathlib import Path


HOST = "127.0.0.1"
PORT = 8765


def main() -> None:
    base_dir = Path(__file__).resolve().parent
    os.chdir(base_dir)
    handler = http.server.SimpleHTTPRequestHandler
    with socketserver.TCPServer((HOST, PORT), handler) as httpd:
        url = f"http://{HOST}:{PORT}/figure-canvas-editor.html"
        print(f"Serving {base_dir}")
        print(f"Open {url}")
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
        httpd.serve_forever()


if __name__ == "__main__":
    main()
