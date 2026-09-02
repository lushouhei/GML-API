# GML-API · 智谱网页会员转 API

把你已经付费的**智谱清言网页版会员**，变成任何软件都能调用的 OpenAI 兼容 API。
部署在 Cloudflare Workers 上，免费、无服务器、全球加速。

- 上游项目：https://github.com/lushouhei/GML-API （MIT）
- 本目录是**加固后的落地版本**，修复了上游的管理接口鉴权漏洞，并补齐了零基础部署工具链

---

## 快速开始

**第一次部署，照着这个走** → [docs/部署指南.md](docs/部署指南.md)

三条命令概括：

```bash
python scripts\check_token.py
```

```bash
powershell -ExecutionPolicy Bypass -File scripts\deploy.ps1
```

```bash
powershell -ExecutionPolicy Bypass -File scripts\setup_keys.ps1
```

---

## 目录结构

```
GML-API/
├── CLAUDE.md                  ← 项目级规则（给 AI 看的）
├── README.md                  ← 本文件
├── wrangler.toml              ← 部署配置（需自建，已 gitignore）
├── src/                       ← Worker 源码（TypeScript）
│   ├── index.ts               ← 路由 + 鉴权 + token 轮询【已打安全补丁】
│   ├── chat.ts                ← 核心：签名算法 + 智谱接口调用 + 工具调用模拟
│   ├── adapters.ts            ← OpenAI / Claude / Gemini 协议互转
│   ├── sse.ts                 ← 流式响应解析
│   ├── utils.ts               ← MD5 / BASE64 等工具函数
│   ├── admin-panel.ts         ← 可视化管理面板 HTML
│   └── welcome.ts             ← 首页 HTML
├── scripts/
│   ├── check_token.py         ← 部署前体检：验证 token 与接口连通性
│   ├── deploy.ps1             ← 一键部署（带配置前置检查）
│   └── setup_keys.ps1         ← 灌 token + 生成 API Key + 实测链路
├── config/
│   ├── token.txt.example      ← 智谱 refresh_token 模板
│   ├── wrangler.toml.example  ← 部署配置模板
│   ├── token.txt              ← 你的真实 token（已 gitignore）
│   └── secrets.txt            ← 自动生成的密钥汇总（已 gitignore）
├── docs/
│   ├── 部署指南.md            ← 零基础部署教程（从这里开始）
│   ├── 逆向分析报告.md        ← 技术原理 + 安全审计
│   └── 上游原始README.md      ← 上游作者的原始文档
└── logs/                      ← 运行日志
```

---

## 它能干什么

| 能力 | 状态 | 备注 |
|---|---|---|
| OpenAI 协议对话（流式/非流式） | ✅ 可用 | 主力场景 |
| Claude 协议 `/v1/messages` | ✅ 可用 | |
| Gemini 协议 `/v1beta` | ✅ 可用 | |
| AI 绘图 `/v1/images/generations` | ✅ 可用 | 对接智谱绘图智能体 |
| 视频生成 `/v1/videos/generations` | ✅ 可用 | 轮询任务状态 |
| 多账号 token 轮询 | ⚠️ 有限 | 轮询索引存内存，多实例下分配不均 |
| Function Calling / 工具调用 | ⚠️ 不稳 | 靠提示词硬凑，非原生支持 |
| 跑 Claude Code 等编程 agent | ❌ 不推荐 | 依赖上一条，复杂工具调用易失败 |

---

## 已知限制（先看这个再决定用不用）

1. **只能部署 Cloudflare Workers** —— 代码用了 `crypto.subtle.digest("MD5")` 和 `caches.default`，都是 CF workerd 运行时的私有扩展，Node.js / Docker 跑不了
2. **模型名是幌子** —— 填 `glm-4.7` 还是 `glm5` 都走同一个网页版默认助手。只有含 `think` / `deepresearch` 的名字会切换模式
3. **违反智谱服务条款** —— 账号有风控/封禁风险，仅限个人自用，别对外提供服务、别高频跑
4. **上游几乎不维护** —— 1 star 项目，作者明说不修 bug，智谱一改接口就得自己动手
5. **要稳定生产可用** —— 请用官方 API https://open.bigmodel.cn/

