import { NextRequest, NextResponse } from "next/server";
import {
  AdminUserActionError,
  getUserAccessOverview,
  grantEmailRole,
  revokeEmailRole
} from "@/lib/admin/users";
import { principalHasRole, requirePermission } from "@/lib/authorization";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  if (error instanceof AdminUserActionError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  if (error instanceof Error && error.message === "NEXT_REDIRECT") {
    throw error;
  }

  console.error("Admin user access error", error);
  return NextResponse.json({ error: "Failed to update user access" }, { status: 500 });
}

export async function GET() {
  const principal = await requirePermission("role:assignment:manage");
  const isAdmin = await principalHasRole(principal.id, "admin");

  if (!isAdmin) {
    return NextResponse.json({ error: "User access management requires the Administrator role." }, { status: 403 });
  }

  return NextResponse.json(await getUserAccessOverview());
}

export async function POST(request: NextRequest) {
  const principal = await requirePermission("role:assignment:manage");
  const isAdmin = await principalHasRole(principal.id, "admin");

  if (!isAdmin) {
    return NextResponse.json({ error: "User access management requires the Administrator role." }, { status: 403 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const action = typeof body?.action === "string" ? body.action : "grant_role";

    if (action === "grant_role") {
      await grantEmailRole({
        email: body?.email,
        roleKey: body?.roleKey,
        actorPrincipalId: principal.id,
        reason: typeof body?.reason === "string" ? body.reason : null
      });

      return NextResponse.json({ ok: true, overview: await getUserAccessOverview() });
    }

    if (action === "revoke_role") {
      await revokeEmailRole({
        email: body?.email,
        roleKey: body?.roleKey,
        actorPrincipalId: principal.id
      });

      return NextResponse.json({ ok: true, overview: await getUserAccessOverview() });
    }

    return NextResponse.json({ error: "Unsupported user access action" }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}
