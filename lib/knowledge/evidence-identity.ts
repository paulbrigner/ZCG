export type SavedGrantAnalysisEvidenceIdentity = {
  documentKey: string;
  contentHash: string;
  applicationId: string;
  sourceKind: string | null;
  sourceId: string | null;
  title?: string | null;
  contentSnapshot: string | null;
  currentDocumentKey?: string | null;
  currentContentHash?: string | null;
};

export type CurrentGrantAnalysisEvidenceIdentity = {
  documentKey: string;
  contentHash: string;
  applicationId: string;
  sourceKind: string | null;
  sourceId: string | null;
  title?: string | null;
  content: string;
};

export type GrantAnalysisEvidenceIdentityChangeStatus = "current" | "changed" | "missing";

const googleSheetRowSourceKind = "google_sheet_row";

export function googleSheetRowNamespace(sourceId: string | null | undefined) {
  if (!sourceId) return null;
  const match = sourceId.trim().match(/^(.*):row:\d+$/);
  return match?.[1] || null;
}

/**
 * Removes only the location-bearing row number from the generated Source line.
 * Dates, amounts, milestone numbers, URLs, and any row-like text in the payload
 * remain part of the comparison.
 */
export function normalizeGoogleSheetEvidenceLocation(
  content: string | null | undefined,
  sourceId: string | null | undefined
) {
  const namespace = googleSheetRowNamespace(sourceId);
  if (!content || !sourceId || !namespace) return null;

  const sourceLine = `Source: ${googleSheetRowSourceKind}:${sourceId.trim()}`;
  const stableSourceLine = `Source: ${googleSheetRowSourceKind}:${namespace}:row:*`;
  let replaced = false;
  const normalized = content
    .split("\n")
    .map((line) => {
      if (!replaced && line === sourceLine) {
        replaced = true;
        return stableSourceLine;
      }
      return line;
    })
    .join("\n");

  return replaced ? normalized : null;
}

function normalizedFieldName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizedIdentityValue(value: string | null | undefined) {
  return value?.trim().replace(/\s+/g, " ").toLowerCase() || null;
}

function generatedContentFields(content: string | null | undefined) {
  const fields = new Map<string, string>();
  if (!content) return fields;

  for (const line of content.split("\n")) {
    const separator = line.indexOf(": ");
    if (separator <= 0) continue;
    const key = normalizedFieldName(line.slice(0, separator));
    const value = normalizedIdentityValue(line.slice(separator + 2));
    if (key && value && !fields.has(key)) fields.set(key, value);
  }

  return fields;
}

/**
 * Returns a business identity for a Sheet row when the mirrored payload exposes
 * stable application-level fields. It intentionally excludes payment/status
 * values so those changes are reported as changes to the same evidence row.
 */
export function googleSheetEvidenceBusinessIdentity(input: {
  sourceId: string | null | undefined;
  title?: string | null;
  content: string | null | undefined;
}) {
  const namespace = googleSheetRowNamespace(input.sourceId);
  if (!namespace) return null;

  const fields = generatedContentFields(input.content);
  const project = fields.get("project");
  const grantee = fields.get("grantee");
  const milestone = fields.get("milestone");
  if (project && grantee && milestone) {
    return `${namespace}|milestone|${project}|${grantee}|${milestone}`;
  }

  const grantPlatformLink = fields.get("grantplatformlink");
  if (grantPlatformLink) {
    return `${namespace}|grant-platform-link|${grantPlatformLink}`;
  }

  const proposalTitle = fields.get("proposaltitle");
  const applicants = fields.get("applicants") ?? fields.get("applicant");
  if (proposalTitle && applicants) {
    return `${namespace}|proposal|${proposalTitle}|${applicants}`;
  }

  return null;
}

function evidenceBucketKey(input: {
  applicationId: string;
  sourceKind: string | null;
  sourceId: string | null;
}) {
  if (input.sourceKind !== googleSheetRowSourceKind) return null;
  const namespace = googleSheetRowNamespace(input.sourceId);
  return namespace ? `${input.applicationId}\u0000${namespace}` : null;
}

/**
 * Resolves evidence rows as a one-to-one matching problem. This prevents one
 * surviving duplicate Sheet row from making multiple saved citations appear
 * current after another duplicate was deleted.
 */
