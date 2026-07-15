import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  GetSecretValueCommand,
  SecretsManagerClient
} from "@aws-sdk/client-secrets-manager";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

export type WebhookProvider = "github" | "discourse" | "google-drive";

export type GitHubSourceLocator = {
  repository: string;
  issueNumber?: number;
  commentId?: number;
  isPullRequest?: boolean;
};

export type DiscourseSourceLocator = {
  topicId?: number;
  postId?: number;
};

export type GoogleDriveSourceLocator = {
  channelId: string;
  resourceId?: string;
  resourceUri?: string;
  fileId?: string;
};

export type CorpusWebhookMessage =
  | {
      schemaVersion: 1;
      provider: "github";
      deliveryId: string;
      eventType: string;
      action: string;
      source: GitHubSourceLocator;
      receivedAt: string;
    }
  | {
      schemaVersion: 1;
      provider: "discourse";
      deliveryId: string;
      eventType: string;
      action: string;
      source: DiscourseSourceLocator;
      receivedAt: string;
    }
  | {
      schemaVersion: 1;
      provider: "google-drive";
      deliveryId: string;
      eventType: "drive-notification";
      action: string;
      source: GoogleDriveSourceLocator;
      receivedAt: string;
    };

export type LambdaFunctionUrlV2Event = {
  version?: string;
  rawPath?: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: {
    http?: {
      method?: string;
      path?: string;
    };
  };
};

export type LambdaFunctionUrlResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

type Environment = Record<string, string | undefined>;

type SecretValue = {
  SecretString?: string;
  SecretBinary?: Uint8Array;
};

type QueueMessageInput = {
  queueUrl: string;
  message: CorpusWebhookMessage;
};

export type WebhookIngressDependencies = {
  env?: Environment;
  now?: () => Date;
  readSecret?: (secretId: string) => Promise<SecretValue>;
  enqueue?: (input: QueueMessageInput) => Promise<void>;
  logError?: (message: string, details: Record<string, unknown>) => void;
};

type NormalizedRequest = {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer;
};

type SecretConfiguration = {
  directEnvironmentKey: string;
  secretIdEnvironmentKeys: string[];
  jsonKeys: string[];
};

class WebhookRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "WebhookRequestError";
  }
}

const secretsManager = new SecretsManagerClient({});
const sqs = new SQSClient({});

const providerForPath = new Map<string, WebhookProvider>([
  ["/github", "github"],
  ["/discourse", "discourse"],
  ["/google-drive", "google-drive"]
]);
const defaultSecretCacheTtlMs = 5 * 60 * 1000;

const secretConfigurations: Record<WebhookProvider, SecretConfiguration> = {
  github: {
    directEnvironmentKey: "GITHUB_WEBHOOK_SECRET",
    secretIdEnvironmentKeys: [
      "GITHUB_WEBHOOK_SECRET_ID",
      "GITHUB_WEBHOOK_SECRET_ARN"
    ],
    jsonKeys: ["GITHUB_WEBHOOK_SECRET", "githubWebhookSecret", "webhookSecret", "secret"]
  },
  discourse: {
    directEnvironmentKey: "DISCOURSE_WEBHOOK_SECRET",
    secretIdEnvironmentKeys: [
      "DISCOURSE_WEBHOOK_SECRET_ID",
      "DISCOURSE_WEBHOOK_SECRET_ARN"
    ],
    jsonKeys: [
      "DISCOURSE_WEBHOOK_SECRET",
      "discourseWebhookSecret",
      "webhookSecret",
      "secret"
    ]
  },
  "google-drive": {
    directEnvironmentKey: "GOOGLE_DRIVE_CHANNEL_TOKEN",
    secretIdEnvironmentKeys: [
      "GOOGLE_DRIVE_CHANNEL_TOKEN_SECRET_ID",
      "GOOGLE_DRIVE_CHANNEL_TOKEN_SECRET_ARN"
    ],
    jsonKeys: [
      "GOOGLE_DRIVE_CHANNEL_TOKEN",
      "googleDriveChannelToken",
      "channelToken",
      "token",
      "secret"
    ]
  }
};

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function boundedHeader(value: unknown, name: string) {
  const normalized = nonEmptyString(value);

  if (!normalized) {
    throw new WebhookRequestError(400, "missing_header", `${name} is required.`);
  }

  if (normalized.length > 512) {
    throw new WebhookRequestError(400, "invalid_header", `${name} is too long.`);
  }

  return normalized;
}

