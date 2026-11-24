const test = require("node:test");
const assert = require("node:assert");
const f = require("../lib/groupFormat.js");
const Y = String(new Date().getFullYear());

test("карточка: поля в строку, без «исполнитель и статус — в CRM»", () => {
  const html = f.taskCard({ num: 167, status: "in_progress", company: "Phoenix Systems", category: "Другое", assignee: "AI-бухгалтер", files: 1, bodyHtml: "Тетя изучи ИИ бухгалтера" });
  assert.match(html, /<b>Клиент:<\/b> Phoenix Systems/);
  assert.match(html, /<b>Исполнитель:<\/b> AI-бухгалтер/);
  assert.match(html, /<b>Файлы:<\/b> 1/);
  assert.doesNotMatch(html, /в CRM/);
  assert.ok(html.split("\n").length <= 9, html);
});
test("карточка новой задачи — без строки исполнителя", () => {
  assert.doesNotMatch(f.taskCard({ num: 1, status: "new", company: "A", assignee: "X", bodyHtml: "t" }), /Исполнитель/);
});
test("разбор ИИ: короткий, совет — одна фраза, дата dd.mm", () => {
  const html = f.aiIntakeNote({ num: 167, priority: "низкий", complexity: "medium", dueDate: `${Y}-11-26`, assignee: "Yulduz Ibragimova",
    missing: ["Какой ИИ-бухгалтер имеется в виду", "Что нужно изучить"], hint: "Уточните у клиента цель. Потом проверьте второй пункт. И третий." });
  assert.match(html, /<b>Срок:<\/b> 26\.11/);
  assert.match(html, /💡 Уточните у клиента цель\.$/m);
  assert.doesNotMatch(html, /наименее загружен|взята в работу/);
  assert.ok(html.split("\n").length <= 7, html);
});
test("напоминания: с названием задачи, без пустого «№164 · »", () => {
  const html = f.remindersDigest({ today: `${Y}-11-24`, overdue: [{ num: 164, text: "Сдать НДС", dueDate: `${Y}-11-11` }, { num: 165, company: "Phoenix", text: "", dueDate: `${Y}-11-19`, assignee: "Юлдуз" }] });
  assert.match(html, /Сроки на 24\.11/);
  assert.match(html, /№164<\/b> Сдать НДС/);
  assert.match(html, /до 11\.11 · без исполнителя/);
  assert.match(html, /№165<\/b> без описания\n   Phoenix · до 19\.11 · Юлдуз/);
});
test("экранирование HTML", () => {
  assert.match(f.taskCard({ num: 1, company: "<b>x</b>", bodyHtml: "" }), /&lt;b&gt;x&lt;\/b&gt;/);
});
