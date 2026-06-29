import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { databaseUrlFromEnv } from "../lib/env";

const { Client } = pg;

async function main() {
  const migrationsDir = path.join(process.cwd(), "migrations");
  const files = (await fs.readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const client = new Client({
    connectionString: databaseUrlFromEnv(),
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: true } : undefined
  });

  await client.connect();

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
        console.log(`Skipping ${file}`);
        continue;
      }

      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      console.log(`Applying ${file}`);
      await client.query(sql);
      await client.query("insert into schema_migrations (version) values ($1)", [file]);
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
