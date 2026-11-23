/* ============================================================
   Finpulse — единый вызов OpenAI Chat Completions.

   Зачем отдельный модуль:
   - новые модели (gpt-5*, gpt-6*, o*) не принимают max_tokens и
     temperature≠1 — шлём max_completion_tokens и без temperature;
   - если модель из env недоступна аккаунту (404 / model_not_found) или
     отклонила параметр — один автоматический повтор на запасной модели
     (OPENAI_MODEL_FALLBACK, по умолчанию gpt-4o), чтобы бот не падал из-за
     опечатки в env или снятой с API модели.

   Модели (Vercel env):
     OPENAI_MODEL          — основная   (по умолчанию gpt-6.2-sol)
     OPENAI_MODEL_STRONG   — для сложных разборов (по умолчанию gpt-6.2-astra)
     OPENAI_MODEL_FALLBACK — запасная   (по умолчанию gpt-4o)
   ============================================================ */

const DEFAULT_MODEL = "gpt-6.2-sol";
const DEFAULT_STRONG = "gpt-6.2-astra";
const DEFAULT_FALLBACK = "gpt-4o";

const modelMain = () => process.env.OPENAI_MODEL || DEFAULT_MODEL;
const modelStrong = () => process.env.OPENAI_MODEL_STRONG || DEFAULT_STRONG;
const modelFallback = () => process.env.OPENAI_MODEL_FALLBACK || DEFAULT_FALLBACK;

/* Новые семейства: max_completion_tokens, temperature только по умолчанию. */
function isNewGen(model) {
  return /^(gpt-5|gpt-6|gpt-7|o\d)/i.test(String(model || ""));
}

function buildBody(model, { messages, tools, maxTokens, temperature, json }) {
  const body = { model, messages };
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

/* Ошибка, при которой имеет смысл повторить на запасной модели. */
function isModelProblem(status, text) {
  if (status === 404) return true;
  if (status !== 400) return false;
  return /model_not_found|does not exist|unsupported_parameter|unsupported_value|not supported with this model|Unrecognized request argument|invalid model/i.test(text || "");
}

async function post(body, key, timeoutMs) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

/**
 * openaiChat({ model, messages, tools, maxTokens, temperature, json, timeoutMs })
 * → { message, usage, model }  (model — фактически ответившая модель)
 */
async function openaiChat(opts) {
  const key = process.env.OPENAI_API_KEY || "";
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const timeoutMs = opts.timeoutMs || 30000;
  const params = {
    messages: opts.messages,
    tools: opts.tools,
    maxTokens: opts.maxTokens || 1000,
    temperature: opts.temperature,
    json: !!opts.json,
  };
  const first = opts.model || modelMain();
  const tried = [];
  for (const model of [first, modelFallback()]) {
    if (tried.includes(model)) continue;
    tried.push(model);
    const res = await post(buildBody(model, params), key, timeoutMs);
    if (res.ok) {
      let data = {};
      try { data = JSON.parse(res.text); } catch (e) { throw new Error("OpenAI: bad JSON"); }
      const message = data.choices && data.choices[0] && data.choices[0].message;
      if (!message) throw new Error("OpenAI: empty completion");
      return { message, usage: data.usage, model: data.model || model, fellBack: model !== first };
    }
    if (!isModelProblem(res.status, res.text)) {
      throw new Error(`OpenAI HTTP ${res.status}: ${res.text.slice(0, 200)}`);
    }
    console.error(`openai: model ${model} rejected (${res.status}), trying fallback:`, res.text.slice(0, 200));
  }
  throw new Error(`OpenAI: модели ${tried.join(", ")} недоступны`);
}

module.exports = { openaiChat, isNewGen, buildBody, isModelProblem, modelMain, modelStrong, modelFallback };
