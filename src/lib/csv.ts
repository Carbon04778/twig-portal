// CSV downloads for the admin panel. A cell a student typed could start with a spreadsheet formula,
// so those get a leading apostrophe. Plain phone numbers like +6581234567 are left as they are.
function cell(value: unknown): string {
  let s = value instanceof Date ? value.toISOString() : String(value ?? "");
  if (/^[=+\-@\t\r]/.test(s) && !/^\+[0-9]+$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
