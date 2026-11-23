const test = require("node:test");
const assert = require("node:assert");
const { extractAttachments, docsToText } = require("../lib/attachments.js");

test("фото + PDF + неподдерживаемый xlsx → vision/file parts, xlsx в skipped", async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.TELEGRAM_BOT_TOKEN = "1:t";
  const paths = { a: "photos/a.jpg", b: "documents/b.pdf", c: "documents/c.xlsx" };
  let sent = null;
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    url = String(url);
    if (url.includes("/getFile")) {
      const id = new URL(url).searchParams.get("file_id");
      return { json: async () => ({ ok: true, result: { file_path: paths[id], file_size: 10 } }) };
    }
    if (url.includes("/file/bot")) return { ok: true, arrayBuffer: async () => new TextEncoder().encode("PDFDATA").buffer };
    if (url.includes("openai")) {
      sent = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ model: sent.model, usage: {}, choices: [{ message: { content: JSON.stringify({ docs: [{ docType: "счёт на оплату", number: "58", total: 12400000, currency: "UZS", seller: "ООО СтройСнаб", sellerInn: "301234567" }] }) } }] }) };
    }
    throw new Error("unexpected " + url);
  };
  try {
    const r = await extractAttachments([{ kind: "photo", file_id: "a" }, { kind: "document", file_id: "b" }, { kind: "document", file_id: "c" }], { question: "оплатить" });
    assert.strictEqual(r.ok, true);
    const parts = sent.messages[1].content;
    assert.ok(parts.some((p) => p.type === "image_url" && p.image_url.url.startsWith("data:image/jpeg;base64,")));
    assert.ok(parts.some((p) => p.type === "file" && p.file.file_data.startsWith("data:application/pdf;base64,")));
    assert.strictEqual(r.skipped.length, 1);
    assert.match(r.skipped[0].reason, /xlsx/);
    assert.match(docsToText(r.docs), /№58.*12\s400\s000 UZS/);
  } finally { global.fetch = orig; }
});
test("голосовые и видео пропускаются без запроса к ИИ", async () => {
  const r = await extractAttachments([{ kind: "voice", file_id: "v" }]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.skipped.length, 1);
});

test("файл из браузера (kind: upload) читается без Telegram", async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  let sent = null;
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    if (!String(url).includes("openai")) throw new Error("unexpected " + url);
    sent = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: "m", choices: [{ message: { content: '{"docs":[{"docType":"счёт","number":"7"}]}' } }] }) };
  };
  try {
    const r = await extractAttachments([
      { kind: "upload", name: "a.pdf", mime: "application/pdf", data: Buffer.from("%PDF-1.1").toString("base64") },
      { kind: "upload", name: "b.exe", mime: "application/x-msdownload", data: "AAAA" },
    ]);
    assert.strictEqual(r.ok, true);
    assert.ok(sent.messages[1].content.some((p) => p.type === "file" && p.file.filename === "a.pdf"));
    assert.strictEqual(r.skipped.length, 1);
  } finally { global.fetch = orig; }
});
