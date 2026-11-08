// Adds exam, Claude and activity reporting to a Twig app that is already connected to the portal.
// Run from the app's project root, after pulling twig-portal:
//   node <twig-portal>/connector/install-tracking.mjs --app <paper1|alevel-mcq|review|worksheets> --web artifacts/<web-app>
//
// It adds two new files and never replaces the app's portalAuth.ts or PortalGate.tsx, because live
// apps can have their own code in those (Paper Generator's teacher sign-in, for example). The only
// edit to portalAuth.ts is the access re-check timer, from 30 minutes to 5, for better time estimates.
//
// It changes nothing unless every expected piece of code is found exactly once, and says what is
// missing. Running it again is safe. Check `git diff`, run the typecheck, commit, then publish.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name) => args[args.indexOf(name) + 1];
const appId = args.includes("--app") ? opt("--app") : null;
const web = args.includes("--web") ? opt("--web") : null;

const IMPORT = "import { reportExamEvent, useExamPresence } from '@/components/PortalExam';";
const APPS = {
  paper1: {
    rules: [
      { match: "POST /api/explanations", type: "claude_used", label: "Explanation" },
      { match: "POST /api/explanations/:id/messages", type: "claude_used", label: "Follow-up question" },
      { match: "POST /api/explanations/:id/audio", type: "voice_used", label: "Voice reply" },
      { match: "POST /api/tests/:code/join", type: "exam_started", ref: "class-{code}", title: "Class test {code}" },
      { match: "POST /api/tests/:code/submit", type: "exam_submitted", ref: "class-{code}", title: "Class test {code}" },
    ],
    edits: [{
      file: "src/App.tsx",
      changes: [
        [
          "import { DiscardAttemptDialog } from '@/components/DiscardAttemptDialog';",
          `import { DiscardAttemptDialog } from '@/components/DiscardAttemptDialog';\n${IMPORT}\nconst examRef = (a: Attempt) => \`\${a.paperId}:\${a.startedAt}\`;`,
        ],
        [
          "    const next = startPracticeAttempt(paper, snapshot);\n",
          "    const replaced = readAttempt();\n    const next = startPracticeAttempt(paper, snapshot);\n" +
          "    if (replaced) reportExamEvent('exam_quit', { ref: examRef(replaced), title: getPracticePaper(replaced.paperId)?.title, label: 'Replaced by a new test' });\n" +
          "    reportExamEvent('exam_started', { ref: examRef(next), title: paper.title });\n",
        ],
        [
          "      discardPracticeAttempt(pendingDiscard.snapshot);\n",
          "      const discarded = readAttempt();\n      discardPracticeAttempt(pendingDiscard.snapshot);\n" +
          "      if (discarded) reportExamEvent('exam_quit', { ref: examRef(discarded), title: pendingDiscard.title });\n",
        ],
        [
          "    setAttempt(null);\n    setLocation(`/results/${encodeURIComponent(paper.id)}`);",
          "    reportExamEvent(timedOut ? 'exam_timed_out' : 'exam_submitted', { ref: examRef(activeAttempt), title: paper.title, score, total: paper.questions.length });\n" +
          "    setAttempt(null);\n    setLocation(`/results/${encodeURIComponent(paper.id)}`);",
        ],
        [
          "      setAttempt(existing);\n    } else {\n",
          "      reportExamEvent('exam_started', { ref: examRef(existing), title: paper.title });\n      setAttempt(existing);\n    } else {\n",
        ],
        [
          "  useEffect(() => {\n    if (!activeAttempt) return;\n    const timer = window.setInterval(() => {",
          "  useExamPresence(activeAttempt ? { ref: examRef(activeAttempt), title: paper?.title } : null);\n\n" +
          "  useEffect(() => {\n    if (!activeAttempt) return;\n    const timer = window.setInterval(() => {",
        ],
      ],
    }],
  },
  "alevel-mcq": {
    rules: [],
    edits: [{
      file: "src/pages/chemistry.tsx",
      changes: [
        ["import { PaperImages } from '../components/PaperImages';", `import { PaperImages } from '../components/PaperImages';\n${IMPORT}`],
        [
          "        saveStored(SESSION_KEY, session);\n",
          "        saveStored(SESSION_KEY, session);\n        reportExamEvent('exam_started', { ref: session.sessionId, title: session.topic ?? session.mode });\n",
        ],
        [
          "  const question = questions[current];\n",
          "  const question = questions[current];\n  useExamPresence(validSession ? { ref: session.sessionId, title: session.topic ?? session.mode } : null);\n",
        ],
        [
          "saveStored(RESULT_KEY, result);",
          "reportExamEvent('exam_submitted', { ref: session.sessionId, title: session.topic ?? session.mode, score: result.correctCount, total: result.totalQuestions }); saveStored(RESULT_KEY, result);",
        ],
      ],
    }],
  },
  review: {
    rules: [
      { match: "POST /api/submissions", type: "claude_used", label: "Script marking" },
      { match: "POST /api/submissions/:id/retry", type: "claude_used", label: "Script marking retry" },
      { match: "POST /api/submissions/:id/worksheet", type: "claude_used", label: "Practice worksheet" },
    ],
    edits: [],
  },
  worksheets: {
    rules: [
      { match: "POST /api/chemistry/papers/generate", type: "action", label: "Generated a paper" },
      { match: "POST /api/chemistry/papers/saved", type: "action", label: "Saved a paper" },
    ],
    edits: [],
  },
};

