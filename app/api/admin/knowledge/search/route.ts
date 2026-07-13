import { NextRequest, NextResponse } from "next/server";
import {
  normalizeAnswerMode,
  normalizeKnowledgeLimit,
  normalizeKnowledgeQuery,
  normalizeRetrievalMode,
  runGrantKnowledgeSearch,
  type GrantKnowledgeSearchResponse,
  type KnowledgeRetrievalMode
} from "@/lib/knowledge/search";
import { isPublicPrototypePrincipal, principalHasPermission, requirePermission } from "@/lib/authorization";
import {
  consumePublicSemanticSearchAllowance,
  publicKnowledgeSearchClientHash,
  recordPublicKnowledgeSearchTelemetry,
  type PublicKnowledgeSearchOutcome
} from "@/lib/knowledge/public-search-controls";

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
  const publicViewer = isPublicPrototypePrincipal(principal);
  const canUseAiAnswer =
    !publicViewer &&
    (await principalHasPermission(principal.id, "knowledge:compose"));
  const hasSemanticPermission =
    !publicViewer &&
    (await principalHasPermission(principal.id, "knowledge:semantic"));
  const canUseSemanticSearch = hasSemanticPermission || (publicViewer && answerMode === "evidence");

  if (publicViewer && answerMode === "ai") {
    return NextResponse.json(
      { error: "AI grounded answers require authorized committee or operational access." },
      { status: 403 }
    );
  }

  if (retrievalMode !== "keyword" && !canUseSemanticSearch) {
    return NextResponse.json(
      { error: "Semantic retrieval is available publicly for evidence summaries; AI answers require authenticated access." },
      { status: 403 }
    );
  }

  let servedMode: KnowledgeRetrievalMode = retrievalMode;
  let outcome: PublicKnowledgeSearchOutcome = "served";
  let retrievalNotice: string | undefined;

  try {
    if (publicViewer && retrievalMode !== "keyword") {
      try {
        const allowance = await consumePublicSemanticSearchAllowance({
          clientHash: publicKnowledgeSearchClientHash(request.headers)
        });

        if (!allowance.allowed) {
          servedMode = "keyword";
          outcome = "rate_limited_fallback";
          retrievalNotice = allowance.reason === "global"
            ? "The public semantic-search daily limit has been reached, so keyword retrieval was used instead."
            : "This client has reached the short-term public semantic-search limit, so keyword retrieval was used instead.";
        }
      } catch (error) {
        console.error("Public semantic search controls were unavailable; using keyword retrieval", error);
        servedMode = "keyword";
        outcome = "control_unavailable_fallback";
        retrievalNotice = "Public semantic-search controls are temporarily unavailable, so keyword retrieval was used instead.";
      }
    }

    let result: GrantKnowledgeSearchResponse;

    try {
      result = await runGrantKnowledgeSearch({
        searchText,
        limit,
        answerMode,
        retrievalMode: servedMode,
        allowAiAnswer: canUseAiAnswer,
        allowSemanticSearch: canUseSemanticSearch,
        principalId: publicViewer ? null : principal.id
      });
    } catch (error) {
      if (!publicViewer || servedMode === "keyword") {
        throw error;
      }

      console.error("Public semantic retrieval failed; using keyword retrieval", error);
      servedMode = "keyword";
      outcome = "provider_error_fallback";
      retrievalNotice = "Semantic retrieval was temporarily unavailable, so keyword retrieval was used instead.";
      result = await runGrantKnowledgeSearch({
        searchText,
        limit,
        answerMode,
        retrievalMode: "keyword",
        allowAiAnswer: false,
        allowSemanticSearch: false,
        principalId: null
      });
    }

    if (
      publicViewer &&
      retrievalMode !== "keyword" &&
      result.retrievalMode === "keyword" &&
      servedMode !== "keyword"
    ) {
      servedMode = "keyword";
      outcome = "provider_error_fallback";
      retrievalNotice = result.retrievalNotice ??
        "Semantic retrieval was temporarily unavailable, so keyword retrieval was used instead.";
    }

    if (publicViewer) {
      await recordPublicKnowledgeSearchTelemetry({
        requestedMode: retrievalMode,
        servedMode: result.retrievalMode,
        outcome
      });
    }

    return NextResponse.json({
      ...result,
      retrievalNotice: retrievalNotice ?? result.retrievalNotice
    });
  } catch (error) {
    if (publicViewer) {
      await recordPublicKnowledgeSearchTelemetry({
        requestedMode: retrievalMode,
        servedMode,
        outcome: "error"
      });
    }
    console.error("Grant knowledge search failed", error);
    return NextResponse.json({ error: "Grant knowledge search failed." }, { status: 500 });
  }
}
