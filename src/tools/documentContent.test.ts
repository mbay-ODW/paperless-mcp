import assert from "node:assert/strict";
import { test } from "node:test";
import { registerDocumentTools } from "./documents";
import { createDocument, createPaperlessApiMock } from "../test/mocks/paperlessApi";

// 83-page tax return sized OCR text (~130k characters)
const OCR = Array.from(
  { length: 2600 },
  (_, i) => `Zeile ${i}: Einkünfte aus Vermietung und Verpachtung, Anlage V.`
).join("\n");
const TEXT = OCR.slice(0, 100_000) + "\nErstattungsbetrag: 1.234,56 EUR\n" + OCR.slice(100_000);

function setup() {
  const tools: Record<string, (args: any, extra: any) => Promise<any>> = {};
  const server = {
    registerTool: (name: string, _config: unknown, handler: any) => {
      tools[name] = handler;
    },
  };
  const api = createPaperlessApiMock() as any;
  api.getDocument = async (id: number) =>
    ({ ...createDocument({ id, title: "ESt 2025", content: TEXT }), page_count: 83 });
  registerDocumentTools(server as any, api);
  return tools;
}

const parse = (r: any) => JSON.parse(r.content[0].text);

test("get_document_content returns a 15k window by default", async () => {
  const out = parse(await setup().get_document_content({ id: 23 }, {}));
  assert.equal(out.id, 23);
  assert.equal(out.page_count, 83);
  assert.equal(out.text_length, TEXT.length);
  assert.equal(out.content.length, 15000);
  assert.equal(out.truncated, true);
  assert.equal(out.next_offset, 15000);
});

test("get_document_content continues at offset", async () => {
  const out = parse(
    await setup().get_document_content({ id: 23, offset: TEXT.length - 50, max_chars: 1000 }, {})
  );
  assert.equal(out.content, TEXT.slice(-50));
  assert.equal(out.truncated, false);
  assert.equal(out.next_offset, null);
});

test("get_document_content with query returns only passages", async () => {
  const out = parse(await setup().get_document_content({ id: 23, query: "Erstattungsbetrag" }, {}));
  assert.equal(out.total_hits, 1);
  assert.ok(out.hits[0].snippet.includes("1.234,56 EUR"));
  const expected = Math.floor((TEXT.indexOf("Erstattungsbetrag") / TEXT.length) * 83) + 1;
  assert.equal(out.hits[0].approx_page, expected);
  assert.equal(out.content, undefined);
});
