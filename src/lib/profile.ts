// The required form after sign-up, and copying its answers to Donnell's Google Sheet.
// The database is the record: a sheet problem never stops a student getting in, and any row that
// didn't reach the sheet is sent with the next sign-up or from Admin -> Sign-ups.
import { asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { studentProfiles, users } from "../db/schema.js";

export const LEVELS = ["JC1", "JC2"] as const;
export const HEARD_FROM = [
  "Current student", "Google", "Instagram", "Facebook", "Friend / Family", "School", "Walk-in", "TTA/Macro", "Other",
] as const;
export const CONSENT_TEXT = 'By clicking "Submit", you acknowledge and agree that your contact and student details will be collected and processed solely for registration, academic follow-ups, and class coordination in compliance with the Singapore Personal Data Protection Act (PDPA).';

export const profileBody = z.object({
  full_name: z.string().trim().min(2, "Please enter your name.").max(100),
  school: z.string().trim().min(2, "Please enter your school.").max(100),
  level: z.enum(LEVELS, "Please choose your level."),
  mobile: z.string().trim().max(24).transform((v) => v.replace(/[\s()-]/g, ""))
    .refine((v) => /^\+?[0-9]{8,15}$/.test(v), "Please enter a valid mobile number."),
  heard_from: z.enum(HEARD_FROM, "Please tell us where you heard about us."),
});

export async function getProfile(db: Db, userId: number) {
  const [row] = await db.select().from(studentProfiles).where(eq(studentProfiles.userId, userId));
  return row ?? null;
}

// First answer stands: submitting twice can't overwrite it or send a second row to the sheet.
export async function saveProfile(db: Db, userId: number, body: z.infer<typeof profileBody>) {
  await db.insert(studentProfiles).values({
    userId, fullName: body.full_name, school: body.school, level: body.level, mobile: body.mobile,
    heardFrom: body.heard_from, consentText: CONSENT_TEXT,
  }).onConflictDoNothing();
  return (await getProfile(db, userId))!;
}

// ---- Google Sheet ------------------------------------------------------------------------
export type SheetTransport = (path: string, init: RequestInit) => Promise<Response>;

const replitTransport: SheetTransport = async (path, init) => {
  const { ReplitConnectors } = await import("@replit/connectors-sdk");
  return new ReplitConnectors().createProxyFetch("google-sheet")(path, init);
};
let transport: SheetTransport = replitTransport;
export const setSheetTransport = (t: SheetTransport) => { transport = t; };

export const SHEET_HEADERS = ["Signed up (SGT)", "Name", "Email", "Mobile", "School", "Level", "Heard about us", "Consent given (SGT)", "User ID"];
export const sgt = (d: Date) => d.toLocaleString("sv-SE", { timeZone: "Asia/Singapore" });

export type SheetResult = { status: "sent" | "nothing_to_send" | "not_configured" | "failed"; sent: number; message?: string };

async function sendUnsynced(db: Db): Promise<SheetResult> {
  const rows = await db.select({ p: studentProfiles, email: users.email }).from(studentProfiles)
    .innerJoin(users, eq(users.id, studentProfiles.userId))
    .where(isNull(studentProfiles.sheetSyncedAt)).orderBy(asc(studentProfiles.createdAt)).limit(200);
  if (!rows.length) return { status: "nothing_to_send", sent: 0 };
  const sheetId = process.env.GOOGLE_SHEET_ID?.trim();
  if (!sheetId) return { status: "not_configured", sent: 0, message: "GOOGLE_SHEET_ID is not set." };

  const ids = rows.map((r) => r.p.userId);
  try {
    const tab = process.env.GOOGLE_SHEET_TAB?.trim();
    const range = (a1: string) => encodeURIComponent(tab ? `'${tab.replaceAll("'", "''")}'!${a1}` : a1);
    const base = `/v4/spreadsheets/${encodeURIComponent(sheetId)}/values`;
    const signal = AbortSignal.timeout(8_000); // a student is waiting on this
    const call = async (path: string, method = "GET", values?: unknown[][]) => {
      const res = await transport(path, {
        method, signal, headers: { "Content-Type": "application/json" },
        ...(values ? { body: JSON.stringify({ majorDimension: "ROWS", values }) } : {}),
      });
      if (!res.ok) throw new Error(`Google Sheets answered ${res.status}`);
      return res.json() as Promise<{ values?: unknown[][] }>;
    };
    // RAW: what a student typed is stored as plain text, never run as a formula.
    const head = await call(`${base}/${range("A1:I1")}`);
    if (!head.values?.length) await call(`${base}/${range("A1:I1")}?valueInputOption=RAW`, "PUT", [SHEET_HEADERS]);
    await call(`${base}/${range("A:I")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, "POST", rows.map(({ p, email }) => [
      sgt(p.createdAt), p.fullName, email, p.mobile, p.school, p.level, p.heardFrom, sgt(p.consentAt), p.userId,
    ]));
    await db.update(studentProfiles).set({ sheetSyncedAt: new Date(), sheetError: null }).where(inArray(studentProfiles.userId, ids));
    return { status: "sent", sent: rows.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not reach Google Sheets";
    await db.update(studentProfiles).set({ sheetError: message }).where(inArray(studentProfiles.userId, ids));
    console.error("Google Sheet sync failed:", message);
    return { status: "failed", sent: 0, message };
  }
}

// One send at a time, so two sign-ups together can't write the same rows twice.
let running: Promise<SheetResult> | null = null;
export async function syncSheet(db: Db): Promise<SheetResult> {
  while (running) await running;
  running = sendUnsynced(db).finally(() => { running = null; });
  return running;
}
