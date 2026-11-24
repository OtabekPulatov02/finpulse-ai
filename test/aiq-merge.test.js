const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const store = new Map();
const fakeRedis = new Proxy({
  get: async (k) => store.get(k) ?? null,
  set: async (k, v) => { store.set(k, v); return "OK"; },
  del: async (k) => { store.delete(k); return 1; },
  lpush: async () => 1, ltrim: async () => "OK", expire: async () => 1, incr: async () => 1, sadd: async () => 1,
}, { get: (t, p) => (p in t ? t[p] : async () => null) });
require.cache[path.resolve(__dirname, "../lib/redisClient.js")] = { exports: fakeRedis };
process.env.TELEGRAM_BOT_TOKEN = "T";
const calls = [];
global.fetch = async (url, opts) => { const body = JSON.parse(opts.body || "{}"); calls.push({ method: String(url).split("/").pop(), body }); return { json: async () => ({ ok: true, result: { message_id: 900 } }) }; };
const ai = require("../api/ai.js");

test("вопрос ИИ дописывается в свежий разбор, а не новым сообщением", async () => {
  store.set("group", -100);
  store.set("task:167", { num: 167, thread: [] });
  const task = { num: 167, gmsg: 10, assignee: "AI-бухгалтер", aiNote: { msg: 11, at: Date.now(), html: "🤖 <b>Разбор ИИ · №167</b>\n<b>Исполнитель:</b> Yulduz Ibragimova\n💡 Уточните цель." } };
  calls.length = 0;
  await ai._askClarificationInGroup(167, task, "Какой сервис имеется в виду? Нужен обзор или инструкция?", "generic", []);
  const edit = calls.find((c) => c.method === "editMessageText");
  assert.ok(edit, JSON.stringify(calls.map((c) => c.method)));
  assert.strictEqual(edit.body.message_id, 11);
  assert.match(edit.body.text, /<b>Исполнитель:<\/b> AI-бухгалтер/);
  assert.match(edit.body.text, /❓ <b>Вопрос:<\/b> Какой сервис имеется в виду\?/);
  assert.ok(!calls.some((c) => c.method === "sendMessage" && /нужен ответ/.test(c.body.text || "")));
  assert.deepStrictEqual(store.get("aiq:11"), { num: 167, kind: "generic", suggestions: [] });
});
test("без свежего разбора — одно короткое сообщение", async () => {
  calls.length = 0;
  await ai._askClarificationInGroup(168, { num: 168, gmsg: 20 }, "Укажите контрагента.", "generic", []);
  const s = calls.find((c) => c.method === "sendMessage");
  assert.match(s.body.text, /^🤖 <b>№168<\/b> · нужен ответ\n❓/);
  assert.ok(s.body.text.split("\n").length <= 3);
});
