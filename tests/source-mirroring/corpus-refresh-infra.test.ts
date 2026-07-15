import assert from "node:assert/strict";
import test from "node:test";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
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
    "WaitForTargetedCorpusEvent",
    "CompleteCorpusRefresh",
    "FailCorpusRefresh"
  ]) {
    assert.match(rendered, new RegExp(stateName));
  }
  assert.match(rendered, /TimeoutSeconds/);
  assert.match(rendered, /10800/);
  assert.match(rendered, /busyOwnerKind/);
  assert.match(rendered, /IsPresent/);
  assert.match(rendered, /States\.TaskFailed/);
});

test("adds authenticated event ingress without replacing the full verification refresh", () => {
  const app = new App({
    context: {
      costMode: "prototype-low-cost",
      environment: "test",
      enableWorkers: true,
      enableHybridCorpusRefresh: true,
      enableSourceSyncSchedule: true,
      removalPolicy: "destroy"
    }
  });
  const stack = new ZcgPrototypeStack(app, "HybridCorpusRefreshTestStack", {
    env: { account: "111111111111", region: "us-east-1" }
  });
  const template = Template.fromStack(stack);

  template.hasResourceProperties("AWS::SQS::Queue", {
    DelaySeconds: 15,
    MessageRetentionPeriod: 345600,
    VisibilityTimeout: 420,
    RedrivePolicy: Match.objectLike({
      maxReceiveCount: 40
    })
  });
  template.hasResourceProperties("AWS::Lambda::Url", {
    AuthType: "NONE"
  });
  template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
    BatchSize: 10,
    FunctionResponseTypes: ["ReportBatchItemFailures"],
    MaximumBatchingWindowInSeconds: 60
  });
  template.hasResourceProperties("AWS::Lambda::Function", {
    Environment: {
      Variables: Match.objectLike({
        WEBHOOK_QUEUE_URL: Match.anyValue(),
        GITHUB_WEBHOOK_SECRET_ARN: Match.anyValue(),
        DISCOURSE_WEBHOOK_SECRET_ARN: Match.anyValue(),
        GOOGLE_DRIVE_CHANNEL_TOKEN_SECRET_ARN: Match.anyValue()
      })
    },
    ReservedConcurrentExecutions: 5,
    Timeout: 15
  });
  template.hasResourceProperties("AWS::Lambda::Function", {
    ReservedConcurrentExecutions: 1,
    Timeout: 300,
    VpcConfig: Match.anyValue()
  });
  template.hasResourceProperties("AWS::Scheduler::Schedule", {
    ScheduleExpression: "cron(0 3 * * ? *)",
    ScheduleExpressionTimezone: "America/New_York",
    State: "ENABLED"
  });

  const rendered = JSON.stringify(template.toJSON());
  assert.match(rendered, /CorpusWebhookUrl/);
  assert.match(rendered, /CorpusEventQueueUrl/);
  assert.match(rendered, /CorpusRefreshStateMachineArn/);
});
