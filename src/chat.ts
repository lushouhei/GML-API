import {
  uuid, md5, unixTimestamp, timestamp, isBASE64Data, extractBASE64DataFormat,
  removeBASE64DataHeader, getMimeType, getExtension, basename, isURL,
  isArray, isObject, isString, isFiniteNumber, isUndefined, isError, attempt,
  randomChoice, sleep, fetchFileBASE64
} from "./utils.ts";
import { createParser } from "./sse.ts";

const MODEL_NAME = "glm";
const DEFAULT_ASSISTANT_ID = "65940acff94777010aa6b796";
const ACCESS_TOKEN_EXPIRES = 3600;
const MAX_RETRY_COUNT = 3;
const RETRY_DELAY = 5000;
const FILE_MAX_SIZE = 100 * 1024 * 1024;

let signSecret = "8a1317a7468aa3ad86e997d08f3f31cb";

export function setSignSecret(secret: string) {
  signSecret = secret;
}

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0"
];

const FAKE_HEADERS: Record<string, string> = {
  "Accept": "text/event-stream",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
  "App-Name": "chatglm",
  "Cache-Control": "no-cache",
  "Content-Type": "application/json",
  "Origin": "https://chatglm.cn",
  "Pragma": "no-cache",
  "Priority": "u=1, i",
  "Sec-Ch-Ua": '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "X-App-Fr": "browser_extension",
  "X-App-Platform": "pc",
  "X-App-Version": "0.0.1",
  "X-Device-Brand": "",
  "X-Device-Model": "",
  "X-Exp-Groups": "na_android_config:exp:NA,na_4o_config:exp:4o_A,tts_config:exp:tts_config_a,na_glm4plus_config:exp:open,mainchat_server_app:exp:A,mobile_history_daycheck:exp:a,desktop_toolbar:exp:A,chat_drawing_server:exp:A,drawing_server_cogview:exp:cogview4,app_welcome_v2:exp:A,chat_drawing_streamv2:exp:A,mainchat_rm_fc:exp:add,mainchat_dr:exp:open,chat_auto_entrance:exp:A,drawing_server_hi_dream:control:A,homepage_square:exp:close,assistant_recommend_prompt:exp:3,app_home_regular_user:exp:A,memory_common:exp:enable,mainchat_moe:exp:300,assistant_greet_user:exp:greet_user,app_welcome_personalize:exp:A,assistant_model_exp_group:exp:glm4.5,ai_wallet:exp:ai_wallet_enable",
  "X-Lang": "zh"
};

function getHeaders() {
  const userAgent = randomChoice(USER_AGENTS) || USER_AGENTS[0];
  return { ...FAKE_HEADERS, "User-Agent": userAgent };
}

// ==================== Tool Calling Helpers ====================

/**
 * 把 JSON Schema 压成一行人类可读的参数说明。
 *
 * 为什么必须压：ZCode 这类编程 agent 一次会带 50+ 个工具，原样 JSON.stringify(schema, null, 2)
 * 能到 10 万字符。智谱网页版是给人聊天用的，单条输入吃不下，结果要么被截断、要么模型淹没在
 * schema 里完全没看到"你可以调用工具"这件事，表现就是模型自称"我没有读取文件的能力"。
 * 压缩后 50+ 工具约 8K 字符，模型才能真正看见工具清单。
 */
function compactSchema(params: any): string {
  if (!params || !isObject(params.properties)) return "none";
  const required = new Set<string>(isArray(params.required) ? params.required : []);
  const fields = Object.entries(params.properties).map(([key, spec]: [string, any]) => {
    const type = spec?.type || (spec?.enum ? "enum" : "any");
    // 描述截断到 60 字，够模型判断用途，又不至于撑爆长度
    const desc = String(spec?.description || "").replace(/\s+/g, " ").slice(0, 60);
    const mark = required.has(key) ? "*" : "";   // * 表示必填
    return `${key}${mark}:${type}${desc ? `(${desc})` : ""}`;
  });
  return fields.join(", ") || "none";
}

function injectToolsPrompt(messages: any[], tools: any[]): any[] {
  if (!tools || tools.length === 0) return messages;
  const toolsDesc = tools.map((tool: any) => {
    const fn = tool.function || tool;
    // 工具描述只取首句/前 150 字，长篇用法说明对"判断该不该调用"没有帮助
    const desc = String(fn.description || "").replace(/\s+/g, " ").slice(0, 150);
    return `- ${fn.name}: ${desc}\n  args: ${compactSchema(fn.parameters)}`;
  }).join("\n");
  const prompt = `You are an assistant with access to tools. When you need to use a tool, you MUST output ONLY a single JSON object with NO markdown, NO explanations, and NO extra text.

STRICT RULES:
1. If a tool is needed, output EXACTLY this format (nothing else):
{"tool_calls":[{"name":"TOOL_NAME","arguments":{"param":"value"}}]}

2. Do NOT wrap the JSON in markdown code blocks (no \`\`\`json).
3. Do NOT add any explanation before or after the JSON.
4. If no tool is needed, respond normally with plain text.

Available tools:
${toolsDesc}

Examples:
User: What is the weather in Beijing?
Assistant: {"tool_calls":[{"name":"get_weather","arguments":{"location":"Beijing"}}]}

User: Hello
Assistant: Hello! How can I help you today?`;
  // 把工具说明挂到【最后一条 user 消息】上，而不是塞进开头的 system。
  //
  // 原因：messagesPrepare 在多轮对话时会把整段历史拼成一条超长文本（<|user|>/<|assistant|> 分隔），
  // 放在最前面的 system 指令离当前问题隔着上万字符，模型完全无视工具清单 ——
  // 实测单轮能正确触发 Read，同样的工具集换成 5 条历史消息就 100% 不触发，
  // 模型还会编造"工具调用次数已达上限"来搪塞。挂到末尾后指令紧邻当前问题，注意力才够。
  const newMessages = [...messages];
  for (let i = newMessages.length - 1; i >= 0; i--) {
    const m: any = newMessages[i];
    if (m.role !== "user") continue;
    if (isArray(m.content)) {
      newMessages[i] = { ...m, content: [...m.content, { type: "text", text: "\n\n" + prompt }] };
    } else {
      newMessages[i] = { ...m, content: `${m.content || ""}\n\n${prompt}` };
    }
    return newMessages;
  }
  // 兜底：没有任何 user 消息时，单独追加一条
  newMessages.push({ role: "user", content: prompt });
  return newMessages;
}

