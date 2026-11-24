/* Разрешённые Origin для браузерных запросов к API.
   CRM_ALLOWED_ORIGINS — точный список через запятую (прод-домены).
   Плюс превью-деплои фронта этой же Vercel-команды: их адреса меняются
   на каждый пуш (finpulse-crm-<hash>-otabek-pulatov-s-projects.vercel.app,
   finpulse-crm-app-git-<ветка>-…), поэтому — по шаблону. Суффикс команды
   в *.vercel.app выдаётся только её проектам, чужой сайт его не получит.
   Шаблон можно переопределить CRM_ALLOWED_ORIGIN_PATTERN (пусто = выкл.). */
const LIST = (process.env.CRM_ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const DEFAULT_PATTERN = "^https://finpulse-crm(-app)?-[a-z0-9-]+-otabek-pulatov-s-projects\\.vercel\\.app$";
const RAW = process.env.CRM_ALLOWED_ORIGIN_PATTERN;
const PATTERN = RAW === "" ? null : new RegExp(RAW || DEFAULT_PATTERN);

function isAllowed(origin) {
  if (!origin) return false;
  return LIST.includes(origin) || (!!PATTERN && PATTERN.test(origin));
}

function resolveOrigin(req) {
  const origin = (req.headers && req.headers.origin) || "";
  if (!LIST.length) return origin || "*"; // список не настроен — не ломаем текущую работу
  return isAllowed(origin) ? origin : LIST[0];
}

module.exports = { resolveOrigin, isAllowed, ALLOWED_ORIGINS: LIST };
