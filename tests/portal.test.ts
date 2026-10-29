// Portal end to end against a temporary PostgreSQL 16, with a stand-in for Clerk:
// the test sends "x-test-user: <clerkId>|<email>|<name>" to act as a signed-in user.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import EmbeddedPostgres from "embedded-postgres";
import { canOpen, formatPromoCode, normalizePromoCode, promoProblem } from "../src/lib/access.js";

test("access rules", () => {
  const app = { enabled: true, publicAccess: false };
  const open = { enabled: true, publicAccess: true };
  assert.equal(canOpen({ role: "public", status: "active" }, app), false);
  assert.equal(canOpen({ role: "public", status: "active" }, open), true);
  assert.equal(canOpen({ role: "student", status: "active" }, app), true);
  assert.equal(canOpen({ role: "admin", status: "active" }, app), true);
  assert.equal(canOpen({ role: "student", status: "revoked" }, open), false, "revoked: nothing");
  assert.equal(canOpen({ role: "admin", status: "active" }, { enabled: false, publicAccess: true }), false, "disabled app");
  assert.equal(canOpen({ role: "student", status: "active" }, app, false), false, "override blocks");
  assert.equal(canOpen({ role: "public", status: "active" }, app, true), true, "override grants");
});

test("promo code normalising and checks", () => {
  assert.equal(normalizePromoCode(" abcd-efgh "), "ABCDEFGH");
  assert.equal(normalizePromoCode("abcd efgh"), "ABCDEFGH");
  assert.equal(formatPromoCode("ABCDEFGH"), "ABCD-EFGH");
  const ok = { maxUses: 2, uses: 1, expiresAt: null, revokedAt: null };
  assert.equal(promoProblem(ok), null);
  assert.equal(promoProblem(undefined), "not_found");
  assert.equal(promoProblem({ ...ok, uses: 2 }), "used_up");
  assert.equal(promoProblem({ ...ok, revokedAt: new Date() }), "revoked");
  assert.equal(promoProblem({ ...ok, expiresAt: new Date(Date.now() - 1000) }), "expired");
});

