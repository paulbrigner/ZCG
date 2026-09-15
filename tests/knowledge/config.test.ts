import assert from "node:assert/strict";
import test from "node:test";
import {
  committeeBriefingAiModel,
  grantAnalysisAiModel,
  grantAnalysisGenerationOptions,
  knowledgeAiModel
} from "../../lib/knowledge/config";

const modelEnvironmentKeys = [
  "ZCG_KNOWLEDGE_AI_MODEL",
  "ZCG_KNOWLEDGE_COMMITTEE_BRIEFING_MODEL"
] as const;

function withModelEnvironment(
  values: Partial<Record<(typeof modelEnvironmentKeys)[number], string>>,
  callback: () => void
) {
  const previous = Object.fromEntries(
    modelEnvironmentKeys.map((key) => [key, process.env[key]])
  ) as Record<(typeof modelEnvironmentKeys)[number], string | undefined>;

  try {
    for (const key of modelEnvironmentKeys) {
      const value = values[key];

      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    callback();
  } finally {
    for (const key of modelEnvironmentKeys) {
      const value = previous[key];

      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("uses standard Astra only for committee briefings by default", { concurrency: false }, () => {
  withModelEnvironment({}, () => {
    assert.equal(knowledgeAiModel(), "openai-gpt-55");
    assert.equal(committeeBriefingAiModel(), "openai-gpt-6-astra");
    assert.equal(grantAnalysisAiModel("committee_briefing"), "openai-gpt-6-astra");
    assert.equal(grantAnalysisAiModel("custom"), "openai-gpt-55");
  });
});

test("gives medium-reasoning briefings a separate completion budget and timeout", () => {
  assert.deepEqual(grantAnalysisGenerationOptions("committee_briefing"), {
    reasoningEffort: "medium", maxTokens: 25_000, timeoutMs: 240_000
  });
  const custom = grantAnalysisGenerationOptions("custom");
  assert.equal(custom.reasoningEffort, undefined);
  assert.equal(custom.temperature, 0.15);
  assert.equal(custom.maxTokens, 2_200);
});

test("keeps committee and custom model overrides independent", { concurrency: false }, () => {
  withModelEnvironment(
    {
      ZCG_KNOWLEDGE_AI_MODEL: "general-custom-model",
      ZCG_KNOWLEDGE_COMMITTEE_BRIEFING_MODEL: "committee-custom-model"
    },
    () => {
      assert.equal(knowledgeAiModel(), "general-custom-model");
      assert.equal(committeeBriefingAiModel(), "committee-custom-model");
      assert.equal(grantAnalysisAiModel("committee_briefing"), "committee-custom-model");
      assert.equal(grantAnalysisAiModel("custom"), "general-custom-model");
    }
  );
});
