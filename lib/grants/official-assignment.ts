export const OFFICIAL_ZCG_ASSIGNMENT_LABEL_SLUGS = [
  "grant_application",
  "ready_for_zcg_review"
] as const;

export function canonicalGitHubWorkflowLabel(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

export function hasOfficialZcgAssignmentLabels(labels: readonly string[]) {
  const labelSlugs = new Set(labels.map(canonicalGitHubWorkflowLabel));

  return OFFICIAL_ZCG_ASSIGNMENT_LABEL_SLUGS.every((labelSlug) => labelSlugs.has(labelSlug));
}

export function missingOfficialZcgAssignmentLabels(labels: readonly string[]) {
  const labelSlugs = new Set(labels.map(canonicalGitHubWorkflowLabel));

  return OFFICIAL_ZCG_ASSIGNMENT_LABEL_SLUGS.filter((labelSlug) => !labelSlugs.has(labelSlug));
}

export function isOfficialZcgCommitteeReview(params: {
  normalizedStatus: string;
  labels: readonly string[];
}) {
  return params.normalizedStatus === "under_review" && hasOfficialZcgAssignmentLabels(params.labels);
}
