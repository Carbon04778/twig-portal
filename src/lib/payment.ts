// One-time payment through HitPay, switched on and off in Admin -> Payment.
//
// HitPay is asked directly whether a payment went through (GET /v1/payment-requests/{id}) before
// any access is given. The webhook and the student's return to the portal only prompt that check,
// so a forged return link gets nothing, and a missed webhook doesn't leave a paying student locked out.
import crypto from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { auditLog, payments, users } from "../db/schema.js";
import type { User } from "./portal.js";
import { getSetting, putSetting } from "./settings.js";

export type Payment = typeof payments.$inferSelect;
const KEY = "payment";

export interface PaymentSettings {
  enabled: boolean;
  priceCents: number;
  compareAtCents: number | null; // shown crossed out, e.g. S$120
  months: number;
  refundPolicy: string;
}

export const DEFAULT_PAYMENT: PaymentSettings = {
  enabled: false, // nothing is charged until Donnell switches this on
  priceCents: 2000,
  compareAtCents: 12000,
  months: 12,
  refundPolicy: "Enjoy full access with our 7-day trial period. If you are not completely satisfied with the Twig Learning Center app, you may request a full refund within 7 days of payment. To request a refund, please contact our support team on WhatsApp at 8338 7476 or by email at hello@twig.sg within this 7-day window. Requests submitted after 7 days will not be eligible for a refund.",
};
export const CURRENCY = "SGD";
const RENEW_WINDOW_MS = 30 * 86_400_000; // paid students may renew in their last 30 days

export const paymentSettingsBody = z.object({
  enabled: z.boolean(),
  price: z.number().min(1).max(10_000),
  compare_at: z.number().min(0).max(100_000).nullable(),
  months: z.number().int().min(1).max(60),
  refund_policy: z.string().trim().min(1, "Students must see a refund policy before paying.").max(2000),
});

export const getPaymentSettings = async (db: Db): Promise<PaymentSettings> =>
  ({ ...DEFAULT_PAYMENT, ...await getSetting<Partial<PaymentSettings>>(db, KEY) });
export const savePaymentSettings = (db: Db, s: PaymentSettings) => putSetting(db, KEY, s);

const apiBase = () => process.env.HITPAY_API_URL?.replace(/\/+$/, "")
  ?? (process.env.HITPAY_MODE === "live" ? "https://api.hit-pay.com" : "https://api.sandbox.hit-pay.com");

export const hitpayStatus = () => ({
  keyIsSet: !!process.env.HITPAY_API_KEY,
  webhookSaltIsSet: !!(process.env.HITPAY_WEBHOOK_SALT || process.env.HITPAY_SALT),
  mode: process.env.HITPAY_MODE === "live" ? "live" : "sandbox",
});

export const mayPay = (user: User, now = new Date()) =>
  user.status === "active" && user.role === "public"
  && (!user.paidUntil || user.paidUntil.getTime() - now.getTime() <= RENEW_WINDOW_MS);

// What the apps page needs. Null hides the payment box.
export async function paymentOffer(db: Db, user: User) {
  const s = await getPaymentSettings(db);
  const [pending] = user.role === "public"
    ? await db.select({ reference: payments.reference }).from(payments)
      .where(and(eq(payments.userId, user.id), eq(payments.status, "pending"), sql`${payments.createdAt} > now() - interval '7 days'`))
      .orderBy(desc(payments.createdAt)).limit(1)
    : [];
  return {
    pendingReference: pending?.reference ?? null,
    offer: s.enabled && hitpayStatus().keyIsSet && mayPay(user)
      ? { priceCents: s.priceCents, compareAtCents: s.compareAtCents, currency: CURRENCY, months: s.months, refundPolicy: s.refundPolicy }
      : null,
  };
}

async function hitpay(path: string, init: RequestInit = {}) {
  const res = await fetch(`${apiBase()}/v1/payment-requests${path}`, {
    ...init,
    signal: AbortSignal.timeout(15_000),
    headers: { "X-BUSINESS-API-KEY": process.env.HITPAY_API_KEY ?? "", "X-Requested-With": "XMLHttpRequest", ...init.headers },
  });
  const body = await res.json().catch(() => ({})) as Record<string, any>;
  if (!res.ok) throw new Error(`HitPay answered ${res.status}: ${String(body.message ?? "").slice(0, 200)}`);
  return body;
}

export type StartResult = { ok: true; url: string } | { ok: false; error: "payment_off" | "not_needed" };

