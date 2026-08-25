/* ============================================================
   Finpulse AI — панель супер-админа платформы (Phase 1, скелет).

   Отдельный от api/auth.js/api/crm.js контур авторизации: пока в основной
   JWT-системе нет роли "super_admin" (это следующий шаг мультитенантности),
   этот эндпоинт защищён отдельным общим секретом SUPERADMIN_SECRET —
   тем же паттерном, что и bootstrap_admin в api/auth.js. Когда роль
   super_admin появится в общей JWT-схеме, этот заголовок можно будет
   заменить на Bearer-токен с ролью super_admin — сигнатуры функций
   в lib/tenant.js от этого не изменятся.

   GET  /api/superadmin?r=tenants           → список всех тенантов
   GET  /api/superadmin?r=tenant&id=<id>    → карточка одного тенанта
   GET  /api/superadmin?r=support_log&id=<id> → лог входов поддержки в этот тенант
   POST /api/superadmin {action:"tenant_create", name, ownerName?, ownerPhone?}
   POST /api/superadmin {action:"tenant_update", id, patch:{...}}
   POST /api/superadmin {action:"tenant_status", id, status:"trial"|"active"|"suspended"}
   POST /api/superadmin {action:"support_access_log", id, byAdminName, reason?}
        → фиксирует факт входа супер-админа в CRM тенанта (вызывается
          фронтендом супер-админ панели в момент перехода "войти как тенант")
   ============================================================ */

const crypto = require("crypto");
const tenants = require("../lib/tenant.js");

const SUPERADMIN_SECRET = process.env.SUPERADMIN_SECRET || "";
const ALLOWED_ORIGINS = (process.env.CRM_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function resolveOrigin(req) {
    const origin = req.headers.origin || "";
    if (!ALLOWED_ORIGINS.length) return origin || "*";
    return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

function timingSafeStringEqual(a, b) {
    const bufA = Buffer.from(String(a || ""), "utf8");
    const bufB = Buffer.from(String(b || ""), "utf8");
    if (bufA.length !== bufB.length) return false;
    try { return crypto.timingSafeEqual(bufA, bufB); } catch { return false; }
}

function checkSuperAdmin(req) {
    // Незаданный секрет = доступ закрыт (в отличие от CRM_API_KEY выше по
  // системе, тут нет причин оставлять "открытый по умолчанию" переходный
  // период — панель супер-админа не используется до явной настройки).
  if (!SUPERADMIN_SECRET) return false;
    return timingSafeStringEqual(req.headers["x-superadmin-secret"], SUPERADMIN_SECRET);
}

module.exports = async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", resolveOrigin(req));
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type,x-superadmin-secret");
    if (req.method === "OPTIONS") return res.status(204).end();

    if (!checkSuperAdmin(req)) {
          return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    try {
          if (req.method === "GET") {
                  const q = req.query || {};

            if (q.r === "tenants") {
                      const list = await tenants.listTenants();
                      return res.status(200).json({ ok: true, tenants: list });
            }

            if (q.r === "tenant") {
                      const t = await tenants.getTenant(String(q.id || ""));
                      if (!t) return res.status(404).json({ ok: false, error: "tenant not found" });
                      return res.status(200).json({ ok: true, tenant: t });
            }

            if (q.r === "support_log") {
                      const log = await tenants.getSupportLog(String(q.id || ""));
                      return res.status(200).json({ ok: true, log });
            }

            return res.status(200).json({ ok: true, service: "Finpulse AI super-admin" });
          }

      if (req.method === "POST") {
              let body = req.body;
              if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
              body = body || {};

            if (body.action === "tenant_create") {
                      const result = await tenants.createTenant({
                                  name: body.name,
                                  ownerName: body.ownerName,
                                  ownerPhone: body.ownerPhone,
                      });
                      return res.status(result.ok ? 200 : 400).json(result);
            }

            if (body.action === "tenant_update") {
                      if (!body.id) return res.status(400).json({ ok: false, error: "id обязателен" });
                      const result = await tenants.updateTenant(String(body.id), body.patch || {});
                      return res.status(result.ok ? 200 : 400).json(result);
            }

            if (body.action === "tenant_status") {
                      if (!body.id) return res.status(400).json({ ok: false, error: "id обязателен" });
                      const result = await tenants.setTenantStatus(String(body.id), body.status);
                      return res.status(result.ok ? 200 : 400).json(result);
            }

            if (body.action === "support_access_log") {
                      if (!body.id) return res.status(400).json({ ok: false, error: "id обязателен" });
                      const entry = await tenants.logSupportAccess(String(body.id), {
                                  byAdminId: body.byAdminId,
                                  byAdminName: body.byAdminName,
                                  reason: body.reason,
                      });
                      return res.status(200).json({ ok: true, entry });
            }

            return res.status(400).json({ ok: false, error: "unknown action" });
      }

      return res.status(405).json({ ok: false, error: "method not allowed" });
    } catch (err) {
          console.error("superadmin error:", err);
          return res.status(500).json({ ok: false, error: "internal error" });
    }
};
