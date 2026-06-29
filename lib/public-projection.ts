export const publicGrantProjectionFields = [
  "publicGrantId",
  "title",
  "publicApplicantName",
  "status",
  "category",
  "requestedAmountUsd",
  "approvedAmountUsd",
  "publicMilestones",
  "publicProgressUpdates",
  "publicPaymentSummary",
  "sourceLinks",
  "updatedAt"
] as const;

export type PublicGrantProjection = {
  [K in (typeof publicGrantProjectionFields)[number]]?: unknown;
};

export function projectPublicGrant(input: Record<string, unknown>): PublicGrantProjection {
  return Object.fromEntries(
    publicGrantProjectionFields
      .filter((field) => Object.prototype.hasOwnProperty.call(input, field))
      .map((field) => [field, input[field]])
  ) as PublicGrantProjection;
}
