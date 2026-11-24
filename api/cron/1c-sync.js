/* ============================================================
   Finpulse CRM — ночной автопересинк справочников 1С (организации,
   контрагенты, договоры, номенклатура) по всем готовым базам.
   Вызывается Vercel Cron (см. vercel.json, "/api/cron/1c-sync").

   Зачем: раньше синк запускался только вручную кнопкой в интерфейсе —
   между нажатиями данные в Redis-картах (1c:orgmap/cpmap/ctmap/nommap)
   могли отставать от 1С (новые контрагенты, новые организации и т.д.).
   Этот крон каждую ночь проходит по всем базам со статусом "готов" и
   вызывает те же самые POST-действия /api/1c, что и кнопки в UI —
   никакой отдельной логики синка, только оркестрация вызовов.

   Авторизация: у /api/1c/* тот же JWT-гейт, что у /api/crm — обычному
   крону взять пользовательский JWT неоткуда, поэтому здесь он
   подписывается сам (тем же JWT_SECRET, что и весь проект) с ролью
   admin и очень коротким сроком жизни (2 минуты, только на время
   самого прогона).

   Защита эндпоинта: как и у /api/cron/reminders — если задан
   CRON_SECRET, требуется "Authorization: Bearer <CRON_SECRET>".

   Лимит 60 с (24.11.2026): полный прогон — 8 справочников × N баз
   последовательно — не влезал в maxDuration и падал с Runtime Timeout.
   Теперь прогон идёт по очереди шагов (база × справочник) с бюджетом
   времени: что не успели — сохраняется в Redis (1c:sync:cursor) и
   продолжается следующим вызовом (?mode=continue — функция сама себя
   дёргает; страховка — почасовой GitHub Actions, который сначала
   доделывает незаконченный полный прогон). Одновременный запуск двух
   прогонов исключён замком 1c:sync:lock.
   ============================================================ */

const jwt = require("jsonwebtoken");
const redis = require("../../lib/redisClient.js");
const { sleep } = require("../../lib/httpRetry.js");
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
async function tgToGroup(payload) {
  if (!TG_TOKEN) return null;
  let group = await redis.get("group");
  if (!group) return null;
  const call = (chatId) =>
    fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...payload }),
    }).then((r) => r.json()).catch(() => null);
  let resp = await call(Number(group));
  if (resp && !resp.ok && resp.parameters && resp.parameters.migrate_to_chat_id) {
    group = resp.parameters.migrate_to_chat_id;
    await redis.set("group", group);
    resp = await call(Number(group));
  }
  return resp;
}

const CRON_SECRET = process.env.CRON_SECRET || "";
const JWT_SECRET = process.env.JWT_SECRET || process.env.CRM_JWT_SECRET || "";
const SELF = process.env.CRM_API_ORIGIN || "https://finpulse-crm.vercel.app";

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a || ""));
  const bufB = Buffer.from(String(b || ""));
  if (bufA.length !== bufB.length) return false;
  const crypto = require("crypto");
  return crypto.timingSafeEqual(bufA, bufB);
}

function internalToken() {
  if (!JWT_SECRET) return null;
  return jwt.sign({ role: "admin", name: "Cron 1C-sync" }, JWT_SECRET, { algorithm: "HS256", expiresIn: "2m" });
}

async function callApi1c(token, body, timeoutMs = 45000) {
  const r = await fetch(`${SELF}/api/1c`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(3000, timeoutMs)),
  });
  return r.json().catch(() => ({ ok: false, error: "bad json" }));
}

const BUDGET_MS = 50000;          /* запас до maxDuration 60 с */
const MIN_STEP_MS = 8000;         /* меньше — новый шаг не начинаем */
const CURSOR_KEY = "1c:sync:cursor";
const LOCK_KEY = "1c:sync:lock";
const FULL_STEPS = ["orgs", "counterparties", "contracts", "nomenclature", "reports", "employees", "positions", "departments"];
const LIGHT_STEPS = ["orgs", "counterparties"];

/* Очередь шагов: сначала все справочники первой базы, потом второй и т.д. */
function buildQueue(apps, light) {
  const steps = light ? LIGHT_STEPS : FULL_STEPS;
  const q = [];
  for (const a of apps) for (const step of steps) q.push({ code: a.code, name: a.name, step });
  return q;
}

/* Базы, где не прошёл ни один справочник, — для алерта в группу */
function brokenBases(stats) {
  return Object.values(stats || {})
    .filter((b) => b.fail > 0 && b.ok === 0)
    .map((b) => `${b.name}: ${b.lastErr || "неизвестная ошибка"}`);
}

/* Решение, что делать в этом вызове: начать новый прогон или продолжить старый.
   full (ночной) — всегда начинает заново; light (почасовой) — сначала доделывает
   незаконченный прогон; continue — только продолжает. */
function planRun(mode, cursor) {
  const unfinished = cursor && Array.isArray(cursor.queue) && cursor.queue.length > 0;
  if (mode === "full") return "new-full";
  if (mode === "continue") return unfinished ? "resume" : "nothing";
  return unfinished ? "resume" : "new-light";
}

