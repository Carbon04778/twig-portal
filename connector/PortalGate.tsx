// Twig portal gate for an app's React frontend. Copy into artifacts/<web-app>/src/components/
// and wrap the app in src/main.tsx:   <PortalGate><App /></PortalGate>
// Signed-in users see the app; everyone else is sent to the Twig portal, which signs them in
// and sends them straight back. usePortalUser() gives { id, email, name, role } anywhere inside.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export interface PortalUser {
  id: number;
  email: string;
  name: string | null;
  role: "public" | "student" | "admin";
}

const PortalUserContext = createContext<PortalUser | null>(null);
export const usePortalUser = () => useContext(PortalUserContext);

const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/portal`;
export const portalSignOutUrl = `${apiBase}/sign-out`;

// ---- Exam timestamps, reported to the portal. Never gets in the student's way. ------------
type ExamEventType = "exam_started" | "exam_left" | "exam_returned" | "exam_submitted" | "exam_timed_out" | "exam_quit";
export interface ExamDetails { ref: string; title?: string | null; label?: string; score?: number; total?: number; at?: number }

export function reportExamEvent(type: ExamEventType, { title, at, ...rest }: ExamDetails) {
  try {
    void fetch(`${apiBase}/events`, {
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
    if (!ref) return;
    const key = `twig-exam-away:${ref}`;
    const isAway = () => { try { return localStorage.getItem(key) !== null; } catch { return false; } };
    const setAway = (away: boolean) => {
      try { if (away) localStorage.setItem(key, "1"); else localStorage.removeItem(key); } catch { /* not essential */ }
    };
    let hiddenAt: number | null = null;
    let timer: number | undefined;
    const left = () => {
      window.clearTimeout(timer);
      if (isAway()) return;
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

export function PortalGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PortalUser | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch(`${apiBase}/me`, { credentials: "same-origin" })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (res.ok) setUser(body.user);
        else if (res.status === 401 && body.portalUrl) window.location.replace(body.portalUrl);
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, []);

  if (failed) {
    return <p style={{ padding: 24, fontFamily: "system-ui" }}>Couldn't check your Twig sign-in. Please refresh the page.</p>;
  }
  if (!user) return <div style={{ padding: 24, fontFamily: "system-ui", color: "#5c6584" }}>Signing you in…</div>;
  return <PortalUserContext.Provider value={user}>{children}</PortalUserContext.Provider>;
}
