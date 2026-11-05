/**
 * Helpers to return only part of a long document text, so a large OCR text
 * (e.g. an 80-page tax return) does not flood the caller's context.
 */

export const DEFAULT_MAX_CHARS = 15_000;
export const MAX_MAX_CHARS = 200_000;
const SNIPPET_CONTEXT = 300;
const MAX_HITS = 20;

export interface TextWindow {
  text_length: number;
  offset: number;
  truncated: boolean;
  next_offset: number | null;
  content: string;
}

export function windowText(
  text: string,
  offset = 0,
  maxChars = DEFAULT_MAX_CHARS
): TextWindow {
  const total = text.length;
  const start = Math.max(0, Math.min(Math.floor(offset), total));
  const size = Math.max(1, Math.min(Math.floor(maxChars), MAX_MAX_CHARS));
  const end = Math.min(total, start + size);
  return {
    text_length: total,
    offset: start,
    truncated: end < total,
    next_offset: end < total ? end : null,
    content: text.slice(start, end),
  };
}

export interface Hit {
  offset: number;
  /** Rough page estimate (position × page count); Paperless text has no page breaks. */
  approx_page: number | null;
  snippet: string;
}

/** Case-insensitive search for any of the words; overlapping windows are merged. */
export function findSnippets(
  text: string,
  query: string,
  pageCount?: number | null
): { total_hits: number; hits: Hit[] } {
  const terms = query.split(/\s+/).filter(Boolean);
  if (!terms.length) return { total_hits: 0, hits: [] };
  const re = new RegExp(
    terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "gi"
  );
  const pageOf = (pos: number) =>
    pageCount && text.length
      ? Math.min(pageCount, Math.floor((pos / text.length) * pageCount) + 1)
      : null;

  const hits: Hit[] = [];
  let total = 0;
  let lastEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    total += 1;
    if (m[0].length === 0) re.lastIndex += 1;
    if (hits.length >= MAX_HITS) continue;
    const start = Math.max(0, m.index - SNIPPET_CONTEXT);
    const end = Math.min(text.length, m.index + m[0].length + SNIPPET_CONTEXT);
    if (hits.length && start <= lastEnd) {
      const h = hits[hits.length - 1];
      h.snippet = text.slice(h.offset, end);
    } else {
      hits.push({ offset: start, approx_page: pageOf(m.index), snippet: text.slice(start, end) });
    }
    lastEnd = end;
  }
  return { total_hits: total, hits };
}