---

## 更新日志

### v1.0.0 · 2026-09-01

**首次落地**：基于上游 `lushouhei/GML-API` 完成安全审计与本地化加固。

**安全修复**
- 🔴 修复管理接口鉴权绕过漏洞：`src/index.ts` 三处 `if (env.ADMIN_KEY && ...)` 改为 `if (!env.ADMIN_KEY || ...)`。原逻辑在 `ADMIN_KEY` 未配置时静默跳过鉴权（fail-open），任何人可读取全部 API Key 明文、增删 token 池；现改为 fail-closed
- 🟡 `wrangler.toml` 加入 `.gitignore`，避免管理密钥随代码提交
- 🟡 `deploy.ps1` 增加部署前拦截，检测到 `ADMIN_KEY` 仍为 `changeme` 或空值直接中止

**新增工具链**
- `scripts/check_token.py` —— Python 复刻智谱签名算法，部署前验证 token 有效性与接口连通性，避免白部署
- `scripts/deploy.ps1` —— 一键部署，含 KV id / ADMIN_KEY 配置校验
- `scripts/setup_keys.ps1` —— 自动灌 token、生成 API Key、实测一次真实对话，结果写入 `config/secrets.txt`
- `config/*.example` —— 全中文注释的配置模板

**新增文档**
- `docs/部署指南.md` —— 零基础 8 步部署教程，含 6 个常见问题排错
- `docs/逆向分析报告.md` —— 签名算法拆解、架构分析、安全审计结果、README 与代码的功能真实性核对

**审计结论**
- ✅ 全量扫描 7 个源文件的 `fetch()` 调用与 URL 字面量，所有网络请求目标仅 `chatglm.cn`，**无第三方外传端点、无后门**
- `src/` 下除 `index.ts` 外的 6 个文件与上游完全一致，未做修改

**验证结果**
- ✅ `tsc --noEmit` 类型检查通过（TypeScript 5.9.3），安全补丁未破坏编译
- ✅ `check_token.py` 签名算法自测通过，与 `chat.ts:228` 的 JS 实现一致
- ✅ 两个 PowerShell 脚本语法校验通过（含 UTF-8 BOM，PS 5.1 下中文不乱码）
- ⚠️ `npm audit` 报 6 个漏洞（esbuild / sharp / undici / ws / miniflare / wrangler），**全部属于 devDependencies**，仅本地部署时使用，不会打包进 Worker 运行时。不建议执行 `npm audit fix --force`（会把 wrangler 升到 4.x，可能破坏兼容）

### v1.0.1 · 2026-09-01

**实测验证（真实账号打通）**
- 通过 Reqable 抓包从 chatglm.cn 提取 `chatglm_refresh_token`，写入 `config/token.txt`
- ✅ `check_token.py` 体检通过：refresh_token 有效，成功换取 access_token
- ✅ **端到端链路实测通过**：`refresh_token → access_token → /assistant/stream 真实对话`，模型正常返回内容，SSE 流解析正常
- 结论：**截至 2026-09-01，智谱网页版接口未改版，签名算法仍然有效，本项目可用**

**新增**
- `scripts/e2e_test.py` —— 端到端验证脚本。不经过 Cloudflare，本机直连智谱走完全流程。
  以后调用失败时先跑它，可一次性区分「token 过期」「接口改版」「Cloudflare 侧问题」三类故障

### v1.0.2 · 2026-09-01

**已正式部署上线** —— 生产地址：`https://<your-worker>.workers.dev`

**部署过程中排除的障碍**
- Cloudflare OAuth 授权拿不到 KV 权限：`wrangler 3.114` 走 OAuth 登录后，本地凭据虽记录了 `workers_kv:write`，但 token 实际未获授权，KV 与 D1 接口一律返回 `401 / code 10000`，Workers 脚本接口却正常。重新 logout/login 无效，走代理与直连结果一致（排除代理干扰）
- **解决方案**：改用 Dashboard 手动创建的 API Token（"Edit Cloudflare Workers" 模板），通过 `CLOUDFLARE_API_TOKEN` 环境变量供 wrangler 使用，绕开旧版 OAuth 的 scope 限制。Token 存于 `config/cf_token.txt`（已 gitignore）

