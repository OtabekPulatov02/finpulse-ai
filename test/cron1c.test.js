const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

/* Мок Redis и sleep до загрузки крона */
const store = new Map();
const fakeRedis = {
  get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null),
  set: async (k, v, o = {}) => { if (o.nx && store.has(k)) return null; store.set(k, typeof v === "string" && v.startsWith("{") ? JSON.parse(v) : v); return "OK"; },
  del: async (...ks) => { ks.forEach((k) => store.delete(k)); return 1; },
};
require.cache[path.resolve(__dirname, "../lib/redisClient.js")] = { exports: fakeRedis };
require.cache[path.resolve(__dirname, "../lib/httpRetry.js")] = { exports: { sleep: async () => {} } };
process.env.JWT_SECRET = "x".repeat(32);
const cron = require("../api/cron/1c-sync.js");

test("planRun: ночной всегда заново, почасовой доделывает хвост", () => {
  assert.strictEqual(cron.planRun("full", { queue: [1] }), "new-full");
  assert.strictEqual(cron.planRun("light", { queue: [1] }), "resume");
  assert.strictEqual(cron.planRun("light", null), "new-light");
  assert.strictEqual(cron.planRun("continue", { queue: [] }), "nothing");
});
test("buildQueue: 5 баз × 8 справочников = 40 шагов, light — 10", () => {
  const apps = [1, 2, 3, 4, 5].map((i) => ({ code: "a" + i, name: "B" + i }));
  assert.strictEqual(cron.buildQueue(apps, false).length, 40);
  assert.strictEqual(cron.buildQueue(apps, true).length, 10);
});
test("brokenBases: только базы, где не прошёл ни один шаг", () => {
  const r = cron.brokenBases({ a: { name: "A", ok: 0, fail: 3, lastErr: "401" }, b: { name: "B", ok: 1, fail: 2 } });
  assert.deepStrictEqual(r, ["A: 401"]);
});

test("полный прогон укладывается в бюджет кусками и доходит до конца", async () => {
  let now = 1_800_000_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  const calls = [];
  let continues = 0;
  global.fetch = async (url, opts = {}) => {
    if (String(url).includes("r=ping")) return { json: async () => ({ apps: [1, 2, 3, 4, 5].map((i) => ({ code: "a" + i, name: "B" + i, ready: i !== 5 })).concat([{ code: "a6", name: "B6", ready: true }]) }) };
    if (String(url).includes("mode=continue")) { continues++; return { json: async () => ({}) }; }
    const body = JSON.parse(opts.body);
    calls.push(body.app + ":" + body.action);
    now += 6000; /* каждый шаг «занимает» 6 с */
    return { json: async () => (body.app === "a6" ? { ok: false, error: "401" } : { ok: true }) };
  };
  const run = async (mode) => {
    let out; const res = { status: () => ({ json: (j) => { out = j; } }) };
    await cron({ query: { mode }, headers: {} }, res);
    return out;
  };
  try {
    const r1 = await run("full");
    assert.ok(r1.remaining > 0, "первый вызов не успевает всё");
    assert.ok(r1.ms <= 50000, "в пределах бюджета: " + r1.ms);
    assert.strictEqual(continues, 1, "сам запускает продолжение");
    let r = r1, guard = 0;
    while (r.remaining && guard++ < 10) { now += 1000; r = await run("continue"); }
    assert.strictEqual(calls.length, 40, "5 готовых баз × 8 справочников");
    assert.strictEqual(new Set(calls).size, 40, "без повторов");
    assert.strictEqual(r.stats.a6.fail, 8);
    assert.strictEqual(store.has("1c:sync:cursor"), false, "курсор удалён");
    assert.strictEqual(store.has("1c:sync:lock"), false, "замок снят");
    const again = await run("continue");
    assert.strictEqual(again.nothing, true);
  } finally { Date.now = realNow; }
});

test("второй прогон при занятом замке пропускается", async () => {
  store.set("1c:sync:lock", "1");
  let out; await cron({ query: { mode: "full" }, headers: {} }, { status: () => ({ json: (j) => { out = j; } }) });
  assert.ok(out.skipped);
  store.delete("1c:sync:lock");
});
