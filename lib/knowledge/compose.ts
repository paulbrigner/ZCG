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

function resultForPrompt(result: GrantKnowledgeSearchResult, index: number) {
  const source = result.sourceUrl ? `Source URL: ${result.sourceUrl}` : `Source: ${result.sourceKind ?? "unknown"}`;
  return [
    `[${index + 1}] ${result.title}`,
    result.applicantName ? `Applicant: ${result.applicantName}` : null,
    result.normalizedStatus ? `Status: ${result.normalizedStatus}` : null,
    result.requestedAmountUsd ? `Requested USD: ${result.requestedAmountUsd}` : null,
    source,
    `Evidence: ${result.excerpt}`
  ]
    .filter(Boolean)
    .join("\n");
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
  const evidence = results.slice(0, 10).map(resultForPrompt).join("\n\n");

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