function parseToolCalls(content: string): { tool_calls: any[] | null; text: string } {
  if (!content || !content.trim()) return { tool_calls: null, text: content };
  let working = content.trim();

  // 1. 去除 markdown 代码块（```json ... ``` 或 ``` ... ```）
  const codeBlockMatch = working.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    working = codeBlockMatch[1].trim();
  }

  // 2. 尝试精确提取 {"tool_calls": [...]} 结构（支持嵌套对象）
  const braceMatch = extractJsonObject(working, "tool_calls");
  if (braceMatch) {
    try {
      const parsed = JSON.parse(braceMatch);
      if (parsed.tool_calls && Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
        const toolCalls = parsed.tool_calls.map((tc: any, idx: number) => ({
          id: `call_${Math.random().toString(36).slice(2, 11)}_${idx}`,
          type: "function",
          function: {
            name: tc.name || tc.function?.name || "",
            arguments: typeof tc.arguments === "string"
              ? tc.arguments
              : typeof tc.function?.arguments === "string"
                ? tc.function.arguments
                : JSON.stringify(tc.arguments || tc.function?.arguments || {}),
          },
        }));
        // 移除原始内容中的 JSON 部分（包括代码块）
        let text = content.replace(braceMatch, "").trim();
        if (codeBlockMatch) text = content.replace(codeBlockMatch[0], "").trim();
        return { tool_calls: toolCalls, text };
      }
    } catch (_) {
      // 继续尝试修复解析
    }
  }

  // 3. 回退：尝试修复常见 JSON 格式错误后再解析
  try {
    const fixed = working
      .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '"$2":')
      .replace(/:\s*'([^']*)'/g, ':"$1"');
    const parsed = JSON.parse(fixed);
    if (parsed.tool_calls && Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
      const toolCalls = parsed.tool_calls.map((tc: any, idx: number) => ({
        id: `call_${Math.random().toString(36).slice(2, 11)}_${idx}`,
        type: "function",
        function: {
          name: tc.name || tc.function?.name || "",
          arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments || {}),
        },
      }));
      let text = content.replace(working, "").trim();
      if (codeBlockMatch) text = content.replace(codeBlockMatch[0], "").trim();
      return { tool_calls: toolCalls, text };
    }
  } catch (_) {
    // ignore
  }

  return { tool_calls: null, text: content };
}

// 辅助函数：从字符串中提取以指定 key 开头的完整 JSON 对象（支持嵌套）
function extractJsonObject(str: string, key: string): string | null {
  const idx = str.indexOf(`"${key}"`);
  if (idx === -1) return null;
  // 向前找到 {
  let start = idx;
  while (start > 0 && str[start] !== "{") start--;
  if (str[start] !== "{") return null;
  // 向后匹配括号
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"' && !escape) { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return str.slice(start, i + 1); }
  }
  return null;
}

function convertToolMessages(messages: any[]): any[] {
  return messages.map((m: any) => {
    if (m.role === "tool") {
      return {
        role: "user",
        content: `工具 ${m.name || ""} (调用ID: ${m.tool_call_id || ""}) 返回结果：\n${m.content || ""}`,
      };
    }
    return m;
  });
}

function getWorkerCache(): Cache {
  return (caches as any).default;
}

function getTokenCacheKey(refreshToken: string): Request {
  return new Request(`https://internal-cache/glm-token/${refreshToken}`);
}

async function getCachedAccessToken(refreshToken: string): Promise<string | null> {
  const response = await getWorkerCache().match(getTokenCacheKey(refreshToken));
  if (!response) return null;
  try {
    const data: any = await response.json();
    if (data.refreshTime > unixTimestamp()) return data.accessToken;
  } catch {}
  return null;
}

async function setCachedAccessToken(refreshToken: string, accessToken: string, refreshTime: number) {
  await getWorkerCache().put(getTokenCacheKey(refreshToken), new Response(JSON.stringify({ accessToken, refreshTime }), {
    headers: { "Content-Type": "application/json" }
  }));
}

async function deleteCachedAccessToken(refreshToken: string) {
  await getWorkerCache().delete(getTokenCacheKey(refreshToken));
}

async function generateSign() {
  const e = Date.now();
  const A = e.toString();
  const t = A.length;
  const o = A.split("").map((c) => Number(c));
  const i = o.reduce((sum, v) => sum + v, 0) - o[t - 2];
  const a = i % 10;
  const timestamp = A.substring(0, t - 2) + a + A.substring(t - 1, t);
  const nonce = uuid(false);
  const sign = await md5(`${timestamp}-${nonce}-${signSecret}`);
  return { timestamp, nonce, sign };
}

const tokenRequestQueues: Record<string, Array<(result: any) => void>> = {};

