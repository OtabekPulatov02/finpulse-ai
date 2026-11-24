const test = require("node:test");
const assert = require("node:assert");
process.env.CRM_ALLOWED_ORIGINS = "https://finpulse-crm-app.vercel.app";
delete require.cache[require.resolve("../lib/cors.js")];
const { resolveOrigin, isAllowed } = require("../lib/cors.js");
const r = (o) => resolveOrigin({ headers: { origin: o } });

test("прод-домен разрешён", () => assert.strictEqual(r("https://finpulse-crm-app.vercel.app"), "https://finpulse-crm-app.vercel.app"));
test("превью команды разрешены", () => {
  for (const o of ["https://finpulse-crm-qqh7e3x46-otabek-pulatov-s-projects.vercel.app", "https://finpulse-crm-app-git-feat-enterprise-ui-otabek-pulatov-s-projects.vercel.app"]) assert.strictEqual(r(o), o);
});
test("чужие домены — нет", () => {
  for (const o of ["https://evil.com", "https://finpulse-crm-x-otabek-pulatov-s-projects.vercel.app.evil.com", "http://finpulse-crm-abc-otabek-pulatov-s-projects.vercel.app", "https://finpulse-crm-abc-other-team.vercel.app"]) {
    assert.strictEqual(isAllowed(o), false, o);
    assert.strictEqual(r(o), "https://finpulse-crm-app.vercel.app");
  }
});
