/** Minimal RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes. */

function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function stringifyCsv(
  header: readonly string[],
  rows: ReadonlyArray<Record<string, string>>,
): string {
  const lines = [header.map(quote).join(',')];
  for (const row of rows) lines.push(header.map((column) => quote(row[column] ?? '')).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** Parses CSV text into records keyed by the header row. A BOM and blank lines are ignored. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  const source = text.replace(/^﻿/, '');
  for (let i = 0; i < source.length; i++) {
    const char = source.charAt(i);
    if (inQuotes) {
      if (char === '"' && source.charAt(i + 1) === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source.charAt(i + 1) === '\n') i++;
      record.push(field);
      field = '';
      records.push(record);
      record = [];
    } else {
      field += char;
    }
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  const [header, ...body] = records.filter((r) => r.some((cell) => cell !== ''));
  if (!header) return [];
  return body.map((cells) =>
    Object.fromEntries(header.map((column, index) => [column, cells[index] ?? ''])),
  );
}
