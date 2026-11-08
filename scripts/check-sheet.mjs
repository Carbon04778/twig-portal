// Read-only check of the Google Sheet connection. Run in the Repl's Shell: node scripts/check-sheet.mjs
// Prints the connection names, whether GOOGLE_SHEET_ID looks right, and what Google answers.
// It never prints tokens or writes to the sheet.
import { ReplitConnectors } from "@replit/connectors-sdk";

const EXPECTED = "1DwD8_oMSwuxp8SdkDaDZhVa9W12JvPIza_pct-uWbf8"; // from Donnell's sheet link
const id = (process.env.GOOGLE_SHEET_ID ?? "").trim();
console.log(`GOOGLE_SHEET_ID: ${id.length} characters, ${id === EXPECTED ? "matches Donnell's sheet link" : `DOES NOT match the sheet link (starts "${id.slice(0, 6)}", ends "${id.slice(-5)}")`}`);

const c = new ReplitConnectors();
try {
  const list = await c.listConnections();
  console.log("Connections:", list.length ? list.map((x) => `${x.connector_name} (${x.status ?? "no status"})`).join(", ") : "none");
} catch (err) {
  console.log("Could not list connections:", err instanceof Error ? err.message : err);
}

const sheet = encodeURIComponent(EXPECTED);
for (const name of ["google-sheet", "google-sheets", "google-drive"]) {
  for (const path of [`/v4/spreadsheets/${sheet}?fields=properties.title`, `/sheets/v4/spreadsheets/${sheet}?fields=properties.title`]) {
    try {
      const res = await c.createProxyFetch(name)(path);
      const body = (await res.text()).replace(/\s+/g, " ").slice(0, 220);
      console.log(`${name} ${path.startsWith("/sheets") ? "/sheets/v4" : "/v4"}: ${res.status} ${body}`);
    } catch (err) {
      console.log(`${name}: request failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
