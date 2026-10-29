import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // Comma-separated emails that get the admin role on sign-in (Donnell's verified email).
  ADMIN_EMAILS: z.string().min(3, "ADMIN_EMAILS is required (e.g. donnellkoh@gmail.com)"),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.string().default("development"),
  // Set by Replit when Clerk is added to the Repl (Auth pane), or from your own Clerk app.
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_PUBLISHABLE_KEY: z.string().optional(),
});

export type Env = z.infer<typeof schema>;
let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`Invalid environment:\n${problems}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export const adminEmails = () =>
  new Set(env().ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));
