// Routes used by the portal page (signed-in users) and by the apps' servers.
import { Router, type NextFunction, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { apps, payments, users } from "../db/schema.js";
import { adminEmails } from "../env.js";
import type { IdentityProvider } from "../auth/identity.js";
import { effectiveRole } from "../lib/access.js";
import { recordCheckIn, recordOpen } from "../lib/activity.js";
import { pageContent } from "../lib/content.js";
import { confirmWithHitpay, handleWebhook, paymentOffer, startPayment, validWebhookSignature } from "../lib/payment.js";
import {
  appsFor, checkUserAccess, createLaunchCode, exchangeLaunchCode, redeemPromo, syncUser, userCanOpen, type User,
} from "../lib/portal.js";
import { CONSENT_TEXT, examYears, getProfile, HEARD_FROM, LEVELS, profileBody, saveProfile, syncSheet } from "../lib/profile.js";

// Loads the signed-in user (or leaves res.locals.user undefined).
export function loadUser(identify: IdentityProvider) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const identity = await identify(req);
      if (identity) res.locals.user = await syncUser(db, identity, adminEmails());
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireUser(_req: Request, res: Response, next: NextFunction) {
  const user = res.locals.user as User | undefined;
  if (!user) return res.status(401).json({ error: "sign_in_required" });
  if (user.status !== "active") return res.status(403).json({ error: "account_revoked" });
  next();
}

const publicUser = (u: User) => ({
  id: u.id, email: u.email, name: u.name, role: effectiveRole(u), status: u.status,
  paidUntil: u.role === "public" ? u.paidUntil : null,
});

// Everything the apps page needs. Donnell (admin) isn't asked to fill in the student form.
async function homePayload(user: User) {
  const [allApps, profile, payment] = await Promise.all([
    db.select().from(apps).orderBy(apps.sortOrder, apps.name), getProfile(db, user.id), paymentOffer(db, user),
  ]);
  return {
    user: { ...publicUser(user), name: profile?.fullName ?? user.name },
    apps: await appsFor(db, user),
    content: await pageContent(db, allApps),
    payment,
    profileRequired: !profile && user.role !== "admin",
    profileForm: { levels: LEVELS, examYears: examYears().map(String), heardFrom: HEARD_FROM, consent: CONSENT_TEXT },
  };
}

export const userApi = Router();
userApi.use(requireUser);

userApi.get("/me", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await homePayload(res.locals.user as User));
});

userApi.post("/profile", async (req, res) => {
  const user = res.locals.user as User;
  await saveProfile(db, user.id, profileBody.parse(req.body));
  await syncSheet(db); // never throws for a sheet problem: the details are already saved
  res.json(await homePayload(user));
});

userApi.post("/pay/start", async (req, res) => {
  const user = res.locals.user as User;
  const profile = await getProfile(db, user.id);
  if (!profile) return res.status(400).json({ error: "profile_required", message: "Please complete your details first." });
  const result = await startPayment(db, user, profile.fullName, `${req.protocol}://${req.get("host")}`).catch((err) => {
    console.error("HitPay checkout failed:", err instanceof Error ? err.message : err);
    return null;
  });
  if (!result) return res.status(502).json({ error: "payment_unavailable", message: "We couldn't reach the payment page. Please try again in a moment." });
  if (!result.ok) {
    return res.status(400).json({
      error: result.error,
      message: result.error === "payment_off" ? "Payment isn't available right now." : "Your account already has full access.",
    });
  }
  res.json({ url: result.url });
});

const payCheckBody = z.object({ reference: z.uuid() });
userApi.post("/pay/check", async (req, res) => {
  const { reference } = payCheckBody.parse(req.body);
  const user = res.locals.user as User;
  const [payment] = await db.select().from(payments).where(and(eq(payments.reference, reference), eq(payments.userId, user.id)));
  if (!payment) return res.status(404).json({ error: "not_found" });
  const status = await confirmWithHitpay(db, payment).catch((err) => {
    console.error("HitPay check failed:", err instanceof Error ? err.message : err);
    return "pending" as const;
  });
  const [fresh] = await db.select().from(users).where(eq(users.id, user.id));
  res.json({ status, ...await homePayload(fresh!) });
});

const redeemBody = z.object({ code: z.string().trim().min(4).max(40) });
const REDEEM_MESSAGES: Record<string, string> = {
  not_found: "That code isn't valid. Check it and try again.",
  revoked: "That code is no longer active.",
  expired: "That code has expired.",
  used_up: "That code has already been used the maximum number of times.",
  already_student: "Your account already has student access.",
};
userApi.post("/redeem", async (req, res) => {
  const { code } = redeemBody.parse(req.body);
  const result = await redeemPromo(db, res.locals.user as User, code);
  if (!result.ok) return res.status(400).json({ error: result.problem, message: REDEEM_MESSAGES[result.problem] });
  res.json(await homePayload(result.user));
});

// Opening an app: browser navigation, so answer with redirects rather than JSON.
export const launch = Router();
launch.get("/launch/:appId", async (req, res) => {
  const appId = String(req.params.appId);
  const user = res.locals.user as User | undefined;
  if (!user) return res.redirect(303, `/?next=${encodeURIComponent(`/launch/${appId}`)}`);
  const app = user.status === "active" ? await userCanOpen(db, user, appId) : null;
  if (!app) return res.redirect(303, `/?denied=${encodeURIComponent(appId)}`);
  // The sign-up form comes first; the portal page returns here once it's filled in.
  if (user.role !== "admin" && !(await getProfile(db, user.id))) {
    return res.redirect(303, `/?next=${encodeURIComponent(`/launch/${appId}`)}`);
  }
  const code = await createLaunchCode(db, user, app);
  await recordOpen(db, user.id, app.id);
  const target = new URL(app.callbackPath, app.url);
  target.searchParams.set("code", code);
  res.redirect(303, target.toString());
});

// HitPay tells us a payment finished. Mounted before the JSON parser: the signature covers the raw body.
export async function hitpayWebhook(req: Request, res: Response) {
  const raw = req.body as Buffer;
  if (!Buffer.isBuffer(raw) || !validWebhookSignature(raw, req.get("hitpay-signature"))) {
    return res.status(401).json({ error: "invalid_signature" });
  }
  await handleWebhook(db, raw); // an error answers 500, so HitPay tries again
  res.json({ ok: true });
}

// Server-to-server, called by each app with its own secret (x-app-secret header).
export const appApi = Router();
const exchangeBody = z.object({ app_id: z.string().min(1).max(60), code: z.string().min(20).max(200) });
appApi.post("/exchange", async (req, res) => {
  const { app_id, code } = exchangeBody.parse(req.body);
  const result = await exchangeLaunchCode(db, app_id, String(req.headers["x-app-secret"] ?? ""), code);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ user: result.user });
});
const checkBody = z.object({ app_id: z.string().min(1).max(60), user_id: z.number().int().positive() });
appApi.post("/check", async (req, res) => {
  const { app_id, user_id } = checkBody.parse(req.body);
  const result = await checkUserAccess(db, app_id, String(req.headers["x-app-secret"] ?? ""), user_id);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  if (result.allowed) await recordCheckIn(db, user_id, app_id);
  res.json({ allowed: result.allowed, role: result.role });
});
