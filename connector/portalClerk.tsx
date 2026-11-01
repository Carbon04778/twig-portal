// Stand-in for the parts of @clerk/react, @clerk/react/internal and @clerk/themes that
// Donnell's apps use, backed by the Twig portal sign-in (PortalGate). The installer points the
// app's Clerk imports here, so existing pages keep working: inside PortalGate the user is
// always signed in through the portal, and signing out goes back to the portal.
import { useEffect, type ReactNode } from "react";
import { portalSignOutUrl, usePortalUser, type PortalUser } from "@/components/PortalGate";

function clerkShapedUser(u: PortalUser) {
  const [firstName, ...rest] = (u.name ?? "").trim().split(/\s+/);
  const email = { id: `email_${u.id}`, emailAddress: u.email, verification: { status: "verified" } };
  return {
    id: `portal_${u.id}`, // matches getAuth(req).userId on the server
    firstName: firstName || null,
    lastName: rest.join(" ") || null,
    fullName: u.name,
    username: null,
    imageUrl: "",
    primaryEmailAddress: email,
    primaryEmailAddressId: email.id,
    emailAddresses: [email],
    publicMetadata: { role: u.role },
  };
}

const signOut = async () => {
  window.location.href = portalSignOutUrl;
};

export function useUser() {
  const u = usePortalUser();
  return { isLoaded: true, isSignedIn: !!u, user: u ? clerkShapedUser(u) : null };
}

export function useAuth() {
  const u = usePortalUser();
  return { isLoaded: true, isSignedIn: !!u, userId: u ? `portal_${u.id}` : null, signOut };
}

export function useClerk() {
  const u = usePortalUser();
  return {
    loaded: true,
    user: u ? clerkShapedUser(u) : null,
    signOut,
    addListener: (_cb: unknown) => () => {},
    openSignIn: () => {},
    redirectToSignIn: () => {},
  };
}

// Providers and themes have nothing to do: the portal already handled sign-in.
export function ClerkProvider({ children }: { children?: ReactNode; [prop: string]: unknown }) {
  return <>{children}</>;
}

// <Show when="signed-in">…</Show> / <Show when="signed-out">…</Show>
export function Show({ when, children }: { when: string; children?: ReactNode }) {
  const u = usePortalUser();
  const signedIn = !!u;
  return <>{(when === "signed-in") === signedIn ? children : null}</>;
}
export const SignedIn = ({ children }: { children?: ReactNode }) => <Show when="signed-in">{children}</Show>;
export const SignedOut = ({ children }: { children?: ReactNode }) => <Show when="signed-out">{children}</Show>;

// Sign-in/sign-up pages: a signed-in portal user is sent on to the app's home page.
function GoHome() {
  useEffect(() => {
    window.location.replace(import.meta.env.BASE_URL || "/");
  }, []);
  return null;
}
export const SignIn = (_props: Record<string, unknown>) => <GoHome />;
export const SignUp = (_props: Record<string, unknown>) => <GoHome />;

export function UserButton(_props: Record<string, unknown>) {
  return (
    <a href={portalSignOutUrl} style={{ fontSize: 14, fontWeight: 600, textDecoration: "underline" }}>
      Sign out
    </a>
  );
}

// @clerk/react/internal and @clerk/themes
export function publishableKeyFromHost(_host: string, fallback?: string) {
  return fallback || "pk_portal"; // apps throw if this is empty; the value is no longer used
}
export const shadcn = {};
export const dark = {};
