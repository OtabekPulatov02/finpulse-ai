/* ============================================================
   Короткие сообщения бота в группу бухгалтеров (24.11.2026).
   Раньше карточка, разбор ИИ и вопрос ИИ шли тремя «простынями»
   с повторами (категория дважды, «исполнитель и статус — в CRM»,
   длинные советы). Теперь — заголовок + строки «Поле: значение»,
   эмодзи только в заголовке, совет ИИ — одна фраза.
   ============================================================ */

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const STATUS = { new: "⚪️ Новая", in_progress: "🔵 В работе", done: "✅ Выполнена", cancelled: "🚫 Отменена" };

/* 2026-11-26 → 26.11 (год — только если не текущий) */
function shortDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  return m[1] === String(new Date().getFullYear()) ? `${m[3]}.${m[2]}` : `${m[3]}.${m[2]}.${m[1]}`;
}

/* первая фраза, не длиннее max */
function firstSentence(s, max = 180) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  const one = m ? m[1] : t;
  return one.length > max ? one.slice(0, max - 1).trimEnd() + "…" : one;
}

const row = (label, value) => (value == null || value === "" ? null : `<b>${label}:</b> ${value}`);

/**
 * Карточка задачи. bodyHtml — уже экранированный текст заявки (для длинных
 * текстов вызывающий код режет его сам).
 */
function taskCard({ num, status = "new", company, category, sub, assignee, files = 0, bodyHtml, deferredFrom, createdBy, replyHint = true }) {
  const lines = [
    `🆕 <b>Задача №${num}</b> · ${STATUS[status] || escapeHtml(status)}`,
    row("Клиент", escapeHtml(company || "—")),
    row("Тип", category ? escapeHtml(category) + (sub ? " · " + escapeHtml(sub) : "") : null),
    status !== "new" ? row("Исполнитель", assignee ? escapeHtml(assignee) : null) : null,
    files ? row("Файлы", String(files)) : null,
    deferredFrom != null ? row("Приём", `с ${deferredFrom}:00 — пришла вне часов`) : null,
    createdBy ? row("Завёл", escapeHtml(createdBy) + " (CRM)") : null,
    "━━━━━━━━━━━━",
    bodyHtml,
  ].filter(Boolean);
  if (replyHint && status !== "done" && status !== "cancelled") lines.push("<i>↩️ Реплай сюда — ответ уйдёт клиенту</i>");
  return lines.join("\n");
}

const COMPLEXITY = { simple: "простая", medium: "средняя", complex: "сложная" };

/** Разбор ИИ по новой заявке — ответом на карточку. */
function aiIntakeNote({ num, priority, complexity, dueDate, assignee, operation1c, attText, relevant = true, missing = [], draft, hint }) {
  const lines = [
    `🤖 <b>Разбор ИИ · №${num}</b>`,
    row("Приоритет", `${escapeHtml(priority || "средний")} · <b>сложность:</b> ${COMPLEXITY[complexity] || "средняя"}`),
    row("Срок", dueDate ? shortDate(dueDate) : null),
    row("Исполнитель", assignee ? escapeHtml(assignee) : null),
    row("1С", operation1c ? escapeHtml(operation1c) : null),
    row("Не хватает", missing && missing.length ? escapeHtml(missing.slice(0, 4).join("; ")) : null),
    row("Из файлов", attText ? escapeHtml(firstSentence(attText, 220)) : null),
    !relevant ? "⚠️ Похоже, не бухгалтерский вопрос — уточните у клиента" : null,
    draft ? "📝 Черновик операции готов — проверьте в CRM" : null,
    hint ? `💡 ${escapeHtml(firstSentence(hint))}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

/** Блок вопроса ИИ (добавляется к разбору или отдельным сообщением). */
function aiQuestionBlock(questionText, hasButtons) {
  return `❓ <b>Вопрос:</b> ${escapeHtml(firstSentence(questionText, 300))}\n` +
    `<i>${hasButtons ? "Кнопка ниже или ответ реплаем" : "Ответьте реплаем"} — продолжу задачу</i>`;
}

/** Строка дайджеста напоминаний: «• №164 Название — Компания · до 11.11 · Исполнитель» */
function reminderLine(t) {
  const title = String(t.text || "").replace(/\s+/g, " ").trim();
  const short = title.length > 60 ? title.slice(0, 59).trimEnd() + "…" : title;
  const parts = [t.company ? escapeHtml(t.company) : null, `до ${shortDate(t.dueDate)}`, t.assignee ? escapeHtml(t.assignee) : "без исполнителя"].filter(Boolean);
  return `• <b>№${t.num}</b> ${escapeHtml(short || "без описания")}\n   ${parts.join(" · ")}`;
}

function remindersDigest({ today, overdue = [], dueToday = [] }) {
  const out = [`⏰ <b>Сроки на ${shortDate(today)}</b>`];
  if (overdue.length) out.push(`\n🔴 <b>Просрочено: ${overdue.length}</b>\n` + overdue.slice(0, 15).map(reminderLine).join("\n") + (overdue.length > 15 ? `\n…и ещё ${overdue.length - 15}` : ""));
  if (dueToday.length) out.push(`\n🟡 <b>Сегодня: ${dueToday.length}</b>\n` + dueToday.slice(0, 15).map(reminderLine).join("\n") + (dueToday.length > 15 ? `\n…и ещё ${dueToday.length - 15}` : ""));
  return out.join("\n");
}

module.exports = { escapeHtml, shortDate, firstSentence, taskCard, aiIntakeNote, aiQuestionBlock, reminderLine, remindersDigest, STATUS };