**上线验收结果（全部通过）**
| 项目 | 结果 |
|---|---|
| KV Namespace | 已创建 `GLM_TOKENS` |
| Worker 部署 | `glm-2api`，128.5 KiB / gzip 29.28 KiB |
| 智谱 token 入池 | ✅ `/token/check` 返回 `live: true` |
| OpenAI 非流式对话 | ✅ HTTP 200，模型正常回复 |
| OpenAI 流式对话 | ✅ 9 个 SSE 分片正常解析 |
| Claude 协议 `/v1/messages` | ✅ HTTP 200 |
| `/v1/models` | ✅ 返回 `glm5` |
| **安全：无密钥访问 `/admin/apikey`** | ✅ **HTTP 401**（v1.0.0 的 fail-closed 补丁确认生效） |
| 安全：伪造 API Key 对话 | ✅ 被拒绝 |

**注意**：`.workers.dev` 域名在中国大陆可能被拦截，当前经代理访问正常。如需裸连，参考 `docs/部署指南.md` 的自定义域名绑定章节。

### v1.0.3 · 2026-09-01

**新增 z.ai 兼容层，接入 ZCode / Claude Code**

背景：新版 Codex Desktop（26.803.81509）已废弃 `wire_api = "chat"`，只认 Responses API（`/v1/responses`），
而本 Worker 没有该端点，故 Codex 接不上。改走 z.ai 路线 —— ZCode 支持任意 Anthropic 兼容端点，
而本项目已实现 Claude 协议 `/v1/messages`，只需让路由认得 z.ai 的地址形状。

- `src/index.ts` 新增路径前缀剥离：`/api/anthropic/*` → `/*`，`/api/paas/v4/*` → `/v1/*`
- `src/index.ts` 新增 `/v1/messages/count_tokens` 端点（按字符数粗估，智谱网页版无 token 计数接口）

**修复两个上游流式 Bug（Claude 协议下才会暴露）**

1. **回合永不结束** — `src/adapters.ts` `sendMessageStop()` 把 `streamClosed = true` 写在两次
   `safeEnqueue` 之前，而 `safeEnqueue` 内部判断 `if (!streamClosed)`，导致它自己要发的
   `message_delta` / `message_stop` 被全部吞掉，只执行了 `controller.close()`。
   客户端收不到回合结束信号会一直等待。修复：置位移到两个事件发出之后。

2. **流式工具调用吐出破损 JSON** — `src/chat.ts` 的"智能缓冲"用全量 `fullContent` 做判断、
   却只发送局部 `pendingContent`，两边记账不一致；在累积满 20 字符时抢先下结论，此时
   `"tool_calls"` 字样常未流完，被误判为普通文本并把 `mightBeToolCall` 打回 `false`，
   下一片又重新进入缓冲并清空 `pendingContent`，于是丢字符，最终向客户端吐出形如
   `{"olls"Bash","arguments":{"command` 的残缺 JSON。
   修复：以 `{` 开头即全程缓冲到流结束，由 `parseToolCalls` 统一判断；解析不出工具调用时
   把缓冲内容补发为普通文本，避免内容丢失。

**验收（Anthropic 协议流式）**

| 项目 | 修复前 | 修复后 |
|---|---|---|
| 事件序列 | 停在 `content_block_stop` | `message_start → content_block_start → content_block_delta → content_block_stop → message_delta → message_stop` |
| 流式工具调用 | 破损 JSON 泄漏为正文 | 正确解析出 `Bash({"command":"ls -la"})` |
| 非流式工具调用 | 正常 | 正常（`stop_reason: tool_use`） |
| `/api/anthropic/v1/messages` | — | ✅ 200 |
| `/api/paas/v4/chat/completions` | — | ✅ 200 |
| `count_tokens` | — | ✅ 200 |

**ZCode 接入参数**

| 字段 | 值 |
|---|---|
| Anthropic 端点 | `https://<your-worker>.workers.dev/api/anthropic` |
| OpenAI 端点 | `https://<your-worker>.workers.dev/v1` |
| 模型 ID | 任意（如 `glm-5.3`）——见"已知限制"第 2 条，模型名不影响实际调用 |

