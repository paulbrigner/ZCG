import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/authorization";
import {
  ReconciliationBusyError,
  runGrantReconciliation
} from "@/lib/reconciliation/grants";

export const dynamic = "force-dynamic";

export async function POST() {
  await requirePermission("reconciliation:write");

  try {
    const result = await runGrantReconciliation();

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ReconciliationBusyError) {
      return NextResponse.json(
        {
          ok: false,
          busy: true,
          error: error.message,
          lockedUntil: error.lockedUntil
        },
        { status: 409 }
      );
    }

    throw error;
  }
}
