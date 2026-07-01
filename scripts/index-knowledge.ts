import { closePool } from "../lib/db";
import { refreshGrantKnowledgeDocuments } from "../lib/knowledge/documents";

async function main() {
  const result = await refreshGrantKnowledgeDocuments();
  console.log(
    `Indexed ${result.documentsIndexed} knowledge documents from ${result.applicationsSeen} applications; removed ${result.staleDocumentsRemoved} stale documents.`
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
