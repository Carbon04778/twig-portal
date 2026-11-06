import { sql } from "drizzle-orm";
import {
  boolean, index, integer, jsonb, pgEnum, pgTable, primaryKey, serial, text, timestamp, uniqueIndex,
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
  // Paid access end date. Until then a "public" user is treated as a student; afterwards they
  // are free again without anything having to run.
  paidUntil: timestamp("paid_until", { withTimezone: true }),
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

// Details from the required form after sign-up. Saved here first, then copied to Google Sheets;
// sheet_synced_at stays empty until the row is in the sheet, so a failed copy can be sent later.
export const studentProfiles = pgTable("student_profiles", {
  userId: integer("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  fullName: text("full_name").notNull(),
  school: text("school").notNull(),
  level: text("level").notNull(),
  mobile: text("mobile").notNull(),
  heardFrom: text("heard_from").notNull(),
  consentText: text("consent_text").notNull(), // the exact wording they agreed to
  consentAt: timestamp("consent_at", { withTimezone: true }).notNull().defaultNow(),
  sheetSyncedAt: timestamp("sheet_synced_at", { withTimezone: true }),
  sheetError: text("sheet_error"),
  createdAt,
}, (t) => [index("student_profiles_unsynced").on(t.sheetSyncedAt)]);

// One row per visit to an app. Started when the student opens it from the portal; last_active_at
// moves on each time the app re-checks access with the portal, which gives the time estimate.
export const appSessions = pgTable("app_sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  appId: text("app_id").notNull().references(() => apps.id, { onDelete: "cascade" }),
  source: text("source").notNull().default("launch"), // launch: opened from the portal; resume: back in a session still open
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("app_sessions_started").on(t.startedAt),
  index("app_sessions_user_app").on(t.userId, t.appId, t.lastActiveAt),
]);

// Things Donnell edits in the admin panel: apps page wording and payment settings.
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const payments = pgTable("payments", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  reference: text("reference").notNull(), // ours, random; also in the return link
  hitpayRequestId: text("hitpay_request_id"),
  checkoutUrl: text("checkout_url"),
  amountCents: integer("amount_cents").notNull(), // the price when this payment was started
  currency: text("currency").notNull(),
  months: integer("months").notNull(),
  status: text("status").notNull().default("pending"), // pending, completed, refunded
  paidAt: timestamp("paid_at", { withTimezone: true }),
  accessUntil: timestamp("access_until", { withTimezone: true }),
  refundedAt: timestamp("refunded_at", { withTimezone: true }),
  createdAt,
}, (t) => [
  uniqueIndex("payments_reference").on(t.reference),
  index("payments_hitpay_request").on(t.hitpayRequestId),
  index("payments_user").on(t.userId, t.status),
]);
