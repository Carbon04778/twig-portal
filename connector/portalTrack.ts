// Reports what students do inside an app to the Twig portal: exam steps, Claude and voice use, and
// other actions. Copied into artifacts/api-server/src/middlewares/ by install-tracking.mjs. It sits
// beside portalAuth.ts and doesn't change it. Uses the same PORTAL_* secrets, and Node built-ins only.
// Best effort: reporting never slows down or breaks what the student is doing.
import crypto from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";

export interface PortalEvent {
  type: "exam_started" | "exam_left" | "exam_returned" | "exam_submitted" | "exam_timed_out" | "exam_quit" | "claude_used" | "voice_used" | "action";
  at?: string; // ISO time; defaults to now
  ref?: string; // ties together the events of one exam attempt
  title?: string; // e.g. the paper's name
  label?: string; // e.g. "Follow-up question"
  score?: number;
  total?: number;
}

async function send(userId: number, event: PortalEvent) {
  const url = process.env.PORTAL_URL?.replace(/\/+$/, "");
  const appId = process.env.PORTAL_APP_ID;
  const secret = process.env.PORTAL_APP_SECRET;
  if (!url || !appId || !secret) return;
  // The ID makes a retry safe: the portal keeps only one copy.
  const body = JSON.stringify({
    app_id: appId, user_id: userId,
    events: [{ ...event, id: crypto.randomUUID(), at: event.at ?? new Date().toISOString() }],
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${url}/api/apps/events`, {
      method: "POST", headers: { "content-type": "application/json", "x-app-secret": secret }, body,
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (res && res.status < 500) return; // a rejected report won't get better by retrying
  }
}

export const reportPortalEvent = (user: { id: number }, event: PortalEvent) => send(user.id, event).catch(() => {});

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
        const user = res.locals.portalUser as { id: number } | undefined;
        if (!user || res.statusCode >= 400) return;
        const groups = hit.regex.exec(path)?.groups ?? {};
        const fill = (text?: string) => text?.replace(/\{(\w+)\}/g, (_m, name: string) => decodeURIComponent(groups[name] ?? ""));
        void reportPortalEvent(user, {
          type: hit.rule.type, ref: fill(hit.rule.ref), title: fill(hit.rule.title), label: fill(hit.rule.label),
        });
      });
    }
    next();
  };
}

// Exam steps from the browser (see PortalExam.tsx), for the signed-in user only. Claude and voice
// use are reported by the server, so a student can't add to those counts. Mount at /api/portal.
const BROWSER_EVENTS = new Set<PortalEvent["type"]>(["exam_started", "exam_left", "exam_returned", "exam_submitted", "exam_timed_out", "exam_quit"]);
export const portalEvents = Router();
portalEvents.post("/events", async (req, res) => {
  const user = res.locals.portalUser as { id: number } | undefined;
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
  await reportPortalEvent(user, { type, at, ref, title, label, score, total });
  res.status(204).end();
});