const config = APPS[appId];
if (!config) throw new Error(`--app must be one of: ${Object.keys(APPS).join(", ")}`);
if (!web) throw new Error("--web artifacts/<web-app> is required");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = process.cwd();
const api = path.join(root, "artifacts/api-server/src");
const webRoot = path.join(root, web);
for (const dir of [api, path.join(webRoot, "src")]) {
  if (!fs.existsSync(dir)) throw new Error(`not found: ${path.relative(root, dir)}. Run from the project root.`);
}

const pending = new Map();
const problems = [];
const read = (f) => (pending.has(f) ? pending.get(f) : fs.readFileSync(f, "utf8").replaceAll("\r\n", "\n"));
const count = (text, needle) => text.split(needle).length - 1;

// 1. The two new files.
pending.set(path.join(api, "middlewares/portalTrack.ts"), fs.readFileSync(path.join(here, "portalTrack.ts"), "utf8"));
pending.set(path.join(webRoot, "src/components/PortalExam.tsx"), fs.readFileSync(path.join(here, "PortalExam.tsx"), "utf8"));

// 2. Server: the events route, and report chosen API calls.
{
  const file = path.join(api, "app.ts");
  let text = read(file);
  const block = `app.use("/api/portal", portalEvents);\napp.use(portalTrack(${JSON.stringify(config.rules, null, 2)}));`;
  const sessionImport = /import \{[^}]*portalSession[^}]*\} from ["']\.\/middlewares\/portalAuth["'];/;
  if (/import \{[^}]*portalTrack[^}]*\} from ["']\.\/middlewares\/portalAuth["']/.test(text)) {
    problems.push("app.ts: the earlier version of this tracking is here. Undo that commit first (git revert), then run this again.");
  } else if (text.includes('from "./middlewares/portalTrack"')) {
    text = text.replace(/app\.use\(portalTrack\(\[[\s\S]*?\]\)\);/, `app.use(portalTrack(${JSON.stringify(config.rules, null, 2)}));`); // keeps the rules up to date
  } else if (count(text, "app.use(portalSession);") !== 1 || !sessionImport.test(text)) {
    problems.push("app.ts: the portal connection isn't there. Connect this app first with install.mjs.");
  } else {
    text = text
      .replace(sessionImport, (line) => `${line}\nimport { portalEvents, portalTrack } from "./middlewares/portalTrack";`)
      .replace("app.use(portalSession);", () => `app.use(portalSession);\n${block}`);
  }
  pending.set(file, text);

  // Only the timer line, so anything else the app has in this file stays exactly as it is.
  const authFile = path.join(api, "middlewares/portalAuth.ts");
  if (!fs.existsSync(authFile)) problems.push("middlewares/portalAuth.ts not found. Connect this app first with install.mjs.");
  else {
    const auth = read(authFile);
    const faster = auth.replace(/const RECHECK_MS = 30 \* 60 \* 1000;/, "const RECHECK_MS = 5 * 60 * 1000;");
    if (faster !== auth) pending.set(authFile, faster);
    else if (!auth.includes("const RECHECK_MS = 5 * 60 * 1000;")) console.log("portalAuth.ts: re-check timer not recognised, left as it is. Time estimates may be rougher.");
  }
}

// 3. Frontend: exam steps.
for (const { file, changes } of config.edits) {
  const full = path.join(webRoot, file);
  let text = read(full);
  if (text.includes("components/PortalExam'")) {
    console.log(`${file} already reports exam steps (skipped)`);
    continue;
  }
  if (text.includes("reportExamEvent")) {
    problems.push(`${file}: the earlier version of this tracking is here. Undo that commit first (git revert), then run this again.`);
    continue;
  }
  for (const [find, replace] of changes) {
    const n = count(text, find);
    if (n !== 1) problems.push(`${file}: expected this exactly once, found ${n}:\n    ${find.trim().split("\n")[0]}`);
    else text = text.replace(find, () => replace);
  }
  pending.set(full, text);
}

if (problems.length) {
  console.error(`Nothing was changed. The app's code differs from what this script expects:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
for (const [file, text] of pending) {
  const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (old === text) continue;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  console.log(`${old === null ? "added  " : "edited "} ${path.relative(root, file)}`);
}
console.log("\nDone. Next: run the typecheck, commit, then publish.");
