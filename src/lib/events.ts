// What students do inside the apps, as reported by each app (connector/portalAuth.ts): exam steps
// with timestamps, Claude and voice use, and other actions. Reports are best effort, so an app
// that hasn't been updated, or a report lost to a network problem, simply shows nothing.
import { and, asc, desc, eq, gte, inArray, isNull, like, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { appEvents, studentProfiles, users } from "../db/schema.js";
import { ensureTab, sgt, sheetCaller, writeRows, type SheetResult } from "./profile.js";

export const EVENT_NAMES = {
  exam_started: "Exam started",
  exam_left: "Stepped away from exam",
  exam_returned: "Came back to exam",
  exam_submitted: "Exam submitted",
  exam_timed_out: "Exam ended: time up",
  exam_quit: "Exam quit",
  claude_used: "Used Claude",
  voice_used: "Used voice reply",
  action: "Action",
} as const;
type EventType = keyof typeof EVENT_NAMES;
const EVENT_TYPES = Object.keys(EVENT_NAMES) as [EventType, ...EventType[]];

export const eventsBody = z.object({
  app_id: z.string().min(1).max(60),
  user_id: z.number().int().positive(),
  events: z.array(z.object({
    id: z.string().min(8).max(80),
    type: z.enum(EVENT_TYPES),
    at: z.iso.datetime({ offset: true }),
    ref: z.string().max(200).optional(),
    title: z.string().max(200).optional(),
    label: z.string().max(100).optional(),
    score: z.number().int().min(0).max(100_000).optional(),
    total: z.number().int().min(0).max(100_000).optional(),
  })).min(1).max(20),
});

export async function recordEvents(db: Db, body: z.infer<typeof eventsBody>) {
  const now = Date.now();
  await db.insert(appEvents).values(body.events.map((e) => ({
    userId: body.user_id, appId: body.app_id, eventId: e.id, type: e.type,
    attemptRef: e.ref ?? null, title: e.title ?? null, label: e.label ?? null, score: e.score ?? null, total: e.total ?? null,
    occurredAt: new Date(Math.min(new Date(e.at).getTime(), now)), // a wrong device clock can't date one in the future
  }))).onConflictDoNothing();
}

const eventFields = {
  id: appEvents.id, userId: appEvents.userId, appId: appEvents.appId, type: appEvents.type,
  attemptRef: appEvents.attemptRef, title: appEvents.title, label: appEvents.label,
  score: appEvents.score, total: appEvents.total, occurredAt: appEvents.occurredAt,
  email: users.email, accountName: users.name, name: studentProfiles.fullName,
  school: studentProfiles.school, level: studentProfiles.level,
};
const studentEvents = (db: Db) => db.select(eventFields).from(appEvents)
  .innerJoin(users, eq(users.id, appEvents.userId))
  .leftJoin(studentProfiles, eq(studentProfiles.userId, users.id));
type Row = Awaited<ReturnType<typeof studentEvents>>[number];

const notAdmin = ne(users.role, "admin"); // Donnell's own testing doesn't count
const inPeriod = (days: number) => and(gte(appEvents.occurredAt, new Date(Date.now() - days * 86_400_000)), notAdmin);
const AI_TYPES: EventType[] = ["claude_used", "voice_used"];
const studentName = (r: Row) => r.name ?? r.accountName ?? r.email;

export const EVENT_HEADERS = ["When (SGT)", "Student", "Email", "School", "Level", "App", "Event", "Exam or paper", "Detail", "Score", "Out of", "Attempt ID", "User ID"];
export const eventRow = (r: Row, title: (id: string) => string) => [
  sgt(r.occurredAt), studentName(r), r.email, r.school ?? "", r.level ?? "", title(r.appId),
  EVENT_NAMES[r.type as EventType] ?? r.type, r.title ?? "", r.label ?? "", r.score ?? "", r.total ?? "", r.attemptRef ?? "", r.userId,
];

export const allEvents = (db: Db, days: number) =>
  studentEvents(db).where(inPeriod(days)).orderBy(desc(appEvents.occurredAt)).limit(50_000);

// One line per exam attempt, built from its events. Only the steps that were reported can show.
function examAttempts(rows: Row[]) {
  const attempts = new Map<string, {
    userId: number; student: string; email: string; appId: string; title: string | null; startedAt: Date; endedAt: Date | null;
    result: string; score: number | null; total: number | null; timesAway: number; minutesAway: number; awaySince: Date | null;
  }>();
  for (const r of [...rows].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())) {
    const key = `${r.appId}|${r.userId}|${r.attemptRef ?? r.id}`;
    const a = attempts.get(key) ?? {
      userId: r.userId, student: studentName(r), email: r.email, appId: r.appId, title: r.title, startedAt: r.occurredAt, endedAt: null,
      result: "Not finished", score: null, total: null, timesAway: 0, minutesAway: 0, awaySince: null,
    };
    a.title ??= r.title;
    if (r.type === "exam_left") { a.timesAway++; a.awaySince = r.occurredAt; }
    if (r.type === "exam_returned" && a.awaySince) {
      a.minutesAway += Math.round((r.occurredAt.getTime() - a.awaySince.getTime()) / 60_000);
      a.awaySince = null;
    }
    if (r.type === "exam_submitted" || r.type === "exam_timed_out" || r.type === "exam_quit") {
      a.endedAt = r.occurredAt;
      a.result = r.type === "exam_submitted" ? "Submitted" : r.type === "exam_timed_out" ? "Time up" : "Quit";
      a.score = r.score;
      a.total = r.total;
    }
    attempts.set(key, a);
  }
  return [...attempts.values()].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
    .slice(0, 300).map(({ awaySince: _awaySince, ...rest }) => rest);
}

