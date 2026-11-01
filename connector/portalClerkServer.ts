// Stand-in for the parts of @clerk/express (and @clerk/shared/keys) that Donnell's apps use,
// backed by the Twig portal sign-in (res.locals.portalUser from portalAuth.ts). The installer
// points the app's Clerk imports here, so its existing code keeps working unchanged:
//   getAuth(req).userId           -> "portal_<id>" of the signed-in portal user, or null
//   clerkClient.users.getUser(id) -> a Clerk-shaped user (name, verified email)
//   clerkMiddleware(), publishableKeyFromHost() -> no-ops
import type { Request, RequestHandler } from "express";
import type { PortalUser } from "./portalAuth";

const known = new Map<string, PortalUser>(); // userId -> portal user, filled as requests arrive

export const portalUserId = (u: PortalUser) => `portal_${u.id}`;

export function getAuth(req: Request): { userId: string | null } {
  const user = (req.res?.locals?.portalUser ?? null) as PortalUser | null;
  if (!user) return { userId: null };
  const userId = portalUserId(user);
  known.set(userId, user);
  return { userId };
}

function clerkShapedUser(userId: string, u: PortalUser) {
  const [firstName, ...rest] = (u.name ?? "").trim().split(/\s+/);
  const emailId = `email_${u.id}`;
  return {
    id: userId,
    firstName: firstName || null,
    lastName: rest.join(" ") || null,
    fullName: u.name,
    username: null,
    primaryEmailAddressId: emailId,
    emailAddresses: [{ id: emailId, emailAddress: u.email, verification: { status: "verified" } }],
    publicMetadata: { role: u.role },
  };
}

export const clerkClient = {
  users: {
    async getUser(userId: string) {
      const u = known.get(userId);
      // Details are known once the user has made a signed-in request to this server instance.
      if (!u) throw new Error(`Portal user ${userId} has not signed in to this server yet`);
      return clerkShapedUser(userId, u);
    },
  },
};

export function clerkMiddleware(_options?: unknown): RequestHandler {
  return (_req, _res, next) => next();
}

export function publishableKeyFromHost(_host: string, fallback?: string) {
  return fallback ?? "";
}
