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
  const CARA = "clerk_cara|cara@example.com|Cara Ng";
  const DETAILS = { full_name: "Amy Tan", school: "=HYPERLINK(\"x\")", level: "JC2", exam_year: String(new Date().getFullYear() + 1), mobile: "+65 8123 4567", heard_from: "Google" };

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

    // Changing one switch must leave every other setting alone.
    await post("/api/admin/apps", DONNELL, { id: "keepme", name: "Keep", url: "https://keep.replit.app", description: "My app", public_access: true, sort_order: 7 });
    await call("/api/admin/apps/keepme", DONNELL, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    const kept = (await call("/api/admin/apps", DONNELL)).body.data.find((a: any) => a.id === "keepme");
    assert.deepEqual([kept.enabled, kept.description, kept.publicAccess, kept.sortOrder, kept.callbackPath],
      [false, "My app", true, 7, "/api/portal/callback"]);
    // (left switched off, so it doesn't appear as a tile in the later tests)

    const s = await post("/api/admin/apps/paper1/secret", DONNELL, {});
    paper1Secret = s.body.data.secret;
    assert.match(paper1Secret, /^tps_/);
    const list = await call("/api/admin/apps", DONNELL);
    assert.ok(!JSON.stringify(list.body).includes(paper1Secret), "secret never listed again");
    assert.equal(list.body.data.find((a: any) => a.id === "paper1").hasSecret, true);
  });

  test("pages and assets are served", async () => {
    for (const [p, text] of [["/", "one sign in"], ["/sign-in", "one sign in"], ["/sign-up/continue", "one sign in"], ["/admin", "Student codes"], ["/assets/portal.js", "mountSignIn"], ["/config.js", "clerkPublishableKey"]] as const) {
      const r = await fetch(`${base}${p}`);
      assert.equal(r.status, 200, p);
      assert.ok((await r.text()).includes(text), `${p} contains "${text}"`);
    }
    assert.equal((await fetch(`${base}/assets/twig-logo.png`)).headers.get("content-type"), "image/png");
    assert.equal((await fetch(`${base}/assets/twig-logo-light.png`)).headers.get("content-type"), "image/png");
  });

  test("config.js: same Clerk key as the server; proxy only for production keys on the deployment", async () => {
    const config = async () => {
      const text = await (await fetch(`${base}/config.js`)).text();
      return JSON.parse(text.replace(/^window\.TWIG = /, "").replace(/;$/, ""));
    };
    const saved = { key: process.env.CLERK_PUBLISHABLE_KEY, dep: process.env.REPLIT_DEPLOYMENT };
    try {
      const devKey = `pk_test_${Buffer.from("example-dev.clerk.accounts.dev$").toString("base64")}`;
      process.env.CLERK_PUBLISHABLE_KEY = devKey;
      process.env.REPLIT_DEPLOYMENT = "1";
      assert.deepEqual(await config(), { clerkPublishableKey: devKey, clerkProxyPath: null }, "dev key: used as-is, never proxied");

      process.env.CLERK_PUBLISHABLE_KEY = `pk_live_${Buffer.from("clerk.example.com$").toString("base64")}`;
      const live = await config();
      assert.equal(Buffer.from(live.clerkPublishableKey.split("_")[2], "base64").toString(), "clerk.127.0.0.1$", "derived from the host");
      assert.equal(live.clerkProxyPath, "/api/__clerk");

      delete process.env.REPLIT_DEPLOYMENT;
      assert.equal((await config()).clerkProxyPath, null, "not on the deployment: no proxy");
    } finally {
      if (saved.key === undefined) delete process.env.CLERK_PUBLISHABLE_KEY; else process.env.CLERK_PUBLISHABLE_KEY = saved.key;
      if (saved.dep === undefined) delete process.env.REPLIT_DEPLOYMENT; else process.env.REPLIT_DEPLOYMENT = saved.dep;
    }
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

    assert.equal((await call("/launch/paper1", AMY)).location, "/?next=%2Flaunch%2Fpaper1", "details form comes first");
    assert.equal((await post("/api/profile", AMY, { ...DETAILS, mobile: "12" })).status, 400, "bad mobile");
    assert.equal((await post("/api/profile", AMY, { ...DETAILS, level: "J3" })).status, 400, "bad level");
    const { exam_year: _omitted, ...noYear } = DETAILS;
    assert.equal((await post("/api/profile", AMY, noYear)).status, 400, "exam year is compulsory");
    assert.equal((await post("/api/profile", AMY, { ...DETAILS, exam_year: "" })).status, 400, "empty exam year");
    assert.equal((await post("/api/profile", AMY, { ...DETAILS, exam_year: "1999" })).status, 400, "exam year out of range");
    assert.equal((await post("/api/profile", AMY, DETAILS)).status, 200);

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
      const { portalRoutes, portalSession, requirePortalRole, requirePortalUser } = await import("../connector/portalAuth.js");
      fake.use(portalSession);
      fake.use("/api/portal", portalRoutes);
      fake.use("/api", requirePortalUser({ allow: ["/healthz"] }));
      fake.get("/api/healthz", (_req, res) => { res.json({ ok: true }); });
      fake.post("/api/admin-thing", requirePortalRole("admin"), (_req, res) => { res.json({ ok: true }); });
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
      assert.equal((await fetch(`${fakeBase}/api/admin-thing`, { method: "POST", headers: { cookie } })).status, 200, "admin passes requirePortalRole");
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

  test("sign-up details reach the sheet, and a failed copy is sent later", async () => {
    const { setSheetTransport } = await import("../src/lib/profile.js");
    const writes: { path: string; values: any[][] }[] = [];
    let sheetDown = false;
    setSheetTransport(async (p, init) => {
      if (sheetDown) return new Response("{}", { status: 503 });
      if (init.method === "GET") return Response.json({ values: writes.length ? [["header"]] : undefined });
      writes.push({ path: p, values: JSON.parse(String(init.body)).values });
      return Response.json({});
    });

    // Not connected yet: saved, student not blocked, nothing lost.
    delete process.env.GOOGLE_SHEET_ID;
    assert.equal((await post("/api/profile", BEN, { ...DETAILS, full_name: "Ben Lim" })).status, 200);
    let list = await call("/api/admin/signups", DONNELL);
    assert.equal(list.body.sheetIsSet, false);
    assert.equal(list.body.data.find((r: any) => r.email === "ben@example.com").sheetSyncedAt, null);

    process.env.GOOGLE_SHEET_ID = "sheet123";
    const sent = await post("/api/admin/signups/sync", DONNELL, {});
    assert.equal(sent.body.data.status, "sent");
    assert.equal(writes[0]!.values[0]![0], "Signed up (SGT)", "header row first");
    const row = writes[1]!.values.find((r) => r[2] === "ben@example.com")!;
    assert.deepEqual(row.slice(1, 8), ["Ben Lim", "ben@example.com", "+6581234567", DETAILS.school, "JC2", Number(DETAILS.exam_year), "Google"]);
    assert.equal(writes[0]!.values[0]![6], "Exam year", "header lines up with the row");
    assert.match(writes[1]!.path, /:append\?valueInputOption=RAW/, "RAW: a typed formula stays text");

    // Sheet down: the student still gets in, and the row goes with the next send.
    sheetDown = true;
    assert.equal((await post("/api/profile", CARA, { ...DETAILS, full_name: "Cara Ng" })).status, 200);
    list = await call("/api/admin/signups", DONNELL);
    assert.match(list.body.data.find((r: any) => r.email === "cara@example.com").sheetError, /503/);
    sheetDown = false;
    assert.equal((await post("/api/admin/signups/sync", DONNELL, {})).body.data.sent, 1);
    assert.equal((await post("/api/admin/signups/sync", DONNELL, {})).body.data.status, "nothing_to_send", "never sent twice");

    // A second submit can't overwrite the first answer.
    await post("/api/profile", CARA, { ...DETAILS, full_name: "Someone Else" });
    assert.equal((await call("/api/me", CARA)).body.user.name, "Cara Ng");

    const csv = await call("/api/admin/signups.csv", DONNELL);
    assert.match(String(csv.body), /'=HYPERLINK/, "formula neutralised in the CSV");
    assert.match(String(csv.body), /,\+6581234567,/, "phone number left alone");
    assert.equal((await call("/api/admin/signups.csv", BEN)).status, 403);
  });

  test("usage: opens and estimated time per app and student; admin not counted", async () => {
    await call("/launch/paper1", DONNELL);
    const amy = (await call("/api/admin/users?q=amy", DONNELL)).body.data[0];
    await mod.pool.query("delete from app_sessions");
    await call("/launch/paper1", AMY);
    await mod.pool.query("update app_sessions set started_at = now() - interval '20 minutes', last_active_at = now() - interval '5 minutes'");
    const chk = await post("/api/apps/check", null, { app_id: "paper1", user_id: amy.id }, { "x-app-secret": paper1Secret });
    assert.equal(chk.body.allowed, true);

    const usage = await call("/api/admin/usage?days=7", DONNELL);
    assert.deepEqual(usage.body.byApp.map((a: any) => [a.appId, a.opens, a.students, a.minutes]), [["paper1", 1, 1, 20]]);
    assert.deepEqual(usage.body.students.map((s: any) => [s.email, s.opens, s.minutes]), [["amy@example.com", 1, 20]]);

    // Coming back long after: a new visit, not one long one, and not counted as an open.
    await mod.pool.query("update app_sessions set last_active_at = now() - interval '2 hours'");
    await post("/api/apps/check", null, { app_id: "paper1", user_id: amy.id }, { "x-app-secret": paper1Secret });
    const later = await call("/api/admin/usage?days=7", DONNELL);
    assert.equal(later.body.byApp[0].opens, 1);
    assert.equal((await mod.pool.query("select count(*)::int as n from app_sessions")).rows[0].n, 2);
    assert.match(String((await call("/api/admin/usage.csv?days=7", DONNELL)).body), /Came back/);
    assert.equal((await call("/api/admin/usage", AMY)).status, 403);

    // Google Sheet: finished visits only, in their own tab, each sent once.
    const { setSheetTransport } = await import("../src/lib/profile.js");
    const sheet: { path: string; method: string; body: any }[] = [];
    let tabs: string[] = ["Sheet1"];
    let down = false;
    setSheetTransport(async (p, init) => {
      if (down) return new Response("{}", { status: 503 });
      const body = init.body ? JSON.parse(String(init.body)) : null;
      sheet.push({ path: p, method: init.method!, body });
      if (p.includes("?fields=")) return Response.json({ sheets: tabs.map((title) => ({ properties: { title } })) });
      if (p.endsWith(":batchUpdate")) tabs = [...tabs, body.requests[0].addSheet.properties.title];
      return Response.json({});
    });
    process.env.GOOGLE_SHEET_ID = "sheet123";
    await mod.pool.query("delete from app_sessions");
    await call("/launch/paper1", DONNELL); // admin: never sent
    await call("/launch/paper1", AMY); // still going: must wait
    await call("/launch/paper1", AMY);
    await mod.pool.query(`update app_sessions set started_at = now() - interval '2 hours', last_active_at = now() - interval '100 minutes'
      where id = (select min(s.id) from app_sessions s join users u on u.id = s.user_id where u.email = 'amy@example.com')`);

    down = true;
    assert.equal((await post("/api/admin/usage/sync", DONNELL, {})).body.data.status, "failed", "sheet down");
    assert.equal((await call("/api/admin/usage", DONNELL)).body.sheetWaiting, 2, "nothing marked sent");
    down = false;

    assert.deepEqual((await post("/api/admin/usage/sync", DONNELL, {})).body.data, { status: "sent", sent: 1 });
    assert.ok(tabs.includes("App activity"), "tab created");
    const append = sheet.find((s) => s.path.includes(":append"))!;
    assert.match(decodeURIComponent(append.path), /'App activity'!A:J:append\?valueInputOption=RAW/);
    const header = sheet.find((s) => s.method === "PUT")!.body.values[0];
    assert.equal(header[7], "App");
    assert.deepEqual(append.body.values.map((r: any[]) => [r[2], r[4], r[7], r[8]]), [[20, "amy@example.com", "Prelim MCQ Practice", "Opened"]]);
    assert.equal((await post("/api/admin/usage/sync", DONNELL, {})).body.data.status, "nothing_to_send", "never sent twice");
    assert.equal((await call("/api/admin/usage", DONNELL)).body.sheetWaiting, 1, "the running visit still waits");
    assert.equal((await post("/api/admin/usage/sync", AMY, {})).status, 403);
    setSheetTransport(async () => Response.json({}));
  });

  test("page text: edited in admin, shown to students, can be restored", async () => {
    const before = await call("/api/admin/content", DONNELL);
    assert.equal(before.body.data.apps.paper1.title, "Prelim MCQ Practice");
    const apps = { ...before.body.data.apps, paper1: { title: "New heading", text: "New words", label: "Tile", tags: ["One", "Two"], cta: "Go" } };
    const sections = Object.fromEntries(before.body.data.sections.map((s: any) => [s.id, { title: s.title, note: s.note }]));
    sections.practise.title = "Papers";
    const body = { intro: "Welcome!", sections, apps };
    assert.equal((await call("/api/admin/content", AMY, { method: "PUT", body: JSON.stringify(body) })).status, 403);
    assert.equal((await call("/api/admin/content", DONNELL, { method: "PUT", body: JSON.stringify(body) })).status, 200);

    const me = (await call("/api/me", AMY)).body;
    assert.equal(me.content.intro, "Welcome!");
    assert.equal(me.content.sections.find((s: any) => s.id === "practise").title, "Papers");
    assert.deepEqual(me.content.apps.paper1.tags, ["One", "Two"]);

    const empty = { ...body, apps: { ...apps, paper1: { ...apps.paper1, title: "" } } };
    assert.equal((await call("/api/admin/content", DONNELL, { method: "PUT", body: JSON.stringify(empty) })).status, 400, "a heading can't be blank");
    await call("/api/admin/content", DONNELL, { method: "DELETE" });
    assert.equal((await call("/api/me", AMY)).body.content.apps.paper1.title, "Prelim MCQ Practice");
  });

  describe("payment", () => {
    const fake = { status: "pending", amount: "20.00", currency: "SGD", created: [] as URLSearchParams[], apiKeys: [] as string[] };
    let hitpayServer: Server;
    const SALT = "webhook-salt";
    let payUser: any;
    const DAN = "clerk_dan|dan@example.com|Dan Goh";

    const settings = (over = {}) => call("/api/admin/payment", DONNELL, {
      method: "PUT",
      body: JSON.stringify({ enabled: true, price: 20, compare_at: 120, months: 12, refund_policy: "7 day refund.", ...over }),
    });
    const webhook = async (body: object, salt = SALT) => {
      const raw = JSON.stringify(body);
      const crypto = await import("node:crypto");
      return fetch(`${base}/api/hitpay/webhook`, {
        method: "POST", body: raw,
        headers: { "content-type": "application/json", "hitpay-signature": crypto.createHmac("sha256", salt).update(raw).digest("hex") },
      });
    };
    const startCheckout = async () => {
      const r = await post("/api/pay/start", DAN, {});
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return new URLSearchParams(fake.created.at(-1)!).get("reference_number")!;
    };

    before(async () => {
      const express = (await import("express")).default;
      const hp = express();
      hp.use(express.urlencoded({ extended: false }));
      hp.post("/v1/payment-requests", (req, res) => {
        fake.apiKeys.push(String(req.headers["x-business-api-key"]));
        fake.created.push(new URLSearchParams(req.body));
        const id = `00000000-0000-4000-8000-${String(fake.created.length).padStart(12, "0")}`;
        res.status(201).json({ id, url: `https://checkout.example/${id}`, status: "pending" });
      });
      hp.get("/v1/payment-requests/:id", (_req, res) => {
        res.json({ status: fake.status, amount: fake.amount, currency: fake.currency });
      });
      hitpayServer = hp.listen(0);
      await new Promise((r) => hitpayServer.once("listening", r));
      process.env.HITPAY_API_URL = `http://127.0.0.1:${(hitpayServer.address() as { port: number }).port}`;
      process.env.HITPAY_API_KEY = "test_key";
      process.env.HITPAY_WEBHOOK_SALT = SALT;
      delete process.env.HITPAY_SALT;
      delete process.env.HITPAY_MODE;
      await call("/api/me", DAN);
      await post("/api/profile", DAN, { ...DETAILS, full_name: "Dan Goh" });
      payUser = (await call("/api/admin/users?q=dan@", DONNELL)).body.data[0];
    });
    after(() => { hitpayServer?.close(); });

    test("off by default: no offer and no charge", async () => {
      assert.equal((await call("/api/me", DAN)).body.payment.offer, null);
      assert.equal((await post("/api/pay/start", DAN, {})).body.error, "payment_off");
      assert.equal(fake.created.length, 0);
      assert.equal((await call("/api/admin/payment", AMY)).status, 403);
    });

    test("a forged return or webhook gives nothing; a real payment unlocks every app for 12 months", async () => {
      assert.equal((await settings()).status, 200);
      const offer = (await call("/api/me", DAN)).body.payment.offer;
      assert.deepEqual([offer.priceCents, offer.compareAtCents, offer.months, offer.refundPolicy], [2000, 12000, 12, "7 day refund."]);

      const reference = await startCheckout();
      const sent = fake.created[0]!;
      assert.deepEqual([sent.get("amount"), sent.get("currency"), sent.get("email")], ["20.00", "SGD", "dan@example.com"]);
      assert.ok(sent.get("redirect_url")!.endsWith(`/?payment=${reference}`));
      assert.equal(fake.apiKeys[0], "test_key");
      await startCheckout();
      assert.equal(fake.created.length, 1, "clicking twice reuses the same checkout");

      // Coming back without paying.
      assert.equal((await post("/api/pay/check", DAN, { reference })).body.status, "pending");
      assert.equal((await call("/api/me", DAN)).body.user.role, "public");
      assert.equal((await post("/api/pay/check", BEN, { reference })).status, 404, "someone else's payment");

      // Forged signature, and a real signature while HitPay says unpaid.
      const hitpayId = (await mod.pool.query("select hitpay_request_id as id from payments where reference = $1", [reference])).rows[0].id;
      assert.equal((await webhook({ id: hitpayId }, "wrong-salt")).status, 401);
      assert.equal((await webhook({ id: hitpayId })).status, 200);
      assert.equal((await call("/api/me", DAN)).body.user.role, "public");

      // HitPay shows less than the price: no access.
      fake.status = "completed";
      fake.amount = "1.00";
      await webhook({ id: hitpayId });
      assert.equal((await call("/api/me", DAN)).body.user.role, "public");

      // Paid. Repeating the webhook and the return must not add time twice.
      fake.amount = "20.00";
      await Promise.all([webhook({ id: hitpayId }), webhook({ id: hitpayId }), post("/api/pay/check", DAN, { reference })]);
      const me = (await call("/api/me", DAN)).body;
      assert.equal(me.user.role, "student");
      assert.ok(me.apps.every((a: any) => a.canOpen));
      assert.equal(me.payment.offer, null, "no offer while plenty of time is left");
      const until = new Date(me.user.paidUntil);
      const months = (until.getFullYear() - new Date().getFullYear()) * 12 + until.getMonth() - new Date().getMonth();
      assert.equal(months, 12);

      // Connected apps see a student too.
      const chk = await post("/api/apps/check", null, { app_id: "paper1", user_id: payUser.id }, { "x-app-secret": paper1Secret });
      assert.equal(chk.body.role, "student");
      assert.equal((await post("/api/pay/start", DAN, {})).body.error, "not_needed");
    });

    test("switching payment off keeps paid access; refund and expiry return to free", async () => {
      await settings({ enabled: false });
      assert.equal((await call("/api/me", DAN)).body.user.role, "student", "off doesn't remove what was paid for");
      await settings();

      // Last month of access: may renew, and the new time stacks on what's left.
      await mod.pool.query("update users set paid_until = now() + interval '10 days' where id = $1", [payUser.id]);
      await mod.pool.query("update payments set access_until = now() + interval '10 days' where user_id = $1", [payUser.id]);
      assert.ok((await call("/api/me", DAN)).body.payment.offer, "renewal offered");
      fake.status = "pending";
      const reference = await startCheckout();
      fake.status = "completed";
      await post("/api/pay/check", DAN, { reference });
      const renewed = new Date((await call("/api/me", DAN)).body.user.paidUntil);
      assert.ok(renewed.getTime() > Date.now() + 370 * 86_400_000, "12 months on top of the 10 days");

      // Refunding the renewal goes back to the earlier end date; refunding that too means free.
      const list = (await call("/api/admin/payment", DONNELL)).body.data.payments.filter((p: any) => p.email === "dan@example.com");
      assert.equal(list.length, 2);
      assert.equal((await post(`/api/admin/payments/${list[0].id}/refund`, AMY, {})).status, 403);
      await post(`/api/admin/payments/${list[0].id}/refund`, DONNELL, {});
      const back = new Date((await call("/api/me", DAN)).body.user.paidUntil);
      assert.ok(back.getTime() < Date.now() + 11 * 86_400_000);
      assert.equal((await post(`/api/admin/payments/${list[0].id}/refund`, DONNELL, {})).status, 400, "only once");
      await post(`/api/admin/payments/${list[1].id}/refund`, DONNELL, {});
      assert.equal((await call("/api/me", DAN)).body.user.role, "public");

      // Time running out needs no job: the student is simply free again.
      await mod.pool.query("update users set paid_until = now() - interval '1 minute' where id = $1", [payUser.id]);
      const expired = (await call("/api/me", DAN)).body;
      assert.equal(expired.user.role, "public");
      assert.ok(expired.payment.offer, "can pay again");
      assert.equal((await call("/launch/worksheets", DAN)).location, "/?denied=worksheets");
    });
  });
});