export async function eventSummary(db: Db, days: number) {
  const aiByApp = await db.select({
    appId: appEvents.appId, type: appEvents.type, label: appEvents.label,
    uses: sql<number>`count(*)::int`, students: sql<number>`count(distinct ${appEvents.userId})::int`,
  }).from(appEvents).innerJoin(users, eq(users.id, appEvents.userId))
    .where(and(inPeriod(days), inArray(appEvents.type, AI_TYPES)))
    .groupBy(appEvents.appId, appEvents.type, appEvents.label).orderBy(desc(sql`count(*)`));

  const aiByStudent = await db.select({
    userId: appEvents.userId, email: users.email, accountName: users.name, name: studentProfiles.fullName,
    claude: sql<number>`(count(*) filter (where ${appEvents.type} = 'claude_used'))::int`,
    voice: sql<number>`(count(*) filter (where ${appEvents.type} = 'voice_used'))::int`,
    lastUsed: sql<string>`max(${appEvents.occurredAt})`,
  }).from(appEvents).innerJoin(users, eq(users.id, appEvents.userId))
    .leftJoin(studentProfiles, eq(studentProfiles.userId, users.id))
    .where(and(inPeriod(days), inArray(appEvents.type, AI_TYPES)))
    .groupBy(appEvents.userId, users.id, studentProfiles.userId).orderBy(desc(sql`count(*)`)).limit(300);

  const examRows = await studentEvents(db).where(and(inPeriod(days), like(appEvents.type, "exam\\_%")))
    .orderBy(desc(appEvents.occurredAt)).limit(5_000);

  return {
    aiByApp,
    aiByStudent: aiByStudent.map((s) => ({ userId: s.userId, email: s.email, name: s.name ?? s.accountName ?? s.email, claude: s.claude, voice: s.voice, lastUsed: s.lastUsed })),
    exams: examAttempts(examRows),
  };
}

// ---- Google Sheet ------------------------------------------------------------------------
const EVENTS_TAB = "Exams and Claude";

export async function eventsWaiting(db: Db) {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(appEvents)
    .innerJoin(users, eq(users.id, appEvents.userId))
    .where(and(isNull(appEvents.sheetSyncedAt), notAdmin));
  return row?.n ?? 0;
}

// Call through oneSheetSendAtATime.
export async function sendNewEvents(db: Db, title: (id: string) => string): Promise<SheetResult> {
  const rows = await studentEvents(db).where(and(isNull(appEvents.sheetSyncedAt), notAdmin))
    .orderBy(asc(appEvents.occurredAt)).limit(500);
  if (!rows.length) return { status: "nothing_to_send", sent: 0 };
  const sheetId = process.env.GOOGLE_SHEET_ID?.trim();
  if (!sheetId) return { status: "not_configured", sent: 0, message: "GOOGLE_SHEET_ID is not set." };
  try {
    const call = sheetCaller(sheetId, 20_000);
    await ensureTab(call, EVENTS_TAB);
    await writeRows(call, EVENTS_TAB, EVENT_HEADERS, rows.map((r) => eventRow(r, title)));
    await db.update(appEvents).set({ sheetSyncedAt: new Date() }).where(inArray(appEvents.id, rows.map((r) => r.id)));
    return { status: "sent", sent: rows.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not reach Google Sheets";
    console.error("Exam and Claude sheet sync failed:", message);
    return { status: "failed", sent: 0, message };
  }
}
