import { NextResponse } from "next/server";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = await query<{
    database_name: string;
    checked_at: string;
    driver_echo: string;
  }>(
    `select current_database() as database_name,
            now() as checked_at,
            $1::text as driver_echo`,
    [process.env.DATABASE_DRIVER ?? "pg"]
  );

  return NextResponse.json({
    ok: true,
    driver: process.env.DATABASE_DRIVER ?? "pg",
    database: result.rows[0]
  });
}
