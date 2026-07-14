import assert from "node:assert/strict";
import test from "node:test";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { ZcgPrototypeStack } from "../../infra/zcg-prototype-stack";

test("synthesizes a DST-aware staged corpus refresh pipeline", () => {
  const app = new App({
    context: {
      costMode: "prototype-low-cost",
      environment: "test",
      enableWorkers: true,
      enableSourceSyncSchedule: true,
      removalPolicy: "destroy"
    }
  });
  const stack = new ZcgPrototypeStack(app, "CorpusRefreshTestStack", {
    env: { account: "111111111111", region: "us-east-1" }
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties("AWS::Scheduler::Schedule", {
    ScheduleExpression: "cron(0 3 * * ? *)",
    ScheduleExpressionTimezone: "America/New_York",
    State: "ENABLED",
    Target: {
      Input: '{"trigger":"schedule","requestedAt":null,"requestedByPrincipalId":null}'
    }
  });
  template.hasResourceProperties("AWS::StepFunctions::StateMachine", {
    StateMachineType: "STANDARD"
  });

  const rendered = JSON.stringify(template.toJSON());

  for (const stateName of [
    "AcquireCorpusRefreshLease",
    "MirrorGitHubIssueBatch",
    "MirrorLinkedForumTopicBatches",
    "MirrorForumUpdateBatches",
    "ReconcileCorpusApplications",
    "RebuildCorpusKnowledgeIndex",
    "CompleteCorpusRefresh",
    "FailCorpusRefresh"
  ]) {
    assert.match(rendered, new RegExp(stateName));
  }
  assert.match(rendered, /TimeoutSeconds/);
  assert.match(rendered, /10800/);
  assert.match(rendered, /IsPresent/);
  assert.match(rendered, /States\.TaskFailed/);
});