async function requestToken(refreshToken: string) {
  if (tokenRequestQueues[refreshToken]) {
    return new Promise((resolve) => tokenRequestQueues[refreshToken].push(resolve));
  }
  tokenRequestQueues[refreshToken] = [];
  const doRequest = async () => {
    const sign = await generateSign();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch("https://chatglm.cn/chatglm/user-api/user/refresh", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${refreshToken}`,
          "Content-Type": "application/json",
          ...getHeaders(),
          "X-Device-Id": uuid(false),
          "X-Nonce": sign.nonce,
          "X-Request-Id": uuid(false),
          "X-Sign": sign.sign,
          "X-Timestamp": `${sign.timestamp}`,
        },
        signal: controller.signal,
      });
      const data = await checkResult(response, refreshToken);
      const { access_token, refresh_token } = data.result;
      return { accessToken: access_token, refreshToken: refresh_token, refreshTime: unixTimestamp() + ACCESS_TOKEN_EXPIRES };
    } finally {
      clearTimeout(timeoutId);
    }
  };
  try {
    const result = await doRequest();
    tokenRequestQueues[refreshToken].forEach((resolve) => resolve(result));
    return result;
  } catch (err) {
    tokenRequestQueues[refreshToken].forEach((resolve) => resolve(err));
    throw err;
  } finally {
    delete tokenRequestQueues[refreshToken];
  }
}

async function acquireToken(refreshToken: string): Promise<string> {
  const cached = await getCachedAccessToken(refreshToken);
  if (cached) return cached;
  const tokenData: any = await requestToken(refreshToken);
  await setCachedAccessToken(refreshToken, tokenData.accessToken, tokenData.refreshTime);
  return tokenData.accessToken;
}

async function removeConversation(convId: string, refreshToken: string, assistantId = DEFAULT_ASSISTANT_ID) {
  const token = await acquireToken(refreshToken);
  const sign = await generateSign();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch("https://chatglm.cn/chatglm/backend-api/assistant/conversation/delete", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Referer: "https://chatglm.cn/main/alltoolsdetail",
        "X-Device-Id": uuid(false),
        "X-Request-Id": uuid(false),
        "X-Sign": sign.sign,
        "X-Timestamp": sign.timestamp,
        "X-Nonce": sign.nonce,
        ...getHeaders(),
      },
      body: JSON.stringify({ assistant_id: assistantId, conversation_id: convId }),
      signal: controller.signal,
    });
    await checkResult(response, refreshToken);
  } catch {}
  finally { clearTimeout(timeoutId); }
}

async function checkResult(response: Response, refreshToken: string): Promise<any> {
  const data: any = await response.json().catch(() => null);
  if (!data) return null;
  const { code, status, message } = data;
  if (!isFiniteNumber(code) && !isFiniteNumber(status)) return data;
  if (code === 0 || status === 0) return data;
  if (code == 401) await deleteCachedAccessToken(refreshToken);
  if (message?.includes('40102')) {
    throw new Error(`[请求glm失败]: 您的refresh_token已过期，请重新登录获取`);
  }
  throw new Error(`[请求glm失败]: ${message}`);
}

async function glmPostStream(url: string, body: any, headers: Record<string, string>, timeout = 120000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function createCompletion(messages: any[], refreshToken: string, model = MODEL_NAME, refConvId = "", retryCount = 0, tools?: any[]): Promise<any> {
  return (async () => {
    let processedMessages = convertToolMessages(messages);
    processedMessages = injectToolsPrompt(processedMessages, tools || []);
    const refFileUrls = extractRefFileUrls(processedMessages);
    const refs = refFileUrls.length ? await Promise.all(refFileUrls.map((fileUrl) => uploadFile(fileUrl, refreshToken))) : [];
    if (!/[0-9a-zA-Z]{24}/.test(refConvId)) refConvId = "";
    let assistantId = /^[a-z0-9]{24,}$/.test(model) ? model : DEFAULT_ASSISTANT_ID;
    let chatMode = '';
    if (model.includes('think') || model.includes('zero')) { chatMode = 'zero'; }
    if (model.includes('deepresearch')) { chatMode = 'deep_research'; }
    const token = await acquireToken(refreshToken);
    const sign = await generateSign();
    const response = await glmPostStream(
      "https://chatglm.cn/chatglm/backend-api/assistant/stream",
      {
        assistant_id: assistantId,
        conversation_id: refConvId,
        project_id: "",
        chat_type: "user_chat",
        messages: messagesPrepare(processedMessages, refs, !!refConvId),
        meta_data: {
          channel: "",
          chat_mode: chatMode || undefined,
          draft_id: "",
          if_plus_model: true,
          input_question_type: "xxxx",
          is_networking: true,
          is_test: false,
          platform: "pc",
          quote_log_id: "",
          cogview: { rm_label_watermark: false }
        },
      },
      {
        Authorization: `Bearer ${token}`,
        ...getHeaders(),
        "X-Device-Id": uuid(false),
        "X-Request-Id": uuid(false),
        "X-Sign": sign.sign,
        "X-Timestamp": sign.timestamp,
        "X-Nonce": sign.nonce,
      }
    );
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) {
      const errText = await response.text();
      console.error(errText);
      throw new Error(`Stream response Content-Type invalid: ${contentType}`);
    }
    const answer = await receiveStream(model, response.body!, tools);
    removeConversation(answer.id, refreshToken, assistantId).catch(() => {});
    return answer;
  })().catch(async (err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      console.error(`Stream response error: ${err.stack || err.message}`);
      await sleep(RETRY_DELAY);
      return createCompletion(messages, refreshToken, model, refConvId, retryCount + 1, tools);
    }
    throw err;
  });
}

export async function createCompletionStream(messages: any[], refreshToken: string, model = MODEL_NAME, refConvId = "", retryCount = 0, tools?: any[]): Promise<ReadableStream> {
  return (async () => {
    let processedMessages = convertToolMessages(messages);
    processedMessages = injectToolsPrompt(processedMessages, tools || []);
    const refFileUrls = extractRefFileUrls(processedMessages);
    const refs = refFileUrls.length ? await Promise.all(refFileUrls.map((fileUrl) => uploadFile(fileUrl, refreshToken))) : [];
    if (!/[0-9a-zA-Z]{24}/.test(refConvId)) refConvId = "";
    let assistantId = /^[a-z0-9]{24,}$/.test(model) ? model : DEFAULT_ASSISTANT_ID;
    let chatMode = '';
    if (model.includes('think') || model.includes('zero')) { chatMode = 'zero'; }
    if (model.includes('deepresearch')) { chatMode = 'deep_research'; }
    const token = await acquireToken(refreshToken);
    const sign = await generateSign();
    const response = await glmPostStream(
      "https://chatglm.cn/chatglm/backend-api/assistant/stream",
      {
        assistant_id: assistantId,
        conversation_id: refConvId,
        project_id: "",
        chat_type: "user_chat",
        messages: messagesPrepare(processedMessages, refs, !!refConvId),
        meta_data: {
          channel: "",
          chat_mode: chatMode || undefined,
          draft_id: "",
          if_plus_model: true,
          input_question_type: "xxxx",
          is_networking: true,
          is_test: false,
          platform: "pc",
          quote_log_id: "",
          cogview: { rm_label_watermark: false }
        },
      },
      {
        Authorization: `Bearer ${token}`,
        Referer: assistantId == DEFAULT_ASSISTANT_ID ? "https://chatglm.cn/main/alltoolsdetail" : `https://chatglm.cn/main/gdetail/${assistantId}`,
        "X-Device-Id": uuid(false),
        "X-Request-Id": uuid(false),
        "X-Sign": sign.sign,
        "X-Timestamp": sign.timestamp,
        "X-Nonce": sign.nonce,
        ...getHeaders(),
      }
    );
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) {
      const errText = await response.text();
      console.error("Invalid response Content-Type:", contentType, errText);
      const encoder = new TextEncoder();
      return new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            id: "", model: MODEL_NAME, object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { role: "assistant", content: "服务暂时不可用，第三方响应错误" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            created: unixTimestamp(),
          })}\n\n`));
          controller.close();
        }
      });
    }
    return createTransStream(model, response.body!, (convId: string) => {
      removeConversation(convId, refreshToken, assistantId).catch(() => {});
    }, tools);
  })().catch(async (err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      console.error(`Stream response error: ${err.stack || err.message}`);
      await sleep(RETRY_DELAY);
      return createCompletionStream(messages, refreshToken, model, refConvId, retryCount + 1, tools);
    }
    throw err;
  });
}

export async function generateImages(model = "65a232c082ff90a2ad2f15e2", prompt: string, refreshToken: string, retryCount = 0): Promise<string[]> {
  return (async () => {
    const messages = [{ role: "user", content: prompt.indexOf("画") == -1 ? `请画：${prompt}` : prompt }];
    const token = await acquireToken(refreshToken);
    const sign = await generateSign();
    const response = await glmPostStream(
      "https://chatglm.cn/chatglm/backend-api/assistant/stream",
      {
        assistant_id: model,
        conversation_id: "",
        messages: messagesPrepare(messages, []),
        meta_data: {
          channel: "", draft_id: "", if_plus_model: true,
          input_question_type: "xxxx", is_test: false, platform: "pc", quote_log_id: ""
        },
      },
      {
        Authorization: `Bearer ${token}`,
        Referer: `https://chatglm.cn/main/gdetail/${model}`,
        "X-Device-Id": uuid(false),
        "X-Request-Id": uuid(false),
        "X-Sign": sign.sign,
        "X-Timestamp": sign.timestamp,
        "X-Nonce": sign.nonce,
        ...getHeaders(),
      }
    );
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) throw new Error(`Stream response Content-Type invalid: ${contentType}`);
    const { convId, imageUrls } = await receiveImages(response.body!);
    removeConversation(convId, refreshToken, model).catch(() => {});
    if (imageUrls.length == 0) throw new Error("图像生成失败");
    return imageUrls;
  })().catch(async (err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      console.error(`Image generation error: ${err.message}`);
      await sleep(RETRY_DELAY);
      return generateImages(model, prompt, refreshToken, retryCount + 1);
    }
    throw err;
  });
}

