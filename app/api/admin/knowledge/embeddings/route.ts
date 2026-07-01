import { NextResponse } from "next/server";
import { recordAuditEvent } from "@/lib/audit";
import { requirePermission } from "@/lib/authorization";
import { refreshGrantKnowledgeEmbeddings } from "@/lib/knowledge/embeddings";

export const dynamic = "force-dynamic";

export async function POST() {
  const principal = await requirePermission("knowledge:index");

  try {
    const result = await refreshGrantKnowledgeEmbeddings({ maxDocuments: 50 });

    await recordAuditEvent({
      actorPrincipalId: principal.id,
      action: "knowledge.embed",
      targetType: "grant_knowledge",
      metadata: result
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Grant knowledge embedding failed", error);
    return NextResponse.json({ error: "Grant knowledge embedding failed." }, { status: 500 });
  }
}
