/**
 * Just enough MediaWiki wikitext to read the street lists, with no dependencies: templates with
 * their arguments, `{| … |}` tables with the headings above them, and `#`/`*` list lines, each
 * cell turned into plain text.
 *
 * The pages are community-written, so nothing here assumes they are tidy. A table with a cell
 * attribute, a row that is one line, a row spread over five, a `||` inside a link: all turn up.
 */

/** Removes comments, `<ref>` notes and layout tags; what is left is the text a reader sees, with the markup of links kept. */
export function stripNotes(text) {
  return String(text ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref\b[^>]*\/>/gi, '')
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?(small|big|span|div|sup|sub|nowiki|center|u|s|del|ins|b|i|font|p|references)\b[^>]*>/gi, '');
}

/** `{{…}}` removed, innermost first, so a template inside a template goes too. */
function dropTemplates(text) {
  let previous;
  let out = text;
  do {
    previous = out;
    out = out.replace(/\{\{[^{}]*\}\}/g, '');
  } while (out !== previous);
  return out;
}

/** A cell of wikitext as plain text: links show their label, bold and italics go, templates go. */
export function plain(text) {
  let out = stripNotes(text);
  out = dropTemplates(out);
  out = out
    .replace(/\[\[(?:Файл|File|Image|Категорія|Category):[^\]]*\]\]/gi, '')
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[(?:https?:)?\/\/\S+\s+([^\]]*)\]/g, '$1')
    .replace(/\[(?:https?:)?\/\/\S+\]/g, '')
    .replace(/'{2,}/g, '')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/<[^>]+>/g, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

/** Splits at `sep`, but not inside `[[ ]]`, `{{ }}`, `<ref>…</ref>` or (when asked) parentheses. */
export function splitTop(text, sep, { parens = false } = {}) {
  const parts = [];
  let depthLink = 0, depthTpl = 0, depthParen = 0, last = 0;
  for (let i = 0; i < text.length; i++) {
    const two = text.substr(i, 2);
    if (two === '[[') { depthLink++; i++; continue; }
    if (two === ']]') { depthLink = Math.max(0, depthLink - 1); i++; continue; }
    if (two === '{{') { depthTpl++; i++; continue; }
    if (two === '}}') { depthTpl = Math.max(0, depthTpl - 1); i++; continue; }
    if (text.startsWith('<ref', i)) {
      const close = text.indexOf('</ref>', i);
      const selfClose = text.indexOf('/>', i);
      const end = text.indexOf('>', i);
      if (selfClose === end - 1 && selfClose !== -1 && (close === -1 || selfClose < close)) { i = end; continue; }
      if (close !== -1) { i = close + 5; continue; }
    }
    const ch = text[i];
    if (parens) {
      if (ch === '(') depthParen++;
      else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
    }
    if (depthLink || depthTpl || depthParen) continue;
    if (text.startsWith(sep, i)) {
      parts.push(text.slice(last, i));
      last = i + sep.length;
      i += sep.length - 1;
    }
  }
  parts.push(text.slice(last));
  return parts;
}

/** Every `{{name|…}}` in the text (name compared case-insensitively), with its top-level arguments. */
export function findTemplates(text, name) {
  const wanted = name.toLowerCase();
  const found = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf('{{', from);
    if (start === -1) break;
    // Find the matching close.
    let depth = 0, end = -1;
    for (let i = start; i < text.length - 1; i++) {
      const two = text.substr(i, 2);
      if (two === '{{') { depth++; i++; }
      else if (two === '}}') { depth--; i++; if (depth === 0) { end = i + 1; break; } }
    }
    if (end === -1) break;
    const inner = text.slice(start + 2, end - 2);
    const args = splitTop(inner, '|');
    if (args[0].trim().toLowerCase() === wanted) found.push({ start, end, args: args.slice(1) });
    from = start + 2;
  }
  return found;
}

/**
 * Tables and the headings above them.
 * Returns `[{ headings: ['== A ==', …], header: [cell…], rows: [[cell…]…] }]` with raw cell
 * text (use `plain` to read it). A header is the first row made of `!` cells.
 */
