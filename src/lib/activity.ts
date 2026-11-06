// Which apps students use and roughly how long. A visit starts when a student opens an app from
// the portal. Each connected app re-checks access with the portal while it is being used, and
// each re-check moves the visit's end time on. So time is an estimate, not a stopwatch.
import { and, desc, eq, gt, gte, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { appSessions, studentProfiles, users } from "../db/schema.js";

// A check-in further apart than this starts a new visit. Must be longer than the connector's
// re-check interval (connector/portalAuth.ts; older copies re-check every 30 minutes).
const SAME_VISIT_MS = 35 * 60_000;

// Tracking must never get in the way of a student opening an app.
const quietly = (work: Promise<unknown>) =>
  work.catch((err) => console.error("Activity tracking failed:", err instanceof Error ? err.message : err));

export const recordOpen = (db: Db, userId: number, appId: string) =>
  quietly(db.insert(appSessions).values({ userId, appId }));

export function recordCheckIn(db: Db, userId: number, appId: string) {
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
    startedAt: appSessions.startedAt, lastActiveAt: appSessions.lastActiveAt, appId: appSessions.appId, source: appSessions.source,
    email: users.email, accountName: users.name, name: studentProfiles.fullName, school: studentProfiles.school, level: studentProfiles.level,
  }).from(appSessions).innerJoin(users, eq(users.id, appSessions.userId))
    .leftJoin(studentProfiles, eq(studentProfiles.userId, users.id))
    .where(inPeriod(days)).orderBy(desc(appSessions.startedAt)).limit(50_000);
}
