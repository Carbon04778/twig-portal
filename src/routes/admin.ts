// Donnell's admin panel API. Only users with the admin role (from ADMIN_EMAILS) get in.
import { Router, type NextFunction, type Request, type Response } from "express";
import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { apps, auditLog, promoCodes, promoRedemptions, userAppAccess, users } from "../db/schema.js";
import { formatPromoCode, normalizePromoCode } from "../lib/access.js";
import { generatePromoCode, generateSecret, type User } from "../lib/portal.js";

export const adminApi = Router();

adminApi.use((_req: Request, res: Response, next: NextFunction) => {
  const user = res.locals.user as User | undefined;
  if (!user) return res.status(401).json({ error: "sign_in_required" });
  if (user.role !== "admin" || user.status !== "active") return res.status(403).json({ error: "admin_only" });
  res.setHeader("Cache-Control", "no-store");
  next();
});

const audit = (res: Response, action: string, target: string, detail?: unknown) =>
  db.insert(auditLog).values({
    actorUserId: (res.locals.user as User).id, action, target, detail: detail === undefined ? null : JSON.stringify(detail),
  });

// ---- Users -------------------------------------------------------------------------------
const usersQuery = z.object({
  q: z.string().trim().max(100).optional(),
  role: z.enum(["public", "student", "admin"]).optional(),
  status: z.enum(["active", "revoked"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
adminApi.get("/users", async (req, res) => {
  const q = usersQuery.parse(req.query);
  const where: SQL[] = [];
  if (q.q) where.push(or(ilike(users.email, `%${q.q}%`), ilike(users.name, `%${q.q}%`))!);
  if (q.role) where.push(eq(users.role, q.role));
  if (q.status) where.push(eq(users.status, q.status));
  const rows = await db.select().from(users).where(and(...where))
    .orderBy(desc(users.lastSeenAt)).limit(q.limit).offset(q.offset);
  const overrides = rows.length
    ? await db.select().from(userAppAccess).where(sql`${userAppAccess.userId} in ${rows.map((r) => r.id)}`)
    : [];
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(users).where(and(...where)) as [{ total: number }];
  res.json({
    total,
    data: rows.map((u) => ({
      ...u, appOverrides: Object.fromEntries(overrides.filter((o) => o.userId === u.id).map((o) => [o.appId, o.allowed])),
    })),
  });
});

const userPatch = z.object({
  role: z.enum(["public", "student"]).optional(), // admin comes only from ADMIN_EMAILS
  status: z.enum(["active", "revoked"]).optional(),
}).refine((b) => b.role || b.status, "nothing to change");
adminApi.patch("/users/:id", async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const body = userPatch.parse(req.body);
  const [target] = await db.select().from(users).where(eq(users.id, id));
  if (!target) return res.status(404).json({ error: "not_found" });
  if (target.role === "admin") return res.status(400).json({ error: "cannot_change_admin", message: "Admins are set by ADMIN_EMAILS." });
  const [row] = await db.update(users).set({
    ...body,
    ...(body.role === "student" && target.role !== "student" ? { studentSince: new Date() } : {}),
    ...(body.role === "public" ? { studentSince: null } : {}),
  }).where(eq(users.id, id)).returning();
  await audit(res, "user.update", String(id), body);
  res.json({ data: row });
});

const overrideBody = z.object({ allowed: z.boolean().nullable() }); // null removes the override
adminApi.put("/users/:id/apps/:appId", async (req, res) => {
  const userId = z.coerce.number().int().positive().parse(req.params.id);
  const appId = String(req.params.appId);
  const { allowed } = overrideBody.parse(req.body);
  if (allowed === null) {
    await db.delete(userAppAccess).where(and(eq(userAppAccess.userId, userId), eq(userAppAccess.appId, appId)));
  } else {
    await db.insert(userAppAccess).values({ userId, appId, allowed })
      .onConflictDoUpdate({ target: [userAppAccess.userId, userAppAccess.appId], set: { allowed } });
  }
  await audit(res, "user.app_access", `${userId}:${appId}`, { allowed });
  res.json({ data: { userId, appId, allowed } });
});

// ---- Promo codes -------------------------------------------------------------------------
adminApi.get("/promo-codes", async (_req, res) => {
  const rows = await db.select().from(promoCodes).orderBy(desc(promoCodes.createdAt));
  res.json({ data: rows.map((p) => ({ ...p, code: formatPromoCode(p.code) })) });
});

const promoBody = z.object({
  label: z.string().trim().max(100).default(""),
  code: z.string().trim().max(40).optional(), // custom code, e.g. "TWIG2027"; random if omitted
  max_uses: z.number().int().positive().max(100_000).nullable().default(null),
  expires_at: z.coerce.date().nullable().default(null),
});
adminApi.post("/promo-codes", async (req, res) => {
  const body = promoBody.parse(req.body);
  const code = body.code ? normalizePromoCode(body.code) : generatePromoCode();
  if (code.length < 4) return res.status(400).json({ error: "code_too_short" });
  const [row] = await db.insert(promoCodes)
    .values({ code, label: body.label, maxUses: body.max_uses, expiresAt: body.expires_at })
    .onConflictDoNothing().returning();
  if (!row) return res.status(409).json({ error: "code_exists" });
  await audit(res, "promo.create", code, body);
  res.status(201).json({ data: { ...row, code: formatPromoCode(row.code) } });
});

adminApi.post("/promo-codes/:id/revoke", async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const [row] = await db.update(promoCodes).set({ revokedAt: new Date() }).where(eq(promoCodes.id, id)).returning();
  if (!row) return res.status(404).json({ error: "not_found" });
  await audit(res, "promo.revoke", row.code);
  res.json({ data: { ...row, code: formatPromoCode(row.code) } });
});

adminApi.get("/promo-codes/:id/redemptions", async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const rows = await db.select({ email: users.email, name: users.name, role: users.role, redeemedAt: promoRedemptions.redeemedAt })
    .from(promoRedemptions).innerJoin(users, eq(users.id, promoRedemptions.userId))
    .where(eq(promoRedemptions.codeId, id)).orderBy(desc(promoRedemptions.redeemedAt));
  res.json({ data: rows });
});

// ---- Apps --------------------------------------------------------------------------------
const publicApp = ({ secretHash, ...a }: typeof apps.$inferSelect) => ({ ...a, hasSecret: !!secretHash });
adminApi.get("/apps", async (_req, res) => {
  res.json({ data: (await db.select().from(apps).orderBy(apps.sortOrder, apps.name)).map(publicApp) });
});

const httpsUrl = z.url().refine((u) => /^https:\/\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(u),
  "must be https (http only for localhost)");
const appBody = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,40}$/, "lowercase letters, digits and dashes"),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(300).default(""),
  url: httpsUrl,
  callback_path: z.string().regex(/^\/[^\s]*$/).default("/api/portal/callback"),
  public_access: z.boolean().default(false),
  enabled: z.boolean().default(true),
  sort_order: z.number().int().default(0),
});
adminApi.post("/apps", async (req, res) => {
  const b = appBody.parse(req.body);
  const [row] = await db.insert(apps).values({
    id: b.id, name: b.name, description: b.description, url: b.url, callbackPath: b.callback_path,
    publicAccess: b.public_access, enabled: b.enabled, sortOrder: b.sort_order,
  }).onConflictDoNothing().returning();
  if (!row) return res.status(409).json({ error: "app_exists" });
  await audit(res, "app.create", b.id, b);
  res.status(201).json({ data: publicApp(row) });
});

