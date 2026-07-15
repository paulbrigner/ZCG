import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  createWebhookIngressHandler,
  type CorpusWebhookMessage,
  type LambdaFunctionUrlV2Event,
  verifySha256Signature,
  webhookIngressWorkerTestHooks
} from "../../workers/webhook-ingress-worker";

const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789012/corpus-webhooks";
const receivedAt = "2026-07-15T12:34:56.000Z";

function signature(body: Buffer | string, secret: string) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function functionUrlEvent(input: {
  path: string;
  body?: string;
  headers?: Record<string, string>;
  method?: string;
  base64?: boolean;
}): LambdaFunctionUrlV2Event {
  return {
    version: "2.0",
    rawPath: input.path,
    headers: input.headers ?? {},
    body: input.body ?? "",
    isBase64Encoded: input.base64 ?? false,
    requestContext: {
      http: {
        method: input.method ?? "POST",
        path: input.path
      }
    }
  };
}

function testHandler(input: {
  env: Record<string, string | undefined>;
  readSecret?: (secretId: string) => Promise<{ SecretString?: string }>;
}) {
  const messages: CorpusWebhookMessage[] = [];
  const handler = createWebhookIngressHandler({
    env: {
      WEBHOOK_QUEUE_URL: queueUrl,
      ...input.env
    },
    now: () => new Date(receivedAt),
    readSecret: input.readSecret,
    logError: () => undefined,
    enqueue: async ({ queueUrl: destination, message }) => {
      assert.equal(destination, queueUrl);
      messages.push(message);
    }
  });

  return { handler, messages };
}

function responseJson(response: Awaited<ReturnType<ReturnType<typeof createWebhookIngressHandler>>>) {
  return JSON.parse(response.body) as Record<string, unknown>;
}

test("verifies an HMAC-SHA256 signature over the exact request bytes", () => {
  const secret = "exact-byte-secret";
  const body = Buffer.from("{\n  \"value\": \"spaced body\"\n}\n", "utf8");

  assert.equal(verifySha256Signature(body, signature(body, secret), secret), true);
  assert.equal(
    verifySha256Signature(Buffer.from(body.toString("utf8").trim()), signature(body, secret), secret),
    false
  );
  assert.equal(verifySha256Signature(body, "sha256=not-a-digest", secret), false);
});

test("accepts and normalizes a signed GitHub issue-comment event", async () => {
  const secret = "github-webhook-secret";
  const body = JSON.stringify({
    action: "edited",
    repository: { full_name: "ZcashCommunityGrants/zcashcommunitygrants" },
    issue: { number: 351 },
    comment: { id: 991234 }
  });
  const { handler, messages } = testHandler({
    env: { GITHUB_WEBHOOK_SECRET: secret }
  });
  const response = await handler(functionUrlEvent({
    path: "/github",
    body,
    headers: {
      "X-GitHub-Delivery": "delivery-github-1",
      "X-GitHub-Event": "issue_comment",
      "X-Hub-Signature-256": signature(body, secret)
    }
  }));

  assert.equal(response.statusCode, 202);
  assert.deepEqual(responseJson(response), {
    accepted: true,
    provider: "github",
    deliveryId: "delivery-github-1"
  });
  assert.deepEqual(messages, [{
    schemaVersion: 1,
    provider: "github",
    deliveryId: "delivery-github-1",
    eventType: "issue_comment",
    action: "edited",
    source: {
      repository: "ZcashCommunityGrants/zcashcommunitygrants",
      issueNumber: 351,
      commentId: 991234
    },
    receivedAt
  }]);
});

test("accepts a signed GitHub ping with a base64 Function URL body", async () => {
  const secret = "github-ping-secret";
  const rawBody = Buffer.from(JSON.stringify({
    zen: "Keep it logically awesome.",
    repository: { full_name: "ZcashCommunityGrants/zcashcommunitygrants" }
  }));
  const { handler, messages } = testHandler({
    env: { GITHUB_WEBHOOK_SECRET: secret }
  });
  const response = await handler(functionUrlEvent({
    path: "/github/",
    body: rawBody.toString("base64"),
    base64: true,
    headers: {
      "x-github-delivery": "delivery-ping-1",
      "x-github-event": "ping",
      "x-hub-signature-256": signature(rawBody, secret)
    }
  }));

  assert.equal(response.statusCode, 202);
  assert.equal(messages[0]?.eventType, "ping");
  assert.equal(messages[0]?.action, "ping");
  assert.deepEqual(messages[0]?.source, {
    repository: "ZcashCommunityGrants/zcashcommunitygrants"
  });
});

