// A small CSV reader for the reporting line import: commas, double quotes
// with "" as an escaped quote, CRLF or LF line ends. Returns one array of
// cells per line, with the 1-based line number it started on.
export function parseCsv(text: string): { line: number; cells: string[] }[] {
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowStart = 1;
  const src = text.replace(/^﻿/, '');

  const endRow = () => {
    cells.push(cell);
    if (cells.some((c) => c.trim() !== '')) rows.push({ line: rowStart, cells });
    cells = [];
    cell = '';
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        if (c === '\n') line++;
        cell += c;
      }
      continue;
    }
    if (c === '"' && cell === '') quoted = true;
    else if (c === ',') {
      cells.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      endRow();
      line++;
      rowStart = line;
    } else cell += c;
  }
  if (cell !== '' || cells.length) endRow();
  return rows;
}