export async function generateVideos(model = "cogvideox", prompt: string, refreshToken: string, options: {
  imageUrl: string; videoStyle: string; emotionalAtmosphere: string; mirrorMode: string; audioId: string;
}, refConvId = "", retryCount = 0): Promise<any[]> {
  return (async () => {
    if (!/[0-9a-zA-Z]{24}/.test(refConvId)) refConvId = "";
    const sourceList: string[] = [];
    if (model == "cogvideox-pro") {
      const imageUrls = await generateImages(undefined as any, prompt, refreshToken);
      options.imageUrl = imageUrls[0];
    }
    if (options.imageUrl) {
      const uploadResult = await uploadFile(options.imageUrl, refreshToken, true);
      sourceList.push(uploadResult.source_id);
    }
    let token = await acquireToken(refreshToken);
    const sign = await generateSign();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    let result;
    try {
      const resp = await fetch("https://chatglm.cn/chatglm/video-api/v1/chat", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Referer: "https://chatglm.cn/video",
          "X-Device-Id": uuid(false),
          "X-Request-Id": uuid(false),
          "X-Sign": sign.sign,
          "X-Timestamp": sign.timestamp,
          "X-Nonce": sign.nonce,
          ...getHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          conversation_id: refConvId,
          prompt,
          source_list: sourceList.length > 0 ? sourceList : undefined,
          advanced_parameter_extra: {
            emotional_atmosphere: options.emotionalAtmosphere,
            mirror_mode: options.mirrorMode,
            video_style: options.videoStyle,
          },
        }),
        signal: controller.signal,
      });
      result = await checkResult(resp, refreshToken);
    } finally { clearTimeout(timeoutId); }
    const { chat_id: chatId, conversation_id: convId } = result.result;
    const startTime = unixTimestamp();
    const results: any[] = [];
    while (true) {
      if (unixTimestamp() - startTime > 600) throw new Error("视频生成失败：超时");
      token = await acquireToken(refreshToken);
      const s = await generateSign();
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 30000);
      let statusResult;
      try {
        const resp = await fetch(`https://chatglm.cn/chatglm/video-api/v1/chat/status/${chatId}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Referer: "https://chatglm.cn/video",
            "X-Device-Id": uuid(false),
            "X-Request-Id": uuid(false),
            "X-Sign": s.sign,
            "X-Timestamp": s.timestamp,
            "X-Nonce": s.nonce,
            ...getHeaders(),
          },
          signal: ctrl.signal,
        });
        statusResult = await checkResult(resp, refreshToken);
      } finally { clearTimeout(tid); }
      const { status, video_url, cover_url, video_duration, resolution } = statusResult.result;
      if (status != "init" && status != "processing") {
        if (status != "finished") throw new Error("视频生成失败");
        let videoUrl = video_url;
        if (options.audioId) {
          const [key, id] = options.audioId.split("-");
          token = await acquireToken(refreshToken);
          const s2 = await generateSign();
          const ctrl2 = new AbortController();
          const tid2 = setTimeout(() => ctrl2.abort(), 30000);
          try {
            const resp = await fetch("https://chatglm.cn/chatglm/video-api/v1/static/composite_video", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                Referer: "https://chatglm.cn/video",
                "X-Device-Id": uuid(false),
                "X-Request-Id": uuid(false),
                "X-Sign": s2.sign,
                "X-Timestamp": s2.timestamp,
                "X-Nonce": s2.nonce,
                ...getHeaders(),
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ chat_id: chatId, key, audio_id: id }),
              signal: ctrl2.signal,
            });
            const compositeResult = await checkResult(resp, refreshToken);
            videoUrl = compositeResult.result.url;
          } finally { clearTimeout(tid2); }
        }
        results.push({ conversation_id: convId, cover_url, video_url: videoUrl, video_duration, resolution });
        break;
      }
      await sleep(1000);
    }
    fetch(`https://chatglm.cn/chatglm/video-api/v1/chat/${chatId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, Referer: "https://chatglm.cn/video", "X-Device-Id": uuid(false), "X-Request-Id": uuid(false), ...getHeaders() },
    }).catch(() => {});
    return results;
  })().catch(async (err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      console.error(`Video generation error: ${err.message}`);
      await sleep(RETRY_DELAY);
      return generateVideos(model, prompt, refreshToken, options, refConvId, retryCount + 1);
    }
    throw err;
  });
}

