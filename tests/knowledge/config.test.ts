import assert from "node:assert/strict";
import test from "node:test";
import {
  committeeBriefingAiModel,
  grantAnalysisAiModel,
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

test("uses Terra Pro only for committee briefings by default", { concurrency: false }, () => {
  withModelEnvironment({}, () => {
    assert.equal(knowledgeAiModel(), "openai-gpt-55");
    assert.equal(committeeBriefingAiModel(), "openai-gpt-56-terra-pro");
    assert.equal(grantAnalysisAiModel("committee_briefing"), "openai-gpt-56-terra-pro");
    assert.equal(grantAnalysisAiModel("custom"), "openai-gpt-55");
  });
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