function authenticationHeader(
  value: unknown,
  name: string,
  missingCode: "missing_signature" | "missing_channel_token"
) {
  const normalized = nonEmptyString(value);

  if (!normalized) {
    throw new WebhookRequestError(401, missingCode, `${name} is required.`);
  }

  if (normalized.length > 512) {
    throw new WebhookRequestError(401, "invalid_authentication", `${name} is invalid.`);
  }

  return normalized;
}

function normalizePath(value: string | undefined) {
  const path = value?.trim() || "/";
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function normalizedHeaders(headers: LambdaFunctionUrlV2Event["headers"]) {
  return Object.fromEntries(
    Object.entries(headers ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([name, value]) => [name.toLowerCase(), value])
  );
}

function normalizeRequest(event: LambdaFunctionUrlV2Event): NormalizedRequest {
  const bodyValue = event.body ?? "";

  return {
    path: normalizePath(event.rawPath ?? event.requestContext?.http?.path),
    method: (event.requestContext?.http?.method ?? "").toUpperCase(),
    headers: normalizedHeaders(event.headers),
    body: Buffer.from(bodyValue, event.isBase64Encoded ? "base64" : "utf8")
  };
}

function jsonBody(body: Buffer) {
  if (!body.byteLength) {
    throw new WebhookRequestError(400, "missing_body", "A JSON request body is required.");
  }

  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Webhook payload must be a JSON object.");
    }

    return parsed as Record<string, unknown>;
  } catch {
    throw new WebhookRequestError(400, "invalid_json", "The webhook body is not valid JSON.");
  }
}

function recordValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function fixedLengthEqual(left: string, right: string) {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function verifySha256Signature(body: Buffer, signature: string, secret: string) {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signature.trim());

  if (!match) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(body).digest();
  const supplied = Buffer.from(match[1], "hex");
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

function secretFromValue(value: SecretValue, jsonKeys: string[]) {
  const decoded = value.SecretString ?? (
    value.SecretBinary ? Buffer.from(value.SecretBinary).toString("utf8") : ""
  );
  const trimmed = decoded.trim();

  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;

    if (typeof parsed === "string") {
      return nonEmptyString(parsed);
    }

    const record = recordValue(parsed);
    if (!record) {
      return null;
    }

    for (const key of jsonKeys) {
      const candidate = nonEmptyString(record[key]);
      if (candidate) return candidate;
    }

    return null;
  } catch {
    return trimmed;
  }
}

function githubMessage(
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  receivedAt: string
): CorpusWebhookMessage {
  const deliveryId = boundedHeader(headers["x-github-delivery"], "X-GitHub-Delivery");
  const eventType = boundedHeader(headers["x-github-event"], "X-GitHub-Event");
  const action = nonEmptyString(payload.action) ?? (eventType === "ping" ? "ping" : eventType);
  const repository = recordValue(payload.repository);
  const owner = recordValue(repository?.owner);
  const repositoryName = nonEmptyString(repository?.full_name) ?? (
    nonEmptyString(owner?.login) && nonEmptyString(repository?.name)
      ? `${nonEmptyString(owner?.login)}/${nonEmptyString(repository?.name)}`
      : null
  );

  if (!repositoryName) {
    throw new WebhookRequestError(
      400,
      "missing_source_locator",
      "The GitHub webhook did not identify a repository."
    );
  }

  const issue = recordValue(payload.issue);
  const comment = recordValue(payload.comment);
  const issueNumber = positiveInteger(issue?.number);
  const commentId = positiveInteger(comment?.id);
  const isPullRequest = Boolean(issue && issue.pull_request);

  return {
    schemaVersion: 1,
    provider: "github",
    deliveryId,
    eventType,
    action,
    source: {
      repository: repositoryName,
      ...(issueNumber ? { issueNumber } : {}),
      ...(commentId ? { commentId } : {}),
      ...(isPullRequest ? { isPullRequest: true } : {})
    },
    receivedAt
  };
}

