// Small key/value store for what Donnell edits in the admin panel.
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema.js";

export async function getSetting<T>(db: Db, key: string): Promise<T | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key));
  return row ? (row.value as T) : null;
}

export async function putSetting(db: Db, key: string, value: unknown) {
  await db.insert(settings).values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

export async function deleteSetting(db: Db, key: string) {
  await db.delete(settings).where(eq(settings.key, key));
}
