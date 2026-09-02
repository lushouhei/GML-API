# GML-API 项目规则

## 项目定位

智谱清言网页版会员 → OpenAI 兼容 API 的中转层，部署在 Cloudflare Workers。
上游 https://github.com/lushouhei/GML-API（MIT），本目录是加固后的落地版本。

## 铁律

1. **绝不把密钥写进代码或提交到 Git**
   - 智谱 `refresh_token` → `config/token.txt`（已 gitignore）
   - `ADMIN_KEY` / KV id → 根目录 `wrangler.toml`（已 gitignore）
   - 自动生成的密钥汇总 → `config/secrets.txt`（已 gitignore）
   - 只有 `config/*.example` 模板可以进 Git

2. **改 `src/index.ts` 的鉴权逻辑前先看 `docs/逆向分析报告.md` 第四节**
   三处管理接口鉴权是 fail-closed 设计（`!env.ADMIN_KEY || ...`），
   **不要改回上游的 `env.ADMIN_KEY && ...`** —— 那是个鉴权绕过漏洞。

3. **改代码必须同步更新 `README.md` 的更新日志**，带日期戳 + 版本号。

4. **不要尝试改成 Node.js / Docker 部署**，除非先替换掉：
   - `src/utils.ts:13` 的 `crypto.subtle.digest("MD5")`（workerd 私有扩展）
   - `src/chat.ts:201` 的 `caches.default`（Cloudflare Cache API）

## 常用命令

```bash
python scripts\check_token.py                                    # 体检 token
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1      # 部署
powershell -ExecutionPolicy Bypass -File scripts\setup_keys.ps1  # 灌 key + 实测
npx wrangler tail                                                # 看线上实时日志
```

## 排错优先级

token 失效（最常见）→ 智谱接口改版 → KV 配置错误 → Cloudflare 网络。
先跑 `check_token.py` 定位，它能区分「token 过期」和「接口改版」两种情况。
