/**
 * HTML as data, with no dependencies: the text a reader sees, and tables as rows of cell text.
 * The pages are untrusted downloads and are only ever read, never executed or followed.
 */
const ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", laquo: '«', raquo: '»', ndash: '–', mdash: '—',
  hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', shy: '', zwnj: '', zwj: ''
};

export function decodeEntities(text) {
  return String(text).replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Removes scripts, styles and comments. */
export function stripScripts(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|head)\b[\s\S]*?<\/\1>/gi, '');
}

/** A fragment as one line of plain text. */
export function cellText(fragment) {
  return decodeEntities(String(fragment).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/[\s ]+/g, ' ').trim();
}

/** The page as lines of text: every block tag starts a new line. */
export function htmlToLines(html) {
  const text = stripScripts(html)
    .replace(/<\/?(p|div|li|ul|ol|tr|td|th|table|h[1-6]|br|section|article|header|footer|blockquote|pre)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text).split('\n').map((l) => l.replace(/[\s ]+/g, ' ').trim()).filter(Boolean);
}

/** Every `<table>` as rows of cell text (nested tables are flattened into their own rows). */
export function htmlTables(html) {
  const clean = stripScripts(html);
  const tables = [];
  for (const t of clean.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const rows = [];
    for (const r of t[0].matchAll(/<tr\b[\s\S]*?(?=<tr\b|<\/table>|<\/tr>)/gi)) {
      const cells = [...r[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)(?=<t[dh]\b|<\/tr>|<\/table>|$)/gi)].map((c) => cellText(c[1].replace(/<\/t[dh]>/gi, '')));
      if (cells.length) rows.push(cells);
    }
    tables.push(rows);
  }
  return tables;
}

/** The `<title>` text. */
export function htmlTitle(html) {
  const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? cellText(m[1]) : '';
}
