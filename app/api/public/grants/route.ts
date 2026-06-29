import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { projectPublicGrant, publicGrantProjectionFields } from "@/lib/public-projection";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = await query<{
    publicGrantId: string;
    title: string;
    publicApplicantName: string | null;
    status: string;
    requestedAmountUsd: string | null;
    approvedAmountUsd: string | null;
    sourceLinks: unknown;
    updatedAt: string;
  }>(
    `select ga.id::text as "publicGrantId",
            ga.title,
            ga.applicant_name as "publicApplicantName",
            ga.normalized_status as status,
            ga.requested_amount_usd::text as "requestedAmountUsd",
            g.approved_amount_usd::text as "approvedAmountUsd",
            coalesce(
              jsonb_agg(
                distinct jsonb_build_object(
                  'sourceKind', sr.source_kind,
                  'sourceUrl', sr.source_url,
                  'sourceId', sr.source_id
                )
              ) filter (where sr.id is not null),
              '[]'::jsonb
            )::text as "sourceLinks",
            ga.updated_at::text as "updatedAt"
       from grant_applications ga
       left join grants g on g.application_id = ga.id
       left join source_links sl on sl.canonical_type = 'grant_application'
                                and sl.canonical_id = ga.id
       left join source_records sr on sr.id = sl.source_record_id
      group by ga.id, g.id
      order by ga.updated_at desc
      limit 100`
  );

  return NextResponse.json({
    grants: result.rows.map((row) =>
      projectPublicGrant({
        ...row,
        sourceLinks: typeof row.sourceLinks === "string" ? JSON.parse(row.sourceLinks) : row.sourceLinks
      })
    ),
    projection: "public_grant_v1",
    allowlistedFields: publicGrantProjectionFields
  });
}
