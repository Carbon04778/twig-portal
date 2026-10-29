// Routes used by the portal page (signed-in users) and by the apps' servers.
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "../db/client.js";
import { adminEmails } from "../env.js";
import type { IdentityProvider } from "../auth/identity.js";
import {
  appsFor, checkUserAccess, createLaunchCode, exchangeLaunchCode, redeemPromo, syncUser, userCanOpen, type User,
} from "../lib/portal.js";

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

const publicUser = (u: User) => ({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status });

export const userApi = Router();
userApi.use(requireUser);

userApi.get("/me", async (_req, res) => {
  const user = res.locals.user as User;
  res.json({ user: publicUser(user), apps: await appsFor(db, user) });
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
  res.json({ user: publicUser(result.user), apps: await appsFor(db, result.user) });
});

// Opening an app: browser navigation, so answer with redirects rather than JSON.
export const launch = Router();
launch.get("/launch/:appId", async (req, res) => {
  const appId = String(req.params.appId);
  const user = res.locals.user as User | undefined;
  if (!user) return res.redirect(303, `/?next=${encodeURIComponent(`/launch/${appId}`)}`);
  const app = user.status === "active" ? await userCanOpen(db, user, appId) : null;
  if (!app) return res.redirect(303, `/?denied=${encodeURIComponent(appId)}`);
  const code = await createLaunchCode(db, user, app);
  const target = new URL(app.callbackPath, app.url);
  target.searchParams.set("code", code);
  res.redirect(303, target.toString());
});

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
  res.json({ allowed: result.allowed, role: result.role });
});
