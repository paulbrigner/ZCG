import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/authorization";
import { runGrantReconciliation } from "@/lib/reconciliation/grants";

export const dynamic = "force-dynamic";

export async function POST() {
  await requirePermission("reconciliation:write");

  const result = await runGrantReconciliation();

  return NextResponse.json(result);
}
