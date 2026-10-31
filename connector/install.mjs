// Connects one of Donnell's pnpm-workspace apps to the Twig portal.
// Run from the app's project root:
//   node <twig-portal>/connector/install.mjs --web artifacts/<web-app> [--admin-route "<exact route start>"]...
// Example (A-Level MCQ):
//   node /tmp/twig-portal/connector/install.mjs --web artifacts/chemistry-mcq \
//     --admin-route 'router.put("/chemistry/topics/weights",' \
//     --admin-route 'router.post("/chemistry/questions/import",'
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
if (!web) throw new Error("--web artifacts/<web-app> is required");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.cwd();
const api = path.join(root, "artifacts/api-server/src");
const plan = []; // { file, before, after } ; applied only if all are valid
const notes = [];

const read = (f) => fs.readFileSync(f, "utf8");
function once(text, needle, file) {
  const n = text.split(needle).length - 1;
  if (n !== 1) throw new Error(`${path.relative(root, file)}: expected exactly one "${needle}", found ${n}. Nothing was changed.`);
}

// 1. Server: middleware file + app.ts wiring.
const appTs = path.join(api, "app.ts");
let app = read(appTs);
if (app.includes("./middlewares/portalAuth")) notes.push("app.ts already wired (skipped)");
else {
  once(app, 'app.use("/api", router);', appTs);
  once(app, 'import router from "./routes";', appTs);
  app = app
    .replace('import router from "./routes";',
      'import router from "./routes";\nimport { portalRoutes, portalSession, requirePortalUser } from "./middlewares/portalAuth";')
    .replace('app.use("/api", router);',
      '// Twig portal sign-in: every API route needs a signed-in portal user (except health).\n' +
      'app.use(portalSession);\napp.use("/api/portal", portalRoutes);\n' +
      'app.use("/api", requirePortalUser({ allow: ["/healthz"] }));\n\napp.use("/api", router);');
  plan.push({ file: appTs, text: app });
}
plan.push({ file: path.join(api, "middlewares/portalAuth.ts"), text: read(path.join(here, "portalAuth.ts")), copy: true });

// 2. Admin-only routes (exact route starts, e.g. 'router.put("/chemistry/topics/weights",').
for (const route of adminRoutes) {
  const file = fs.readdirSync(path.join(api, "routes")).map((f) => path.join(api, "routes", f))
    .find((f) => read(f).includes(route));
  if (!file) throw new Error(`route not found in src/routes: ${route}. Nothing was changed.`);
  const pending = plan.find((p) => p.file === file);
  let text = pending ? pending.text : read(file);
  const guarded = `${route} requirePortalRole("admin"),`;
  if (text.includes(guarded)) { notes.push(`${route} already admin-only (skipped)`); continue; }
  once(text, route, file);
  text = text.replace(route, guarded);
  if (!text.includes("requirePortalRole } from")) {
    text = `import { requirePortalRole } from "../middlewares/portalAuth";\n${text}`;
  }
  if (pending) pending.text = text; else plan.push({ file, text });
}

// 3. Frontend: PortalGate component + wrap <App /> in main.tsx.
const webSrc = path.join(root, web, "src");
const mainTsx = path.join(webSrc, "main.tsx");
let main = read(mainTsx);
if (main.includes("PortalGate")) notes.push("main.tsx already wrapped (skipped)");
else {
  once(main, "<App />", mainTsx);
  once(main, "import App from './App';", mainTsx);
  main = main
    .replace("import App from './App';", "import App from './App';\nimport { PortalGate } from '@/components/PortalGate';")
    .replace("<App />", "<PortalGate>\n      <App />\n    </PortalGate>");
  plan.push({ file: mainTsx, text: main });
}
plan.push({ file: path.join(webSrc, "components/PortalGate.tsx"), text: read(path.join(here, "PortalGate.tsx")), copy: true });

// All checks passed: write.
for (const p of plan) {
  fs.mkdirSync(path.dirname(p.file), { recursive: true });
  fs.writeFileSync(p.file, p.text);
  console.log(`${p.copy ? "copied " : "edited "} ${path.relative(root, p.file)}`);
}
for (const n of notes) console.log(n);
console.log("\nDone. Next: set the secrets PORTAL_URL, PORTAL_APP_ID, PORTAL_APP_SECRET, run the typecheck, then publish.");