describe("portal", () => {
  let postgres: EmbeddedPostgres;
  let dataDir = "";
  let http: Server;
  let base = "";
  let mod: { pool: typeof import("../src/db/client.js")["pool"] };

  const DONNELL = "clerk_admin|donnellkoh@gmail.com|Donnell Koh";
  const AMY = "clerk_amy|amy@example.com|Amy Tan";
  const BEN = "clerk_ben|ben@example.com|Ben Lim";

  async function call(p: string, as: string | null, init: RequestInit = {}) {
    const headers: Record<string, string> = { ...(as ? { "x-test-user": as } : {}), ...(init.body ? { "content-type": "application/json" } : {}) };
    const res = await fetch(`${base}${p}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) }, redirect: "manual" });
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* redirects and HTML */ }
    return { status: res.status, body, location: res.headers.get("location") };
  }
  const post = (p: string, as: string | null, body: unknown, headers: Record<string, string> = {}) =>
    call(p, as, { method: "POST", body: JSON.stringify(body), headers });

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "portal-test-pg-"));
    const port = 46000 + Math.floor(Math.random() * 2000);
    postgres = new EmbeddedPostgres({
      databaseDir: dataDir, port, user: "postgres", password: "postgres", persistent: false,
      onLog: () => {}, initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await postgres.initialise();
    await postgres.start();
    await postgres.createDatabase("portal_test");
    process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/portal_test`;
    process.env.ADMIN_EMAILS = "donnellkoh@gmail.com";

    const client = await import("../src/db/client.js");
    mod = { pool: client.pool };
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(client.pool, () => {});
    const { createApp } = await import("../src/app.js");
    const app = await createApp({
      identify: async (req) => {
        const h = req.headers["x-test-user"];
        if (typeof h !== "string") return null;
        const [clerkId, email, name] = h.split("|");
        return { clerkId: clerkId!, email: email!, name: name ?? null };
      },
    });
    http = app.listen(0);
    await new Promise((r) => http.once("listening", r));
    base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  });

  after(async () => {
    http?.close();
    await mod?.pool.end();
    await postgres?.stop();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows may hold files briefly */ }
  });

  let paper1Secret = "";

  test("admin sets up apps; only admins may", async () => {
    assert.equal((await call("/api/admin/apps", null)).status, 401);
    assert.equal((await call("/api/admin/apps", AMY)).status, 403, "a normal user is not admin");
    const me = await call("/api/me", DONNELL);
    assert.equal(me.body.user.role, "admin", "ADMIN_EMAILS gives admin");

    for (const a of [
      { id: "paper1", name: "Paper 1 Practice", url: "https://h2chempaper1.replit.app", public_access: true, sort_order: 1 },
      { id: "worksheets", name: "Paper Generator", url: "https://h2chemworksheets.replit.app", sort_order: 2 },
      { id: "review", name: "ChemReview", url: "https://twigchemreview.replit.app", sort_order: 3 },
    ]) assert.equal((await post("/api/admin/apps", DONNELL, a)).status, 201);
    assert.equal((await post("/api/admin/apps", DONNELL, { id: "paper1", name: "x", url: "https://x.replit.app" })).status, 409);
    assert.equal((await post("/api/admin/apps", DONNELL, { id: "bad", name: "x", url: "http://evil.example" })).status, 400, "https only");

    const s = await post("/api/admin/apps/paper1/secret", DONNELL, {});
    paper1Secret = s.body.data.secret;
    assert.match(paper1Secret, /^tps_/);
    const list = await call("/api/admin/apps", DONNELL);
    assert.ok(!JSON.stringify(list.body).includes(paper1Secret), "secret never listed again");
    assert.equal(list.body.data.find((a: any) => a.id === "paper1").hasSecret, true);
  });

  test("pages and assets are served", async () => {
    for (const [p, text] of [["/", "one sign in"], ["/admin", "Student codes"], ["/assets/portal.js", "mountSignIn"], ["/config.js", "clerkPublishableKey"]] as const) {
      const r = await fetch(`${base}${p}`);
      assert.equal(r.status, 200, p);
      assert.ok((await r.text()).includes(text), `${p} contains "${text}"`);
    }
    assert.equal((await fetch(`${base}/assets/twig-logo.png`)).headers.get("content-type"), "image/png");
  });

  test("a new user is public and sees only the public app", async () => {
    assert.equal((await call("/api/me", null)).status, 401);
    const me = await call("/api/me", AMY);
    assert.equal(me.body.user.role, "public");
    assert.deepEqual(me.body.apps.map((a: any) => [a.id, a.canOpen]), [["paper1", true], ["worksheets", false], ["review", false]]);
  });

  test("promo code turns a public user into a student", async () => {
    const created = await post("/api/admin/promo-codes", DONNELL, { label: "J2 class", max_uses: 1 });
    assert.equal(created.status, 201);
    const code = created.body.data.code as string;
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const wrong = await post("/api/redeem", AMY, { code: "NOPE-NOPE" });
    assert.equal(wrong.body.error, "not_found");
    const ok = await post("/api/redeem", AMY, { code: code.toLowerCase().replace("-", " ") });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.user.role, "student");
    assert.ok(ok.body.apps.every((a: any) => a.canOpen));

    assert.equal((await post("/api/redeem", AMY, { code })).body.error, "already_student");
    await call("/api/me", BEN);
    assert.equal((await post("/api/redeem", BEN, { code })).body.error, "used_up", "max_uses 1");

    const red = await call(`/api/admin/promo-codes/${created.body.data.id}/redemptions`, DONNELL);
    assert.deepEqual(red.body.data.map((r: any) => r.email), ["amy@example.com"]);
  });

  test("revoked and expired codes are refused; racing redemptions never exceed max_uses", async () => {
    const r = await post("/api/admin/promo-codes", DONNELL, { code: "TWIG-REV1" });
    await post(`/api/admin/promo-codes/${r.body.data.id}/revoke`, DONNELL, {});
    assert.equal((await post("/api/redeem", BEN, { code: "twigrev1" })).body.error, "revoked");
    await post("/api/admin/promo-codes", DONNELL, { code: "OLDCODE1", expires_at: new Date(Date.now() - 60_000).toISOString() });
    assert.equal((await post("/api/redeem", BEN, { code: "OLDCODE1" })).body.error, "expired");

    const race = await post("/api/admin/promo-codes", DONNELL, { code: "RACE2X", max_uses: 2 });
    const racers = Array.from({ length: 6 }, (_, i) => `clerk_r${i}|r${i}@example.com|R${i}`);
    for (const u of racers) await call("/api/me", u);
    const results = await Promise.all(racers.map((u) => post("/api/redeem", u, { code: "RACE2X" })));
    assert.equal(results.filter((x) => x.status === 200).length, 2);
    const list = await call("/api/admin/promo-codes", DONNELL);
    assert.equal(list.body.data.find((p: any) => p.id === race.body.data.id).uses, 2);
  });

  test("launch: redirect with a one-time code, exchanged once by the app", async () => {
    const out = await call("/launch/paper1", null);
    assert.equal(out.status, 303);
    assert.equal(out.location, "/?next=%2Flaunch%2Fpaper1", "signed out: back to sign-in");

    const denied = await call("/launch/review", BEN); // Ben is public
    assert.equal(denied.location, "/?denied=review");

    const go = await call("/launch/paper1", AMY);
    assert.equal(go.status, 303);
    const target = new URL(go.location!);
    assert.equal(target.origin + target.pathname, "https://h2chempaper1.replit.app/api/portal/callback");
    const code = target.searchParams.get("code")!;

    const bad = await post("/api/apps/exchange", null, { app_id: "paper1", code }, { "x-app-secret": "tps_wrong" });
    assert.equal(bad.status, 401);
    const other = await post("/api/apps/exchange", null, { app_id: "worksheets", code }, { "x-app-secret": paper1Secret });
    assert.equal(other.status, 401, "another app's secret");
    const ok = await post("/api/apps/exchange", null, { app_id: "paper1", code }, { "x-app-secret": paper1Secret });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.user.email, ok.body.user.role], ["amy@example.com", "student"]);
    const again = await post("/api/apps/exchange", null, { app_id: "paper1", code }, { "x-app-secret": paper1Secret });
    assert.equal(again.body.error, "invalid_or_expired_code", "single use");
  });

  test("connector: an app signs users in through the portal with portalAuth.ts", async () => {
    // A stand-in app server wired exactly as the README tells each app to do it.
    const express = (await import("express")).default;
    const fake = express();
    const fakeHttp = fake.listen(0);
    await new Promise((r) => fakeHttp.once("listening", r));
    const fakeBase = `http://127.0.0.1:${(fakeHttp.address() as { port: number }).port}`;
    try {
      await post("/api/admin/apps", DONNELL, { id: "fakeapp", name: "Fake app", url: fakeBase });
      const secret = (await post("/api/admin/apps/fakeapp/secret", DONNELL, {})).body.data.secret;
      process.env.PORTAL_URL = base;
      process.env.PORTAL_APP_ID = "fakeapp";
      process.env.PORTAL_APP_SECRET = secret;
      const { portalRoutes, portalSession, requirePortalUser } = await import("../connector/portalAuth.js");
      fake.use(portalSession);
      fake.use("/api/portal", portalRoutes);
      fake.use("/api", requirePortalUser({ allow: ["/healthz"] }));
      fake.get("/api/healthz", (_req, res) => { res.json({ ok: true }); });
      fake.get("/api/data", (_req, res) => { res.json({ hello: res.locals.portalUser.email, role: res.locals.portalUser.role }); });

      // Signed out: the app's API says where to sign in.
      const anon = await fetch(`${fakeBase}/api/data`);
      assert.equal(anon.status, 401);
      assert.equal((await anon.json() as any).portalUrl, `${base}/launch/fakeapp`);
      assert.equal((await fetch(`${fakeBase}/api/healthz`)).status, 200, "allow-listed route stays open");

      // Ben (public) can't open a students-only app; Donnell (admin) can.
      assert.equal((await call("/launch/fakeapp", BEN)).location, "/?denied=fakeapp");
      const go = await call("/launch/fakeapp", DONNELL);
      const cb = await fetch(go.location!, { redirect: "manual" });
      assert.equal(cb.status, 303);
      assert.equal(cb.headers.get("location"), "/");
      const cookie = cb.headers.get("set-cookie")!.split(";")[0]!;
      assert.match(cookie, /^twig_portal=/);

      const data = await fetch(`${fakeBase}/api/data`, { headers: { cookie } });
      assert.deepEqual(await data.json(), { hello: "donnellkoh@gmail.com", role: "admin" });
      const me = await fetch(`${fakeBase}/api/portal/me`, { headers: { cookie } });
      assert.equal((await me.json() as any).user.email, "donnellkoh@gmail.com");

      // A tampered cookie is rejected; reusing the launch code fails.
      const forged = cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
      assert.equal((await fetch(`${fakeBase}/api/data`, { headers: { cookie: forged } })).status, 401);
      const reuse = await fetch(go.location!, { redirect: "manual" });
      assert.equal(reuse.status, 400);
    } finally {
      fakeHttp.close();
    }
  });

  test("admin can revoke, downgrade, and override access per app", async () => {
    const users = await call("/api/admin/users?q=amy", DONNELL);
    const amy = users.body.data[0];
    assert.equal(amy.email, "amy@example.com");

    // Block one app for Amy, then check the app-side re-check endpoint.
    await call(`/api/admin/users/${amy.id}/apps/paper1`, DONNELL, { method: "PUT", body: JSON.stringify({ allowed: false }) });
    const chk = await post("/api/apps/check", null, { app_id: "paper1", user_id: amy.id }, { "x-app-secret": paper1Secret });
    assert.equal(chk.body.allowed, false);
    assert.equal((await call("/launch/paper1", AMY)).location, "/?denied=paper1");
    await call(`/api/admin/users/${amy.id}/apps/paper1`, DONNELL, { method: "PUT", body: JSON.stringify({ allowed: null }) });

    // A code issued before revoking is refused at exchange time.
    const pending = new URL((await call("/launch/paper1", AMY)).location!).searchParams.get("code")!;
    await call(`/api/admin/users/${amy.id}`, DONNELL, { method: "PATCH", body: JSON.stringify({ status: "revoked" }) });
    const late = await post("/api/apps/exchange", null, { app_id: "paper1", code: pending }, { "x-app-secret": paper1Secret });
    assert.equal(late.status, 403);
    assert.equal((await call("/api/me", AMY)).body.error, "account_revoked");

    await call(`/api/admin/users/${amy.id}`, DONNELL, { method: "PATCH", body: JSON.stringify({ status: "active", role: "public" }) });
    const me = await call("/api/me", AMY);
    assert.equal(me.body.user.role, "public");
    assert.deepEqual(me.body.apps.filter((a: any) => a.canOpen).map((a: any) => a.id), ["paper1"]);

    const admins = await call("/api/admin/users?role=admin", DONNELL);
    assert.equal((await call(`/api/admin/users/${admins.body.data[0].id}`, DONNELL, { method: "PATCH", body: JSON.stringify({ status: "revoked" }) })).status, 400,
      "admins can't be changed from the panel");
    const audit = await call("/api/admin/audit", DONNELL);
    assert.ok(audit.body.data.some((a: any) => a.action === "promo.redeem"));
  });
});