test("marks GitHub pull-request comment events so the corpus worker can ignore them", async () => {
  const secret = "github-pr-comment-secret";
  const body = JSON.stringify({
    action: "created",
    repository: { full_name: "ZcashCommunityGrants/zcashcommunitygrants" },
    issue: {
      number: 352,
      pull_request: { url: "https://api.github.com/repos/ZcashCommunityGrants/zcashcommunitygrants/pulls/352" }
    },
    comment: { id: 991235 }
  });
  const { handler, messages } = testHandler({
    env: { GITHUB_WEBHOOK_SECRET: secret }
  });

  const response = await handler(functionUrlEvent({
    path: "/github",
    body,
    headers: {
      "x-github-delivery": "delivery-pr-comment-1",
      "x-github-event": "issue_comment",
      "x-hub-signature-256": signature(body, secret)
    }
  }));

  assert.equal(response.statusCode, 202);
  assert.deepEqual(messages[0]?.source, {
    repository: "ZcashCommunityGrants/zcashcommunitygrants",
    issueNumber: 352,
    commentId: 991235,
    isPullRequest: true
  });
});

test("rejects a GitHub request with an invalid signature without enqueueing", async () => {
  const secret = "github-webhook-secret";
  const body = JSON.stringify({ repository: { full_name: "owner/repo" } });
  const { handler, messages } = testHandler({
    env: { GITHUB_WEBHOOK_SECRET: secret }
  });
  const response = await handler(functionUrlEvent({
    path: "/github",
    body,
    headers: {
      "x-github-delivery": "delivery-github-2",
      "x-github-event": "issues",
      "x-hub-signature-256": signature(body, "wrong-secret")
    }
  }));

  assert.equal(response.statusCode, 401);
  assert.deepEqual(responseJson(response), {
    accepted: false,
    error: "invalid_signature"
  });
  assert.equal(messages.length, 0);
});

test("loads and caches a Discourse webhook secret from Secrets Manager", async () => {
  const secret = "discourse-webhook-secret";
  const body = JSON.stringify({ post: { id: 887, topic_id: 56588 } });
  let secretReads = 0;
  const { handler, messages } = testHandler({
    env: { DISCOURSE_WEBHOOK_SECRET_ARN: "arn:example:discourse-secret" },
    readSecret: async (secretId) => {
      assert.equal(secretId, "arn:example:discourse-secret");
      secretReads += 1;
      return {
        SecretString: JSON.stringify({ DISCOURSE_WEBHOOK_SECRET: secret })
      };
    }
  });
  const event = functionUrlEvent({
    path: "/discourse",
    body,
    headers: {
      "x-discourse-event-id": "discourse-event-887",
      "x-discourse-event-type": "post",
      "x-discourse-event": "post_edited",
      "x-discourse-event-signature": signature(body, secret)
    }
  });

  const firstResponse = await handler(event);
  const secondResponse = await handler(event);

  assert.equal(firstResponse.statusCode, 202);
  assert.equal(secondResponse.statusCode, 202);
  assert.equal(secretReads, 1);
  assert.deepEqual(messages[0], {
    schemaVersion: 1,
    provider: "discourse",
    deliveryId: "discourse-event-887",
    eventType: "post",
    action: "post_edited",
    source: {
      topicId: 56588,
      postId: 887
    },
    receivedAt
  });
});

test("reloads a Secrets Manager credential after the configured cache TTL", async () => {
  const secret = "rotating-discourse-secret";
  const body = JSON.stringify({ topic: { id: 56588 } });
  let currentTime = new Date("2026-07-15T12:00:00.000Z");
  let secretReads = 0;
  const handler = createWebhookIngressHandler({
    env: {
      WEBHOOK_QUEUE_URL: queueUrl,
      DISCOURSE_WEBHOOK_SECRET_ARN: "arn:example:rotating-discourse-secret",
      WEBHOOK_SECRET_CACHE_TTL_MS: "50"
    },
    now: () => currentTime,
    readSecret: async () => {
      secretReads += 1;
      return { SecretString: JSON.stringify({ secret }) };
    },
    enqueue: async () => undefined,
    logError: () => undefined
  });
  const event = functionUrlEvent({
    path: "/discourse",
    body,
    headers: {
      "x-discourse-event-id": "discourse-ttl-test",
      "x-discourse-event-type": "topic",
      "x-discourse-event": "topic_edited",
      "x-discourse-event-signature": signature(body, secret)
    }
  });

  assert.equal((await handler(event)).statusCode, 202);
  currentTime = new Date("2026-07-15T12:00:00.100Z");
  assert.equal((await handler(event)).statusCode, 202);
  assert.equal(secretReads, 2);
});

test("rejects an unsigned Discourse request", async () => {
  const { handler, messages } = testHandler({
    env: { DISCOURSE_WEBHOOK_SECRET: "discourse-secret" }
  });
  const response = await handler(functionUrlEvent({
    path: "/discourse",
    body: JSON.stringify({ topic: { id: 56588 } }),
    headers: {
      "x-discourse-event-id": "discourse-event-1",
      "x-discourse-event-type": "topic",
      "x-discourse-event": "topic_edited"
    }
  }));

  assert.equal(response.statusCode, 401);
  assert.equal(responseJson(response).error, "missing_signature");
  assert.equal(messages.length, 0);
});

