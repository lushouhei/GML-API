# -*- coding: utf-8 -*-
"""
用途：本地中转服务。ZCode 这类 Electron 应用不走系统代理，直连 .workers.dev 会被墙。
     本脚本在本机开一个 http://127.0.0.1:8788，ZCode 连它（本地地址不过墙），
     再由本脚本替 ZCode 走你的 Clash 代理把请求转发到 Cloudflare Worker。
路径：01_PROJECTS/GML-API/scripts/local_proxy.py
运行：python scripts/local_proxy.py     （或双击 scripts/启动本地中转.bat）
前置：pip install requests；Clash 等代理软件已开启
"""
import os
import sys
import io
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import requests
except ImportError:
    print("[X] 缺少依赖，请先运行：pip install requests")
    sys.exit(1)

sys.stdout.reconfigure(encoding="utf-8")

# ===== 配置区（一般不用改）=====
LISTEN_HOST = "127.0.0.1"          # 只监听本机，外部访问不到，安全
LISTEN_PORT = 8788                 # 本地端口，被占用就改这里
# Worker 地址从 config/worker_url.txt 读取（该文件已被 .gitignore 排除，不会进仓库）
def _load_upstream():
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "config", "worker_url.txt")
    if os.path.exists(path):
        for line in io.open(path, encoding="utf-8-sig"):
            line = line.strip()
            if line and not line.startswith("#"):
                return line.rstrip("/")
    print("[X] 找不到 config/worker_url.txt")
    print("    请复制 config/worker_url.txt.example 为 worker_url.txt，填入你的 Worker 地址")
    sys.exit(1)

UPSTREAM = _load_upstream()   # 你的 Worker 地址
PROXY = os.environ.get("HTTPS_PROXY") or "http://127.0.0.1:7897"  # 你的 Clash 代理

# 转发时要丢掉的逐跳头（这些由本地连接自己决定，不能原样透传）
HOP_HEADERS = {
    "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "content-length", "accept-encoding",
}

session = requests.Session()
session.trust_env = False          # 不读环境变量，代理由下面显式指定
PROXIES = {"http": PROXY, "https": PROXY}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass   # 关掉默认的逐行日志，改用我们自己的输出

    def _forward(self, method):
        # 1) 读取 ZCode 发来的请求体
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None

        # 2) 复制请求头，去掉逐跳头
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_HEADERS}

        url = UPSTREAM + self.path
        try:
            # 3) 走代理转发到 Worker，stream=True 保证 SSE 能边收边转
            r = session.request(method, url, headers=headers, data=body,
                                proxies=PROXIES, stream=True, timeout=(15, 300))
        except Exception as e:
            print(f"  [X] 转发失败 {method} {self.path} -> {type(e).__name__}: {str(e)[:120]}")
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            msg = f'{{"error":"local_proxy upstream failed: {type(e).__name__}"}}'.encode()
            self.send_header("Content-Length", str(len(msg)))
            self.end_headers()
            self.wfile.write(msg)
            return

        ctype = r.headers.get("Content-Type", "")
        is_sse = "event-stream" in ctype
        print(f"  {method} {self.path[:60]} -> {r.status_code} {'[SSE流]' if is_sse else ''}")

        # 4) 非流式响应必须先把 body 读完，才能算出 Content-Length。
        #    （上游的 Content-Length 在 HOP_HEADERS 里被剥掉了，因为 requests 会自动解压，
        #      解压后长度和上游声明的对不上；这里必须按实际字节数重新声明，
        #      否则客户端不知道 body 到哪结束，会一直挂起等到超时。）
        data = None if is_sse else r.content

        # 5) 回传响应头
        self.send_response(r.status_code)
        for k, v in r.headers.items():
            if k.lower() in HOP_HEADERS or k.lower() == "content-encoding":
                continue
            self.send_header(k, v)
        if is_sse:
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Content-Length", str(len(data)))
        self.end_headers()

        # 6) 回传响应体
        try:
            if is_sse:
                for chunk in r.iter_content(chunk_size=None):
                    if not chunk:
                        continue
                    # HTTP/1.1 分块编码：长度(十六进制)\r\n 数据 \r\n
                    self.wfile.write(f"{len(chunk):X}\r\n".encode())
                    self.wfile.write(chunk)
                    self.wfile.write(b"\r\n")
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            else:
                self.wfile.write(data)
                self.wfile.flush()
        except Exception as e:
            print(f"  [!] 回传中断（客户端可能已断开）: {type(e).__name__}")
        finally:
            r.close()

    def do_POST(self):
        self._forward("POST")

    def do_GET(self):
        self._forward("GET")

    def do_DELETE(self):
        self._forward("DELETE")

    def do_OPTIONS(self):
        self._forward("OPTIONS")


def main():
    # 非流式响应需要 Content-Length，requests 已解压则长度会变，这里统一按实际长度回传
    print("=" * 62)
    print("GML-API 本地中转服务")
    print("=" * 62)
    print(f"  本地地址（填给 ZCode）: http://{LISTEN_HOST}:{LISTEN_PORT}/api/anthropic")
    print(f"  上游 Worker           : {UPSTREAM}")
    print(f"  出网代理              : {PROXY}")
    print("-" * 62)

    # 启动前先自检一次，确认经代理能连通 Worker
    try:
        r = session.get(UPSTREAM + "/ping", proxies=PROXIES, timeout=20)
        print(f"  [OK] 上游自检通过: {r.status_code} {r.text[:20]}")
    except Exception as e:
        print(f"  [X] 上游自检失败: {type(e).__name__}: {str(e)[:120]}")
        print(f"      请确认代理 {PROXY} 已开启（Clash 之类的软件要处于运行状态）")
        print("      服务仍会启动，但转发大概率失败")

    print("-" * 62)
    print("  服务已启动，保持本窗口开着。按 Ctrl+C 停止。")
    print("=" * 62)

    srv = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    srv.daemon_threads = True
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
