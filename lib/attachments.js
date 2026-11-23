/* ============================================================
   Finpulse — чтение вложений клиента ИИ-бухгалтером.

   Фото счёта / скан / PDF / txt / csv из Telegram → OpenAI (vision и
   file-input) → структурированные данные документа: тип, номер, дата,
   стороны, ИНН, суммы, НДС, позиции. Excel/Word пока не читаем (в
   ответе — пометка «не прочитан»).

   Лимиты: до 4 файлов за раз, до 8 МБ каждый (Bot API отдаёт ≤20 МБ).
   ============================================================ */

const { openaiChat, modelMain } = require("./openai.js");

const MAX_FILES = 4;
const MAX_BYTES = 8 * 1024 * 1024;
const TG = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN || ""}`;
const TG_FILE = () => `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN || ""}`;

const MIME_BY_EXT = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
  pdf: "application/pdf", txt: "text/plain", csv: "text/csv",
};

/* Файл, загруженный из браузера (AI-ассистент в CRM): { kind:"upload", name, mime, data: base64 } */
function fromUpload(file) {
  const mime = String(file.mime || "").toLowerCase();
  const name = String(file.name || "файл").slice(0, 120);
  if (!Object.values(MIME_BY_EXT).includes(mime)) return { name, skip: "формат пока не читается (поддерживаются фото, PDF, txt, csv)" };
  let buf;
  try { buf = Buffer.from(String(file.data || ""), "base64"); } catch (e) { return { name, skip: "файл повреждён" }; }
  if (!buf.length) return { name, skip: "пустой файл" };
  if (buf.length > MAX_BYTES) return { name, skip: "файл больше 8 МБ" };
  return { name, mime, buf };
}

/* Скачать файл Telegram → { name, mime, buf } или { name, skip } */
async function downloadTelegramFile(file) {
  if (file && file.kind === "upload") return fromUpload(file);
  if (!file || !file.file_id) return { skip: "нет file_id" };
  if (["video", "voice", "audio"].includes(file.kind)) return { name: file.kind, skip: "аудио/видео не анализируется" };
  const meta = await fetch(`${TG()}/getFile?file_id=${encodeURIComponent(file.file_id)}`, { signal: AbortSignal.timeout(10000) })
    .then((r) => r.json()).catch(() => null);
  const path = meta && meta.ok && meta.result && meta.result.file_path;
  if (!path) return { name: file.name || file.kind, skip: "Telegram не отдал файл (возможно, больше 20 МБ)" };
  if (meta.result.file_size && meta.result.file_size > MAX_BYTES) return { name: path, skip: "файл больше 8 МБ" };
  const ext = String(path.split(".").pop() || "").toLowerCase();
  const mime = file.kind === "photo" ? "image/jpeg" : (MIME_BY_EXT[ext] || null);
  const name = file.name || path.split("/").pop();
  if (!mime) return { name, skip: `формат .${ext} пока не читается (поддерживаются фото, PDF, txt, csv)` };
  const r = await fetch(`${TG_FILE()}/${path}`, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) return { name, skip: `скачивание не удалось (HTTP ${r.status})` };
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BYTES) return { name, skip: "файл больше 8 МБ" };
  return { name, mime, buf };
}

/* Файл → content part для Chat Completions */
function toContentPart(f) {
  if (f.mime.startsWith("image/")) {
    return { type: "image_url", image_url: { url: `data:${f.mime};base64,${f.buf.toString("base64")}`, detail: "high" } };
  }
  if (f.mime === "application/pdf") {
    return { type: "file", file: { filename: f.name || "document.pdf", file_data: `data:application/pdf;base64,${f.buf.toString("base64")}` } };
  }
  /* текст/csv — прямо текстом */
  return { type: "text", text: `Файл ${f.name}:\n${f.buf.toString("utf8").slice(0, 20000)}` };
}

const EXTRACT_PROMPT = `Ты — бухгалтер (Узбекистан). Тебе прислали документы клиента (фото/сканы/PDF).
Извлеки данные КАЖДОГО документа. Ничего не выдумывай: если поле не видно — null.
Ответ строго JSON:
{"docs":[{
 "file": "имя файла или порядковый номер",
 "docType": "счёт на оплату | счёт-фактура (ЭСФ) | акт | договор | накладная | платёжное поручение | выписка банка | чек | доверенность | паспорт/ID | другое",
 "number": "номер документа или null", "date": "YYYY-MM-DD или null",
 "seller": "поставщик/исполнитель или null", "sellerInn": "ИНН или null",
 "buyer": "покупатель/заказчик или null", "buyerInn": "ИНН или null",
 "currency": "UZS | USD | ...", "total": число или null, "vat": число или null, "vatRate": "12% | без НДС | null",
 "bankAccount": "р/с получателя или null", "mfo": "МФО или null",
 "items": [{"name":"...","qty":число|null,"price":число|null,"amount":число|null}],
 "dueDate": "срок оплаты YYYY-MM-DD или null",
 "summary": "1-2 предложения: что это и что с ним сделать бухгалтеру",
 "issues": ["что не сходится/не читается/подозрительно"]
}]}`;

/**
 * extractAttachments(files, { question, redis, logUsage }) →
 *   { ok, docs:[...], skipped:[{name, reason}], model }
 * files — элементы task.files / extractFile(): {kind, file_id, name?}
 */
async function extractAttachments(files, opts = {}) {
  const list = (Array.isArray(files) ? files : []).slice(0, MAX_FILES);
  const skipped = [];
  const parts = [];
  for (let i = 0; i < list.length; i++) {
    let f;
    try { f = await downloadTelegramFile(list[i]); } catch (e) { f = { name: `файл ${i + 1}`, skip: String(e).slice(0, 120) }; }
    if (f.skip) { skipped.push({ name: f.name || `файл ${i + 1}`, reason: f.skip }); continue; }
    parts.push({ type: "text", text: `— Файл ${i + 1}: ${f.name}` });
    parts.push(toContentPart(f));
  }
  if (!parts.length) return { ok: false, docs: [], skipped, error: "нет файлов, которые можно прочитать" };
  if (opts.question) parts.unshift({ type: "text", text: `Контекст/вопрос: ${String(opts.question).slice(0, 1000)}` });
  const { message, usage, model } = await openaiChat({
    model: opts.model || modelMain(),
    messages: [{ role: "system", content: EXTRACT_PROMPT }, { role: "user", content: parts }],
    maxTokens: 4000, temperature: 0, json: true, timeoutMs: 40000,
  });
  if (opts.redis && opts.logUsage) { void opts.logUsage(opts.redis, usage, model); }
  let parsed = {};
  try { parsed = JSON.parse(message.content || "{}"); } catch (e) { /* noop */ }
  const docs = Array.isArray(parsed.docs) ? parsed.docs.slice(0, 10) : [];
  return { ok: docs.length > 0, docs, skipped, model };
}

/* Короткая текстовая сводка для карточки/промпта */
function docsToText(docs) {
  return (docs || []).map((d, i) => {
    const sum = d.total != null ? `${Number(d.total).toLocaleString("ru-RU")} ${d.currency || "UZS"}` : null;
    return [
      `${i + 1}. ${d.docType || "документ"}${d.number ? " №" + d.number : ""}${d.date ? " от " + d.date : ""}`,
      d.seller ? `поставщик: ${d.seller}${d.sellerInn ? " (ИНН " + d.sellerInn + ")" : ""}` : null,
      d.buyer ? `покупатель: ${d.buyer}${d.buyerInn ? " (ИНН " + d.buyerInn + ")" : ""}` : null,
      sum ? `сумма: ${sum}${d.vat != null ? ", НДС " + Number(d.vat).toLocaleString("ru-RU") : ""}` : null,
      d.dueDate ? `оплатить до ${d.dueDate}` : null,
      Array.isArray(d.issues) && d.issues.length ? `⚠️ ${d.issues.join("; ")}` : null,
    ].filter(Boolean).join(" · ");
  }).join("\n");
}

module.exports = { extractAttachments, docsToText, downloadTelegramFile, toContentPart, MAX_FILES };
