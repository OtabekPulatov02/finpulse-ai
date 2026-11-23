/* Живая проверка моделей OpenAI по всем путям, которыми пользуется бот.
   Не входит в npm test (тратит токены). Запуск перед сменой модели:
     OPENAI_API_KEY=... node scripts/ai-live-check.js [model1,model2,...]
   По умолчанию: OPENAI_MODEL, OPENAI_MODEL_STRONG, OPENAI_MODEL_FALLBACK.
   Зачем: юнит-тесты мокают OpenAI и повторяют наши же допущения — так в
   ноябре 2026 в прод ушёл вызов tools через Chat Completions, который
   gpt-6.x отклоняет. Этот скрипт ловит такие несовместимости до деплоя. */
const { openaiChat, modelMain, modelStrong, modelFallback } = require("../lib/openai.js");

const models = (process.argv[2] || [modelMain(), modelStrong(), modelFallback()].join(",")).split(",");
const tool = { type: "function", function: { name: "tax_calc", description: "Налоговый расчёт", parameters: { type: "object", properties: { kind: { type: "string" }, gross: { type: "number" } }, required: ["kind"] } } };
const sys = { role: "system", content: "Ты бухгалтер (Узбекистан, суммы в сумах). Любые налоговые и зарплатные расчёты делай ТОЛЬКО через tax_calc." };
const ask = { role: "user", content: "Посчитай зарплату на руки, если начислено 10 000 000 (kind=payroll)" };
const pdf = "%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 60>>stream\nBT /F1 18 Tf 20 80 Td (Invoice 58 total 12400000 UZS) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF";

const cases = {
  json: async (m) => JSON.parse((await openaiChat({ model: m, messages: [{ role: "user", content: 'Верни JSON {"ok": true}' }], json: true, maxTokens: 1200, timeoutMs: 40000 })).message.content || "{}").ok === true,
  pdf: async (m) => Number(JSON.parse((await openaiChat({ model: m, json: true, maxTokens: 1500, timeoutMs: 45000, messages: [{ role: "user", content: [{ type: "text", text: 'Какая сумма в документе? JSON {"total": число}' }, { type: "file", file: { filename: "inv.pdf", file_data: "data:application/pdf;base64," + Buffer.from(pdf).toString("base64") } }] }] })).message.content || "{}").total) === 12400000,
  "agent loop": async (m) => {
    const convo = [sys, ask];
    const a = await openaiChat({ model: m, messages: convo, tools: [tool], maxTokens: 2000, temperature: 0.1, timeoutMs: 45000 });
    if (a.fellBack || !a.message.tool_calls) return false;
    convo.push(a.message);
    for (const tc of a.message.tool_calls) convo.push({ role: "tool", tool_call_id: tc.id, content: '{"ok":true,"net":8800000}' });
    const b = await openaiChat({ model: m, messages: convo, tools: [tool], maxTokens: 2000, temperature: 0.1, timeoutMs: 45000 });
    return !b.fellBack && /8[\s .,]?800[\s .,]?000/.test(b.message.content || "");
  },
};

(async () => {
  let fails = 0;
  for (const m of models) for (const [name, fn] of Object.entries(cases)) {
    let ok = false, err = "";
    try { ok = await fn(m); } catch (e) { err = String(e.message || e).slice(0, 160); }
    if (!ok) fails++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${m.padEnd(16)} ${name}${err ? "  " + err : ""}`);
  }
  process.exit(fails ? 1 : 0);
})();
