import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/authorization";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  await requirePermission("audit:read");

  const result = await query<{
    id: string;
    action: string;
    target_type: string;
    created_at: string;
  }>(
    `select id, action, target_type, created_at
       from audit_events
      order by created_at desc
      limit 50`
  );

  return NextResponse.json({ auditEvents: result.rows });
}