export function resolveGrantAnalysisEvidenceChanges(
  savedEvidence: readonly SavedGrantAnalysisEvidenceIdentity[],
  currentCandidates: readonly CurrentGrantAnalysisEvidenceIdentity[]
): GrantAnalysisEvidenceIdentityChangeStatus[] {
  const statuses: GrantAnalysisEvidenceIdentityChangeStatus[] = savedEvidence.map((saved) => {
    const bucketKey = evidenceBucketKey(saved);
    if (bucketKey) {
      return saved.currentContentHash && saved.currentContentHash === saved.contentHash
        ? "current"
        : "missing";
    }
    if (saved.currentContentHash === null || saved.currentContentHash === undefined) {
      return "missing";
    }
    return saved.currentContentHash === saved.contentHash ? "current" : "changed";
  });
  const usedCandidateKeys = new Set<string>();

  savedEvidence.forEach((saved, index) => {
    if (statuses[index] !== "current" || !evidenceBucketKey(saved)) return;
    usedCandidateKeys.add(saved.currentDocumentKey ?? saved.documentKey);
  });

  const savedByBucket = new Map<string, number[]>();
  savedEvidence.forEach((saved, index) => {
    const bucketKey = evidenceBucketKey(saved);
    if (!bucketKey || statuses[index] === "current") return;
    const indexes = savedByBucket.get(bucketKey) ?? [];
    indexes.push(index);
    savedByBucket.set(bucketKey, indexes);
  });

  const candidatesByBucket = new Map<string, CurrentGrantAnalysisEvidenceIdentity[]>();
  for (const candidate of [...currentCandidates].sort((left, right) =>
    left.documentKey.localeCompare(right.documentKey)
  )) {
    const bucketKey = evidenceBucketKey(candidate);
    if (!bucketKey || usedCandidateKeys.has(candidate.documentKey)) continue;
    const candidates = candidatesByBucket.get(bucketKey) ?? [];
    candidates.push(candidate);
    candidatesByBucket.set(bucketKey, candidates);
  }

  for (const [bucketKey, savedIndexes] of savedByBucket) {
    let availableCandidates = candidatesByBucket.get(bucketKey) ?? [];

    // First pair byte-equivalent business content as a multiset, ignoring only
    // the mirrored row coordinate. These are genuinely current citations.
    for (const savedIndex of savedIndexes) {
      const saved = savedEvidence[savedIndex];
      const savedContent = normalizeGoogleSheetEvidenceLocation(
        saved.contentSnapshot,
        saved.sourceId
      );
      if (!savedContent) continue;

      const candidateIndex = availableCandidates.findIndex((candidate) =>
        normalizeGoogleSheetEvidenceLocation(candidate.content, candidate.sourceId) === savedContent
      );
      if (candidateIndex < 0) continue;

      statuses[savedIndex] = "current";
      usedCandidateKeys.add(availableCandidates[candidateIndex].documentKey);
      availableCandidates = availableCandidates.filter((_, index) => index !== candidateIndex);
    }

    const unresolvedIndexes = savedIndexes.filter((index) => statuses[index] === "missing");
    if (!unresolvedIndexes.length || !availableCandidates.length) continue;

    // A moved row with changed business data is paired only when its stable
    // business identity is unique on both sides.
    const savedByIdentity = new Map<string, number[]>();
    for (const savedIndex of unresolvedIndexes) {
      const saved = savedEvidence[savedIndex];
      const identity = googleSheetEvidenceBusinessIdentity({
        sourceId: saved.sourceId,
        title: saved.title,
        content: saved.contentSnapshot
      });
      if (!identity) continue;
      const indexes = savedByIdentity.get(identity) ?? [];
      indexes.push(savedIndex);
      savedByIdentity.set(identity, indexes);
    }

    const candidatesByIdentity = new Map<string, CurrentGrantAnalysisEvidenceIdentity[]>();
    for (const candidate of availableCandidates) {
      const identity = googleSheetEvidenceBusinessIdentity({
        sourceId: candidate.sourceId,
        title: candidate.title,
        content: candidate.content
      });
      if (!identity) continue;
      const candidates = candidatesByIdentity.get(identity) ?? [];
      candidates.push(candidate);
      candidatesByIdentity.set(identity, candidates);
    }

    for (const [identity, identitySavedIndexes] of savedByIdentity) {
      const identityCandidates = candidatesByIdentity.get(identity) ?? [];
      if (identitySavedIndexes.length !== 1 || identityCandidates.length !== 1) continue;
      statuses[identitySavedIndexes[0]] = "changed";
      const matchedKey = identityCandidates[0].documentKey;
      usedCandidateKeys.add(matchedKey);
      availableCandidates = availableCandidates.filter(
        (candidate) => candidate.documentKey !== matchedKey
      );
    }

  }

  return statuses;
}