test("authenticates and normalizes a Google Drive notification", async () => {
  const { handler, messages } = testHandler({
    env: {
      GOOGLE_DRIVE_CHANNEL_TOKEN: "drive-channel-token",
      GOOGLE_DRIVE_CHANNEL_ID: "zcg-sheet-channel"
    }
  });
  const response = await handler(functionUrlEvent({
    path: "/google-drive",
    headers: {
      "x-goog-channel-id": "zcg-sheet-channel",
      "x-goog-channel-token": "drive-channel-token",
      "x-goog-message-number": "42",
      "x-goog-resource-id": "stable-resource-id",
      "x-goog-resource-state": "update",
      "x-goog-resource-uri": "https://www.googleapis.com/drive/v3/files/file-123?alt=json"
    }
  }));

  assert.equal(response.statusCode, 202);
  assert.deepEqual(messages, [{
    schemaVersion: 1,
    provider: "google-drive",
    deliveryId: "zcg-sheet-channel:42",
    eventType: "drive-notification",
    action: "update",
    source: {
      channelId: "zcg-sheet-channel",
      resourceId: "stable-resource-id",
      resourceUri: "https://www.googleapis.com/drive/v3/files/file-123?alt=json",
      fileId: "file-123"
    },
    receivedAt
  }]);
});

test("rejects a Google Drive notification with a wrong token or channel", async () => {
  const { handler, messages } = testHandler({
    env: {
      GOOGLE_DRIVE_CHANNEL_TOKEN: "expected-token",
      GOOGLE_DRIVE_CHANNEL_ID: "expected-channel"
    }
  });
  const headers = {
    "x-goog-channel-id": "expected-channel",
    "x-goog-channel-token": "wrong-token",
    "x-goog-message-number": "43",
    "x-goog-resource-state": "update"
  };

  const wrongToken = await handler(functionUrlEvent({ path: "/google-drive", headers }));
  const wrongChannel = await handler(functionUrlEvent({
    path: "/google-drive",
    headers: {
      ...headers,
      "x-goog-channel-token": "expected-token",
      "x-goog-channel-id": "wrong-channel"
    }
  }));

  assert.equal(wrongToken.statusCode, 401);
  assert.equal(responseJson(wrongToken).error, "invalid_channel_token");
  assert.equal(wrongChannel.statusCode, 401);
  assert.equal(responseJson(wrongChannel).error, "invalid_channel");
  assert.equal(messages.length, 0);
});

test("returns narrow route and method failures without reading credentials", async () => {
  let secretReads = 0;
  const { handler, messages } = testHandler({
    env: {},
    readSecret: async () => {
      secretReads += 1;
      return { SecretString: "unused" };
    }
  });

  const missingRoute = await handler(functionUrlEvent({ path: "/unknown" }));
  const wrongMethod = await handler(functionUrlEvent({
    path: "/github",
    method: "GET"
  }));

  assert.equal(missingRoute.statusCode, 404);
  assert.equal(responseJson(missingRoute).error, "not_found");
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(responseJson(wrongMethod).error, "method_not_allowed");
  assert.equal(secretReads, 0);
  assert.equal(messages.length, 0);
});

test("returns a retryable response when the queue is unavailable", async () => {
  const secret = "github-secret";
  const body = JSON.stringify({ repository: { full_name: "owner/repo" } });
  const handler = createWebhookIngressHandler({
    env: {
      WEBHOOK_QUEUE_URL: queueUrl,
      GITHUB_WEBHOOK_SECRET: secret
    },
    logError: () => undefined,
    enqueue: async () => {
      throw new Error("simulated SQS outage");
    }
  });
  const response = await handler(functionUrlEvent({
    path: "/github",
    body,
    headers: {
      "x-github-delivery": "delivery-retry",
      "x-github-event": "ping",
      "x-hub-signature-256": signature(body, secret)
    }
  }));

  assert.equal(response.statusCode, 503);
  assert.deepEqual(responseJson(response), {
    accepted: false,
    error: "temporarily_unavailable"
  });
});

test("extracts Drive file identifiers only from file resource URIs", () => {
  assert.equal(
    webhookIngressWorkerTestHooks.fileIdFromResourceUri(
      "https://www.googleapis.com/drive/v3/files/a-file-id?alt=json"
    ),
    "a-file-id"
  );
  assert.equal(
    webhookIngressWorkerTestHooks.fileIdFromResourceUri(
      "https://www.googleapis.com/drive/v3/changes?pageToken=123"
    ),
    null
  );
  assert.equal(webhookIngressWorkerTestHooks.fileIdFromResourceUri("not-a-url"), null);
});
