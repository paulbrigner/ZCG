import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mirrorGoogleSheetTabs } from "../lib/source-mirroring/google-sheet";
import {
  GOOGLE_SHEET_CHECKSUM_PATTERN,
  GOOGLE_SHEET_POLL_STATE_KEY,
  googleSheetContentChecksum,
  type GoogleSheetSuccessMarker
} from "../lib/source-mirroring/google-sheet-checksum";

export { googleSheetContentChecksum } from "../lib/source-mirroring/google-sheet-checksum";

const s3 = new S3Client({});
type PollEvent = { action?: "check" };

type PollDependencies = {
  mirror: typeof mirrorGoogleSheetTabs;
  readMarker: () => Promise<GoogleSheetSuccessMarker | null>;
  now: () => Date;
};

function configuredBucket() {
  const bucket = process.env.SNAPSHOT_BUCKET_NAME?.trim();

  if (!bucket) {
    throw new Error("SNAPSHOT_BUCKET_NAME is required for Google Sheet polling.");
  }

  return bucket;
}

function configuredStateKey() {
  return process.env.GOOGLE_SHEET_POLL_STATE_KEY?.trim() || GOOGLE_SHEET_POLL_STATE_KEY;
}

function isMissingObject(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value.name === "NoSuchKey" || value.name === "NotFound" || value.$metadata?.httpStatusCode === 404;
}

async function readMarkerFromS3(): Promise<GoogleSheetSuccessMarker | null> {
  try {
    const response = await s3.send(new GetObjectCommand({
      Bucket: configuredBucket(),
      Key: configuredStateKey()
    }));
    const body = await response.Body?.transformToString();

    if (!body) {
      return null;
    }

    const marker = JSON.parse(body) as Partial<GoogleSheetSuccessMarker>;

    return marker.schemaVersion === 1 &&
      typeof marker.checksum === "string" &&
      GOOGLE_SHEET_CHECKSUM_PATTERN.test(marker.checksum) &&
      typeof marker.committedAt === "string"
      ? marker as GoogleSheetSuccessMarker
      : null;
  } catch (error) {
    if (isMissingObject(error)) {
      return null;
    }

    throw error;
  }
}

export function createGoogleSheetPollHandler(
  dependencies: Partial<PollDependencies> = {}
) {
  const mirror = dependencies.mirror ?? mirrorGoogleSheetTabs;
  const readMarker = dependencies.readMarker ?? readMarkerFromS3;
  const now = dependencies.now ?? (() => new Date());

  return async function googleSheetPollHandler(_event: PollEvent = {}) {
    const result = await mirror();
    const checksum = googleSheetContentChecksum(result);
    const previous = await readMarker();
    const checkedAt = now().toISOString();

    return {
      ok: true,
      action: "check" as const,
      changed: previous?.checksum !== checksum,
      checksum,
      previousChecksum: previous?.checksum ?? null,
      checkedAt,
      sheetId: result.sourceId,
      recordCount: result.records.length
    };
  };
}

export const handler = createGoogleSheetPollHandler();

export const googleSheetPollWorkerTestHooks = {
  defaultStateKey: GOOGLE_SHEET_POLL_STATE_KEY
};