function extractRefFileUrls(messages: any[]) {
  const urls: string[] = [];
  if (!messages.length) return urls;
  const lastMessage = messages[messages.length - 1];
  if (isArray(lastMessage.content)) {
    lastMessage.content.forEach((v: any) => {
      if (!isObject(v) || !["file", "image_url"].includes(v["type"])) return;
      if (v["type"] == "file" && isObject(v["file_url"]) && isString(v["file_url"]["url"])) urls.push(v["file_url"]["url"]);
      else if (v["type"] == "image_url" && isObject(v["image_url"]) && isString(v["image_url"]["url"])) urls.push(v["image_url"]["url"]);
    });
  }
  return urls;
}

function messagesPrepare(messages: any[], refs: any[], isRefConv = false) {
  let content: string;
  if (isRefConv || messages.length < 2) {
    content = messages.reduce((content: string, message: any) => {
      if (isArray(message.content)) {
        return message.content.reduce((_content: string, v: any) => {
          if (!isObject(v) || v["type"] != "text") return _content;
          return _content + (v["text"] || "") + "\n";
        }, content);
      }
      return content + `${message.content}\n`;
    }, "");
  } else {
    const latestMessage = messages[messages.length - 1];
    const hasFileOrImage = isArray(latestMessage.content) && latestMessage.content.some((v: any) => typeof v === "object" && ["file", "image_url"].includes(v["type"]));
    if (hasFileOrImage) {
      messages.splice(messages.length - 1, 0, { content: "关注用户最新发送文件和消息", role: "system" });
    }
    content = (messages.reduce((content: string, message: any) => {
      const role = message.role.replace("system", "<|sytstem|>").replace("assistant", "<|assistant|>").replace("user", "<|user|>");
      if (isArray(message.content)) {
        return message.content.reduce((_content: string, v: any) => {
          if (!isObject(v) || v["type"] != "text") return _content;
          return _content + (`${role}\n` + v["text"] || "") + "\n";
        }, content);
      }
      return (content += `${role}\n${message.content}\n`);
    }, "") + "<|assistant|>\n").replace(/\!\[.+\]\(.+\)/g, "").replace(/\/mnt\/data\/.+/g, "");
  }
  const fileRefs = refs.filter((ref) => !ref.width && !ref.height);
  const imageRefs = refs.filter((ref) => ref.width || ref.height).map((ref: any) => { ref.image_url = ref.file_url; return ref; });
  return [{
    role: "user",
    content: [
      { type: "text", text: content },
      ...(fileRefs.length == 0 ? [] : [{ type: "file", file: fileRefs }]),
      ...(imageRefs.length == 0 ? [] : [{ type: "image", image: imageRefs }]),
    ],
  }];
}

async function checkFileUrl(fileUrl: string) {
  if (isBASE64Data(fileUrl)) return;
  const response = await fetch(fileUrl, { method: "HEAD" });
  if (response.status >= 400) throw new Error(`File ${fileUrl} is not valid: [${response.status}] ${response.statusText}`);
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const fileSize = parseInt(contentLength, 10);
    if (fileSize > FILE_MAX_SIZE) throw new Error(`File ${fileUrl} exceeds size limit`);
  }
}