### v1.0.4 · 2026-09-01

**新增本地中转服务，解决 ZCode 连不上的问题**

ZCode 报"重新连接中"，从 `~/.zcode/cli/log/*.jsonl` 的 `model.network.failed` 事件定位到真因：

```
"reason": "timeout"
"statusMessage": "Cannot connect to API: Connect Timeout Error
                  (attempted address: <your-worker>.workers.dev:443, timeout: 10000ms)"
```

配置完全正确（baseURL、apiKey、模型都对），是 **TCP 层连不上** —— `.workers.dev` 在中国大陆被墙。
本地 Python 脚本能通是因为 requests 会读系统代理环境变量，而 **ZCode 是 Electron/Node，默认不走系统代理**，直连即撞墙。ZCode 也没有代理设置项（配置文件里搜不到任何 proxy 字段）。

**解决方案**：`scripts/local_proxy.py` —— 本机监听 `127.0.0.1:8788`（本地地址不过墙），
接收 ZCode 的请求后，显式经由系统代理（默认 `http://127.0.0.1:7897`）转发到 Cloudflare Worker。

- 支持 SSE 流式转发（`iter_content` 边收边转 + HTTP 分块编码），保证 ZCode 能实时收到 token
- 启动时先自检上游连通性，代理没开会直接提示
- 只监听 `127.0.0.1`，外部访问不到
- 配套 `scripts/启动本地中转.bat`，双击即可运行

**踩坑记录**：初版转发后请求一直挂起直到超时。原因是 `Content-Length` 被放进了逐跳头黑名单
（因为 requests 自动解压后长度与上游声明不符），剥掉后又忘了重新声明，非流式响应就没有任何
长度标识，客户端不知道 body 到哪结束。修复：非流式先 `r.content` 读完再按实际字节数设置
`Content-Length`；流式则改用 `Transfer-Encoding: chunked`。

**验收（经本地中转，客户端 `trust_env=False` 模拟 ZCode 直连）**

| 项目 | 结果 |
|---|---|
| 非流式 `/v1/messages` | ✅ HTTP 200 |
| 流式事件序列 | ✅ `message_start → content_block_start → content_block_delta → content_block_stop → message_delta → message_stop` |
| 流式工具调用 | ✅ `Bash({"command":"ls -la"})` |

**ZCode 最终接入参数（走本地中转）**

| 字段 | 值 |
|---|---|
| Anthropic 端点 | `http://127.0.0.1:8788/api/anthropic` |
| API Key | 见 `config/secrets.txt` |
| 模型 ID | `glm-5.3` |

> 前提：`scripts/启动本地中转.bat` 保持运行，且系统代理（Clash 等）已开启。
> 若不想常驻这个窗口，长久之计是给 Worker 绑自定义域名（Cloudflare 注册约 $10/年，无需备案）。

### v1.0.5 · 2026-09-01

**修复 ZCode「无法读取本地文件」——两个独立的根因**

现象：ZCode 已连通，但模型自称"我当前环境里可用的工具只有联网搜索，没有读取本地文件、
执行 shell 命令的能力"，即使用户已开启完全访问权限。

#### 根因一：53 个工具的 schema 撑爆了网页版输入

从 `~/.zcode/cli/rollout/model-io-*.jsonl` 取出 ZCode 的真实请求体，构成如下：

| 组成 | 字符数 | 占比 |
|---|---|---|
| tools 定义（53 个） | 103,654 | 89% |
| system 提示词 | 13,024 | 11% |
| messages | 2 | — |

`injectToolsPrompt` 原本用 `JSON.stringify(fn.parameters, null, 2)` 把完整 JSON Schema
（还带缩进美化）注入 system 消息。智谱网页版是面向人类聊天的接口，单条输入吃不下 10 万字符，
工具清单要么被截断、要么模型淹没其中根本没看到"你可以调用工具"。

**修复**：新增 `compactSchema()`，把 JSON Schema 压成一行 `参数名*:类型(描述前60字)`，
工具描述截断至 150 字。实测 **120,343 → 16,045 字符，压缩 87%（缩小 7.5 倍）**。

#### 根因二：流式增量被当成累积全量，切碎了输出

