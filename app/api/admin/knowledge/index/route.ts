import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { NextResponse } from "next/server";
import { recordAuditEvent } from "@/lib/audit";
import { principalHasRole, requirePermission } from "@/lib/authorization";
import { refreshGrantKnowledgeDocuments } from "@/lib/knowledge/documents";

export const dynamic = "force-dynamic";

const lambda = new LambdaClient({});

async function enqueueKnowledgeIndexRebuild(principalId: string) {
  const functionName = process.env.ZCG_KNOWLEDGE_INDEX_WORKER_FUNCTION_NAME;

  if (!functionName) {
    return null;
  }

  const payload = {
    requestedAt: new Date().toISOString(),
    requestedByPrincipalId: principalId
  };
  const result = await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(payload))
    })
  );

  if (result.StatusCode && result.StatusCode >= 300) {
    throw new Error(`Knowledge index worker invoke failed with status ${result.StatusCode}.`);
  }

  await recordAuditEvent({
    actorPrincipalId: principalId,
    action: "knowledge.index.requested",
    targetType: "grant_knowledge",
    metadata: {
      functionName,
      invocationStatusCode: result.StatusCode ?? null
    }
  });

  return {
    ok: true,
    accepted: true,
    message: "Knowledge index rebuild started."
  };
}

export async function POST() {
  const principal = await requirePermission("knowledge:index");
  const isAdmin = await principalHasRole(principal.id, "admin");

  if (!isAdmin) {
    return NextResponse.json({ error: "Knowledge indexing requires the Administrator role." }, { status: 403 });
  }

  try {
    const queued = await enqueueKnowledgeIndexRebuild(principal.id);

    if (queued) {
      return NextResponse.json(queued, { status: 202 });
    }

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