async function uploadFile(fileUrl: string, refreshToken: string, isVideoImage = false) {
  await checkFileUrl(fileUrl);
  let filename: string, fileData: ArrayBuffer, mimeType: string | null = null;
  if (isBASE64Data(fileUrl)) {
    mimeType = extractBASE64DataFormat(fileUrl);
    const ext = mimeType ? getExtension(mimeType) : "bin";
    filename = `${uuid()}.${ext || "bin"}`;
    const base64Data = removeBASE64DataHeader(fileUrl);
    fileData = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0)).buffer;
  } else {
    filename = basename(fileUrl);
    const response = await fetch(fileUrl);
    fileData = await response.arrayBuffer();
  }
  mimeType = mimeType || getMimeType(filename);
  // 注意：CF Worker 不支持 sharp，跳过图片 resize
  const formData = new FormData();
  formData.append("file", new Blob([fileData], { type: mimeType }), filename);
  const token = await acquireToken(refreshToken);
  const uploadUrl = isVideoImage
    ? "https://chatglm.cn/chatglm/video-api/v1/static/upload"
    : "https://chatglm.cn/chatglm/backend-api/assistant/file_upload";
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Referer: isVideoImage ? "https://chatglm.cn/video" : "https://chatglm.cn/",
      ...getHeaders(),
    },
    body: formData,
  });
  const uploadResult = await checkResult(response, refreshToken);
  return uploadResult.result;
}

async function receiveStream(model: string, readableStream: ReadableStream, tools?: any[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = {
      id: "", model, object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "", reasoning_content: null as string | null }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created: unixTimestamp(),
    };
    const isSilentModel = model.includes('silent');
    const cachedParts: any[] = [];
    const parser = createParser((event) => {
      try {
        const result = attempt(() => JSON.parse(event.data));
        if (isError(result)) throw new Error(`Stream response invalid: ${event.data}`);
        if (!data.id && result.conversation_id) data.id = result.conversation_id;
        if (result.status != "finish") {
          if (result.parts) { cachedParts.length = 0; cachedParts.push(...result.parts); }
          const searchMap = new Map<string, any>();
          cachedParts.forEach((part) => {
            if (!part.content || !isArray(part.content)) return;
            const { meta_data } = part;
            part.content.forEach((item: any) => {
              if (item.type == "tool_result" && meta_data?.tool_result_extra?.search_results) {
                meta_data.tool_result_extra.search_results.forEach((res: any) => { if (res.match_key) searchMap.set(res.match_key, res); });
              }
            });
          });
          const keyToIdMap = new Map<string, number>();
          let counter = 1;
          let fullText = "";
          let fullReasoning = "";
          cachedParts.forEach((part: any) => {
            const { content, meta_data } = part;
            if (!isArray(content)) return;
            let partText = "";
            let partReasoning = "";
            content.forEach((value: any) => {
              const { type, text, think, image, code, content: innerContent } = value;
              if (type == "text") {
                let txt = text;
                if (searchMap.size > 0) {
                  txt = txt.replace(/【?(turn\d+[a-zA-Z]+\d+)】?/g, (match: string, key: string) => {
                    const searchInfo = searchMap.get(key);
                    if (!searchInfo) return match;
                    if (!keyToIdMap.has(key)) keyToIdMap.set(key, counter++);
                    const newId = keyToIdMap.get(key);
                    return ` [${newId}](${searchInfo.url})`;
                  });
                }
                partText += txt;
              } else if (type == "think" && !isSilentModel) {
                partReasoning += think;
              } else if (type == "tool_result" && meta_data?.tool_result_extra?.search_results && isArray(meta_data.tool_result_extra.search_results) && !isSilentModel) {
                partReasoning += meta_data.tool_result_extra.search_results.reduce((meta: string, v: any) => meta + `> 检索 ${v.title}(${v.url}) ...\n`, "");
              } else if (type == "quote_result" && part.status == "finish" && meta_data && isArray(meta_data.metadata_list) && !isSilentModel) {
                partReasoning += meta_data.metadata_list.reduce((meta: string, v: any) => meta + `> 检索 ${v.title}(${v.url}) ...\n`, "");
              } else if (type == "image" && isArray(image) && part.status == "finish") {
                partText += image.reduce((imgs: string, v: any) => imgs + (/^(http|https):\/\//.test(v.image_url) ? `![图像](${v.image_url || ""})` : ""), "") + "\n";
              } else if (type == "code") {
                partText += "\`\`\`python\n" + code + (part.status == "finish" ? "\n\`\`\`\n" : "");
              } else if (type == "execution_output" && isString(innerContent) && part.status == "finish") {
                partText += innerContent + "\n";
              }
            });
            if (partText) fullText += (fullText.length > 0 ? "\n" : "") + partText;
            if (partReasoning) fullReasoning += (fullReasoning.length > 0 ? "\n" : "") + partReasoning;
          });
          data.choices[0].message.content = fullText;
          (data.choices[0].message as any).reasoning_content = fullReasoning || null;
        } else {
          let content = data.choices[0].message.content;
          content = content.replace(/【\d+†(来源|源|source)】/g, "");
          data.choices[0].message.content = content;
          if (tools && tools.length > 0) {
            const parsed = parseToolCalls(content);
            if (parsed.tool_calls) {
              (data.choices[0].message as any).tool_calls = parsed.tool_calls;
              (data.choices[0].message as any).content = parsed.text || "";
              data.choices[0].finish_reason = "tool_calls";
            }
          }
          resolve(data);
        }
      } catch (err) {
        reject(err);
      }
    });
    const reader = readableStream.getReader();
    const decoder = new TextDecoder();
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { resolve(data); break; }
          parser.feed(decoder.decode(value, { stream: true }));
        }
      } catch (err) {
        reject(err);
      } finally {
        reader.releaseLock();
      }
    })();
  });
}

