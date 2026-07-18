/**
 * Markdown → Telegram MarkdownV2 rendering.
 *
 * Bot API 10.2 `sendRichMessage` renders real headings/tables/collapsibles, but
 * only new Telegram clients draw it — older ones show the raw markdown. So we
 * target classic MarkdownV2, which every client has rendered for years, via
 * `telegramify-markdown` (handles the fiddly escaping that otherwise leaks
 * backslashes). Its one gap is GFM tables: it escapes the pipes as plain text,
 * and a proportional font then destroys column alignment. We pre-render tables
 * to aligned ASCII inside a fenced code block (monospace) so columns line up on
 * every client, then hand the rest to the library.
 */

import telegramify from 'telegramify-markdown'

const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isSep = (l: string) => /^\s*\|[\s:|-]+\|\s*$/.test(l);

/** Split a GFM table row into trimmed cells, dropping the outer empties. */
function cells(row: string): string[] {
  return row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

/** Render a GFM table (header + separator + body rows) as aligned monospace ASCII. */
function renderTable(header: string, body: string[]): string {
  const rows = [cells(header), ...body.map(cells)];
  const cols = Math.max(...rows.map((r) => r.length));
  const width = Array.from({ length: cols }, (_, c) =>
    Math.max(...rows.map((r) => (r[c] ?? '').length))
  );
  const line = (r: string[]) =>
    r.map((cell, c) => (cell ?? '').padEnd(width[c])).join('  ').replace(/\s+$/, '');
  const [head, ...rest] = rows;
  const rule = width.map((w) => '─'.repeat(w)).join('  ');
  return [line(head), rule, ...rest.map(line)].join('\n');
}

/** Replace GFM tables with fenced ASCII blocks; leave everything else untouched. */
export function fenceTables(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (isRow(lines[i]) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const header = lines[i];
      i += 2; // skip header + separator
      const body: string[] = [];
      while (i < lines.length && isRow(lines[i])) body.push(lines[i++]);
      out.push('```', renderTable(header, body), '```');
    } else {
      out.push(lines[i++]);
    }
  }
  return out.join('\n');
}

/** Convert arbitrary GFM markdown to Telegram-ready MarkdownV2. */
export function toMarkdownV2(md: string): string {
  return telegramify(fenceTables(md), 'escape');
}
