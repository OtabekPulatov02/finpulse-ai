/* ============================================================
   Finpulse — налоговые калькуляторы (Республика Узбекистан).

   Считает код, а не модель: ИИ вызывает tax_calc и получает точные
   цифры. Ставки по умолчанию — общие ставки 2026 г. по открытым
   источникам; их можно переопределить в Redis (ключ tax:rates,
   действие crm_post не нужно — агент читает через tax_calc{kind:"rates"}).
   Льготы, отраслевые ставки и спецрежимы — всегда на проверку бухгалтеру.
   ============================================================ */

const DEFAULT_RATES = {
  vat: 12,              // НДС
  profit: 15,           // налог на прибыль, общий
  pit: 12,              // НДФЛ (включает 0.1% ИНПС, удерживаемый из НДФЛ)
  inps: 0.1,            // накопительная пенсия — часть НДФЛ, не сверху
  social: 12,           // социальный налог, работодатель
  socialBudget: 25,     // социальный налог, бюджетные организации
  turnover: 4,          // налог с оборота, юрлица (общая ставка)
  turnoverIp: 1,        // налог с оборота, ИП
  dividend: 5,          // дивиденды резидентам (проверить по договору/статусу)
  updated: "2026 (по открытым источникам; проверяйте льготы и отраслевые ставки)",
};

async function getRates(redis) {
  let custom = null;
  try { custom = redis ? await redis.get("tax:rates") : null; } catch (e) { /* noop */ }
  return { ...DEFAULT_RATES, ...(custom && typeof custom === "object" ? custom : {}) };
}

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const num = (v) => {
  if (v == null || String(v).trim() === "") return NaN;
  const n = Number(String(v == null ? "" : v).replace(/[\s ]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
};

/**
 * calc(kind, args, rates) — чистая функция, без I/O.
 * kind:
 *  vat_extract  {amount}            — выделить НДС из суммы С НДС
 *  vat_add      {amount}            — начислить НДС сверху
 *  payroll      {gross, budget?}    — зарплата: НДФЛ, ИНПС, на руки, соцналог, затраты работодателя
 *  payroll_net  {net, budget?}      — обратный расчёт: сколько начислить, чтобы на руки было net
 *  turnover     {revenue, ip?}      — налог с оборота
 *  profit       {income, expenses}  — налог на прибыль
 *  dividend     {amount}            — налог у источника на дивиденды
 */
function calc(kind, args, rates) {
  const R = rates || DEFAULT_RATES;
  const a = args || {};
  switch (kind) {
    case "vat_extract": {
      const total = num(a.amount);
      if (!Number.isFinite(total)) return { ok: false, error: "нужна amount" };
      const vat = r2(total * R.vat / (100 + R.vat));
      return { ok: true, rate: R.vat, total, vat, net: r2(total - vat) };
    }
    case "vat_add": {
      const net = num(a.amount);
      if (!Number.isFinite(net)) return { ok: false, error: "нужна amount" };
      const vat = r2(net * R.vat / 100);
      return { ok: true, rate: R.vat, net, vat, total: r2(net + vat) };
    }
    case "payroll": {
      const gross = num(a.gross);
      if (!Number.isFinite(gross)) return { ok: false, error: "нужна gross (начисленная зарплата)" };
      const pitTotal = r2(gross * R.pit / 100);
      const inps = r2(gross * R.inps / 100);
      const socialRate = a.budget ? R.socialBudget : R.social;
      const social = r2(gross * socialRate / 100);
      return {
        ok: true, gross,
        pit: pitTotal, pitToBudget: r2(pitTotal - inps), inps,
        net: r2(gross - pitTotal),
        social, socialRate,
        employerCost: r2(gross + social),
        note: "ИНПС удерживается в составе НДФЛ (не сверху). Льготы/вычеты не учтены.",
      };
    }
    case "payroll_net": {
      const net = num(a.net);
      if (!Number.isFinite(net)) return { ok: false, error: "нужна net (на руки)" };
      const gross = r2(net / (1 - R.pit / 100));
      return { ...calc("payroll", { gross, budget: a.budget }, R), requestedNet: net };
    }
    case "turnover": {
      const revenue = num(a.revenue);
      if (!Number.isFinite(revenue)) return { ok: false, error: "нужна revenue" };
      const rate = a.ip ? R.turnoverIp : (num(a.rate) > 0 ? num(a.rate) : R.turnover);
      return { ok: true, revenue, rate, tax: r2(revenue * rate / 100), note: "Отраслевые и льготные ставки уточните у бухгалтера." };
    }
    case "profit": {
      const income = num(a.income), expenses = num(a.expenses || 0);
      if (!Number.isFinite(income)) return { ok: false, error: "нужен income" };
      const base = Math.max(0, r2(income - (Number.isFinite(expenses) ? expenses : 0)));
      const rate = num(a.rate) > 0 ? num(a.rate) : R.profit;
      return { ok: true, income, expenses, base, rate, tax: r2(base * rate / 100) };
    }
    case "dividend": {
      const amount = num(a.amount);
      if (!Number.isFinite(amount)) return { ok: false, error: "нужна amount" };
      const rate = num(a.rate) > 0 ? num(a.rate) : R.dividend;
      return { ok: true, amount, rate, tax: r2(amount * rate / 100), net: r2(amount - amount * rate / 100) };
    }
    case "rates":
      return { ok: true, rates: R };
    default:
      return { ok: false, error: "неизвестный kind; есть: vat_extract, vat_add, payroll, payroll_net, turnover, profit, dividend, rates" };
  }
}

module.exports = { DEFAULT_RATES, getRates, calc };