/** 取出一个 part 里所有 text 类型内容拼成的字符串 */
function extractPartText(part: any): string {
  if (!part || !isArray(part.content)) return "";
  return part.content
    .filter((c: any) => c && c.type === "text")
    .map((c: any) => c.text || "")
    .join("");
}

/**
 * 合并同一 logic_id 的流式 part。
 *
 * 智谱网页版流式对同一个 part 发的是【增量片段】而非累积全量（实测：'西湖'→'位于'→'浙江省'…），
 * 只在收尾时会补发一次完整全文。原代码直接 cachedParts[index] = part 覆盖，
 * 于是 fullText 只剩最新的一两个字，再被 fullText.substring(sentContent.length) 一切，
 * 输出就成了被啃掉开头的碎片 —— 表现为正文乱码，以及工具调用 JSON 破损后解析失败、
 * 泄漏成正文（例如 {"olls"Read","arguments":{"file}]}uments":…）。
 */
function mergeStreamPart(oldPart: any, newPart: any): any {
  const oldText = extractPartText(oldPart);
  const newText = extractPartText(newPart);
  if (!oldText) return newPart;
  // 收尾补发的完整全文：已包含旧内容，直接采用，避免重复
  if (newText.length >= oldText.length && newText.startsWith(oldText)) return newPart;
  // 常态的增量片段：把已累积的文本接到前面
  const merged: any = { ...newPart, content: isArray(newPart.content) ? [...newPart.content] : [] };
  const at = merged.content.findIndex((c: any) => c && c.type === "text");
  if (at !== -1) {
    merged.content[at] = { ...merged.content[at], text: oldText + (merged.content[at].text || "") };
  } else {
    merged.content.unshift({ type: "text", text: oldText });
  }
  return merged;
}

