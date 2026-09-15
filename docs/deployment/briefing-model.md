# Committee briefing model releases

## Astra configuration

The standard Venice model is `openai-gpt-6-astra`, distinct from the Pro model.
The committee worker sends `reasoning_effort: "medium"`, no `temperature`, and
`max_completion_tokens: 25000`. The latter includes reasoning and visible output.
The request timeout is 240 seconds; the Lambda timeout is 420 seconds. Custom
analysis and knowledge search retain their existing separate settings.

Compatibility references:

- [OpenAI Astra migration guide](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md#migration-quickstart)
- [Venice reasoning controls](https://docs.venice.ai/guides/features/reasoning-models)
- [Venice chat-completion contract](https://docs.venice.ai/api-reference/endpoint/chat/completions)

## Release order

1. Run `npm test` and `npm run check`, plus
   `AWS_PROFILE=zodldashboard AWS_REGION=us-east-1 npm run infra:diff:prototype-low-cost`.
   Preserve the helper's live sender, secret references, and low-cost context.
   Inspect the synthesized template for unrelated resource drift.
2. Run a bounded provider canary with the real evidence pack and production
   prompt. Check final text, required sections, citations, finish reason, token
   usage, and latency. Do not publish or replace saved briefings as a canary.
3. Obtain independent review of immutable code revisions, the exact AWS diff,
   and the deployment order under `AGENTS.md` before deployment or merge.
4. Deploy the reviewed backend first. Existing queued jobs pin their model; the
   new worker accepts the old committee model with medium reasoning during the
   transition. Wait for successful stack completion and verify Lambda code,
   model environment, and timeout.
5. Change only the Amplify app's `ZCG_KNOWLEDGE_COMMITTEE_BRIEFING_MODEL` to
   `openai-gpt-6-astra`, preserving all other environment entries. Check for a
   branch-level override. Then merge the exact reviewed head into `main` to
   trigger the web build. Verify the build revision and successful deployment.
6. Verify the live grant/briefing views, old report history, and the deployed
   worker with a temporary test job that does not publish a report. Record its
   model, effective effort, completion status, and measured latency.

Rollback keeps saved reports intact. Set the committee model back to the
previous reviewed value in both backend context (`knowledgeCommitteeBriefingModel`)
and Amplify, then rebuild the web tier. The previous Terra Pro model supports
medium reasoning in this worker. Follow independent review for rollback changes;
do not restore the old worker while Astra jobs are queued or running.
