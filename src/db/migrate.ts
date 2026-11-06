// Apply pending Drizzle migrations (drizzle/*.sql) to whatever DATABASE_URL the app has.
// Runs at server startup so the production database gets the same schema as development.
// An advisory lock stops several autoscale instances from migrating at the same time.
//
// Replit creates the production database as a copy of the development database's schema
// (tables and types, but no rows, so Drizzle's own record of applied migrations comes over
// empty) and copies schema changes again on later publishes. Running a migration whose
// objects already exist would fail with "already exists". So before migrating, any pending
// migration whose changes are already present is recorded as applied instead of run.
import fs from "node:fs";
import path from "node:path";
import type pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { pool as defaultPool } from "./client.js";

const MIGRATION_LOCK = 727_002;
// The repo's drizzle/ folder is two levels above both src/db and dist/db.
export const migrationsFolder = path.resolve(import.meta.dirname, "../../drizzle");

// One query per migration (by journal tag) that returns true when that migration's schema
// changes are already in the database. Every new migration needs an entry here; a test checks.
export const MIGRATION_MARKERS: Record<string, string> = {
  "0000_init": "select to_regclass('public.users') is not null and to_regclass('public.launch_codes') is not null",
  "0001_signup_tracking_payments": "select to_regclass('public.student_profiles') is not null and to_regclass('public.app_sessions') is not null and to_regclass('public.settings') is not null and to_regclass('public.payments') is not null and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'users' and column_name = 'paid_until')",
  "0002_app_events": "select to_regclass('public.app_events') is not null",
};

export function journalTags(folder = migrationsFolder): string[] {
  const journal = JSON.parse(fs.readFileSync(path.join(folder, "meta", "_journal.json"), "utf8"));
  return journal.entries.map((e: { tag: string }) => e.tag);
}

// Record, in order, the pending migrations whose changes are already present; stop at the
// first one that isn't, so Drizzle runs that one and everything after it as usual.
async function recordPresentMigrations(conn: pg.PoolClient, log: (m: string) => void) {
  const migrations = readMigrationFiles({ migrationsFolder });
  const tags = journalTags();
  await conn.query("create schema if not exists drizzle");
  await conn.query(`create table if not exists drizzle.__drizzle_migrations (
    id serial primary key, hash text not null, created_at bigint)`);
  const { rows } = await conn.query<{ created_at: string }>(
    "select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1");
  const last = rows[0] ? Number(rows[0].created_at) : -1;

  for (const [i, m] of migrations.entries()) {
    if (m.folderMillis <= last) continue; // already recorded
    const tag = tags[i]!;
    const marker = MIGRATION_MARKERS[tag];
    if (!marker) throw new Error(`no MIGRATION_MARKERS entry for migration ${tag} (src/db/migrate.ts)`);
    const present = (await conn.query<{ present: boolean }>(`select (${marker}) as present`)).rows[0]?.present;
    if (!present) return;
    await conn.query("insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)", [m.hash, m.folderMillis]);
    log(`migration ${tag}: schema already present (copied by Replit), recorded as applied`);
  }
}

export async function runMigrations(pool: pg.Pool = defaultPool, log: (m: string) => void = console.log) {
  const conn = await pool.connect();
  try {
    await conn.query("select pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await recordPresentMigrations(conn, log);
    await migrate(drizzle(conn), { migrationsFolder }); // same session that holds the lock
  } finally {
    await conn.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
    conn.release();
  }
}
