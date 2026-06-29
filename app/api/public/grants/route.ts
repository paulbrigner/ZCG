import { NextResponse } from "next/server";
import { publicGrantProjectionFields } from "@/lib/public-projection";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    grants: [],
    projection: "public_grant_v1",
    allowlistedFields: publicGrantProjectionFields,
    note: "Phase 0 exposes the public projection contract before importing source systems."
  });
}
