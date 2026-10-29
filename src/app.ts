import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { clerkIdentity, type IdentityProvider } from "./auth/identity.js";
import { adminApi } from "./routes/admin.js";
import { appApi, launch, loadUser, userApi } from "./routes/portal.js";

const publicDir = path.resolve(import.meta.dirname, "../public");

// identify: who is signed in. Defaults to Clerk; tests pass a stand-in.
export async function createApp(opts: { identify?: IdentityProvider } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  const usingClerk = !opts.identify;
  if (usingClerk) {
    const { CLERK_PROXY_PATH, clerkProxyMiddleware, getClerkProxyHost } = await import("./auth/clerkProxy.js");
    const { clerkMiddleware } = await import("@clerk/express");
    const { publishableKeyFromHost } = await import("@clerk/shared/keys");
    app.use(CLERK_PROXY_PATH, clerkProxyMiddleware()); // before the body parsers
    app.use(clerkMiddleware((req) => ({
      publishableKey: publishableKeyFromHost(getClerkProxyHost(req) ?? "", process.env.CLERK_PUBLISHABLE_KEY),
    })));
  }

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // App-to-portal API: no browser session, authenticated by the app secret.
  app.use("/api/apps", express.json({ limit: "10kb" }), appApi);

  app.use(express.json({ limit: "100kb" }));
  app.use(loadUser(opts.identify ?? clerkIdentity()));
  app.use(launch);
  app.use("/api", userApi);
  app.use("/api/admin", adminApi);

  // Public config for the pages: the Clerk publishable key (safe to expose) and, in production,
  // the proxy path Clerk is reached through (the proxy only runs in production).
  app.get("/config.js", (_req, res) => {
    res.type("application/javascript").setHeader("Cache-Control", "no-store");
    res.send(`window.TWIG = ${JSON.stringify({
      clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY ?? null,
      clerkProxyPath: process.env.NODE_ENV === "production" ? "/api/__clerk" : null,
    })};`);
  });
  app.use(express.static(publicDir, { extensions: ["html"], index: "index.html" }));
  app.get("/admin", (_req, res) => res.sendFile(path.join(publicDir, "admin.html")));

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: "invalid_request", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    console.error(`${req.method} ${req.path} failed:`, err);
    res.status(500).json({ error: "internal_error" });
  });
  return app;
}
