/* Клиентский мини-дашборд (задача #13 из бэклога): остаток/долги из 1С.
   Минимальный самостоятельный OData-клиент (те же BASE/логин/пароль, что
   и в api/1c.js) — не тянем сюда весь api/1c.js, чтобы не плодить лишние
   зависимости между эндпоинтами; логика идентична проверенной в api/1c.js. */
const { fetchWithRetry } = require("./httpRetry.js");

const BASE = process.env.ODATA_1C_BASE || "https://clobus.uz";
const LOGIN = process.env.ODATA_1C_LOGIN || "";
const PASSWORD = process.env.ODATA_1C_PASSWORD || "";

function authHeader() {
  return "Basic " + Buffer.from(`${LOGIN}:${PASSWORD}`).toString("base64");
}

async function odata(appPath, resource, params) {
  const url = `${BASE}${appPath}/odata/standard.odata/${resource}${params ? `?${params}` : ""}`;
  const r = await fetchWithRetry(() => fetch(url, {
    headers: { Authorization: authHeader(), Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  }));
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* xml/html */ }
  return { status: r.status, json, text };
}

function sumField(rows, field) {
  return (rows || []).reduce((s, r) => s + (Number(r[field]) || 0), 0);
}

/* Дебиторка клиента: выставленные счета + реализации по ЕГО ЖЕ организации
   внутри его собственной базы 1С (каждая база в DEFAULT_APPS — это база
   ОДНОГО клиента, поле "Организация" там — сам клиент, а "Контрагент" —
   уже ЕГО покупатели/поставщики). Поэтому фильтруем по Организация_Key,
   а не по конкретному контрагенту — это сумма по всем его клиентам сразу. */
async function getClientReceivables(appPath, orgRef) {
  if (!LOGIN || !PASSWORD) return { ok: false, error: "ODATA_1C_LOGIN/PASSWORD не заданы" };
  const filter = `Организация_Key eq guid'${orgRef}' and Posted eq true`;
  const select = "$select=СуммаДокумента,Date,Number&$top=1000&$format=json";

  const [invRes, realRes] = await Promise.all([
    odata(appPath, "Document_СчетНаОплатуПокупателю", `${select}&$filter=${filter}`),
    odata(appPath, "Document_РеализацияТоваровУслуг", `${select}&$filter=${filter}`),
  ]);

  if (invRes.status === 404 && realRes.status === 404) {
    return { ok: false, error: "Счета/реализации не включены в состав OData этой базы — настройте состав REST-сервиса" };
  }
  if (invRes.status === 401 || realRes.status === 401) return { ok: false, error: "auth: проверьте ODATA_1C_LOGIN/PASSWORD" };

  const invoiced = invRes.status === 200 ? sumField(invRes.json?.value, "СуммаДокумента") : null;
  const shipped = realRes.status === 200 ? sumField(realRes.json?.value, "СуммаДокумента") : null;

  return {
    ok: true,
    invoicedTotal: invoiced,
    shippedTotal: shipped,
    invoicesCount: invRes.json?.value?.length || 0,
    shipmentsCount: realRes.json?.value?.length || 0,
    note: "Сумма выставленных счетов и реализаций по данным 1С (Document_СчетНаОплатуПокупателю + Document_РеализацияТоваровУслуг). Платежи (Document_ПлатежноеПоручение) не вычтены — реквизит привязки контрагента в этом документе не зафиксирован против $metadata как надёжный для автоматического сопоставления, поэтому это не точный «остаток долга», а объём выставленных документов. За точной суммой к оплате обращайтесь к бухгалтеру.",
  };
}

/* ---------- Сальдо и обороты по счетам (оборотно-сальдовая ведомость) ----------
   Раньше обороты считались через AccountingRegister_Хозрасчетный_RecordType с
   $filter=AccountDr/Code eq '...'. На Clobus такой фильтр всегда падает с HTTP 500
   «Операция не разрешена в предложении ГДЕ»: фильтровать по полям счёта в WHERE
   нельзя. Из-за этого ИИ отвечал «нет доступа» на любой вопрос про сальдо.
   Рабочий способ (проверен на живой базе 46516): виртуальная таблица
   BalanceAndTurnovers без $filter — она лёгкая (одна строка на пару
   организация/счёт). Фильтр по организации и счёту делаем уже здесь, в JS.
   Важно: одна база 1С может вести несколько организаций (в базе finpulse их
   около 10), поэтому без фильтра по организации суммы получатся смешанными. */
const ACC_RE = /^[0-9.]{1,20}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ORG_STOP = new Set(["ооо", "ooo", "mchj", "мчж", "xk", "хк", "чп", "ип", "ao", "ао", "masuliyati", "mas`uliyati", "mas'uliyati", "cheklangan", "jamiyati", "общество", "с", "ограниченной", "ответственностью"]);

function normOrgName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[«»"“”'`.,()]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !ORG_STOP.has(w))
    .join(" ");
}

function oneCError(res, what) {
  if (res.status === 401) return "auth: проверьте ODATA_1C_LOGIN/PASSWORD";
  if (res.status === 404) return `${what} не опубликован в OData этой базы — настройте состав REST-сервиса`;
  const msg = res.json && res.json["odata.error"] && res.json["odata.error"].message && res.json["odata.error"].message.value;
  return `1С вернула HTTP ${res.status}${msg ? ": " + String(msg).slice(0, 200) : ""}`;
}