async function selfContinue() {
  /* Не ждём ответа: вызов продолжает работу на Vercel и после обрыва соединения */
  await fetch(`${SELF}/api/cron/1c-sync?mode=continue`, {
    headers: CRON_SECRET ? { authorization: `Bearer ${CRON_SECRET}` } : {},
    signal: AbortSignal.timeout(2500),
  }).catch(() => null);
}

module.exports = async (req, res) => {
  if (CRON_SECRET) {
    const auth = req.headers.authorization || "";
    if (!timingSafeStringEqual(auth, `Bearer ${CRON_SECRET}`)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
  }

  const started = Date.now();
  const left = () => BUDGET_MS - (Date.now() - started);
  const q = (req.query && req.query.mode) || "full";
  const mode = q === "light" || q === "continue" ? q : "full";

  const got = await redis.set(LOCK_KEY, String(started), { nx: true, ex: 58 }).catch(() => "OK");
  if (!got) return res.status(200).json({ ok: true, skipped: "another run in progress" });

  try {
    const token = internalToken();
    let cursor = await redis.get(CURSOR_KEY).catch(() => null);
    if (typeof cursor === "string") { try { cursor = JSON.parse(cursor); } catch { cursor = null; } }
    const plan = planRun(mode, cursor);
    if (plan === "nothing") return res.status(200).json({ ok: true, mode, nothing: true });

    if (plan !== "resume") {
      /* /api/1c?r=ping сам ходит по всем базам — тоже под бюджет */
      const pingRes = await fetch(`${SELF}/api/1c?r=ping`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(25000),
      }).then((r) => r.json()).catch(() => null);
      const apps = (pingRes && pingRes.apps) || [];
      const ready = apps.filter((a) => a.ready);
      cursor = { kind: plan === "new-light" ? "light" : "full", startedAt: new Date(started).toISOString(), total: apps.length, ready: ready.length, queue: buildQueue(ready, plan === "new-light"), stats: {}, calls: 0 };
    }

    let prev = null;
    while (cursor.queue.length && left() > MIN_STEP_MS) {
      const it = cursor.queue[0];
      if (prev && prev !== it.code) await sleep(400); /* пауза между базами — лимит Clobus на абонента */
      const r = await callApi1c(token, { action: `sync_${it.step}`, app: it.code }, Math.min(40000, left() - 3000))
        .catch((e) => ({ ok: false, error: String(e && e.name === "TimeoutError" ? "таймаут" : e).slice(0, 120) }));
      const st = cursor.stats[it.code] || (cursor.stats[it.code] = { name: it.name, ok: 0, fail: 0, lastErr: null });
      if (r && r.ok !== false) st.ok++; else { st.fail++; st.lastErr = (r && r.error) || "ошибка"; }
      cursor.queue.shift();
      cursor.calls++;
      prev = it.code;
    }

    const remaining = cursor.queue.length;
    if (remaining) {
      await redis.set(CURSOR_KEY, JSON.stringify(cursor), { ex: 6 * 3600 });
      await redis.del(LOCK_KEY).catch(() => null);
      await selfContinue();
      return res.status(200).json({ ok: true, mode, kind: cursor.kind, remaining, done: cursor.calls, ms: Date.now() - started });
    }

    await redis.del(CURSOR_KEY).catch(() => null);
    /* Мониторинг: если хотя бы одна база не смогла синкнуть ни один справочник —
       алерт в группу бухгалтеров с перечнем проблемных баз. */
    const broken = brokenBases(cursor.stats);
    if (broken.length) {
      const label = cursor.kind === "light" ? "Часовой синк 1С" : "Ночной синк 1С";
      await tgToGroup({
        text: `⚠️ <b>${label} не смог обновить ни один справочник</b> в ${broken.length} из ${cursor.ready} баз:\n${broken.map((b) => "• " + b).join("\n")}\n\nПроверьте логи Vercel (cron/1c-sync) и доступ к базе в Clobus.`,
        parse_mode: "HTML",
      }).catch(() => null);
    }
    return res.status(200).json({ ok: true, mode, kind: cursor.kind, total: cursor.total, synced: cursor.ready, calls: cursor.calls, stats: cursor.stats, ms: Date.now() - started });
  } catch (e) {
    console.error("1c-sync cron:", e);
    await tgToGroup({
      text: `🔴 <b>Синк 1С упал целиком</b>\n${String(e).slice(0, 300)}\n\nПроверьте логи Vercel (cron/1c-sync).`,
      parse_mode: "HTML",
    }).catch(() => null);
    return res.status(200).json({ ok: false, error: String(e).slice(0, 300) });
  } finally {
    await redis.del(LOCK_KEY).catch(() => null);
  }
};

module.exports.buildQueue = buildQueue;
module.exports.brokenBases = brokenBases;
module.exports.planRun = planRun;
