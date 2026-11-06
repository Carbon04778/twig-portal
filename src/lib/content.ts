// The wording on the apps page, editable in Admin -> Page text. These defaults are shown until
// Donnell saves his own. Colours and symbols stay in public/assets/portal.js.
import { z } from "zod";
import type { Db } from "../db/client.js";
import { getSetting } from "./settings.js";

export const CONTENT_KEY = "page_content";

export interface AppText { title: string; text: string; label: string; tags: string[]; cta: string }
export interface SectionText { title: string; note: string }

const SECTIONS = [
  { id: "practise", ids: ["paper1", "alevel-mcq", "worksheets"], wide: false, title: "Practise papers", note: "Timed practice and topical papers" },
  { id: "learn", ids: ["question-bank", "definitions"], wide: false, title: "Learn & revise", note: "Key ideas and commonly tested questions" },
  { id: "feedback", ids: ["review"], wide: true, title: "Get feedback", note: "Turn your scripts into a plan for an A" },
] as const;
const MORE = { title: "More apps", note: "Also available on your account" };
const INTRO = "Practise a paper, test with timed trial, revise key ideas, or get feedback on a marked script.";

const APPS: Record<string, AppText> = {
  paper1: { label: "Prelim MCQ", title: "Prelim MCQ Practice", text: "Timed practice for Prelim MCQ with worked solutions and voice explanations.", tags: ["Timed", "Voice"], cta: "Open" },
  "alevel-mcq": { label: "A-Level MCQ", title: "A-Level MCQ Practice", text: "Timed practice for A-Level MCQ with worked solutions.", tags: ["Timed", "Worked solutions"], cta: "Open" },
  worksheets: { label: "Topical", title: "Topical Prelim Practice", text: "Build topical prelim practice papers, complete with mark schemes.", tags: ["Topical", "Mark scheme"], cta: "Open" },
  "question-bank": { label: "Hotspots", title: "H2 Chem Exam Hotspots", text: "The most-tested H2 Chemistry questions, all in one app.", tags: ["Most tested"], cta: "Open" },
  definitions: { label: "Definitions", title: "H2 Chemistry Definitions Handbook", text: "Learn and test yourself on key chemistry definitions.", tags: ["Flashcards", "Self-test"], cta: "Open" },
  review: { label: "Mark Script", title: "Mark My Script", text: "Upload your marked or unmarked script for detailed feedback and a personal roadmap to get an A.", tags: [], cta: "Upload a script" },
};

const sectionBody = z.object({ title: z.string().trim().min(1).max(80), note: z.string().trim().max(160) });
const appBody = z.object({
  title: z.string().trim().min(1).max(100),
  text: z.string().trim().max(300),
  label: z.string().trim().max(40),
  tags: z.array(z.string().trim().min(1).max(30)).max(6),
  cta: z.string().trim().min(1).max(30),
});
export const contentBody = z.object({
  intro: z.string().trim().max(300),
  sections: z.record(z.string().max(40), sectionBody),
  apps: z.record(z.string().max(40), appBody),
});
export type StoredContent = z.infer<typeof contentBody>;

// Saved wording over the defaults. Apps added later start from their name and description in Admin.
export async function pageContent(db: Db, allApps: { id: string; name: string; description: string }[]) {
  const saved = await getSetting<StoredContent>(db, CONTENT_KEY);
  const known = new Set<string>(SECTIONS.flatMap((s) => [...s.ids]));
  const sections = [
    ...SECTIONS.map((s) => ({ id: s.id, ids: [...s.ids] as string[], wide: s.wide, title: s.title, note: s.note, ...saved?.sections[s.id] })),
    { id: "more", ids: allApps.map((a) => a.id).filter((id) => !known.has(id)), wide: false, ...MORE, ...saved?.sections.more },
  ];
  const apps: Record<string, AppText> = {};
  for (const a of allApps) {
    apps[a.id] = saved?.apps[a.id] ?? APPS[a.id] ?? { label: a.name, title: a.name, text: a.description, tags: [], cta: "Open" };
  }
  return { intro: saved?.intro ?? INTRO, sections, apps };
}
