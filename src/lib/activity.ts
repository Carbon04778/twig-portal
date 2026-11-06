// Which apps students use and roughly how long. A visit starts when a student opens an app from
// the portal. Each connected app re-checks access with the portal while it is being used, and
// each re-check moves the visit's end time on. So time is an estimate, not a stopwatch.
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { apps, appSessions, studentProfiles, users } from "../db/schema.js";
import { pageContent } from "./content.js";
import { oneSheetSendAtATime, sgt, sheetCaller, writeRows, type SheetResult } from "./profile.js";

// A check-in further apart than this starts a new visit. Must be longer than the connector's
// re-check interval (connector/portalAuth.ts; older copies re-check every 30 minutes).
const SAME_VISIT_MS = 35 * 60_000;

// Tracking must never get in the way of a student opening an app.
const quietly = (work: Promise<unknown>) =>
  work.catch((err) => console.error("Activity tracking failed:", err instanceof Error ? err.message : err));

export const recordOpen = (db: Db, userId: number, appId: string) => {
  sendActivitySoon(db);
  return quietly(db.insert(appSessions).values({ userId, appId }));
};

export function recordCheckIn(db: Db, userId: number, appId: string) {
  sendActivitySoon(db);
  return quietly((async () => {
    const [visit] = await db.select({ id: appSessions.id }).from(appSessions)
      .where(and(eq(appSessions.userId, userId), eq(appSessions.appId, appId),
        gt(appSessions.lastActiveAt, new Date(Date.now() - SAME_VISIT_MS))))
      .orderBy(desc(appSessions.lastActiveAt)).limit(1);
    if (visit) await db.update(appSessions).set({ lastActiveAt: new Date() }).where(eq(appSessions.id, visit.id));
    else await db.insert(appSessions).values({ userId, appId, source: "resume" });
  })());
}

const minutes = sql<number>`coalesce(round(sum(extract(epoch from ${appSessions.lastActiveAt} - ${appSessions.startedAt})) / 60), 0)::int`;
const opens = sql<number>`(count(*) filter (where ${appSessions.source} = 'launch'))::int`;
const since = (days: number) => new Date(Date.now() - days * 86_400_000);
// Donnell's own testing shouldn't count as student use.
const inPeriod = (days: number) => and(gte(appSessions.startedAt, since(days)), ne(users.role, "admin"));

export async function usageSummary(db: Db, days: number) {
  const byApp = await db.select({
    appId: appSessions.appId, opens, minutes, students: sql<number>`count(distinct ${appSessions.userId})::int`,
  }).from(appSessions).innerJoin(users, eq(users.id, appSessions.userId))
    .where(inPeriod(days)).groupBy(appSessions.appId).orderBy(desc(opens));

  const rows = await db.select({
    userId: users.id, email: users.email, accountName: users.name, name: studentProfiles.fullName,
    school: studentProfiles.school, level: studentProfiles.level, appId: appSessions.appId, opens, minutes,
    lastActive: sql<string>`max(${appSessions.lastActiveAt})`,
  }).from(appSessions).innerJoin(users, eq(users.id, appSessions.userId))
    .leftJoin(studentProfiles, eq(studentProfiles.userId, users.id))
    .where(inPeriod(days))
    .groupBy(users.id, studentProfiles.userId, appSessions.appId);

  const students = new Map<number, {
    userId: number; name: string; email: string; school: string; level: string; opens: number; minutes: number;
    lastActive: string; apps: { appId: string; opens: number; minutes: number }[];
  }>();
  for (const r of rows) {
    const s = students.get(r.userId) ?? {
      userId: r.userId, name: r.name ?? r.accountName ?? r.email, email: r.email, school: r.school ?? "", level: r.level ?? "",
      opens: 0, minutes: 0, lastActive: r.lastActive, apps: [],
    };
    s.opens += r.opens;
    s.minutes += r.minutes;
    if (new Date(r.lastActive) > new Date(s.lastActive)) s.lastActive = r.lastActive;
    s.apps.push({ appId: r.appId, opens: r.opens, minutes: r.minutes });
    students.set(r.userId, s);
  }
  const list = [...students.values()].sort((a, b) => b.opens - a.opens);
  for (const s of list) s.apps.sort((a, b) => b.opens - a.opens);
  return { byApp, students: list };
}

