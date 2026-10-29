// Who is signed in. Production uses Clerk; tests inject a stand-in through createApp().
import type { Request } from "express";
import type { Identity } from "../lib/portal.js";

export type IdentityProvider = (req: Request) => Promise<Identity | null>;

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { until: number; identity: Identity | null }>();

// Clerk: the session cookie gives the user ID; name and verified email come from Clerk's API,
// cached for a few minutes to stay well inside Clerk's rate limits.
export function clerkIdentity(): IdentityProvider {
  return async (req) => {
    const { getAuth, clerkClient } = await import("@clerk/express");
    const userId = getAuth(req).userId;
    if (!userId) return null;
    const hit = cache.get(userId);
    if (hit && hit.until > Date.now()) return hit.identity;
    const user = await clerkClient.users.getUser(userId);
    const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
    const verified = [primary, ...user.emailAddresses].find((e) => e?.verification?.status === "verified");
    const identity = verified
      ? { clerkId: userId, email: verified.emailAddress.toLowerCase(), name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null }
      : null; // no verified email yet: treated as signed out
    cache.set(userId, { until: Date.now() + CACHE_MS, identity });
    return identity;
  };
}
