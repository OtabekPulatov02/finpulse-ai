/* ============================================================
   Finpulse — единый вызов OpenAI.

   Два пути:
   - Responses API (/v1/responses) — для новых моделей (gpt-5*, gpt-6*, o*)
     с function tools: в Chat Completions они не принимают tools вместе с
     рассуждением, а reasoning_effort:"none" не поддерживают (проверено на
     проде 23.11.2026). Агент получает и инструменты, и рассуждение.
   - Chat Completions — для остального (JSON-разборы, vision без tools,
     старые модели). Новые модели: max_completion_tokens, без temperature.

   На входе и выходе — формат Chat Completions (messages, tool_calls),
   поэтому вызывающий код не знает, какой путь сработал.

   Если модель недоступна или отклонила параметр — один повтор на запасной
   модели (OPENAI_MODEL_FALLBACK, по умолчанию gpt-4o).

   Vercel env:
     OPENAI_MODEL            — основная   (по умолчанию gpt-6.2-sol)
     OPENAI_MODEL_STRONG     — для сложных разборов (по умолчанию gpt-6.2-astra)
     OPENAI_MODEL_FALLBACK   — запасная   (по умолчанию gpt-4o)
     OPENAI_REASONING_EFFORT — глубина рассуждений агента (low|medium|high, по умолчанию low)
   ============================================================ */

const DEFAULT_MODEL = "gpt-6.2-sol";
const DEFAULT_STRONG = "gpt-6.2-astra";
const DEFAULT_FALLBACK = "gpt-4o";

const modelMain = () => process.env.OPENAI_MODEL || DEFAULT_MODEL;
const modelStrong = () => process.env.OPENAI_MODEL_STRONG || DEFAULT_STRONG;
const modelFallback = () => process.env.OPENAI_MODEL_FALLBACK || DEFAULT_FALLBACK;

function isNewGen(model) {
  return /^(gpt-5|gpt-6|gpt-7|o\d)/i.test(String(model || ""));
}
const useResponses = (model, tools) => isNewGen(model) && !!(tools && tools.length);

/* ---------- Chat Completions ---------- */
/* Служебное поле _rsp (сырые элементы ответа Responses) Chat Completions не знает. */
const stripPrivate = (messages) => (messages || []).map((m) => {
  if (!m || !("_rsp" in m)) return m;
  const { _rsp, ...rest } = m;
  return rest;
});

function buildBody(model, { messages, tools, maxTokens, temperature, json }) {
  const body = { model, messages: stripPrivate(messages) };
  if (tools && tools.length) body.tools = tools;
  if (isNewGen(model)) {
    body.max_completion_tokens = maxTokens;
  } else {
    body.max_tokens = maxTokens;
    if (temperature != null) body.temperature = temperature;
  }
  if (json) body.response_format = { type: "json_object" };
  return body;
}

/* ---------- Responses API: перевод форматов ---------- */
function partToInput(p) {
  if (!p || typeof p !== "object") return { type: "input_text", text: String(p || "") };
  if (p.type === "text") return { type: "input_text", text: p.text || "" };
  if (p.type === "image_url") {
    const url = typeof p.image_url === "string" ? p.image_url : (p.image_url && p.image_url.url);
    return { type: "input_image", image_url: url, detail: (p.image_url && p.image_url.detail) || "auto" };
  }
  if (p.type === "file") return { type: "input_file", filename: (p.file && p.file.filename) || "file.pdf", file_data: p.file && p.file.file_data };
  return p;
}

function toResponsesInput(messages) {
  const input = [];
  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: m.tool_call_id, output: String(m.content == null ? "" : m.content) });
      continue;
    }
    if (m.role === "assistant") {
      /* Ход, пришедший из Responses: возвращаем его элементы как есть —
         с зашифрованным рассуждением, чтобы модель продолжала свою же
         цепочку мыслей после результата инструмента. */
      if (Array.isArray(m._rsp) && m._rsp.length) { input.push(...m._rsp); continue; }
      if (m.content) input.push({ role: "assistant", content: String(m.content) });
      for (const tc of m.tool_calls || []) {
        input.push({ type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || "{}" });
      }
      continue;
    }
    const role = m.role === "system" ? "developer" : m.role;
    input.push({ role, content: Array.isArray(m.content) ? m.content.map(partToInput) : String(m.content == null ? "" : m.content) });
  }
  return input;
}

function toResponsesTools(tools) {
  return (tools || []).map((t) => {
    const f = t.function || t;
    return { type: "function", name: f.name, description: f.description, parameters: f.parameters };
  });
}

