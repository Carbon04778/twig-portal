// Twig portal sign-in for an app's Express API server. Copy this one file into
// artifacts/api-server/src/middlewares/portalAuth.ts. Uses only Node built-ins (Node 20+).
//
// Secrets (Replit Secrets of the app):
//   PORTAL_URL         https://<portal>.replit.app
//   PORTAL_APP_ID      this app's ID in the portal admin panel, e.g. "paper1"
//   PORTAL_APP_SECRET  shown once when you click "Connect" for the app in the portal admin
//
// In src/app.ts, before `app.use("/api", router)`:
//   import { portalRoutes, portalSession, requirePortalUser } from "./middlewares/portalAuth";
//   app.use(portalSession);                       // reads the session cookie
//   app.use("/api/portal", portalRoutes);         // callback, me, sign-out
//   app.use("/api", requirePortalUser({ allow: ["/healthz"] }));  // everything else needs a user
//
// In route handlers: res.locals.portalUser = { id, email, name, role } (role: public|student|admin).
import crypto from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";

export interface PortalUser {
  id: number;
  email: string;
  name: string | null;
  role: "public" | "student" | "admin";
}
interface Session extends PortalUser {
  exp: number; // session end (ms)
  chk: number; // last access re-check with the portal (ms)
}

const COOKIE = "twig_portal";
const SESSION_MS = 12 * 60 * 60 * 1000;
const RECHECK_MS = 5 * 60 * 1000; // also how the portal estimates time spent in the app

function config() {
  const url = process.env.PORTAL_URL?.replace(/\/+$/, "");
  const appId = process.env.PORTAL_APP_ID;
  const secret = process.env.PORTAL_APP_SECRET;
  if (!url || !appId || !secret) throw new Error("PORTAL_URL, PORTAL_APP_ID and PORTAL_APP_SECRET must be set");
  return { url, appId, secret, key: crypto.createHash("sha256").update(`twig-portal-session:${secret}`).digest() };
}

export const portalLaunchUrl = () => {
  const { url, appId } = config();
  return `${url}/launch/${encodeURIComponent(appId)}`;
};

// ---- Signed cookie (HMAC-SHA256; changing PORTAL_APP_SECRET signs everyone out) ----------
function seal(s: Session): string {
  const body = Buffer.from(JSON.stringify(s)).toString("base64url");
  return `${body}.${crypto.createHmac("sha256", config().key).update(body).digest("base64url")}`;
}
function unseal(value: string | undefined): Session | null {
  const [body, sig] = value?.split(".") ?? [];
  if (!body || !sig) return null;
  const expected = Buffer.from(crypto.createHmac("sha256", config().key).update(body).digest("base64url"));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString()) as Session;
    return s.exp > Date.now() ? s : null;
  } catch {
    return null;
  }
}
function readCookie(req: Request): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(v.join("="));
  }
  return undefined;
}
function writeCookie(req: Request, res: Response, s: Session | null) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  const attrs = `Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  res.append("Set-Cookie", s
    ? `${COOKIE}=${encodeURIComponent(seal(s))}; Max-Age=${Math.floor((s.exp - Date.now()) / 1000)}; ${attrs}`
    : `${COOKIE}=; Max-Age=0; ${attrs}`);
}

async function portalPost(path: string, body: unknown) {
  const { url, secret } = config();
  const res = await fetch(`${url}/api/apps/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-app-secret": secret },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> };
}

// ---- Middleware ------------------------------------------------------------------------
// Reads the session and, every 5 minutes, asks the portal whether the user still has access.
export async function portalSession(req: Request, res: Response, next: NextFunction) {
  try {
    let s = unseal(readCookie(req));
    if (s && Date.now() - s.chk > RECHECK_MS) {
      const { appId } = config();
      const r = await portalPost("check", { app_id: appId, user_id: s.id }).catch(() => null);
      if (r?.status === 200 && r.body.allowed) {
        s = { ...s, role: r.body.role ?? s.role, chk: Date.now() };
        writeCookie(req, res, s);
      } else if (r?.status === 200) {
        s = null; // access removed in the portal
        writeCookie(req, res, null);
      } // portal unreachable: keep the session until the next check
    }
    if (s) res.locals.portalUser = { id: s.id, email: s.email, name: s.name, role: s.role } satisfies PortalUser;
    next();
  } catch (err) {
    next(err);
  }
}

export function requirePortalUser(opts: { allow?: string[] } = {}) {
  const open = new Set(opts.allow ?? []);
  return (req: Request, res: Response, next: NextFunction) => {
    if (open.has(req.path) || res.locals.portalUser) return next();
    res.status(401).json({ error: "portal_sign_in_required", portalUrl: portalLaunchUrl() });
  };
}

// A stable UUID for the signed-in portal user (UUID v5 format from a SHA-1 of the user ID),
// for apps that key saved data by an "ownerId" UUID the browser used to invent.
export function portalOwnerId(user: PortalUser): string {
  const h = crypto.createHash("sha1").update(`twig-portal-owner:${user.id}`).digest("hex");
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// Replaces a client-sent owner field (query string or JSON body) with the portal user's own
// ID, so users can only ever reach their own saved data. Mount after portalSession.
export function portalOwner(field: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = res.locals.portalUser as PortalUser | undefined;
    if (!user) return next();
    const id = portalOwnerId(user);
    if (req.query && field in req.query) {
      Object.defineProperty(req, "query", { value: { ...req.query, [field]: id }, configurable: true, writable: true });
    }
    if (req.body && typeof req.body === "object" && field in req.body) (req.body as Record<string, unknown>)[field] = id;
    next();
  };
}

