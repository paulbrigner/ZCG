import assert from "node:assert/strict";
import test from "node:test";
import { composeGroundedGrantAnalysis, composeGroundedGrantAnalysisResult } from "../../lib/knowledge/compose";
import { grantAnalysisGenerationOptions } from "../../lib/knowledge/config";

const prompt = { systemPrompt: "System", userPrompt: "Evidence [1]" };

async function withProvider(
  mockFetch: typeof fetch,
  callback: () => Promise<void>,
  baseUrl = "https://api.venice.ai/api/v1"
) {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  try {
    process.env.ZCG_KNOWLEDGE_AI_API_KEY = "test-key";
    process.env.ZCG_KNOWLEDGE_AI_BASE_URL = baseUrl;
    globalThis.fetch = mockFetch;
    await callback();
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ["ZCG_KNOWLEDGE_AI_API_KEY", "ZCG_KNOWLEDGE_AI_BASE_URL"]) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
}

function response(payload: unknown) {
  return new Response(JSON.stringify(payload), { status: 200 });
}

const success = {
  choices: [{ finish_reason: "stop", message: { content: "Grounded response [1].", reasoning_content: "Private reasoning" } }],
  usage: { prompt_tokens: 1000, completion_tokens: 6000, completion_tokens_details: { reasoning_tokens: 4000 } }
};

test("committee requests use standard Astra, medium effort, and a combined completion budget", async () => {
  await withProvider(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "openai-gpt-6-astra");
    assert.equal(body.reasoning_effort, "medium");
    assert.equal(body.reasoning, undefined);
    assert.equal(body.temperature, undefined);
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.max_completion_tokens, 25_000);
    return response(success);
  }, async () => {
    const result = await composeGroundedGrantAnalysisResult({
      ...prompt, model: "openai-gpt-6-astra", ...grantAnalysisGenerationOptions("committee_briefing")
    });
    assert.equal(result.text, "Grounded response [1].");
    assert.equal(result.finishReason, "stop");
    assert.equal(result.inputTokens, 1000);
    assert.equal(result.outputTokens, 6000);
    assert.equal(result.reasoningTokens, 4000);
    assert.ok(result.latencyMs >= 0);
  });
});

test("custom analyses retain sampling, disabled reasoning, and their original budget", async () => {
  await withProvider(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "openai-gpt-55");
    assert.equal(body.temperature, 0.15);
    assert.equal(body.reasoning_effort, "none");
    assert.deepEqual(body.reasoning, { enabled: false });
    assert.equal(body.max_completion_tokens, 2200);
    return response(success);
  }, async () => {
    assert.equal(await composeGroundedGrantAnalysis({
      ...prompt, model: "openai-gpt-55", ...grantAnalysisGenerationOptions("custom")
    }), "Grounded response [1].");
  });
});

test("non-Venice reasoning requests also use max_completion_tokens without Venice-only flags", async () => {
  await withProvider(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.max_completion_tokens, 25_000);
    assert.equal(body.max_tokens, undefined);
    assert.equal(body.reasoning, undefined);
    assert.equal(body.temperature, undefined);
    return response(success);
  }, async () => {
    await composeGroundedGrantAnalysis({ ...prompt, model: "gpt-6-astra", ...grantAnalysisGenerationOptions("committee_briefing") });
  }, "https://api.openai.com/v1");
});

for (const finishReason of ["length", "content_filter", "tool_calls", null]) {
  test(`rejects an incomplete reasoning completion even with visible text: ${finishReason}`, async () => {
    await withProvider(async () => response({
      choices: [{ finish_reason: finishReason, message: { content: "Partial [1]." } }]
    }), async () => {
      await assert.rejects(composeGroundedGrantAnalysis({ ...prompt, reasoningEffort: "medium" }), /response was incomplete/);
    });
  });
}

test("rejects refusal text and never uses reasoning as the final answer", async () => {
  for (const message of [
    { content: "Partial answer", refusal: "Refused" },
    { content: "", reasoning_content: "Private reasoning" }
  ]) {
    await withProvider(async () => response({ choices: [{ finish_reason: "stop", message }] }), async () => {
      await assert.rejects(composeGroundedGrantAnalysis({ ...prompt, reasoningEffort: "medium" }), /refusal|did not include text/);
    });
  }
});

test("normalizes missing and malformed usage without inventing token counts", async () => {
  await withProvider(async () => response({
    choices: [{ finish_reason: "stop", message: { content: [{ text: "Part one" }, { text: "Part two" }] } }],
    usage: { prompt_tokens: -1, completion_tokens: "100", completion_tokens_details: { reasoning_tokens: 0 } }
  }), async () => {
    const result = await composeGroundedGrantAnalysisResult(prompt);
    assert.equal(result.text, "Part one\nPart two");
    assert.equal(result.inputTokens, null);
    assert.equal(result.outputTokens, null);
    assert.equal(result.reasoningTokens, 0);
  });
});

test("reports provider HTTP failures", async () => {
  await withProvider(async () => new Response("unsupported parameter", { status: 400 }), async () => {
    await assert.rejects(composeGroundedGrantAnalysis(prompt), /failed \(400\): unsupported parameter/);
  });
});

for (const duringBody of [false, true]) {
  test(`timeout aborts ${duringBody ? "response body reading" : "the pending request"}`, async () => {
    await withProvider(async (_input, init) => {
      const signal = init?.signal;
      const pending = () => new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
      if (!duringBody) return pending();
      return { ok: true, json: pending } as unknown as Response;
    }, async () => {
      await assert.rejects(composeGroundedGrantAnalysis({ ...prompt, timeoutMs: 10 }), /timed out after 10 ms/);
    });
  });
}