async function getSaldo(appPath, { org, orgRef, account, from, to } = {}) {
  if (!LOGIN || !PASSWORD) return { ok: false, error: "ODATA_1C_LOGIN/PASSWORD не заданы" };
  if (account && !ACC_RE.test(String(account))) return { ok: false, error: "Некорректный код счёта" };
  if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
    return { ok: false, error: "Некорректный формат даты (ожидается YYYY-MM-DD)" };
  }
  const today = new Date().toISOString().slice(0, 10);
  const dTo = to || today;
  const dFrom = from || dTo.slice(0, 4) + "-01-01";
  const vt = `AccountingRegister_Хозрасчетный/BalanceAndTurnovers(StartPeriod=datetime'${dFrom}T00:00:00',EndPeriod=datetime'${dTo}T23:59:59')`;

  const [regRes, accRes, orgRes] = await Promise.all([
    odata(appPath, vt, "$select=Account_Key,Организация_Key,СуммаOpeningBalance,СуммаTurnoverDr,СуммаTurnoverCr,СуммаClosingBalance&$format=json"),
    odata(appPath, "ChartOfAccounts_Хозрасчетный", "$select=Ref_Key,Code,Description&$format=json"),
    odata(appPath, "Catalog_Организации", "$select=Ref_Key,Description,ИНН&$format=json"),
  ]);
  if (regRes.status !== 200) return { ok: false, error: oneCError(regRes, "Регистр бухгалтерии") };
  if (accRes.status !== 200) return { ok: false, error: oneCError(accRes, "План счетов") };
  if (orgRes.status !== 200) return { ok: false, error: oneCError(orgRes, "Справочник организаций") };

  const accounts = {};
  for (const a of accRes.json?.value || []) accounts[a.Ref_Key] = { code: a.Code, name: a.Description };
  const allOrgs = orgRes.json?.value || [];
  const orgNames = {};
  for (const o of allOrgs) orgNames[o.Ref_Key] = o.Description;

  let orgKeys = null; // null = все организации базы
  if (orgRef) {
    orgKeys = new Set([orgRef]);
  } else if (org) {
    const q = String(org).trim();
    const digits = q.replace(/\D/g, "");
    const n = normOrgName(q);
    const matched = allOrgs.filter((o) =>
      (digits.length >= 9 && String(o["ИНН"] || "") === digits) ||
      (n && normOrgName(o.Description).includes(n))
    );
    if (!matched.length) {
      return { ok: false, error: `Организация «${q}» не найдена в этой базе 1С`, availableOrgs: allOrgs.map((o) => o.Description) };
    }
    orgKeys = new Set(matched.map((o) => o.Ref_Key));
  }

  const acc = account ? String(account) : null;
  const agg = new Map();
  for (const r of regRes.json?.value || []) {
    if (orgKeys && !orgKeys.has(r["Организация_Key"])) continue;
    const a = accounts[r.Account_Key] || { code: "?", name: "?" };
    if (acc && !String(a.code).startsWith(acc)) continue;
    const key = r["Организация_Key"] + "|" + r.Account_Key;
    const row = agg.get(key) || {
      org: orgNames[r["Организация_Key"]] || null, account: a.code, accountName: a.name,
      opening: 0, debit: 0, credit: 0, closing: 0,
    };
    row.opening += Number(r["СуммаOpeningBalance"]) || 0;
    row.debit += Number(r["СуммаTurnoverDr"]) || 0;
    row.credit += Number(r["СуммаTurnoverCr"]) || 0;
    row.closing += Number(r["СуммаClosingBalance"]) || 0;
    agg.set(key, row);
  }
  const rows = [...agg.values()]
    .filter((r) => r.opening || r.debit || r.credit || r.closing)
    .sort((x, y) => String(x.org).localeCompare(String(y.org)) || String(x.account).localeCompare(String(y.account)));
  const totals = rows.reduce((t, r) => ({
    opening: t.opening + r.opening, debit: t.debit + r.debit, credit: t.credit + r.credit, closing: t.closing + r.closing,
  }), { opening: 0, debit: 0, credit: 0, closing: 0 });

  return {
    ok: true,
    from: dFrom,
    to: dTo,
    account: acc,
    orgs: orgKeys ? [...orgKeys].map((k) => orgNames[k] || k) : null,
    rows: rows.slice(0, 150),
    truncated: rows.length > 150,
    totals: acc ? totals : undefined,
    note: "Данные регистра бухгалтерии 1С. Положительное сальдо дебетовое, отрицательное кредитовое. Разбивки по контрагентам нет: субконто не публикуется через OData.",
  };
}

/* Остаток денег организации на сегодня: конечное сальдо по счетам 50xx/51xx/52xx
   (касса, расчётные и валютные счета). Раньше считался через тот же сломанный
   фильтр по коду счёта и без фильтра по организации. */
async function getCashEstimate(appPath, orgRef) {
  const r = await getSaldo(appPath, { orgRef });
  if (!r.ok) return r;
  const cashRows = r.rows.filter((x) => /^5[012]/.test(String(x.account)));
  return {
    ok: true,
    estimate: cashRows.reduce((s, x) => s + x.closing, 0),
    accounts: cashRows.map((x) => ({ account: x.account, name: x.accountName, closing: x.closing })),
    note: "Остаток на сегодня по счетам денежных средств (50xx/51xx/52xx) по данным регистра бухгалтерии 1С.",
  };
}

module.exports = { getClientReceivables, getCashEstimate, getSaldo, normOrgName };
