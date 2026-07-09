import {
  knowledgeAiApiKey,
  knowledgeAiBaseUrl,
  knowledgeAiModel,
  knowledgeAiTimeoutMs
} from "@/lib/knowledge/config";
import type { GrantKnowledgeSearchResult } from "@/lib/knowledge/search";

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
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

export async function composeGrantKnowledgeAnswer({
  searchText,
  results
}: {
  searchText: string;
  results: GrantKnowledgeSearchResult[];
}) {
  const apiKey = knowledgeAiApiKey();

  if (!apiKey) {
    throw new Error("ZCG knowledge AI key is not configured.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), knowledgeAiTimeoutMs());
  const evidence = evidenceForPrompt(results);

  try {
    const response = await fetch(`${knowledgeAiBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: knowledgeAiModel(),
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You answer questions about Zcash Community Grants using only the provided evidence. " +
              "If the evidence is insufficient, say what is missing. Cite evidence with bracket numbers like [1]."
          },
          {
            role: "user",
            content: [
              `Question: ${searchText}`,
              "",
              "Grounded evidence:",
              evidence || "No matching evidence was retrieved."
            ].join("\n")
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

    if (!text) {
      throw new Error("Knowledge answer response did not include text.");
    }

    return text;
  } finally {
    clearTimeout(timeout);
  }
}
