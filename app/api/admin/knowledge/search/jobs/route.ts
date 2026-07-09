import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "@/lib/audit";
import { principalHasPermission, requirePermission } from "@/lib/authorization";
import {
  createGrantKnowledgeAnswerJob,
  failGrantKnowledgeAnswerJob,
  serializeGrantKnowledgeAnswerJob
} from "@/lib/knowledge/answer-jobs";
import {
  normalizeAnswerMode,
  normalizeKnowledgeLimit,
  normalizeKnowledgeQuery,
  normalizeRetrievalMode
} from "@/lib/knowledge/search";

export const dynamic = "force-dynamic";

const lambda = new LambdaClient({});

async function invokeKnowledgeAnswerWorker(jobId: string) {
  const functionName = process.env.ZCG_KNOWLEDGE_ANSWER_WORKER_FUNCTION_NAME;

  if (!functionName) {
    throw new Error("ZCG_KNOWLEDGE_ANSWER_WORKER_FUNCTION_NAME is not configured.");
  }

  const result = await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({ jobId }))
    })
  );

  if (result.StatusCode && result.StatusCode >= 300) {
    throw new Error(`Knowledge answer worker invoke failed with status ${result.StatusCode}.`);
  }

  return {
    functionName,
    invocationStatusCode: result.StatusCode ?? null
  };
}

export async function POST(request: NextRequest) {
  const principal = await requirePermission("knowledge:search");
  const body = await request.json().catch(() => ({}));
  const searchText = normalizeKnowledgeQuery(body?.query);

  if (!searchText) {
    return NextResponse.json({ error: "Enter a search query." }, { status: 400 });
  }

  const answerMode = normalizeAnswerMode(body?.answerMode);

  if (answerMode !== "ai") {
    return NextResponse.json({ error: "Async knowledge jobs are only used for AI grounded answers." }, { status: 400 });
  }

  const retrievalMode = normalizeRetrievalMode(body?.retrievalMode);
  const limit = normalizeKnowledgeLimit(body?.limit);
  const canUseAiAnswer = await principalHasPermission(principal.id, "knowledge:compose");
  const canUseSemanticSearch = await principalHasPermission(principal.id, "knowledge:semantic");

  if (!canUseAiAnswer) {
    return NextResponse.json({ error: "AI grounded answers require compose access." }, { status: 403 });
  }

  if (retrievalMode !== "keyword" && !canUseSemanticSearch) {
    return NextResponse.json({ error: "Semantic retrieval requires authenticated semantic access." }, { status: 403 });
  }

  const job = await createGrantKnowledgeAnswerJob({
    principalId: principal.id,
    request: {
      searchText,
      limit,
      answerMode,
      retrievalMode,
      allowAiAnswer: canUseAiAnswer,
      allowSemanticSearch: canUseSemanticSearch
    }
  });

  try {
    const invocation = await invokeKnowledgeAnswerWorker(job.id);

    await recordAuditEvent({
      actorPrincipalId: principal.id,
      action: "knowledge.answer.requested",
      targetType: "grant_knowledge_answer_job",
      targetId: job.id,
      metadata: {
        query: searchText,
        limit,
        answerMode,
        retrievalMode,
        ...invocation
      }
    });

    return NextResponse.json({ accepted: true, ...serializeGrantKnowledgeAnswerJob(job) }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Knowledge answer worker invoke failed.";
    await failGrantKnowledgeAnswerJob(job.id, message).catch((failError) => {
      console.error("Failed to mark knowledge answer job failed", failError);
    });
    console.error("Knowledge answer job enqueue failed", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