export function parseTables(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const tables = [];
  const headingStack = [];
  let table = null, row = null, inCell = false;

  const closeRow = () => {
    if (table && row && row.length) table.rows.push(row);
    row = null;
  };
  const addCells = (line, header) => {
    // `|a || b || c` or `!a !! b`; each may start with attributes ending in a lone `|`.
    const body = line.slice(1);
    const sep = header ? /!!|\|\|/ : /\|\|/;
    const parts = splitTop(body, header ? '!!' : '||').flatMap((p) => (header ? splitTop(p, '||') : [p]));
    void sep;
    for (let part of parts) {
      part = stripCellAttributes(part);
      row ??= [];
      row.push(part);
      if (header) row.isHeader = true;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine;
    const trimmed = line.trim();
    const heading = trimmed.match(/^(={2,6})\s*(.*?)\s*\1\s*$/);
    if (heading && !table) {
      const level = heading[1].length;
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) headingStack.pop();
      headingStack.push({ level, text: heading[2] });
      continue;
    }
    if (trimmed.startsWith('{|')) {
      table = { headings: headingStack.map((h) => h.text), header: null, rows: [], attrs: trimmed.slice(2) };
      row = null;
      inCell = false;
      continue;
    }
    if (!table) continue;
    if (trimmed.startsWith('|}')) {
      closeRow();
      tables.push(table);
      table = null;
      continue;
    }
    if (trimmed.startsWith('|-')) {
      closeRow();
      inCell = false;
      continue;
    }
    if (trimmed.startsWith('|+')) continue;
    if (trimmed.startsWith('!')) {
      row ??= [];
      addCells(trimmed, true);
      inCell = true;
      continue;
    }
    if (trimmed.startsWith('|')) {
      row ??= [];
      addCells(trimmed, false);
      inCell = true;
      continue;
    }
    // A continuation line of the previous cell.
    if (inCell && row && row.length) row[row.length - 1] += `\n${line}`;
  }
  // Header rows: the first row made of `!` cells is the table's header.
  for (const t of tables) {
    const idx = t.rows.findIndex((r) => r.isHeader);
    if (idx !== -1) {
      t.headerRaw = t.rows[idx];
      t.header = t.rows[idx].map((c) => plain(c));
      t.rows = t.rows.filter((_, i) => i !== idx).filter((r) => !r.isHeader);
    }
  }
  return tables;
}

/** `style="x" | text` → `text`; a `|` inside a link is not an attribute separator. */
function stripCellAttributes(cell) {
  const idx = cell.indexOf('|');
  if (idx === -1) return cell;
  const before = cell.slice(0, idx);
  if (/\[\[|\{\{/.test(before)) return cell;
  if (/^\s*(\w+\s*=\s*("[^"]*"|'[^']*'|[^\s|]+)\s*)+$/.test(before)) return cell.slice(idx + 1);
  return cell;
}

/** `#` and `*` list lines with the heading above each: `[{ headings, text }]`. */
export function parseListLines(text) {
  const out = [];
  const headingStack = [];
  let inTable = false;
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{|')) inTable = true;
    if (inTable) { if (trimmed.startsWith('|}')) inTable = false; continue; }
    const heading = trimmed.match(/^(={2,6})\s*(.*?)\s*\1\s*$/);
    if (heading) {
      const level = heading[1].length;
      while (headingStack.length && headingStack[headingStack.length - 1].level >= level) headingStack.pop();
      headingStack.push({ level, text: heading[2] });
      continue;
    }
    const item = trimmed.match(/^[#*]+\s*(.*)$/);
    if (item) out.push({ headings: headingStack.map((h) => h.text), text: item[1] });
  }
  return out;
}

/** The revision a page was fetched at: `{ title, revid, timestamp, text }` for each page of an API answer. */
export function pagesOf(apiJson) {
  return (apiJson.query?.pages ?? []).map((p) => ({
    title: p.title,
    pageid: p.pageid,
    revid: p.revisions?.[0]?.revid,
    timestamp: p.revisions?.[0]?.timestamp,
    text: p.revisions?.[0]?.slots?.main?.content ?? ''
  }));
}
