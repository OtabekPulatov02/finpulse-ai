const test = require("node:test");
const assert = require("node:assert");
const { calc, DEFAULT_RATES } = require("../lib/tax.js");

test("vat_extract: 11 200 000 с НДС → НДС 1 200 000", () => {
  const r = calc("vat_extract", { amount: 11200000 }, DEFAULT_RATES);
  assert.strictEqual(r.vat, 1200000);
  assert.strictEqual(r.net, 10000000);
});
test("vat_add: строка с пробелами", () => {
  const r = calc("vat_add", { amount: "10 000 000" }, DEFAULT_RATES);
  assert.strictEqual(r.total, 11200000);
});
test("payroll: 10 000 000 → на руки 8 800 000, соцналог 1 200 000", () => {
  const r = calc("payroll", { gross: 10000000 }, DEFAULT_RATES);
  assert.strictEqual(r.pit, 1200000);
  assert.strictEqual(r.inps, 10000);
  assert.strictEqual(r.pitToBudget, 1190000);
  assert.strictEqual(r.net, 8800000);
  assert.strictEqual(r.social, 1200000);
  assert.strictEqual(r.employerCost, 11200000);
});
test("payroll budget org → соцналог 25%", () => {
  assert.strictEqual(calc("payroll", { gross: 1000000, budget: true }, DEFAULT_RATES).social, 250000);
});
test("payroll_net: обратный расчёт", () => {
  const r = calc("payroll_net", { net: 8800000 }, DEFAULT_RATES);
  assert.strictEqual(r.gross, 10000000);
});
test("turnover и profit", () => {
  assert.strictEqual(calc("turnover", { revenue: 100000000 }, DEFAULT_RATES).tax, 4000000);
  assert.strictEqual(calc("turnover", { revenue: 100000000, ip: true }, DEFAULT_RATES).tax, 1000000);
  assert.strictEqual(calc("profit", { income: 50000000, expenses: 30000000 }, DEFAULT_RATES).tax, 3000000);
});
test("ошибки ввода", () => {
  assert.strictEqual(calc("vat_add", {}, DEFAULT_RATES).ok, false);
  assert.strictEqual(calc("xxx", {}, DEFAULT_RATES).ok, false);
});
