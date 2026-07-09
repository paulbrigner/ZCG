import { closePool, query } from "../lib/db";
import { refreshGrantKnowledgeDocuments } from "../lib/knowledge/documents";
import { getGrantKnowledgeEmbeddingStatus } from "../lib/knowledge/embeddings";

type WorkerEvent = {
  requestedAt?: string;
  requestedByPrincipalId?: string | null;
};

type KnowledgeIndexStatus = {
  documentCount: number;
  latestIndexedAt: string | null;
};

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function getKnowledgeIndexStatus(): Promise<KnowledgeIndexStatus> {
  const result = await query<{
    document_count: string;
    latest_indexed_at: string | null;
  }>(
    `select count(*)::text as document_count,
            max(indexed_at)::text as latest_indexed_at
       from grant_knowledge_documents`
  );
  const row = result.rows[0];

  return {
    documentCount: Number(row?.document_count ?? 0),
    latestIndexedAt: row?.latest_indexed_at ?? null
  };
}

async function recordIndexRun(
  params: {
    action: "knowledge.index" | "knowledge.index.failed";
    actorPrincipalId: string | null;
    metadata: Record<string, unknown>;
  }
) {
  await query(
    `insert into audit_events (actor_principal_id, action, target_type, metadata)
     values ($1, $2, 'grant_knowledge', $3::jsonb)`,
    [
      params.actorPrincipalId,
      params.action,
      JSON.stringify(params.metadata)
    ]
  );
}

export async function handler(event: WorkerEvent = {}) {
  const startedAt = new Date().toISOString();
  const actorPrincipalId = stringValue(event.requestedByPrincipalId);

  try {
    const before = await getKnowledgeIndexStatus();
    const result = await refreshGrantKnowledgeDocuments();
    const after = await getKnowledgeIndexStatus();
    const embeddingStatus = await getGrantKnowledgeEmbeddingStatus();
    const metadata = {
      ...result,
      requestedAt: stringValue(event.requestedAt),
      startedAt,
      completedAt: new Date().toISOString(),
      before,
      after,
      embeddingStatus
    };

    await recordIndexRun({
      action: "knowledge.index",
      actorPrincipalId,
      metadata
    });

    return metadata;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await recordIndexRun({
      action: "knowledge.index.failed",
      actorPrincipalId,
      metadata: {
        requestedAt: stringValue(event.requestedAt),
        startedAt,
        completedAt: new Date().toISOString(),
        error: message
      }
    }).catch((auditError) => {
      console.error("Failed to record knowledge index failure", auditError);
    });

    throw error;
  }
}

if (process.argv[1]?.endsWith("knowledge-index-worker.ts")) {
  handler()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closePool();
    });
}
