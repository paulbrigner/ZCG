import assert from "node:assert/strict";
import test from "node:test";
import { composeGroundedGrantAnalysis } from "../../lib/knowledge/compose";

test("sends an explicitly selected grant-analysis model to the provider", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.ZCG_KNOWLEDGE_AI_API_KEY;
  const originalBaseUrl = process.env.ZCG_KNOWLEDGE_AI_BASE_URL;
  const captured: { body?: Record<string, unknown> } = {};

  try {
    process.env.ZCG_KNOWLEDGE_AI_API_KEY = "test-key";
    process.env.ZCG_KNOWLEDGE_AI_BASE_URL = "https://api.venice.ai/api/v1";
    globalThis.fetch = (async (_input, init) => {
      captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "Grounded response [1]." } }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    const answer = await composeGroundedGrantAnalysis({
      systemPrompt: "System",
      userPrompt: "Evidence [1]",
      model: "openai-gpt-56-terra-pro",
      maxTokens: 500
    });

    assert.equal(answer, "Grounded response [1].");
    assert.equal(captured.body?.model, "openai-gpt-56-terra-pro");
    assert.equal(captured.body?.max_completion_tokens, 500);
  } finally {
    globalThis.fetch = originalFetch;

    if (originalApiKey === undefined) {
      delete process.env.ZCG_KNOWLEDGE_AI_API_KEY;
    } else {
      process.env.ZCG_KNOWLEDGE_AI_API_KEY = originalApiKey;
    }

    if (originalBaseUrl === undefined) {
      delete process.env.ZCG_KNOWLEDGE_AI_BASE_URL;
    } else {
      process.env.ZCG_KNOWLEDGE_AI_BASE_URL = originalBaseUrl;
    }
  }
});
