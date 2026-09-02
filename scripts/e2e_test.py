# -*- coding: utf-8 -*-
"""
用途：端到端验证。不经过 Cloudflare，直接用本机模拟 Worker 的全部逻辑，
     走完 refresh_token -> access_token -> 真实对话 三步，确认智谱接口没改版。
路径：01_PROJECTS/GML-API/scripts/e2e_test.py
运行：python scripts/e2e_test.py
前置：config/token.txt 里已填好 refresh_token
"""
import hashlib, json, sys, time, uuid, io, os
import requests

sys.stdout.reconfigure(encoding='utf-8')
SECRET = "8a1317a7468aa3ad86e997d08f3f31cb"
ASSISTANT = "65940acff94777010aa6b796"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 项目根目录（本脚本的上一级）

def sign():
    ms = str(int(time.time()*1000)); d=[int(c) for c in ms]
    cs = (sum(d)-d[len(ms)-2]) % 10
    ts = ms[:len(ms)-2]+str(cs)+ms[len(ms)-1]
    n = uuid.uuid4().hex
    return ts, n, hashlib.md5(f"{ts}-{n}-{SECRET}".encode()).hexdigest()

def hdrs(auth, sse=False):
    ts,n,s = sign()
    return {
        "Authorization": f"Bearer {auth}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream" if sse else "application/json",
        "App-Name": "chatglm", "Origin": "https://chatglm.cn",
        "Referer": "https://chatglm.cn/main/alltoolsdetail",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        "X-App-Platform":"pc","X-App-Version":"0.0.1","X-Lang":"zh",
        "X-Device-Id": uuid.uuid4().hex, "X-Request-Id": uuid.uuid4().hex,
        "X-Nonce": n, "X-Sign": s, "X-Timestamp": ts,
    }

tok = [l.strip() for l in io.open(os.path.join(ROOT,"config","token.txt"),encoding="utf-8")
       if l.strip() and not l.strip().startswith("#")][0]

# 1. 换 access_token
r = requests.post("https://chatglm.cn/chatglm/user-api/user/refresh", headers=hdrs(tok), json={}, timeout=20)
at = r.json()["result"]["access_token"]
print("[1/3] access_token 换取成功")

# 2. 打真实对话
body = {
    "assistant_id": ASSISTANT, "conversation_id": "", "project_id": "", "chat_type": "user_chat",
    "messages": [{"role":"user","content":[{"type":"text","text":"只回复四个字：链路已通"}]}],
    "meta_data": {"channel":"","draft_id":"","if_plus_model":True,"input_question_type":"xxxx",
                  "is_networking":True,"is_test":False,"platform":"pc","quote_log_id":"",
                  "cogview":{"rm_label_watermark":False}},
}
r = requests.post("https://chatglm.cn/chatglm/backend-api/assistant/stream",
                  headers=hdrs(at, sse=True), json=body, stream=True, timeout=90)
ct = r.headers.get("content-type","")
print(f"[2/3] 对话接口 HTTP {r.status_code}, content-type={ct}")
if "event-stream" not in ct:
    print("    [X] 不是 SSE 流，返回：", r.text[:400]); sys.exit(1)

final, model_seen, n = "", set(), 0
for line in r.iter_lines(decode_unicode=True):
    if not line or not line.startswith("data:"): continue
    n += 1
    try: d = json.loads(line[5:].strip())
    except: continue
    if d.get("model"): model_seen.add(d["model"])
    for p in d.get("parts", []):
        for c in p.get("content", []):
            if c.get("type")=="text" and c.get("text"): final = c["text"]
    if d.get("status") == "finish": break

print(f"[3/3] 收到 {n} 个 SSE 事件")
print(f"      上游真实模型: {', '.join(model_seen) if model_seen else '未标注'}")
print(f"      模型回复: {final.strip()[:120]}")
print("\n===> 端到端链路验证 " + ("通过" if final.strip() else "失败：无内容返回"))