function discourseMessage(
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  receivedAt: string
): CorpusWebhookMessage {
  const deliveryId = boundedHeader(headers["x-discourse-event-id"], "X-Discourse-Event-Id");
  const eventType = boundedHeader(headers["x-discourse-event-type"], "X-Discourse-Event-Type");
  const action = nonEmptyString(headers["x-discourse-event"])
    ?? nonEmptyString(payload.action)
    ?? eventType;
  const post = recordValue(payload.post);
  const topic = recordValue(payload.topic);
  const postId = positiveInteger(post?.id);
  const topicId = positiveInteger(post?.topic_id) ?? positiveInteger(topic?.id);

  if (!postId && !topicId) {
    throw new WebhookRequestError(
      400,
      "missing_source_locator",
      "The Discourse webhook did not identify a topic or post."
    );
  }

  return {
    schemaVersion: 1,
    provider: "discourse",
    deliveryId,
    eventType,
    action,
    source: {
      ...(topicId ? { topicId } : {}),
      ...(postId ? { postId } : {})
    },
    receivedAt
  };
}

function fileIdFromResourceUri(resourceUri: string | undefined) {
  if (!resourceUri) return null;

  try {
    const segments = new URL(resourceUri).pathname.split("/").filter(Boolean);
    const fileIndex = segments.lastIndexOf("files");
    return fileIndex >= 0 ? nonEmptyString(segments[fileIndex + 1]) : null;
  } catch {
    return null;
  }
}

function googleDriveMessage(
  headers: Record<string, string>,
  receivedAt: string,
  configuredFileId?: string
): CorpusWebhookMessage {
  const channelId = boundedHeader(headers["x-goog-channel-id"], "X-Goog-Channel-Id");
  const messageNumber = boundedHeader(headers["x-goog-message-number"], "X-Goog-Message-Number");
  const action = boundedHeader(headers["x-goog-resource-state"], "X-Goog-Resource-State");
  const resourceId = nonEmptyString(headers["x-goog-resource-id"]);
  const resourceUri = nonEmptyString(headers["x-goog-resource-uri"]);
  const fileId = nonEmptyString(configuredFileId) ?? fileIdFromResourceUri(resourceUri ?? undefined);

  return {
    schemaVersion: 1,
    provider: "google-drive",
    deliveryId: `${channelId}:${messageNumber}`,
    eventType: "drive-notification",
    action,
    source: {
      channelId,
      ...(resourceId ? { resourceId } : {}),
      ...(resourceUri ? { resourceUri } : {}),
      ...(fileId ? { fileId } : {})
    },
    receivedAt
  };
}

function jsonResponse(statusCode: number, value: Record<string, unknown>): LambdaFunctionUrlResponse {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
    body: JSON.stringify(value)
  };
}

async function defaultReadSecret(secretId: string) {
  return secretsManager.send(new GetSecretValueCommand({ SecretId: secretId }));
}

async function defaultEnqueue({ queueUrl, message }: QueueMessageInput) {
  await sqs.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(message)
  }));
}

