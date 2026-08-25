/* ============================================================
   Finpulse AI — реестр тенантов (мультитенантность, Phase 1).

   Тенант = один бухгалтерский аутсорс/бизнес, работающий на платформе.
   Иерархия: Владелец платформы (super_admin) → Тенант (владелец
   бухгалтерского аутсорса, role:"admin" внутри своего тенанта) →
   данные тенанта (его клиенты, задачи, сотрудники).

   Это ПЕРВЫЙ слой мультитенантности — только реестр тенантов и
   namespacing-хелпер для ключей. Существующие api/*.js и lib/*.js
   пока НЕ переведены на tenantKey() — это следующий шаг (Phase 1,
   пункт 2 в архитектурном плане). Файл сделан отдельным модулем
   специально, чтобы ничего не ломать в уже работающем проде: подключаем
   постепенно, endpoint за endpoint.

   Ключи:
     tenant:<id>              — карточка тенанта (JSON)
     tenants                  — SET всех id тенантов
     tenant:supportlog:<id>   — LIST аудит-лога входов супер-админа
                                 в CRM этого тенанта (см. logSupportAccess)
   ============================================================ */

const redis = require("./redisClient.js");

const STATUSES = ["trial", "active", "suspended"];

function genId(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* Namespacing-хелпer: все данные КОНКРЕТНОГО тенанта (клиенты, задачи,
   сотрудники, RAG-документы и т.д.) должны в итоге жить под этим
   префиксом, чтобы данные разных тенантов физически не пересекались
   в Redis. tenantId сюда должен приходить ТОЛЬКО из серверного
   контекста (JWT-claim / резолюция по Telegram-группе) — никогда не
   от клиента напрямую, иначе один тенант сможет читать данные другого,
   просто подставив чужой id в параметр запроса. */
function tenantKey(tenantId, key) {
    if (!tenantId) throw new Error("tenantKey: tenantId is required");
    return `t:${tenantId}:${key}`;
}

async function createTenant({ name, ownerName, ownerPhone } = {}) {
    if (!name || !String(name).trim()) {
          return { ok: false, error: "Название бизнеса обязательно" };
    }
    const id = genId("tn_");
    const tenant = {
          id,
          name: String(name).trim(),
          ownerName: ownerName ? String(ownerName).trim() : null,
          ownerPhone: ownerPhone ? String(ownerPhone).trim() : null,
          status: "trial",
          // Интеграции, включённые для тенанта — по умолчанию всё выключено,
          // супер-админ включает по мере онбординга (см. api/superadmin.js).
          integrations: { oneC: false, didox: false, bank: false, aiAutonomous: false },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
    };
    await redis.mset({ [`tenant:${id}`]: tenant });
    await redis.sadd("tenants", id);
    return { ok: true, tenant };
}

async function getTenant(id) {
    if (!id) return null;
    const t = await redis.get(`tenant:${id}`);
    return t || null;
}

async function listTenants() {
    const ids = (await redis.smembers("tenants")) || [];
    if (!ids.length) return [];
    const keys = ids.map((id) => `tenant:${id}`);
    const rows = await redis.mget(...keys);
    return rows
      .filter(Boolean)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

async function updateTenant(id, patch = {}) {
    const tenant = await getTenant(id);
    if (!tenant) return { ok: false, error: "Тенант не найден" };
    const next = { ...tenant, ...patch, id: tenant.id, updatedAt: new Date().toISOString() };
    await redis.mset({ [`tenant:${id}`]: next });
    return { ok: true, tenant: next };
}

async function setTenantStatus(id, status) {
    if (!STATUSES.includes(status)) {
          return { ok: false, error: `Статус должен быть одним из: ${STATUSES.join(", ")}` };
    }
    return updateTenant(id, { status });
}

/* Каждый вход супер-админа в CRM тенанта под видом поддержки должен
   быть залогирован — это обязательное условие, на котором согласована
   мультитенантная модель (прозрачность = доверие тенанта к платформе).
   Лог отдаётся тенанту по запросу (будущий эндпоинт в CRM тенанта). */
async function logSupportAccess(tenantId, { byAdminId, byAdminName, reason } = {}) {
    if (!tenantId) throw new Error("logSupportAccess: tenantId is required");
    const entry = {
          at: new Date().toISOString(),
          byAdminId: byAdminId || null,
          byAdminName: byAdminName || null,
          reason: reason || null,
    };
    await redis.lpush(`tenant:supportlog:${tenantId}`, JSON.stringify(entry));
    await redis.ltrim(`tenant:supportlog:${tenantId}`, 0, 199);
    return entry;
}

async function getSupportLog(tenantId, limit = 50) {
    if (!tenantId) return [];
    const rows = (await redis.lrange(`tenant:supportlog:${tenantId}`, 0, limit - 1)) || [];
    return rows
      .map((raw) => {
              try {
                        return typeof raw === "string" ? JSON.parse(raw) : raw;
              } catch {
                        return null;
              }
      })
      .filter(Boolean);
}

module.exports = {
    STATUSES,
    genId,
    tenantKey,
    createTenant,
    getTenant,
    listTenants,
    updateTenant,
    setTenantStatus,
    logSupportAccess,
    getSupportLog,
};