function buildResponsesBody(model, { messages, tools, maxTokens, json, reasoning }) {
  const body = {
    model,
    input: toResponsesInput(messages),
    max_output_tokens: maxTokens,
    reasoning: { effort: reasoning || process.env.OPENAI_REASONING_EFFORT || "low" },
    store: false,
    include: ["reasoning.encrypted_content"],
  };
  if (tools && tools.length) body.tools = toResponsesTools(tools);
  if (json) body.text = { format: { type: "json_object" } };
  return body;
}

/* Ответ Responses → сообщение в формате Chat Completions */
function fromResponses(data) {
  const out = Array.isArray(data.output) ? data.output : [];
  let text = "";
  const toolCalls = [];
  for (const item of out) {
    if (item.type === "message") {
      for (const c of item.content || []) if (c.type === "output_text") text += c.text || "";
    } else if (item.type === "function_call") {
      toolCalls.push({ id: item.call_id || item.id, type: "function", function: { name: item.name, arguments: item.arguments || "{}" } });
    }
  }
  if (!text && typeof data.output_text === "string") text = data.output_text;
  const message = { role: "assistant", content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  /* сырые элементы хода (reasoning + function_call) — для следующего шага агента */
  const keep = out.filter((it) => it.type === "reasoning" || it.type === "function_call");
  if (toolCalls.length && keep.length) Object.defineProperty(message, "_rsp", { value: keep, enumerable: true, writable: true });
  const u = data.usage || {};
  const usage = { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0 };
  return { message, usage };
}

/* Ошибка, при которой имеет смысл повторить на запасной модели. */
function isModelProblem(status, text) {
  if (status === 404) return true;
  if (status !== 400) return false;
  return /model_not_found|does not exist|reasoning_effort|reasoning\.effort|unsupported_parameter|unsupported_value|not supported with this model|Unrecognized request argument|invalid model/i.test(text || "");
}

async function post(path, body, key, timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const r = await fetch("https://api.openai.com/v1/" + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    /* signal снаружи — общий стоп запроса (дедлайн агента), чтобы после ответа
       пользователю не висели фоновые вызовы и функция не падала по 60 с */
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

/**
 * openaiChat({ model, messages, tools, maxTokens, temperature, json, timeoutMs, reasoning })
 * → { message, usage, model, fellBack, api }
 */
async function openaiChat(opts) {
  const key = process.env.OPENAI_API_KEY || "";
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const baseTimeout = opts.timeoutMs || 30000;
  const params = {
    messages: opts.messages,
    tools: opts.tools,
    maxTokens: opts.maxTokens || 1000,
    temperature: opts.temperature,
    json: !!opts.json,
    reasoning: opts.reasoning,
  };
  const first = opts.model || modelMain();
  const tried = [];
  const t0 = Date.now();
  for (const model of [first, modelFallback()]) {
    if (tried.includes(model)) continue;
    if (opts.signal && opts.signal.aborted) throw new Error("OpenAI: остановлено");
    /* время вышло на первой модели — запасную не пробуем, иначе выходим за лимит функции */
    if (tried.length && Date.now() - t0 > baseTimeout - 3000) break;
    /* запасная модель — только в оставшееся время, а не ещё один полный таймаут */
    const timeoutMs = Math.max(3000, baseTimeout - (Date.now() - t0));
    tried.push(model);
    const viaResponses = useResponses(model, params.tools);
    const res = viaResponses
      ? await post("responses", buildResponsesBody(model, params), key, timeoutMs, opts.signal)
      : await post("chat/completions", buildBody(model, params), key, timeoutMs, opts.signal);
    if (res.ok) {
      let data = {};
      try { data = JSON.parse(res.text); } catch (e) { throw new Error("OpenAI: bad JSON"); }
      if (viaResponses) {
        const { message, usage } = fromResponses(data);
        if (!message.content && !message.tool_calls) throw new Error("OpenAI: empty response");
        return { message, usage, model: data.model || model, fellBack: model !== first, api: "responses" };
      }
      const message = data.choices && data.choices[0] && data.choices[0].message;
      if (!message) throw new Error("OpenAI: empty completion");
      return { message, usage: data.usage, model: data.model || model, fellBack: model !== first, api: "chat" };
    }
    if (!isModelProblem(res.status, res.text)) {
      throw new Error(`OpenAI HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    }
    console.error(`openai: model ${model} rejected (${res.status}), trying fallback:`, res.text.slice(0, 200));
  }
  throw new Error(`OpenAI: модели ${tried.join(", ")} недоступны`);
}

module.exports = {
  openaiChat, isNewGen, useResponses, buildBody, buildResponsesBody, toResponsesInput, fromResponses,
  isModelProblem, modelMain, modelStrong, modelFallback,
};