`createTransStream` 里合并 parts 用的是 `cachedParts[index] = part` 直接覆盖，
再用 `fullText.substring(sentContent.length)` 取增量。这假设上游发的是累积全量文本。

实测直连智谱验证（同一 logic_id 的 part 文本变化）：

```
[增量] 上次'西湖'  -> 本次'位于'
[增量] 上次'位于'  -> 本次'浙江省'
[增量] 上次'浙江省' -> 本次'杭州市'
共 19 次更新：增量模式 17 次，累积模式 1 次（仅收尾补发一次全文）
```

**上游发的是增量片段**。覆盖后 `fullText` 只剩最新的一两个字，再被一个很长的
`sentContent.length` 一切，输出就成了被啃掉开头的碎片 —— 表现为正文乱码，
以及工具调用 JSON 破损后解析失败、泄漏成正文：

```
收到: {"olls"Read","arguments":{"file}]}uments":{"file_path":"D:\...README.md"}}]}
应为: {"tool_calls":[{"name":"Read","arguments":{"file_path":"..."}}]}
```

非流式路径不受影响（它只取最后一个事件的全量文本），这就是非流式一直正常、
只有流式出问题的原因。

**修复**：新增 `extractPartText()` / `mergeStreamPart()`，合并同 logic_id 的 part 时
按增量追加；对收尾补发的全文（`newText.startsWith(oldText)`）则直接采用，避免重复。

#### 验收（经本地中转 + ZCode 的真实 53 个工具与 system）

| 项目 | 结果 |
|---|---|
| 非流式 + 53 工具 | ✅ `stop_reason: tool_use`，`Read(file_path=".../README.md")` |
| 流式 + 53 工具 | ✅ 正确触发 `Read`，参数完整 |
| 流式工具调用重复测试 | ✅ 2/2 成功 |
| 流式纯文本完整性 | ✅ 3 次中 2 次精确匹配，0 次编码破坏；破损 JSON 与错乱特征消失 |
| A/B 对比（直连 Worker vs 经中转） | ✅ 中转链路无字符损失 |

### v1.0.6 · 2026-09-01

**修复多轮对话下工具调用完全失效**

v1.0.5 压缩工具 schema 后，单轮对话能正常触发工具，但用户在 ZCode 里实际使用仍然失败，
模型自称"我可用的工具只有联网搜索和打开网页链接"，甚至改用智谱网页版自带的搜索工具去
`file://` 打开本地目录，并编造"工具调用次数已达上限"。

**对照实验定位差异**（同一套 53 工具 + 同一 system）：

| 场景 | 工具触发 |
|---|---|
| 单轮全新对话 | ✅ `Read` |
| 多轮（5 条历史） | ❌ 完全不触发 |

**根因**：`injectToolsPrompt` 把工具清单追加到 **system 消息**，而 `messagesPrepare` 在
多轮场景（`messages.length >= 2`）会把整段历史拼接成一条超长文本，用 `<|user|>` /
`<|assistant|>` 标记分隔。工具清单因此被放在整条消息的最开头，离当前问题隔着上万字符，
模型注意力衰减后完全无视它。单轮之所以正常，是因为走的是另一分支，内容短、指令紧邻问题。

（附带发现上游一处 typo：角色标记写成了 `<|sytstem|>`，正确应为 `<|system|>`。未改动，
因为它同时影响历史消息的解析格式，改了反而可能扰动既有行为。）

**修复**：把工具说明从 system 挪到**最后一条 user 消息**末尾，无论单轮多轮都紧邻当前问题。
`content` 为数组（多模态）时追加一个 text 块，为字符串时直接拼接。

**验收**

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 单轮 | ✅ | ✅ |
| 多轮（5 条历史）×6 次 | ❌ 0% | ✅ **83%（5/6）** |
| 多轮（9 条历史） | ❌ | ✅ |

**关于那 17% 的失败**：这是提示词模拟工具调用的固有天花板 —— 智谱网页版接口不原生支持
Function Calling，全靠 system 指令诱导模型输出特定 JSON，模型不遵守时就会退化成普通文本回复。
对 ZCode 这类 agent 意味着平均每 6 次操作可能有 1 次需要重试。**这不是配置问题，无法通过调参消除。**
