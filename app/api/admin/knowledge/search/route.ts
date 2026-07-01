import { NextRequest, NextResponse } from "next/server";
import {
  normalizeAnswerMode,
  normalizeKnowledgeLimit,
  normalizeKnowledgeQuery,
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
  const limit = normalizeKnowledgeLimit(body?.limit);
  const canUseAiAnswer =
    !isPublicPrototypePrincipal(principal) &&
    (await principalHasPermission(principal.id, "knowledge:compose"));

  try {
    const result = await runGrantKnowledgeSearch({
      searchText,
      limit,
      answerMode,
      allowAiAnswer: canUseAiAnswer,
      principalId: isPublicPrototypePrincipal(principal) ? null : principal.id
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("Grant knowledge search failed", error);
    return NextResponse.json({ error: "Grant knowledge search failed." }, { status: 500 });
  }
}
