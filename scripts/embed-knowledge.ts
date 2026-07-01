import { closePool } from "../lib/db";
import { refreshGrantKnowledgeEmbeddings } from "../lib/knowledge/embeddings";

async function main() {
  const maxDocuments = Number(process.env.ZCG_KNOWLEDGE_EMBED_MAX_DOCUMENTS ?? 0);
  const result = await refreshGrantKnowledgeEmbeddings({
    maxDocuments: Number.isFinite(maxDocuments) && maxDocuments > 0 ? maxDocuments : 0
  });

  console.log(
    `Embedded ${result.documentsEmbedded} knowledge documents with ${result.model} (${result.dims} dimensions); skipped ${result.documentsSkipped}.`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
