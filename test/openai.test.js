const test = require("node:test");
const assert = require("node:assert");
const { buildBody, isNewGen, isModelProblem, openaiChat, toResponsesInput, fromResponses, useResponses, buildResponsesBody } = require("../lib/openai.js");

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

test("новая модель + tools → Responses API, ответ в формате Chat Completions", async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  const orig = global.fetch;
  let url = null, sent = null;
  global.fetch = async (u, init) => {
    url = String(u); sent = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: "gpt-6.2-sol-2026-11-17", usage: { input_tokens: 7, output_tokens: 3 },
      output: [{ type: "reasoning", summary: [] }, { type: "function_call", call_id: "call_1", name: "tax_calc", arguments: '{"kind":"rates"}' }] }) };
  };
  try {
    const tools = [{ type: "function", function: { name: "tax_calc", description: "d", parameters: { type: "object", properties: {} } } }];
    const out = await openaiChat({ model: "gpt-6.2-sol", messages: [{ role: "system", content: "S" }, { role: "user", content: "Q" }], tools, maxTokens: 500 });
    assert.match(url, /\/v1\/responses$/);
    assert.strictEqual(sent.max_output_tokens, 500);
    assert.strictEqual(sent.reasoning.effort, "low");
    assert.deepStrictEqual(sent.tools[0], { type: "function", name: "tax_calc", description: "d", parameters: { type: "object", properties: {} } });
    assert.deepStrictEqual(sent.input[0], { role: "developer", content: "S" });
    assert.strictEqual(out.api, "responses");
    assert.strictEqual(out.message.tool_calls[0].id, "call_1");
    assert.strictEqual(out.message.tool_calls[0].function.name, "tax_calc");
    assert.deepStrictEqual(out.usage, { prompt_tokens: 7, completion_tokens: 3 });
  } finally { global.fetch = orig; }
});
test("история с вызовами инструментов → function_call / function_call_output", () => {
  const input = toResponsesInput([
    { role: "user", content: [{ type: "text", text: "что это?" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,AA", detail: "high" } }, { type: "file", file: { filename: "a.pdf", file_data: "data:application/pdf;base64,BB" } }] },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: '{"ok":true}' },
  ]);
  assert.deepStrictEqual(input[0].content.map((p) => p.type), ["input_text", "input_image", "input_file"]);
  assert.strictEqual(input[0].content[1].image_url, "data:image/jpeg;base64,AA");
  assert.deepStrictEqual(input[1], { type: "function_call", call_id: "c1", name: "x", arguments: "{}" });
  assert.deepStrictEqual(input[2], { type: "function_call_output", call_id: "c1", output: '{"ok":true}' });
});
test("текстовый ответ Responses и выбор пути", () => {
  const { message } = fromResponses({ output: [{ type: "message", content: [{ type: "output_text", text: "Готово" }] }] });
  assert.strictEqual(message.content, "Готово");
  assert.ok(!message.tool_calls);
  assert.ok(useResponses("gpt-6.2-sol", [{}]) && !useResponses("gpt-6.2-sol", []) && !useResponses("gpt-4o", [{}]));
  assert.deepStrictEqual(buildResponsesBody("gpt-6.2-astra", { messages: [], maxTokens: 10, json: true, reasoning: "medium" }).text, { format: { type: "json_object" } });
});
test("цепочка рассуждений: _rsp возвращается в Responses и не уходит в Chat Completions", () => {
  const { message } = fromResponses({ output: [
    { type: "reasoning", id: "rs_1", encrypted_content: "ENC", summary: [] },
    { type: "function_call", id: "fc_1", call_id: "c1", name: "x", arguments: "{}" },
  ] });
  assert.strictEqual(message._rsp.length, 2);
  const input = toResponsesInput([{ role: "user", content: "q" }, message, { role: "tool", tool_call_id: "c1", content: "{}" }]);
  assert.deepStrictEqual(input.map((i) => i.type || i.role), ["user", "reasoning", "function_call", "function_call_output"]);
  assert.strictEqual(input[1].encrypted_content, "ENC");
  const chat = buildBody("gpt-4o", { messages: [message], maxTokens: 10 });
  assert.ok(!("_rsp" in chat.messages[0]));
  assert.ok(buildResponsesBody("gpt-6.2-sol", { messages: [], maxTokens: 10 }).include.includes("reasoning.encrypted_content"));
});
