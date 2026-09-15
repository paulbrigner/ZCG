import {
  knowledgeAiApiKey,
  knowledgeAiBaseUrl,
  knowledgeAiModel,
  knowledgeAiTimeoutMs
} from "@/lib/knowledge/config";
import type { GrantKnowledgeSearchResult } from "@/lib/knowledge/search";

type ChatCompletionResponse = {
  choices?: Array<{
    finish_reason?: unknown;
    message?: {
      content?: unknown;
      refusal?: unknown;
      reasoning_content?: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    completion_tokens_details?: {
      reasoning_tokens?: unknown;
    };
  };
};

const maxEvidenceItems = 100;
const maxEvidencePromptChars = 80000;
const maxEvidenceTextChars = 4000;
const richEvidenceTextChars = 3500;
const expandedEvidenceTextChars = 1400;
const minEvidenceTextChars = 500;
const richEvidenceItems = 8;
const expandedEvidenceItems = 24;

function promptEvidenceText(result: GrantKnowledgeSearchResult, maxChars: number) {
  const text = result.content.replace(/\n{3,}/g, "\n\n").trim() || result.excerpt;
  const effectiveMaxChars = Math.max(200, Math.min(maxChars, maxEvidenceTextChars));

  if (text.length <= effectiveMaxChars) {
    return text;
  }

  return `${text.slice(0, effectiveMaxChars - 90)}\n\n[Evidence text truncated for prompt size.]`;
}

function resultForPrompt(result: GrantKnowledgeSearchResult, index: number, maxTextChars: number) {
  const source = result.sourceUrl ? `Source URL: ${result.sourceUrl}` : `Source: ${result.sourceKind ?? "unknown"}`;
  return [
    `[${index + 1}] ${result.title}`,
    result.applicantName ? `Applicant: ${result.applicantName}` : null,
    result.normalizedStatus ? `Status: ${result.normalizedStatus}` : null,
    result.requestedAmountUsd ? `Requested USD: ${result.requestedAmountUsd}` : null,
    source,
    `Evidence text:\n${promptEvidenceText(result, maxTextChars)}`
  ]
    .filter(Boolean)
    .join("\n");
}

function evidenceForPrompt(results: GrantKnowledgeSearchResult[]) {
  const selectedResults = results.slice(0, maxEvidenceItems);
  const blocks: string[] = [];
  let usedChars = 0;

  for (const [index, result] of selectedResults.entries()) {
    const preferredTextBudget =
      index < richEvidenceItems
        ? richEvidenceTextChars
        : index < expandedEvidenceItems
          ? expandedEvidenceTextChars
          : minEvidenceTextChars;
    let block = resultForPrompt(result, index, preferredTextBudget);

    if (usedChars + block.length > maxEvidencePromptChars && preferredTextBudget > minEvidenceTextChars) {
      block = resultForPrompt(result, index, minEvidenceTextChars);
    }

    if (usedChars + block.length > maxEvidencePromptChars) {
      break;
    }

    blocks.push(block);
    usedChars += block.length + 2;
  }

  return blocks.join("\n\n");
}

function responseText(payload: ChatCompletionResponse) {
  const content = payload.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (!part || typeof part !== "object") {
          return null;
        }

        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : null;
      })
      .filter((part): part is string => Boolean(part));

    return parts.join("\n").trim();
  }

  return "";
}

export type GroundedGrantAnalysisOptions = {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  temperature?: number;
  timeoutMs?: number;
  maxTokens?: number;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
};

function tokenCount(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export async function composeGroundedGrantAnalysis(options: GroundedGrantAnalysisOptions) {
  return (await composeGroundedGrantAnalysisResult(options)).text;
}

export async function composeGroundedGrantAnalysisResult({
  systemPrompt,
  userPrompt,
  model = knowledgeAiModel(),
  temperature = 0.2,
  timeoutMs = knowledgeAiTimeoutMs(),
  maxTokens,
  reasoningEffort
}: GroundedGrantAnalysisOptions) {
  const apiKey = knowledgeAiApiKey();

  if (!apiKey) {
    throw new Error("ZCG knowledge AI key is not configured.");
  }

  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const baseUrl = knowledgeAiBaseUrl();
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    const isVenice = hostname === "venice.ai" || hostname.endsWith(".venice.ai");
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        // Astra does not accept sampling parameters such as temperature.
        ...(!reasoningEffort ? { temperature } : {}),
        ...(maxTokens
          ? isVenice || reasoningEffort
            ? { max_completion_tokens: maxTokens }
            : { max_tokens: maxTokens }
          : {}),
        ...(reasoningEffort
          ? { reasoning_effort: reasoningEffort }
          : isVenice ? { reasoning: { enabled: false }, reasoning_effort: "none" } : {}),
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: userPrompt
          }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const snippet = detail.trim().slice(0, 240);
      throw new Error(`Knowledge answer request failed (${response.status})${snippet ? `: ${snippet}` : ""}`);
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const text = responseText(payload);
    const choice = payload.choices?.[0];
    const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
    const refused = typeof choice?.message?.refusal === "string" && Boolean(choice.message.refusal.trim());

    if (refused || (finishReason && finishReason !== "stop") || (reasoningEffort && !finishReason)) {
      throw new Error(
        `Knowledge answer response was incomplete (finish reason: ${finishReason ?? "unknown"}).` +
        (refused ? " The provider returned a refusal." : "")
      );
    }

    if (!text) {
      const choice = payload.choices?.[0];
      const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : "unknown";
      const refusal = typeof choice?.message?.refusal === "string" && choice.message.refusal.trim()
        ? " The provider returned a refusal."
        : "";
      const reasoningTokens = Number(payload.usage?.completion_tokens_details?.reasoning_tokens);
      const reasoningDetail = Number.isFinite(reasoningTokens) && reasoningTokens > 0
        ? ` ${reasoningTokens} completion token(s) were used for reasoning.`
        : "";
      throw new Error(
        `Knowledge answer response did not include text (finish reason: ${finishReason}).${refusal}${reasoningDetail}`
      );
    }

    return {
      text,
      finishReason,
      inputTokens: tokenCount(payload.usage?.prompt_tokens),
      outputTokens: tokenCount(payload.usage?.completion_tokens),
      reasoningTokens: tokenCount(payload.usage?.completion_tokens_details?.reasoning_tokens),
      latencyMs: Date.now() - startedAt
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Knowledge answer request timed out after ${timeoutMs} ms.`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function composeGrantKnowledgeAnswer({
  searchText,
  results
}: {
  searchText: string;
  results: GrantKnowledgeSearchResult[];
}) {
  const evidence = evidenceForPrompt(results);

  return composeGroundedGrantAnalysis({
    systemPrompt:
      "You answer questions about Zcash Community Grants using only the provided evidence. " +
      "If the evidence is insufficient, say what is missing. Cite evidence with bracket numbers like [1].",
    userPrompt: [
      `Question: ${searchText}`,
      "",
      "Grounded evidence:",
      evidence || "No matching evidence was retrieved."
    ].join("\n")
  });
}
