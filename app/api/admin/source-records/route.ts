import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/authorization";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  await requirePermission("source:mirror:read");

  const result = await query<{
    id: string;
    source_kind: string;
    source_id: string;
    source_url: string | null;
    title: string | null;
    summary: string | null;
    source_updated_at: string | null;
    updated_at: string;
  }>(
    `select id,
            source_kind,
            source_id,
            source_url,
            title,
            summary,
            source_updated_at,
            updated_at
       from source_records
      order by updated_at desc
      limit 100`
  );

  return NextResponse.json({ sourceRecords: result.rows });
}