export function createWebhookIngressHandler(dependencies: WebhookIngressDependencies = {}) {
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date());
  const readSecret = dependencies.readSecret ?? defaultReadSecret;
  const enqueue = dependencies.enqueue ?? defaultEnqueue;
  const logError = dependencies.logError ?? console.error;
  const secretCache = new Map<WebhookProvider, { value: string; loadedAt: number }>();
  const configuredCacheTtlMs = positiveInteger(env.WEBHOOK_SECRET_CACHE_TTL_MS)
    ?? defaultSecretCacheTtlMs;

  async function configuredSecret(provider: WebhookProvider) {
    const cached = secretCache.get(provider);
    if (cached && now().getTime() - cached.loadedAt < configuredCacheTtlMs) {
      return cached.value;
    }

    const config = secretConfigurations[provider];
    const direct = nonEmptyString(env[config.directEnvironmentKey]);

    if (direct) {
      secretCache.set(provider, { value: direct, loadedAt: now().getTime() });
      return direct;
    }

    const secretId = config.secretIdEnvironmentKeys
      .map((key) => nonEmptyString(env[key]))
      .find((value): value is string => Boolean(value));

    if (!secretId) {
      throw new WebhookRequestError(
        500,
        "configuration_error",
        `${config.directEnvironmentKey} or a corresponding Secrets Manager identifier must be configured.`
      );
    }

    const value = secretFromValue(await readSecret(secretId), config.jsonKeys);

    if (!value) {
      throw new WebhookRequestError(
        500,
        "configuration_error",
        `The configured ${provider} credential secret did not contain a usable value.`
      );
    }

    secretCache.set(provider, { value, loadedAt: now().getTime() });
    return value;
  }

  return async function webhookIngressHandler(
    event: LambdaFunctionUrlV2Event = {}
  ): Promise<LambdaFunctionUrlResponse> {
    let provider: WebhookProvider | undefined;

    try {
      const request = normalizeRequest(event);
      provider = providerForPath.get(request.path);

      if (!provider) {
        throw new WebhookRequestError(404, "not_found", "Webhook endpoint not found.");
      }

      if (request.method !== "POST") {
        throw new WebhookRequestError(405, "method_not_allowed", "Only POST is supported.");
      }

      const secret = await configuredSecret(provider);
      const receivedAt = now().toISOString();
      let message: CorpusWebhookMessage;

      if (provider === "github") {
        const signature = authenticationHeader(
          request.headers["x-hub-signature-256"],
          "X-Hub-Signature-256",
          "missing_signature"
        );

        if (!verifySha256Signature(request.body, signature, secret)) {
          throw new WebhookRequestError(401, "invalid_signature", "Invalid webhook signature.");
        }

        message = githubMessage(request.headers, jsonBody(request.body), receivedAt);
      } else if (provider === "discourse") {
        const signature = authenticationHeader(
          request.headers["x-discourse-event-signature"],
          "X-Discourse-Event-Signature",
          "missing_signature"
        );

        if (!verifySha256Signature(request.body, signature, secret)) {
          throw new WebhookRequestError(401, "invalid_signature", "Invalid webhook signature.");
        }

        message = discourseMessage(request.headers, jsonBody(request.body), receivedAt);
      } else {
        const suppliedToken = authenticationHeader(
          request.headers["x-goog-channel-token"],
          "X-Goog-Channel-Token",
          "missing_channel_token"
        );

        if (!fixedLengthEqual(suppliedToken, secret)) {
          throw new WebhookRequestError(401, "invalid_channel_token", "Invalid channel token.");
        }

        const expectedChannelId = nonEmptyString(env.GOOGLE_DRIVE_CHANNEL_ID);
        if (
          expectedChannelId &&
          !fixedLengthEqual(request.headers["x-goog-channel-id"] ?? "", expectedChannelId)
        ) {
          throw new WebhookRequestError(401, "invalid_channel", "Invalid notification channel.");
        }

        message = googleDriveMessage(
          request.headers,
          receivedAt,
          env.GOOGLE_DRIVE_FILE_ID
        );
      }

      const queueUrl = nonEmptyString(env.WEBHOOK_QUEUE_URL);

      if (!queueUrl) {
        throw new WebhookRequestError(
          500,
          "configuration_error",
          "WEBHOOK_QUEUE_URL must be configured."
        );
      }

      await enqueue({ queueUrl, message });

      return jsonResponse(202, {
        accepted: true,
        provider: message.provider,
        deliveryId: message.deliveryId
      });
    } catch (error) {
      if (error instanceof WebhookRequestError) {
        return jsonResponse(error.statusCode, {
          accepted: false,
          error: error.code
        });
      }

      logError("Webhook ingress failed", {
        provider: provider ?? null,
        error: error instanceof Error ? error.message : String(error)
      });
      return jsonResponse(503, {
        accepted: false,
        error: "temporarily_unavailable"
      });
    }
  };
}

export const handler = createWebhookIngressHandler();

export const webhookIngressWorkerTestHooks = {
  fileIdFromResourceUri,
  googleDriveMessage,
  normalizeRequest,
  secretFromValue
};
