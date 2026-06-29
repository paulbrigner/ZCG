import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "@/lib/audit";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const sharedSecret = process.env.WORKER_SHARED_SECRET;
  const providedSecret = request.headers.get("x-worker-secret");

  if (!sharedSecret || providedSecret !== sharedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    source?: string;
    status?: string;
    recordsSeen?: number;
    errorSummary?: string;
  };

  const result = await query<{ id: string }>(
    `insert into sync_runs (source, status, records_seen, error_summary, started_at, completed_at)
     values ($1, $2, $3, $4, now(), now())
     returning id`,
    [body.source ?? "phase0", body.status ?? "completed", body.recordsSeen ?? 0, body.errorSummary ?? null]
  );

  await recordAuditEvent({
    action: "sync_run.recorded",
    targetType: "sync_run",
    targetId: result.rows[0]?.id,
    metadata: { source: body.source ?? "phase0", status: body.status ?? "completed" }
  });

  return NextResponse.json({ id: result.rows[0]?.id });
}
