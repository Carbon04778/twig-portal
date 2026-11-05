// Connects one of Donnell's pnpm-workspace apps to the Twig portal.
// Run from the app's project root:
//   node <twig-portal>/connector/install.mjs --web artifacts/<web-app> [options]
// Options:
//   --admin-route '<exact route start>'  make that route admin-only (repeatable), e.g.
//                                        'router.put("/chemistry/topics/weights",'
//   --clerk-shim                         the app uses Clerk: point its @clerk/* imports at
//                                        portal-backed stand-ins (portalClerkServer.ts / portalClerk.tsx)
//   --owner-field <name>                 the app keys saved data by a client-sent owner ID
//                                        (e.g. ownerId): replace it with the signed-in user's ID
//
// It only edits when every expected anchor is found exactly once; otherwise it changes nothing
// and says why. Running it again is safe (already-done steps are skipped). Check `git diff`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const web = opt("--web")[0];
const adminRoutes = opt("--admin-route");
const clerkShim = args.includes("--clerk-shim");
const ownerField = opt("--owner-field")[0];
if (!web) throw new Error("--web artifacts/<web-app> is required");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.cwd();
const api = path.join(root, "artifacts/api-server/src");
const webSrc = path.join(root, web, "src");
for (const dir of [api, webSrc]) if (!fs.existsSync(dir)) throw new Error(`not found: ${path.relative(root, dir)}. Run from the project root.`);

const pending = new Map(); // file -> new text (written only if every check passes)
const notes = [];
const read = (f) => (pending.has(f) ? pending.get(f) : fs.readFileSync(f, "utf8"));
const write = (f, text) => pending.set(f, text);
const copy = (from, to) => write(to, fs.readFileSync(path.join(here, from), "utf8"));
function once(text, needle, file) {
  const n = text.split(needle).length - 1;
  if (n !== 1) throw new Error(`${path.relative(root, file)}: expected exactly one "${needle}", found ${n}. Nothing was changed.`);
}
function walk(dir, exts) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(f, exts);
    return exts.some((x) => e.name.endsWith(x)) ? [f] : [];
  });
}
const rel = (from, to) => {
  let r = path.relative(path.dirname(from), to).split(path.sep).join("/").replace(/\.tsx?$/, "");
  return r.startsWith(".") ? r : `./${r}`;
};

// 1. Server: portalAuth.ts + app.ts wiring.
copy("portalAuth.ts", path.join(api, "middlewares/portalAuth.ts"));
const appTs = path.join(api, "app.ts");
let app = read(appTs);
if (app.includes("./middlewares/portalAuth")) notes.push("app.ts already wired (skipped)");
else {
  const routerImport = app.match(/import router from ["']\.\/routes["'];/)?.[0];
  const mount = app.match(/app\.use\(["']\/api["'], router\);/)?.[0];
  if (!routerImport || !mount) throw new Error("app.ts: router import or app.use(\"/api\", router) not found. Nothing was changed.");
  once(app, mount, appTs);
  const names = ["portalRoutes", "portalSession", "requirePortalUser", ...(ownerField ? ["portalOwner"] : [])];
  app = app
    .replace(routerImport, `${routerImport}\nimport { ${names.join(", ")} } from "./middlewares/portalAuth";`)
    .replace(mount,
      "// Twig portal sign-in: every API route needs a signed-in portal user (except health).\n" +
      'app.use(portalSession);\napp.use("/api/portal", portalRoutes);\n' +
      'app.use("/api", requirePortalUser({ allow: ["/healthz"] }));\n' +
      (ownerField ? `// Saved data belongs to the signed-in user, whatever "${ownerField}" the browser sends.\napp.use("/api", portalOwner("${ownerField}"));\n` : "") +
      `\n${mount}`);
  write(appTs, app);
}

// 2. Admin-only routes.
for (const route of adminRoutes) {
  const file = walk(path.join(api, "routes"), [".ts"]).find((f) => read(f).includes(route));
  if (!file) throw new Error(`route not found in src/routes: ${route}. Nothing was changed.`);
  let text = read(file);
  if (text.includes(`${route} requirePortalRole("admin"),`)) { notes.push(`${route} already admin-only (skipped)`); continue; }
  once(text, route, file);
  text = text.replace(route, `${route} requirePortalRole("admin"),`);
  if (!/requirePortalRole[^;]*from ["'][^"']*portalAuth["']/.test(text)) {
    text = `import { requirePortalRole } from "${rel(file, path.join(api, "middlewares/portalAuth.ts"))}";\n${text}`;
  }
  write(file, text);
}

// 3. Frontend: PortalGate + wrap the app in main.tsx (inside <ErrorBoundary>).
copy("PortalGate.tsx", path.join(webSrc, "components/PortalGate.tsx"));
const mainTsx = path.join(webSrc, "main.tsx");
let main = read(mainTsx);
if (main.includes("PortalGate")) notes.push("main.tsx already wrapped (skipped)");
else {
  const ebImport = main.match(/import \{ ErrorBoundary \} from ['"]@\/components\/error-boundary['"];/)?.[0];
  if (!ebImport) throw new Error("main.tsx: ErrorBoundary import not found. Nothing was changed.");
  once(main, "<ErrorBoundary>", mainTsx);
  once(main, "</ErrorBoundary>", mainTsx);
  main = main
    .replace(ebImport, `${ebImport}\nimport { PortalGate } from '@/components/PortalGate';`)
    .replace("<ErrorBoundary>", "<ErrorBoundary>\n    <PortalGate>")
    .replace("</ErrorBoundary>", "</PortalGate>\n  </ErrorBoundary>");
  write(mainTsx, main);
}

// 4. Clerk stand-ins: repoint @clerk/* imports.
if (clerkShim) {
  const serverShim = path.join(api, "middlewares/portalClerkServer.ts");
  copy("portalClerkServer.ts", serverShim);
  copy("portalClerk.tsx", path.join(webSrc, "lib/portalClerk.tsx"));
  let n = 0;
  for (const f of walk(api, [".ts"])) {
    if (f === serverShim || /\.test\.ts$/.test(f)) continue;
    const t = read(f);
    const u = t.replace(/from (["'])@clerk\/(express|shared\/keys)\1/g, (_m, q) => `from ${q}${rel(f, serverShim)}${q}`);
    if (u !== t) { write(f, u); n++; }
  }
  for (const f of walk(webSrc, [".ts", ".tsx"])) {
    if (f.endsWith(`${path.sep}portalClerk.tsx`) || /\.test\.tsx?$/.test(f)) continue;
    const t = read(f);
    const u = t.replace(/from (["'])@clerk\/(react\/internal|react|themes)\1/g, (_m, q) => `from ${q}@/lib/portalClerk${q}`);
    if (u !== t) { write(f, u); n++; }
  }
  notes.push(n ? `Clerk imports repointed in ${n} file(s)` : "no @clerk imports left to repoint (skipped)");
}

// All checks passed: write.
for (const [file, text] of pending) {
  const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (old === text) continue;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  console.log(`${old === null ? "added  " : "edited "} ${path.relative(root, file)}`);
}
for (const n of notes) console.log(n);
console.log("\nDone. Next: run the typecheck, commit, then publish.");
