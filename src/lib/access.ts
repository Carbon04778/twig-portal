// Who may open which app. Pure function so the rule is easy to read and test.
//
// 1. Revoked users and disabled apps: never.
// 2. A per-user override for this app (admin panel) wins next.
// 3. Admins and students: every enabled app.
// 4. Public users: only apps marked publicAccess.
export type Role = "public" | "student" | "admin";

export interface AccessUser {
  role: Role;
  status: "active" | "revoked";
}
export interface AccessApp {
  enabled: boolean;
  publicAccess: boolean;
}

export function canOpen(user: AccessUser, app: AccessApp, override?: boolean | null): boolean {
  if (user.status !== "active" || !app.enabled) return false;
  if (override === true || override === false) return override;
  if (user.role === "admin" || user.role === "student") return true;
  return app.publicAccess;
}

// Codes are shown as ABCD-EFGH but stored and matched without dashes, spaces or case.
export const normalizePromoCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");
export const formatPromoCode = (code: string) => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);

export type PromoProblem = "not_found" | "revoked" | "expired" | "used_up";

export function promoProblem(
  promo: { maxUses: number | null; uses: number; expiresAt: Date | null; revokedAt: Date | null } | undefined,
  now = new Date(),
): PromoProblem | null {
  if (!promo) return "not_found";
  if (promo.revokedAt) return "revoked";
  if (promo.expiresAt && promo.expiresAt <= now) return "expired";
  if (promo.maxUses !== null && promo.uses >= promo.maxUses) return "used_up";
  return null;
}
