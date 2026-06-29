import pg from "pg";
import { databaseUrlFromEnv } from "@/lib/env";
import { dataApiQuery } from "@/lib/data-api";

const { Pool } = pg;

declare global {
  var zcgPgPool: pg.Pool | undefined;
}

export const pool =
  globalThis.zcgPgPool ??
  new Pool({
    connectionString: databaseUrlFromEnv(),
    max: Number(process.env.DB_POOL_MAX ?? 8),
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: true } : undefined
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.zcgPgPool = pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: readonly unknown[] = []
): Promise<pg.QueryResult<T>> {
  if (process.env.DATABASE_DRIVER === "data-api") {
    const result = await dataApiQuery<T>(text, values);
    return {
      command: "",
      oid: 0,
      fields: [],
      rowCount: result.rowCount,
      rows: result.rows
    };
  }

  return pool.query<T>(text, [...values]);
}

export async function closePool() {
  if (process.env.DATABASE_DRIVER === "data-api") {
    return;
  }

  await pool.end();
}