function createTransStream(model: string, readableStream: ReadableStream, endCallback?: (convId: string) => void, tools?: any[]): ReadableStream {
  const created = unixTimestamp();
  const encoder = new TextEncoder();
  const isSilentModel = model.includes('silent');
  let sentContent = "";
  let sentReasoning = "";
  let fullContent = "";
  let isToolCallMode = false;
  let mightBeToolCall = false;
  let pendingContent = "";
  const cachedParts: any[] = [];
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id: "", model, object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
        created,
      })}\n\n`));
      const reader = readableStream.getReader();
      const decoder = new TextDecoder();
      const parser = createParser((event) => {
        try {
          const result = attempt(() => JSON.parse(event.data));
          if (isError(result)) return;
          if (result.status != "finish" && result.status != "intervene") {
            if (result.parts) {
              result.parts.forEach((part: any) => {
                const index = cachedParts.findIndex((p) => p.logic_id === part.logic_id);
                // 必须累积而不是替换：智谱流式对同一 logic_id 发的是增量片段
                // （实测 17 次增量 / 1 次全量：'西湖'→'位于'→'浙江省'→'杭州市'→'，'）
                if (index !== -1) cachedParts[index] = mergeStreamPart(cachedParts[index], part);
                else cachedParts.push(part);
              });
            }
            const searchMap = new Map<string, any>();
            cachedParts.forEach((part) => {
              if (!part.content || !isArray(part.content)) return;
              const { meta_data } = part;
              part.content.forEach((item: any) => {
                if (item.type == "tool_result" && meta_data?.tool_result_extra?.search_results) {
                  meta_data.tool_result_extra.search_results.forEach((res: any) => { if (res.match_key) searchMap.set(res.match_key, res); });
                }
              });
            });
            const keyToIdMap = new Map<string, number>();
            let counter = 1;
            let fullText = "";
            let fullReasoning = "";
            cachedParts.forEach((part: any) => {
              const { content, meta_data } = part;
              if (!isArray(content)) return;
              let partText = "";
              let partReasoning = "";
              content.forEach((value: any) => {
                const { type, text, think, image, code, content: innerContent } = value;
                if (type == "text") {
                  let txt = text;
                  if (searchMap.size > 0) {
                    txt = txt.replace(/【?(turn\d+[a-zA-Z]+\d+)】?/g, (match: string, key: string) => {
                      const searchInfo = searchMap.get(key);
                      if (!searchInfo) return match;
                      if (!keyToIdMap.has(key)) keyToIdMap.set(key, counter++);
                      const newId = keyToIdMap.get(key);
                      return ` [${newId}](${searchInfo.url})`;
                    });
                  }
                  partText += txt;
                } else if (type == "think" && !isSilentModel) {
                  partReasoning += think;
                } else if (type == "tool_result" && meta_data?.tool_result_extra?.search_results && isArray(meta_data.tool_result_extra.search_results) && !isSilentModel) {
                  partReasoning += meta_data.tool_result_extra.search_results.reduce((meta: string, v: any) => meta + `> 检索 ${v.title}(${v.url}) ...\n`, "");
                } else if (type == "quote_result" && part.status == "finish" && meta_data && isArray(meta_data.metadata_list) && !isSilentModel) {
                  partReasoning += meta_data.metadata_list.reduce((meta: string, v: any) => meta + `> 检索 ${v.title}(${v.url}) ...\n`, "");
                } else if (type == "image" && isArray(image) && part.status == "finish") {
                  partText += image.reduce((imgs: string, v: any) => imgs + (/^(http|https):\/\//.test(v.image_url) ? `![图像](${v.image_url || ""})` : ""), "") + "\n";
                } else if (type == "code") {
                  partText += "\`\`\`python\n" + code + (part.status == "finish" ? "\n\`\`\`\n" : "");
                } else if (type == "execution_output" && isString(innerContent) && part.status == "finish") {
                  partText += innerContent + "\n";
                }
              });
              if (partText) fullText += (fullText.length > 0 ? "\n" : "") + partText;
              if (partReasoning) fullReasoning += (fullReasoning.length > 0 ? "\n" : "") + partReasoning;
            });
            const reasoningChunk = fullReasoning.substring(sentReasoning.length);
            if (reasoningChunk) {
              sentReasoning += reasoningChunk;
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                id: result.conversation_id, model: MODEL_NAME, object: "chat.completion.chunk",
                choices: [{ index: 0, delta: { reasoning_content: reasoningChunk }, finish_reason: null }],
                created,
              })}\n\n`));
            }
            const chunk = fullText.substring(sentContent.length);
            if (chunk) {
              sentContent += chunk;
              fullContent += chunk;
              // 智能缓冲：检测是否可能是纯工具调用 JSON，避免先发送部分 JSON 文本
              if (!isToolCallMode && tools && tools.length > 0) {
                const trimmed = fullContent.trim();
                // 只要整段输出以 { 开头，就一路缓冲到流结束再统一判断。
                //
                // 旧逻辑在累积满 20 字符时就抢先下结论，但判断用的是全量 fullContent、
                // 发送的却只是局部 pendingContent，两边记账不一致；当 "tool_calls"
                // 字样还没流完时会误判为普通文本、把 mightBeToolCall 打回 false，
                // 下一片又重新进入缓冲并清空 pendingContent，于是丢字符，
                // 最终向客户端吐出类似 {"olls"Bash","arguments":{"command 的破损 JSON。
                if (mightBeToolCall || trimmed.startsWith("{")) {
                  mightBeToolCall = true;
                  pendingContent += chunk;
                } else {
                  // 不以 { 开头，肯定不是纯工具调用，正常逐片下发
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                    id: result.conversation_id, model: MODEL_NAME, object: "chat.completion.chunk",
                    choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
                    created,
                  })}\n\n`));
                }
              } else if (!isToolCallMode) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                  id: result.conversation_id, model: MODEL_NAME, object: "chat.completion.chunk",
                  choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
                  created,
                })}\n\n`));
              }
            }
          } else {
            let finishReason = "stop";
            let delta: any = result.status == "intervene" && result.last_error?.intervene_text ? { content: `\n\n${result.last_error.intervene_text}` } : {};
            if (tools && tools.length > 0) {
              const parsed = parseToolCalls(fullContent);
              if (parsed.tool_calls) {
                finishReason = "tool_calls";
                delta = { tool_calls: parsed.tool_calls };
              } else if (pendingContent) {
                // 缓冲了一段以 { 开头的内容，但最终解析不出工具调用，
                // 说明它就是普通文本（比如模型在讲 JSON），此处补发，避免内容丢失
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                  id: result.conversation_id, model: MODEL_NAME, object: "chat.completion.chunk",
                  choices: [{ index: 0, delta: { content: pendingContent }, finish_reason: null }],
                  created,
                })}\n\n`));
                pendingContent = "";
              }
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              id: result.conversation_id, model: MODEL_NAME, object: "chat.completion.chunk",
              choices: [{
                index: 0,
                delta,
                finish_reason: finishReason,
              }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              created,
            })}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            endCallback?.(result.conversation_id);
          }
        } catch (err) {
          controller.error(err);
        }
      });
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { controller.close(); break; }
          parser.feed(decoder.decode(value, { stream: true }));
        }
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    }
  });
}

async function receiveImages(readableStream: ReadableStream): Promise<{ convId: string; imageUrls: string[] }> {
  return new Promise((resolve, reject) => {
    let convId = "";
    const imageUrls: string[] = [];
    const parser = createParser((event) => {
      try {
        const result = attempt(() => JSON.parse(event.data));
        if (isError(result)) throw new Error(`Stream response invalid: ${event.data}`);
        if (!convId && result.conversation_id) convId = result.conversation_id;
        if (result.status == "intervene") throw new Error("内容由于合规问题已被阻止生成");
        if (result.status != "finish") {
          result.parts.forEach((part: any) => {
            const { status: partStatus, content } = part;
            if (!isArray(content)) return;
            content.forEach((value: any) => {
              const { type, image, text } = value;
              if (type == "image" && isArray(image) && partStatus == "finish") {
                image.forEach((value: any) => {
                  if (!/^(http|https):\/\//.test(value.image_url) || imageUrls.includes(value.image_url)) return;
                  imageUrls.push(value.image_url);
                });
              }
              if (type == "text" && partStatus == "finish") {
                const urlPattern = /\((https?:\/\/\S+)\)/g;
                let match;
                while ((match = urlPattern.exec(text)) !== null) {
                  const url = match[1];
                  if (!imageUrls.includes(url)) imageUrls.push(url);
                }
              }
            });
          });
        }
      } catch (err) {
        reject(err);
      }
    });
    const reader = readableStream.getReader();
    const decoder = new TextDecoder();
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { resolve({ convId, imageUrls }); break; }
          parser.feed(decoder.decode(value, { stream: true }));
        }
      } catch (err) {
        reject(err);
      } finally {
        reader.releaseLock();
      }
    })();
  });
}

export function tokenSplit(authorization: string): string[] {
  return authorization.replace("Bearer ", "").split(",");
}

export async function getTokenLiveStatus(refreshToken: string) {
  const sign = await generateSign();
  try {
    const response = await fetch("https://chatglm.cn/chatglm/user-api/user/refresh", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${refreshToken}`,
        Referer: "https://chatglm.cn/main/alltoolsdetail",
        "X-Device-Id": uuid(false),
        "X-Request-Id": uuid(false),
        "X-Sign": sign.sign,
        "X-Timestamp": sign.timestamp,
        "X-Nonce": sign.nonce,
        ...getHeaders(),
        "Content-Type": "application/json",
      },
    });
    const data = await checkResult(response, refreshToken);
    return !!data.result?.access_token;
  } catch {
    return false;
  }
}
