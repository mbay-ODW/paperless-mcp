import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MAX_CHARS, findSnippets, windowText } from "./textSlice";

const long = Array.from({ length: 3000 }, (_, i) => `Zeile ${i}: Solarpflicht Neubau Dachfläche.`).join("\n");

test("windowText returns a small default window and where to continue", () => {
  const w = windowText(long);
  assert.equal(DEFAULT_MAX_CHARS, 15000);
  assert.equal(w.content.length, 15000);
  assert.equal(w.truncated, true);
  assert.equal(w.next_offset, 15000);
  assert.equal(w.text_length, long.length);
});

test("reading all windows gives back the full text", () => {
  let out = "";
  let offset: number | null = 0;
  while (offset !== null) {
    const w = windowText(long, offset, 40000);
    out += w.content;
    offset = w.next_offset;
  }
  assert.equal(out, long);
});

test("windowText clamps offsets and sizes", () => {
  assert.equal(windowText("abc", 10).content, "");
  assert.equal(windowText("abc", -5, 2).content, "ab");
  assert.equal(windowText("abc", 0, 10).truncated, false);
  assert.equal(windowText("abc", 0, 10).next_offset, null);
});

test("findSnippets finds words case-insensitively with an approximate page", () => {
  const text = "a".repeat(9000) + " Widerrufsfrist endet am 11.11. " + "b".repeat(1000);
  const { total_hits, hits } = findSnippets(text, "widerrufsfrist", 10);
  assert.equal(total_hits, 1);
  assert.equal(hits[0].approx_page, 9);
  assert.ok(hits[0].snippet.includes("Widerrufsfrist endet am 11.11."));
});

test("findSnippets merges overlapping windows and caps hits", () => {
  const { total_hits, hits } = findSnippets(long, "Solarpflicht");
  assert.equal(total_hits, 3000);
  assert.ok(hits.length <= 20);
  assert.equal(findSnippets("x", "  ").total_hits, 0);
  assert.equal(findSnippets("a (b)", "(b)").total_hits, 1); // regex chars are literal
});
