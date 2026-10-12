/**
 * Tab-separated tables with a header row: the form every committed source and manual table takes,
 * so a refresh shows as a reviewable git diff. A cell never holds a tab or a line break (they become
 * a space), an empty cell is the empty string, and a line that starts with `#` is a comment.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const cell = (value) => String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();

export function parseTsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length && !l.startsWith('#'));
  if (!lines.length) return [];
  const header = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
  });
}

export async function readTsv(path) {
  return parseTsv(await readFile(path, 'utf8'));
}

/** `rows` are objects; `columns` fixes the order. Rows are written in the order given. */
export function formatTsv(columns, rows, comment = '') {
  const head = comment ? comment.split('\n').map((l) => `# ${l}`).join('\n') + '\n' : '';
  return head + [columns.join('\t'), ...rows.map((r) => columns.map((c) => cell(r[c])).join('\t'))].join('\n') + '\n';
}

export async function writeTsv(path, columns, rows, comment = '') {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, formatTsv(columns, rows, comment), 'utf8');
}

/** Orders rows by the given columns (string compare, then as given), so a rewrite is stable. */
export function sortRows(rows, columns) {
  return [...rows].sort((a, b) => {
    for (const c of columns) {
      const x = String(a[c] ?? ''), y = String(b[c] ?? '');
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  });
}
