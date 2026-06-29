import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { workerDatabaseUrl } from "../lib/worker-db-url";

const { Client } = pg;

export async function handler() {
  const migrationsDir = path.join(process.cwd(), "migrations");
  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const client = new Client({
    connectionString: await workerDatabaseUrl(),
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: true } : undefined
  });

  await client.connect();

  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await client.query("begin");
    await client.query(
      `create table if not exists schema_migrations (
        version text primary key,
        applied_at timestamptz not null default now()
      )`
    );

    for (const file of files) {
      const alreadyApplied = await client.query(
        "select 1 from schema_migrations where version = $1",
        [file]
      );

      if (alreadyApplied.rowCount) {
        skipped.push(file);
        continue;
      }

      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      await client.query(sql);
      await client.query("insert into schema_migrations (version) values ($1)", [file]);
      applied.push(file);
    }

    await client.query(
      `insert into audit_events (action, target_type, metadata)
       values ('migration_runner.completed', 'schema_migration', $1::jsonb)`,
      [JSON.stringify({ applied, skipped })]
    );

    await client.query("commit");
    return { ok: true, applied, skipped };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith("migration-runner.ts")) {
  handler()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
