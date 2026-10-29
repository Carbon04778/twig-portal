// Database operations behind the portal: users, access, promo codes, launch codes.
import crypto from "node:crypto";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { apps, auditLog, launchCodes, promoCodes, promoRedemptions, userAppAccess, users } from "../db/schema.js";
import { canOpen, normalizePromoCode, promoProblem, type PromoProblem } from "./access.js";

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const LAUNCH_CODE_TTL_MS = 60_000;

export interface Identity {
  clerkId: string;
  email: string; // verified
  name: string | null;
}

export type User = typeof users.$inferSelect;
export type App = typeof apps.$inferSelect;

// Create or refresh the user on every sign-in. ADMIN_EMAILS always get admin; the role is
// otherwise kept (admins demoted by removing them from ADMIN_EMAILS fall back to student).
export async function syncUser(db: Db, id: Identity, admins: Set<string>): Promise<User> {
  const email = id.email.toLowerCase();
  const isAdmin = admins.has(email);
  const [row] = await db.insert(users)
    .values({ clerkId: id.clerkId, email, name: id.name, role: isAdmin ? "admin" : "public" })
    .onConflictDoUpdate({
      target: users.clerkId,
      set: {
        email, name: id.name, lastSeenAt: new Date(),
        role: isAdmin
          ? sql`'admin'::user_role`
          : sql`case when ${users.role} = 'admin' then 'student'::user_role else ${users.role} end`,
      },
    })
    .returning();
  return row!;
}

export async function appsFor(db: Db, user: User) {
  const [all, overrides] = await Promise.all([
    db.select().from(apps).orderBy(apps.sortOrder, apps.name),
    db.select().from(userAppAccess).where(eq(userAppAccess.userId, user.id)),
  ]);
  const byApp = new Map(overrides.map((o) => [o.appId, o.allowed]));
  return all.filter((a) => a.enabled).map((a) => ({
    id: a.id, name: a.name, description: a.description,
    canOpen: canOpen(user, a, byApp.get(a.id)),
  }));
}

export async function userCanOpen(db: Db, user: User, appId: string): Promise<App | null> {
  const [app] = await db.select().from(apps).where(eq(apps.id, appId));
  if (!app) return null;
  const [o] = await db.select().from(userAppAccess)
    .where(and(eq(userAppAccess.userId, user.id), eq(userAppAccess.appId, appId)));
  return canOpen(user, app, o?.allowed) ? app : null;
}

export type RedeemResult = { ok: true; user: User } | { ok: false; problem: PromoProblem | "already_student" };

// Atomic: the use counter is incremented with a guard, so a code with max_uses = 30 can't be
// redeemed 31 times by students racing each other.
export async function redeemPromo(db: Db, user: User, rawCode: string): Promise<RedeemResult> {
  if (user.role !== "public") return { ok: false, problem: "already_student" };
  const code = normalizePromoCode(rawCode);
  return db.transaction(async (tx) => {
    const [promo] = await tx.select().from(promoCodes).where(eq(promoCodes.code, code));
    const problem = promoProblem(promo);
    if (problem) return { ok: false as const, problem };
    const [claimed] = await tx.update(promoCodes).set({ uses: sql`${promoCodes.uses} + 1` })
      .where(and(eq(promoCodes.id, promo!.id), sql`(${promoCodes.maxUses} is null or ${promoCodes.uses} < ${promoCodes.maxUses})`))
      .returning({ id: promoCodes.id });
    if (!claimed) return { ok: false as const, problem: "used_up" as const };
    await tx.insert(promoRedemptions).values({ codeId: promo!.id, userId: user.id }).onConflictDoNothing();
    const [updated] = await tx.update(users).set({ role: "student", studentSince: new Date() })
      .where(eq(users.id, user.id)).returning();
    await tx.insert(auditLog).values({ actorUserId: user.id, action: "promo.redeem", target: code });
    return { ok: true as const, user: updated! };
  });
}

export async function createLaunchCode(db: Db, user: User, app: App): Promise<string> {
  const code = crypto.randomBytes(32).toString("base64url");
  await db.delete(launchCodes).where(lt(launchCodes.expiresAt, new Date(Date.now() - 3600_000)));
  await db.insert(launchCodes).values({
    codeHash: sha256(code), userId: user.id, appId: app.id, expiresAt: new Date(Date.now() + LAUNCH_CODE_TTL_MS),
  });
  return code;
}

export type ExchangeResult =
  | { ok: true; user: { id: number; email: string; name: string | null; role: string } }
  | { ok: false; status: number; error: string };

// Called by an app's server. Checks the app secret, uses the code once, and re-checks access
// at this moment (so a user revoked between click and exchange is refused).
export async function exchangeLaunchCode(db: Db, appId: string, appSecret: string, code: string): Promise<ExchangeResult> {
  const [app] = await db.select().from(apps).where(eq(apps.id, appId));
  if (!app?.secretHash || !crypto.timingSafeEqual(Buffer.from(app.secretHash), Buffer.from(sha256(appSecret)))) {
    return { ok: false, status: 401, error: "invalid_app_credentials" };
  }
  const [used] = await db.update(launchCodes).set({ usedAt: new Date() })
    .where(and(eq(launchCodes.codeHash, sha256(code)), eq(launchCodes.appId, appId),
      isNull(launchCodes.usedAt), gt(launchCodes.expiresAt, new Date())))
    .returning({ userId: launchCodes.userId });
  if (!used) return { ok: false, status: 400, error: "invalid_or_expired_code" };
  const [user] = await db.select().from(users).where(eq(users.id, used.userId));
  if (!user || !(await userCanOpen(db, user, appId))) return { ok: false, status: 403, error: "no_access" };
  return { ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
}

// Lets an app re-check a session it already holds (e.g. every few hours).
export async function checkUserAccess(db: Db, appId: string, appSecret: string, userId: number) {
  const [app] = await db.select().from(apps).where(eq(apps.id, appId));
  if (!app?.secretHash || !crypto.timingSafeEqual(Buffer.from(app.secretHash), Buffer.from(sha256(appSecret)))) {
    return { ok: false as const, status: 401, error: "invalid_app_credentials" };
  }
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  const allowed = !!user && !!(await userCanOpen(db, user, appId));
  return { ok: true as const, allowed, role: user?.role ?? null };
}

export function generateSecret(prefix: string) {
  const secret = `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
  return { secret, hash: sha256(secret), prefix: secret.slice(0, prefix.length + 7) };
}

export function generatePromoCode() {
  // No 0/O/1/I so codes read clearly when Donnell shares them.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join(""); // 32 divides 256: no bias
}
