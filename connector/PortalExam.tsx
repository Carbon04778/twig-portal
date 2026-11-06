// Exam timestamps for an app's React frontend, reported to the Twig portal. Copied into
// src/components/ by install-tracking.mjs. It sits beside PortalGate.tsx and doesn't change it.
// Never gets in the student's way.
import { useEffect } from "react";

const eventsUrl = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/portal/events`;

type ExamEventType = "exam_started" | "exam_left" | "exam_returned" | "exam_submitted" | "exam_timed_out" | "exam_quit";
export interface ExamDetails { ref: string; title?: string | null; label?: string; score?: number; total?: number; at?: number }

// Some apps stay on the same page after an exam ends, so remember that it has ended.
const doneKey = (ref: string) => `twig-exam-done:${ref}`;
const isDone = (ref: string) => { try { return localStorage.getItem(doneKey(ref)) !== null; } catch { return false; } };

export function reportExamEvent(type: ExamEventType, { title, at, ...rest }: ExamDetails) {
  if (type === "exam_submitted" || type === "exam_timed_out" || type === "exam_quit") {
    try { localStorage.setItem(doneKey(rest.ref), "1"); } catch { /* not essential */ }
  }
  try {
    void fetch(eventsUrl, {
      method: "POST", credentials: "same-origin", keepalive: true, // keepalive: still sent while the page closes
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, ...rest, title: title ?? undefined, at: new Date(at ?? Date.now()).toISOString() }),
    }).catch(() => {});
  } catch { /* reporting must never interrupt an exam */ }
}

// Pass the running exam, or null. Records when the page is hidden or closed for 20 seconds or
// more, and when the student comes back, including after closing the browser.
const AWAY_AFTER_MS = 20_000;
export function useExamPresence(exam: { ref: string; title?: string | null } | null) {
  const ref = exam?.ref;
  const title = exam?.title;
  useEffect(() => {
    if (!ref || isDone(ref)) return;
    const key = `twig-exam-away:${ref}`;
    const isAway = () => { try { return localStorage.getItem(key) !== null; } catch { return false; } };
    const setAway = (away: boolean) => {
      try { if (away) localStorage.setItem(key, "1"); else localStorage.removeItem(key); } catch { /* not essential */ }
    };
    let hiddenAt: number | null = null;
    let timer: number | undefined;
    const left = () => {
      window.clearTimeout(timer);
      if (isAway() || isDone(ref)) return;
      setAway(true);
      reportExamEvent("exam_left", { ref, title, at: hiddenAt ?? Date.now() });
    };
    const back = () => {
      window.clearTimeout(timer);
      hiddenAt = null;
      if (!isAway()) return;
      setAway(false);
      reportExamEvent("exam_returned", { ref, title });
    };
    const onVisibility = () => {
      if (!document.hidden) return back();
      hiddenAt = Date.now();
      timer = window.setTimeout(left, AWAY_AFTER_MS);
    };
    const onPageHide = () => { hiddenAt ??= Date.now(); left(); };
    back(); // back after closing the page
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [ref, title]);
}
