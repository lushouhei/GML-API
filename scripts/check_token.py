# -*- coding: utf-8 -*-
"""
用途：部署前体检。验证你的智谱 refresh_token 是否有效、chatglm.cn 的私有接口是否还活着。
路径：01_PROJECTS/GML-API/scripts/check_token.py
运行：python scripts/check_token.py
前置：先把 refresh_token 填到 config/token.txt（一行一个），并 pip install requests
"""
import hashlib          # 算 MD5 签名用
import json
import os
import sys
import time
import uuid

try:
    import requests     # 发 HTTP 请求
except ImportError:
    print("[X] 缺少依赖，请先运行：pip install requests")
    sys.exit(1)

# 智谱网页版的签名固定盐（从网页 JS 里挖出来的，全网通用，不是你的私人密钥）
SIGN_SECRET = "8a1317a7468aa3ad86e997d08f3f31cb"
REFRESH_URL = "https://chatglm.cn/chatglm/user-api/user/refresh"

# 项目根目录 = 本脚本的上一级
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN_FILE = os.path.join(ROOT, "config", "token.txt")


def generate_sign():
    """复刻网页版 JS 的签名算法：把毫秒时间戳的倒数第二位换成校验位，再 MD5"""
    ms = str(int(time.time() * 1000))           # 当前毫秒时间戳
    digits = [int(c) for c in ms]               # 拆成一位一位的数字
    # 所有位求和，再减去倒数第二位（这一位马上要被替换掉）
    checksum = (sum(digits) - digits[len(ms) - 2]) % 10
    # 用校验位替换掉倒数第二位，得到"自校验时间戳"
    ts = ms[: len(ms) - 2] + str(checksum) + ms[len(ms) - 1]
    nonce = uuid.uuid4().hex                    # 随机串，防重放
    sign = hashlib.md5(f"{ts}-{nonce}-{SIGN_SECRET}".encode()).hexdigest()
    return ts, nonce, sign


def build_headers(refresh_token):
    """构造伪装成浏览器的请求头（和 Worker 里 FAKE_HEADERS 一致）"""
    ts, nonce, sign = generate_sign()
    return {
        "Authorization": f"Bearer {refresh_token}",
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "App-Name": "chatglm",
        "Origin": "https://chatglm.cn",
        "Referer": "https://chatglm.cn/main/alltoolsdetail",
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"),
        "X-App-Platform": "pc",
        "X-App-Version": "0.0.1",
        "X-Device-Id": uuid.uuid4().hex,
        "X-Request-Id": uuid.uuid4().hex,
        "X-Lang": "zh",
        "X-Nonce": nonce,
        "X-Sign": sign,
        "X-Timestamp": ts,
    }


def check_one(refresh_token, index):
    """拿 refresh_token 去换 access_token，能换到就说明账号有效、接口没变"""
    short = refresh_token[:12] + "..." + refresh_token[-6:]
    print(f"\n[{index}] 检测 token: {short}")
    try:
        resp = requests.post(REFRESH_URL, headers=build_headers(refresh_token),
                             json={}, timeout=20)
    except Exception as e:
        print(f"    [X] 网络请求失败：{e}")
        print("    -> 可能是本机网络问题，或需要代理访问 chatglm.cn")
        return False

    print(f"    HTTP 状态码: {resp.status_code}")
    try:
        data = resp.json()
    except Exception:
        print(f"    [X] 返回的不是 JSON，接口可能已改版。原始内容前 300 字：")
        print("    " + resp.text[:300])
        return False

    code = data.get("code", data.get("status"))
    if code in (0, None) and data.get("result", {}).get("access_token"):
        at = data["result"]["access_token"]
        print(f"    [OK] token 有效！已成功换取 access_token: {at[:20]}...")
        return True

    msg = str(data.get("message", ""))
    print(f"    [X] 换取失败 code={code} message={msg}")
    if "40102" in msg or code == 401:
        print("    -> refresh_token 已过期，请重新登录 chatglm.cn 复制新的")
    else:
        print(f"    -> 完整返回：{json.dumps(data, ensure_ascii=False)[:500]}")
    return False


def main():
    print("=" * 60)
    print("GML-API 部署前体检 —— 验证智谱 refresh_token 与接口连通性")
    print("=" * 60)

    if not os.path.exists(TOKEN_FILE):
        print(f"[X] 没找到配置文件：{TOKEN_FILE}")
        print("    请复制 config/token.txt.example 为 config/token.txt，并填入你的 refresh_token")
        sys.exit(1)

    with open(TOKEN_FILE, "r", encoding="utf-8") as f:
        # 过滤掉空行和 # 开头的注释行
        tokens = [ln.strip() for ln in f if ln.strip() and not ln.strip().startswith("#")]

    if not tokens:
        print(f"[X] {TOKEN_FILE} 里没有有效的 token，请填入后重试")
        sys.exit(1)

    print(f"共读取到 {len(tokens)} 个 token，开始逐个检测...")
    ok = sum(1 for i, t in enumerate(tokens, 1) if check_one(t, i))

    print("\n" + "=" * 60)
    print(f"体检结果：{ok}/{len(tokens)} 个 token 有效")
    if ok:
        print("[OK] 接口连通、账号可用 —— 可以继续部署到 Cloudflare（见 docs/部署指南.md）")
    else:
        print("[X] 全部失败 —— 先别急着部署，按上面的提示排查（多半是 token 过期或接口改版）")
    print("=" * 60)


if __name__ == "__main__":
    main()
