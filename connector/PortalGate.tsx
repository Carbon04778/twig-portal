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
