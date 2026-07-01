import { NextRequest, NextResponse } from "next/server";
import {
  normalizeAnswerMode,
  normalizeKnowledgeLimit,
  normalizeKnowledgeQuery,
  normalizeRetrievalMode,
  runGrantKnowledgeSearch
} from "@/lib/knowledge/search";
import { isPublicPrototypePrincipal, principalHasPermission, requirePermission } from "@/lib/authorization";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const principal = await requirePermission("knowledge:search", { allowPublicPrototypeRead: true });
  const body = await request.json().catch(() => ({}));
  const searchText = normalizeKnowledgeQuery(body?.query);

  if (!searchText) {
    return NextResponse.json({ error: "Enter a search query." }, { status: 400 });
  }

  const answerMode = normalizeAnswerMode(body?.answerMode);
  const retrievalMode = normalizeRetrievalMode(body?.retrievalMode);
  const limit = normalizeKnowledgeLimit(body?.limit);
  const canUseAiAnswer =
    !isPublicPrototypePrincipal(principal) &&
    (await principalHasPermission(principal.id, "knowledge:compose"));
  const canUseSemanticSearch =
    !isPublicPrototypePrincipal(principal) &&
    (await principalHasPermission(principal.id, "knowledge:semantic"));

  if (retrievalMode !== "keyword" && !canUseSemanticSearch) {
    return NextResponse.json({ error: "Semantic retrieval requires authenticated access." }, { status: 403 });
  }

  try {
    const result = await runGrantKnowledgeSearch({
      searchText,
      limit,
      answerMode,
      retrievalMode,
      allowAiAnswer: canUseAiAnswer,
      allowSemanticSearch: canUseSemanticSearch,
      principalId: isPublicPrototypePrincipal(principal) ? null : principal.id
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Grant knowledge search failed", error);
    return NextResponse.json({ error: "Grant knowledge search failed." }, { status: 500 });
  }
}
