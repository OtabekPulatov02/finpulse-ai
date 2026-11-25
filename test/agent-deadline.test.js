const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const store = new Map();
const fakeRedis = new Proxy({ get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); return "OK"; } },
  { get: (t, p) => (p in t ? t[p] : async () => null) });
require.cache[path.resolve(__dirname, "../lib/redisClient.js")] = { exports: fakeRedis };
process.env.OPENAI_API_KEY = "sk-test";
process.env.AGENT_DEADLINE_MS = "9000";
delete process.env.JWT_SECRET; delete process.env.CRM_JWT_SECRET;

/* OpenAI «висит», пока его не оборвут сигналом */
let pending = 0, aborted = 0;
global.fetch = (url, opts = {}) => new Promise((resolve, reject) => {
  pending++;
  const sig = opts.signal;
  const done = () => { pending--; aborted++; reject(Object.assign(new Error("aborted"), { name: "AbortError" })); };
  if (sig) { if (sig.aborted) return done(); sig.addEventListener("abort", done, { once: true }); }
});
const ai = require("../api/ai.js");

test("агент упёрся в дедлайн → отвечаем сами и обрываем фоновые вызовы", async () => {
  const keep = setInterval(() => {}, 200); // реальная сеть держит цикл событий; мок — нет
  const t0 = Date.now();
  let status, json;
  const res = { setHeader() {}, status(c) { status = c; return this; }, json(j) { json = j; return this; }, end() { return this; } };
  await ai({ method: "POST", headers: {}, query: {}, body: { action: "agent", messages: [{ role: "user", content: "долгий запрос" }] } }, res);
  const ms = Date.now() - t0;
  assert.strictEqual(status, 200);
  clearInterval(keep);
  assert.ok(json, "ответ отправлен");
  /* дедлайн 9 с + название чата не дольше дедлайна+4 с → ответ гарантированно раньше лимита */
  assert.ok(ms < 13500, "ответ за " + ms + " мс");
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(pending, 0, "висящих запросов не осталось");
  assert.ok(aborted >= 1);
});