// Restrict a route to some roles, e.g. router.post("/x", requirePortalRole("admin"), handler).
export function requirePortalRole(...roles: PortalUser["role"][]) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const user = res.locals.portalUser as PortalUser | undefined;
    if (!user) {
      res.status(401).json({ error: "portal_sign_in_required", portalUrl: portalLaunchUrl() });
      return;
    }
    if (!roles.includes(user.role)) {
      res.status(403).json({ error: "not_allowed", message: "Only Twig admins can do this." });
      return;
    }
    next();
  };
}

// ---- Reporting activity to the portal ----------------------------------------------------
// Best effort: reporting never slows down or breaks what the student is doing.
export interface PortalEvent {
  type: "exam_started" | "exam_left" | "exam_returned" | "exam_submitted" | "exam_timed_out" | "exam_quit" | "claude_used" | "voice_used" | "action";
  at?: string; // ISO time; defaults to now
  ref?: string; // ties together the events of one exam attempt
  title?: string; // e.g. the paper's name
  label?: string; // e.g. "Follow-up question"
  score?: number;
  total?: number;
}

export async function reportPortalEvent(user: PortalUser, event: PortalEvent) {
  const { appId } = config();
  // The ID makes a retry safe: the portal keeps only one copy.
  const body = { app_id: appId, user_id: user.id, events: [{ ...event, id: crypto.randomUUID(), at: event.at ?? new Date().toISOString() }] };
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await portalPost("events", body).catch(() => null);
    if (r && r.status < 500) return; // a rejected report won't get better by retrying
  }
}

// Reports chosen API calls once they succeed, so an app's route code needs no changes.
//   app.use(portalTrack([{ match: "POST /api/tests/:code/submit", type: "exam_submitted", ref: "{code}" }]));
// ref, title and label may use {name} for a part of the path. Mount after portalSession.
export interface PortalTrackRule extends Omit<PortalEvent, "at" | "score" | "total"> { match: string }

export function portalTrack(rules: PortalTrackRule[]) {
  const compiled = rules.map((rule) => {
    const [method, pattern] = rule.match.split(" ") as [string, string];
    const source = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:(\w+)/g, "(?<$1>[^/]+)");
    return { rule, method, regex: new RegExp(`^${source}/?$`) };
  });
  return (req: Request, res: Response, next: NextFunction) => {
    const path = req.originalUrl.split("?")[0]!;
    const hit = compiled.find((c) => c.method === req.method && c.regex.test(path));
    if (hit) {
      res.on("finish", () => {
        const user = res.locals.portalUser as PortalUser | undefined;
        if (!user || res.statusCode >= 400) return;
        const groups = hit.regex.exec(path)?.groups ?? {};
        const fill = (text?: string) => text?.replace(/\{(\w+)\}/g, (_m, name: string) => decodeURIComponent(groups[name] ?? ""));
        void reportPortalEvent(user, {
          type: hit.rule.type, ref: fill(hit.rule.ref), title: fill(hit.rule.title), label: fill(hit.rule.label),
        }).catch(() => {});
      });
    }
    next();
  };
}

export const portalRoutes = Router();

// Exam steps from the browser (see reportExamEvent in PortalGate.tsx), for the signed-in user only.
// Claude and voice use are reported by the server, so a student can't add to those counts.
const BROWSER_EVENTS = new Set<PortalEvent["type"]>(["exam_started", "exam_left", "exam_returned", "exam_submitted", "exam_timed_out", "exam_quit"]);
portalRoutes.post("/events", async (req, res) => {
  const user = res.locals.portalUser as PortalUser | undefined;
  const event = req.body as PortalEvent | undefined;
  if (!user) {
    res.status(401).json({ error: "portal_sign_in_required" });
    return;
  }
  if (!event || !BROWSER_EVENTS.has(event.type)) {
    res.status(400).json({ error: "invalid_event" });
    return;
  }
  const { type, at, ref, title, label, score, total } = event;
  await reportPortalEvent(user, { type, at, ref, title, label, score, total }).catch(() => {});
  res.status(204).end();
});

// The portal redirects here with ?code=...; swap it for the user, start the session.
portalRoutes.get("/callback", async (req, res, next) => {
  try {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const { appId } = config();
    const r = code ? await portalPost("exchange", { app_id: appId, code }) : null;
    if (r?.status !== 200) {
      res.status(r?.status === 403 ? 403 : 400).type("html").send(
        `<p>Sign-in didn't complete. <a href="${portalLaunchUrl()}">Try again from Twig</a>.</p>`);
      return;
    }
    const u = r.body.user as PortalUser;
    writeCookie(req, res, { id: u.id, email: u.email, name: u.name, role: u.role, exp: Date.now() + SESSION_MS, chk: Date.now() });
    res.redirect(303, "/");
  } catch (err) {
    next(err);
  }
});

portalRoutes.get("/me", (_req, res) => {
  if (!res.locals.portalUser) {
    res.status(401).json({ error: "portal_sign_in_required", portalUrl: portalLaunchUrl() });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({ user: res.locals.portalUser });
});

portalRoutes.get("/sign-out", (req, res) => {
  writeCookie(req, res, null);
  res.redirect(303, config().url);
});
