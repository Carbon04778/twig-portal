import { sql } from "drizzle-orm";
import {
  boolean, index, integer, pgEnum, pgTable, primaryKey, serial, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";

// public: signed in, no promo code. student: redeemed a promo code (or upgraded by admin).
// admin: Donnell (and anyone in ADMIN_EMAILS); can open every app and the admin panel.
export const userRole = pgEnum("user_role", ["public", "student", "admin"]);
export const userStatus = pgEnum("user_status", ["active", "revoked"]);

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  clerkId: text("clerk_id").notNull().unique(),
  email: text("email").notNull(), // verified email from Clerk, lowercase
  name: text("name"),
  role: userRole("role").notNull().default("public"),
  status: userStatus("status").notNull().default("active"),
  studentSince: timestamp("student_since", { withTimezone: true }),
  createdAt,
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("users_email").on(t.email)]);

// One row per connected app. Each app is its own Replit deployment.
export const apps = pgTable("apps", {
  id: text("id").primaryKey(), // short slug, e.g. "paper1"
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  url: text("url").notNull(), // https://h2chempaper1.replit.app
  callbackPath: text("callback_path").notNull().default("/api/portal/callback"),
  publicAccess: boolean("public_access").notNull().default(false), // open to "public" users
  enabled: boolean("enabled").notNull().default(true), // shown as a tile and launchable
  sortOrder: integer("sort_order").notNull().default(0),
  secretHash: text("secret_hash"), // SHA-256 of the app's secret for the code exchange
  secretPrefix: text("secret_prefix"),
  createdAt,
});

// Per-user exceptions to the role rules ("revoke access per app" / grant one extra app).
export const userAppAccess = pgTable("user_app_access", {
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  appId: text("app_id").notNull().references(() => apps.id, { onDelete: "cascade" }),
  allowed: boolean("allowed").notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.appId] })]);

export const promoCodes = pgTable("promo_codes", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(), // stored uppercase
  label: text("label").notNull().default(""), // e.g. "2027 J2 class"
  maxUses: integer("max_uses"), // null = unlimited
  uses: integer("uses").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt,
}, (t) => [uniqueIndex("promo_codes_code").on(t.code)]);

export const promoRedemptions = pgTable("promo_redemptions", {
  codeId: integer("code_id").notNull().references(() => promoCodes.id),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.codeId, t.userId] })]);

// One-time launch codes: the portal redirects to the app with ?code=..., the app's server
// exchanges it (with its app secret) for the user's details. Stored hashed; single use.
export const launchCodes = pgTable("launch_codes", {
  codeHash: text("code_hash").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  appId: text("app_id").notNull().references(() => apps.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt,
}, (t) => [index("launch_codes_expires").on(t.expiresAt)]);

export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  actorUserId: integer("actor_user_id"),
  action: text("action").notNull(), // e.g. "user.role", "promo.create", "app.update"
  target: text("target"),
  detail: text("detail"),
  at: timestamp("at", { withTimezone: true }).notNull().default(sql`now()`),
});