export async function startPayment(db: Db, user: User, displayName: string, returnBase: string): Promise<StartResult> {
  const s = await getPaymentSettings(db);
  if (!s.enabled || !hitpayStatus().keyIsSet) return { ok: false, error: "payment_off" };
  if (!mayPay(user)) return { ok: false, error: "not_needed" };

  // Clicking Pay twice returns to the same checkout unless the price has changed since.
  const [recent] = await db.select().from(payments)
    .where(and(eq(payments.userId, user.id), eq(payments.status, "pending"), eq(payments.amountCents, s.priceCents),
      eq(payments.months, s.months), sql`${payments.createdAt} > now() - interval '30 minutes'`))
    .orderBy(desc(payments.createdAt)).limit(1);
  if (recent?.checkoutUrl) return { ok: true, url: recent.checkoutUrl };

  const reference = crypto.randomUUID();
  const created = await hitpay("", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      amount: (s.priceCents / 100).toFixed(2), currency: CURRENCY, email: user.email, name: displayName,
      purpose: `Twig Learning Center: ${s.months} months access`, reference_number: reference,
      redirect_url: `${returnBase}/?payment=${reference}`,
    }),
  });
  if (!created.id || !created.url) throw new Error("HitPay did not return a checkout link");
  await db.insert(payments).values({
    userId: user.id, reference, hitpayRequestId: String(created.id), checkoutUrl: String(created.url),
    amountCents: s.priceCents, currency: CURRENCY, months: s.months,
  });
  return { ok: true, url: String(created.url) };
}

const addMonths = (d: Date, months: number) => {
  const out = new Date(d);
  out.setMonth(out.getMonth() + months);
  return out;
};

// Safe to run any number of times and at the same moment: only one caller can move a payment out
// of "pending", so access is extended exactly once. Stacks on any time the student has left.
async function grant(db: Db, p: Payment) {
  await db.transaction(async (tx) => {
    const [claimed] = await tx.update(payments).set({ status: "completed", paidAt: new Date() })
      .where(and(eq(payments.id, p.id), eq(payments.status, "pending"))).returning({ id: payments.id });
    if (!claimed) return;
    const [user] = await tx.select().from(users).where(eq(users.id, p.userId)).for("update");
    const now = new Date();
    const from = user?.paidUntil && user.paidUntil > now ? user.paidUntil : now;
    const until = addMonths(from, p.months);
    await tx.update(users).set({ paidUntil: until }).where(eq(users.id, p.userId));
    await tx.update(payments).set({ accessUntil: until }).where(eq(payments.id, p.id));
    await tx.insert(auditLog).values({
      actorUserId: p.userId, action: "payment.completed", target: p.reference,
      detail: JSON.stringify({ amount_cents: p.amountCents, currency: p.currency, access_until: until }),
    });
  });
}

// Ask HitPay about a payment and give access if it is paid in full.
export async function confirmWithHitpay(db: Db, p: Payment): Promise<Payment["status"]> {
  if (p.status !== "pending" || !p.hitpayRequestId) return p.status;
  const remote = await hitpay(`/${encodeURIComponent(p.hitpayRequestId)}`);
  if (remote.status !== "completed") return "pending";
  const paidCents = Math.round(Number(remote.amount) * 100);
  if (paidCents !== p.amountCents || String(remote.currency).toUpperCase() !== p.currency) {
    console.error(`Payment ${p.reference}: HitPay shows ${remote.amount} ${remote.currency}, expected ${p.amountCents / 100} ${p.currency}`);
    return "pending";
  }
  await grant(db, p);
  return "completed";
}

// HMAC-SHA256 of the raw body, hex, with the salt from that webhook's page in HitPay.
export function validWebhookSignature(rawBody: Buffer, signature: string | undefined) {
  if (!signature) return false;
  const given = Buffer.from(signature);
  return [process.env.HITPAY_WEBHOOK_SALT, process.env.HITPAY_SALT].some((salt) => {
    if (!salt) return false;
    const expected = Buffer.from(crypto.createHmac("sha256", salt).update(rawBody).digest("hex"));
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  });
}

export async function handleWebhook(db: Db, rawBody: Buffer) {
  const event = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
  const ids = [event.payment_request_id, event.id].filter((v): v is string => typeof v === "string");
  let row: Payment | undefined;
  for (const id of ids) {
    [row] = await db.select().from(payments).where(eq(payments.hitpayRequestId, id));
    if (row) break;
  }
  if (!row && typeof event.reference_number === "string") {
    [row] = await db.select().from(payments).where(eq(payments.reference, event.reference_number));
  }
  if (row) await confirmWithHitpay(db, row); // not ours (other HitPay activity): nothing to do
}

// Marks a refund made in HitPay's dashboard. Access falls back to any other payment still standing.
export async function markRefunded(db: Db, paymentId: number) {
  return db.transaction(async (tx) => {
    const [p] = await tx.update(payments).set({ status: "refunded", refundedAt: new Date() })
      .where(and(eq(payments.id, paymentId), eq(payments.status, "completed"))).returning();
    if (!p) return null;
    const [{ until }] = await tx.select({ until: sql<Date | null>`max(${payments.accessUntil})` }).from(payments)
      .where(and(eq(payments.userId, p.userId), eq(payments.status, "completed"))) as [{ until: Date | string | null }];
    await tx.update(users).set({ paidUntil: until ? new Date(until) : null }).where(eq(users.id, p.userId));
    return p;
  });
}
