import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/authorization";
import {
  applyManualReconciliationDecisions,
  createReconciliationDecision,
  getReconciliationWorkspace,
  ReconciliationDecisionError,
  type ReconciliationDecisionType
} from "@/lib/reconciliation/decisions";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  if (error instanceof ReconciliationDecisionError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  if (error instanceof Error && error.message === "NEXT_REDIRECT") {
    throw error;
  }

  console.error("Manual reconciliation decision error", error);
  return NextResponse.json({ error: "Failed to update reconciliation decisions." }, { status: 500 });
}

export async function GET() {
  await requirePermission("reconciliation:read", { allowPublicPrototypeRead: true });

  return NextResponse.json(await getReconciliationWorkspace());
}

export async function POST(request: NextRequest) {
  const principal = await requirePermission("reconciliation:write");

  try {
    const body = await request.json().catch(() => ({}));
    const action = typeof body?.action === "string" ? body.action : "create_decision";

    if (action === "apply_manual_decisions") {
      const applyResult = await applyManualReconciliationDecisions();
      return NextResponse.json({ ok: true, applyResult, workspace: await getReconciliationWorkspace() });
    }

    if (action === "create_decision") {
      const result = await createReconciliationDecision(
        {
          decisionType: body?.decisionType as ReconciliationDecisionType,
          sourceKind: body?.sourceKind,
          sourceId: body?.sourceId,
          canonicalType: body?.canonicalType,
          canonicalKey: body?.canonicalKey,
          relatedCanonicalKey: body?.relatedCanonicalKey,
          relationshipType: body?.relationshipType,
          fieldName: body?.fieldName,
          fieldValue: body?.fieldValue,
          rationale: body?.rationale,
          confidence: body?.confidence,
          evidence: body?.evidence && typeof body.evidence === "object" ? body.evidence : null,
          reconciliationIssueId: body?.reconciliationIssueId,
          resolutionStatus: body?.resolutionStatus
        },
        principal.id
      );

      return NextResponse.json({ ok: true, ...result, workspace: await getReconciliationWorkspace() });
    }

    return NextResponse.json({ error: "Unsupported reconciliation action." }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}
