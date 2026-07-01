import { NextResponse } from "next/server";
import { recordAuditEvent } from "@/lib/audit";
import { principalHasRole, requirePermission } from "@/lib/authorization";
import { refreshGrantKnowledgeDocuments } from "@/lib/knowledge/documents";

export const dynamic = "force-dynamic";

export async function POST() {
  const principal = await requirePermission("knowledge:index");
  const isAdmin = await principalHasRole(principal.id, "admin");

  if (!isAdmin) {
    return NextResponse.json({ error: "Knowledge indexing requires the Administrator role." }, { status: 403 });
  }

  try {
    const result = await refreshGrantKnowledgeDocuments();

    await recordAuditEvent({
      actorPrincipalId: principal.id,
      action: "knowledge.index",
      targetType: "grant_knowledge",
      metadata: result
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Grant knowledge indexing failed", error);
    return NextResponse.json({ error: "Grant knowledge indexing failed." }, { status: 500 });
  }
}
