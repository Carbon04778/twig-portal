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
const HEARTBEAT_MS = 5 * 60 * 1000; // matches RECHECK_MS in portalAuth.ts

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

  // Apps whose content is built in (no server calls) still need the portal's re-check: it ends a
  // revoked user's access and is how the portal estimates time spent. Only while the page is visible.
  useEffect(() => {
    if (!user) return;
    let last = Date.now();
    const ping = () => {
      if (document.hidden || Date.now() - last < HEARTBEAT_MS - 1000) return;
      last = Date.now();
      fetch(`${apiBase}/me`, { credentials: "same-origin" })
        .then(async (res) => {
          if (res.status !== 401) return;
          const body = await res.json().catch(() => ({}));
          if (body.portalUrl) window.location.replace(body.portalUrl);
        })
        .catch(() => {});
    };
    const timer = window.setInterval(ping, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", ping);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", ping);
    };
  }, [user]);

  if (failed) {
    return <p style={{ padding: 24, fontFamily: "system-ui" }}>Couldn't check your Twig sign-in. Please refresh the page.</p>;
  }
  if (!user) return <div style={{ padding: 24, fontFamily: "system-ui", color: "#5c6584" }}>Signing you in…</div>;
  return <PortalUserContext.Provider value={user}>{children}</PortalUserContext.Provider>;
}
