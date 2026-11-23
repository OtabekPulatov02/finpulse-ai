const test = require("node:test");
const assert = require("node:assert");
const { buildBody, isNewGen, isModelProblem, openaiChat } = require("../lib/openai.js");

test("новые модели: max_completion_tokens, без temperature", () => {
  const b = buildBody("gpt-6.2-sol", { messages: [], maxTokens: 100, temperature: 0.1 });
  assert.strictEqual(b.max_completion_tokens, 100);
  assert.ok(!("max_tokens" in b) && !("temperature" in b));
  assert.ok(isNewGen("o4-mini") && isNewGen("gpt-5.4") && !isNewGen("gpt-4o"));
});
test("старые модели: max_tokens + temperature", () => {
  const b = buildBody("gpt-4o", { messages: [], maxTokens: 100, temperature: 0.1, json: true });
  assert.strictEqual(b.max_tokens, 100);
  assert.strictEqual(b.temperature, 0.1);
  assert.deepStrictEqual(b.response_format, { type: "json_object" });
});
test("isModelProblem", () => {
  assert.ok(isModelProblem(404, ""));
  assert.ok(isModelProblem(400, '{"error":{"code":"model_not_found"}}'));
  assert.ok(!isModelProblem(400, '{"error":{"code":"context_length_exceeded"}}'));
  assert.ok(!isModelProblem(429, "rate"));
});
test("откат на запасную модель при model_not_found", async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  const seen = [];
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body.model);
    if (body.model === "gpt-6.2-sol") return { ok: false, status: 404, text: async () => '{"error":{"code":"model_not_found"}}' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: body.model, choices: [{ message: { content: "hi" } }], usage: {} }) };
  };
  try {
    const out = await openaiChat({ model: "gpt-6.2-sol", messages: [{ role: "user", content: "x" }] });
    assert.deepStrictEqual(seen, ["gpt-6.2-sol", "gpt-4o"]);
    assert.strictEqual(out.fellBack, true);
    assert.strictEqual(out.message.content, "hi");
  } finally { global.fetch = orig; }
});
test("прочие ошибки не маскируются откатом", async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status: 429, text: async () => "rate limited" });
  try { await assert.rejects(() => openaiChat({ messages: [] }), /HTTP 429/); } finally { global.fetch = orig; }
});

test("gpt-6.x: tools + reasoning → повтор с reasoning_effort:none, без отката", async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  const { modelOverrides } = require("../lib/openai.js");
  modelOverrides.clear();
  const seen = [];
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ model: body.model, re: body.reasoning_effort });
    if (body.tools && body.reasoning_effort !== "none") {
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "Function tools with reasoning_effort are not supported for gpt-6.2-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'." } }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: body.model, choices: [{ message: { content: "ok" } }] }) };
  };
  try {
    const tools = [{ type: "function", function: { name: "x", parameters: { type: "object", properties: {} } } }];
    const a = await openaiChat({ model: "gpt-6.2-sol", messages: [], tools });
    assert.strictEqual(a.fellBack, false);
    assert.deepStrictEqual(seen, [{ model: "gpt-6.2-sol", re: undefined }, { model: "gpt-6.2-sol", re: "none" }]);
    seen.length = 0;
    await openaiChat({ model: "gpt-6.2-sol", messages: [], tools });
    assert.deepStrictEqual(seen, [{ model: "gpt-6.2-sol", re: "none" }], "второй вызов сразу с none");
    seen.length = 0;
    await openaiChat({ model: "gpt-6.2-sol", messages: [] });
    assert.deepStrictEqual(seen, [{ model: "gpt-6.2-sol", re: undefined }], "без tools — reasoning остаётся");
  } finally { global.fetch = orig; }
});