export function usageVisits(db: Db, days: number) {
  return db.select({
    ...visitFields,
  }).from(appSessions).innerJoin(users, eq(users.id, appSessions.userId))
    .leftJoin(studentProfiles, eq(studentProfiles.userId, users.id))
    .where(inPeriod(days)).orderBy(desc(appSessions.startedAt)).limit(50_000);
}

const visitFields = {
  id: appSessions.id, userId: appSessions.userId,
  startedAt: appSessions.startedAt, lastActiveAt: appSessions.lastActiveAt, appId: appSessions.appId, source: appSessions.source,
  email: users.email, accountName: users.name, name: studentProfiles.fullName, school: studentProfiles.school, level: studentProfiles.level,
};
type Visit = { userId: number; startedAt: Date; lastActiveAt: Date; appId: string; source: string; email: string; accountName: string | null; name: string | null; school: string | null; level: string | null };

// The same columns in the usage CSV and the Sheet's App activity tab.
export const VISIT_HEADERS = ["Started (SGT)", "Last active (SGT)", "Minutes (estimate)", "Name", "Email", "School", "Level", "App", "Type", "User ID"];
export const visitRow = (r: Visit, title: (id: string) => string) => [
  sgt(r.startedAt), sgt(r.lastActiveAt), Math.round((r.lastActiveAt.getTime() - r.startedAt.getTime()) / 60_000),
  r.name ?? r.accountName ?? "", r.email, r.school ?? "", r.level ?? "", title(r.appId), r.source === "launch" ? "Opened" : "Came back", r.userId,
];

export async function appTitles(db: Db) {
  const content = await pageContent(db, await db.select().from(apps));
  return (id: string) => content.apps[id]?.title ?? id;
}

// ---- Google Sheet ------------------------------------------------------------------------
// A visit goes to the Sheet once it has ended, so its minutes are final and each visit is one row.
const ACTIVITY_TAB = "App activity";
const SEND_EVERY_MS = 15 * 60_000;
const finishedBefore = () => new Date(Date.now() - SAME_VISIT_MS);

export async function activityWaiting(db: Db) {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(appSessions)
    .innerJoin(users, eq(users.id, appSessions.userId))
    .where(and(isNull(appSessions.sheetSyncedAt), ne(users.role, "admin")));
  return row?.n ?? 0;
}

async function sendFinishedVisits(db: Db): Promise<SheetResult> {
  const rows = await db.select(visitFields).from(appSessions).innerJoin(users, eq(users.id, appSessions.userId))
    .leftJoin(studentProfiles, eq(studentProfiles.userId, users.id))
    .where(and(isNull(appSessions.sheetSyncedAt), lte(appSessions.lastActiveAt, finishedBefore()), ne(users.role, "admin")))
    .orderBy(asc(appSessions.startedAt)).limit(500);
  if (!rows.length) return { status: "nothing_to_send", sent: 0 };
  const sheetId = process.env.GOOGLE_SHEET_ID?.trim();
  if (!sheetId) return { status: "not_configured", sent: 0, message: "GOOGLE_SHEET_ID is not set." };
  try {
    const call = sheetCaller(sheetId, 20_000);
    const { sheets } = await call("?fields=sheets.properties.title");
    if (!sheets?.some((s) => s.properties?.title === ACTIVITY_TAB)) {
      await call(":batchUpdate", "POST", { requests: [{ addSheet: { properties: { title: ACTIVITY_TAB } } }] });
    }
    const title = await appTitles(db);
    await writeRows(call, ACTIVITY_TAB, VISIT_HEADERS, rows.map((r) => visitRow(r, title)));
    await db.update(appSessions).set({ sheetSyncedAt: new Date() }).where(inArray(appSessions.id, rows.map((r) => r.id)));
    return { status: "sent", sent: rows.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not reach Google Sheets";
    console.error("App activity sheet sync failed:", message);
    return { status: "failed", sent: 0, message }; // unsent rows stay waiting for the next send
  }
}

export const syncActivity = (db: Db) => oneSheetSendAtATime(() => sendFinishedVisits(db));

// Runs in the background, at most every 15 minutes, whenever someone is using the apps.
let lastSend = 0;
function sendActivitySoon(db: Db) {
  if (Date.now() - lastSend < SEND_EVERY_MS) return;
  lastSend = Date.now();
  void quietly(syncActivity(db));
}