adminApi.patch("/apps/:id", async (req, res) => {
  const b = appBody.omit({ id: true }).partial().parse(req.body);
  const [row] = await db.update(apps).set({
    name: b.name, description: b.description, url: b.url, callbackPath: b.callback_path,
    publicAccess: b.public_access, enabled: b.enabled, sortOrder: b.sort_order,
  }).where(eq(apps.id, String(req.params.id))).returning();
  if (!row) return res.status(404).json({ error: "not_found" });
  await audit(res, "app.update", row.id, b);
  res.json({ data: publicApp(row) });
});

// Creates or replaces the app's secret. Shown once; the app stores it as PORTAL_APP_SECRET.
adminApi.post("/apps/:id/secret", async (req, res) => {
  const { secret, hash, prefix } = generateSecret("tps");
  const [row] = await db.update(apps).set({ secretHash: hash, secretPrefix: prefix })
    .where(eq(apps.id, String(req.params.id))).returning();
  if (!row) return res.status(404).json({ error: "not_found" });
  await audit(res, "app.secret", row.id);
  res.json({ data: { ...publicApp(row), secret } });
});

adminApi.get("/audit", async (_req, res) => {
  res.json({ data: await db.select().from(auditLog).orderBy(desc(auditLog.at)).limit(200) });
});
