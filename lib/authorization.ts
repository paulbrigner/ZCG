import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { query } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";

export type Principal = {
  id: string;
  authSubject: string;
  email: string;
  accessMode?: "authenticated" | "public-readonly";
};

type RequirePermissionOptions = {
  allowPublicPrototypeRead?: boolean;
};

const publicPrototypeReadPermissions = new Set([
  "admin:dashboard:view",
  "source:mirror:read",
  "grant:read",
  "knowledge:search",
  "reconciliation:read"
]);

const publicPrototypePrincipal: Principal = {
  id: "public-prototype-readonly",
  authSubject: "public-prototype-readonly",
  email: "public-readonly@prototype.local",
  accessMode: "public-readonly"
};

export function isPublicPrototypePrincipal(principal: Principal) {
  return principal.accessMode === "public-readonly";
}

function canUsePublicPrototypeRead(permissionKey: string, options?: RequirePermissionOptions) {
  return (
    options?.allowPublicPrototypeRead === true &&
    process.env.PUBLIC_PROTOTYPE_READONLY === "true" &&
    publicPrototypeReadPermissions.has(permissionKey)
  );
}

export async function getCurrentPrincipal(): Promise<Principal | null> {
  const session = await auth.api.getSession({
    headers: await headers()
  });

  if (!session?.user?.id || !session.user.email) {
    return null;
  }

  const result = await query<Principal>(
    `insert into principals (auth_provider, auth_subject, email, display_name)
     values ('better-auth', $1, $2, $3)
     on conflict (auth_provider, auth_subject)
     do update set email = excluded.email, display_name = excluded.display_name, updated_at = now()
     returning id, auth_subject as "authSubject", email`,
    [session.user.id, session.user.email, session.user.name ?? session.user.email]
  );

  const principal = result.rows[0] ? { ...result.rows[0], accessMode: "authenticated" as const } : null;

  if (principal) {
    await ensureBootstrapAdmin(principal);
    await ensureEmailRoleAssignments(principal);
  }

  return principal;
}

async function ensureBootstrapAdmin(principal: Principal) {
  const bootstrapEmails = (process.env.BOOTSTRAP_ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  if (!bootstrapEmails.includes(principal.email.toLowerCase())) {
    return;
  }

  await query(
    `insert into role_assignments (principal_id, role_id, reason)
     select $1, roles.id, 'Bootstrap admin email'
       from roles
      where roles.role_key = 'admin'
     on conflict (principal_id, role_id) do nothing`,
    [principal.id]
  );
}

async function ensureEmailRoleAssignments(principal: Principal) {
  try {
    await query(
      `insert into role_assignments (principal_id, role_id, granted_by_principal_id, reason, expires_at)
       select $1, era.role_id, era.granted_by_principal_id, coalesce(era.reason, 'Email role grant'), era.expires_at
         from email_role_assignments era
        where era.email = lower($2)
          and (era.expires_at is null or era.expires_at > now())
       on conflict (principal_id, role_id)
       do update set reason = excluded.reason,
                     granted_by_principal_id = excluded.granted_by_principal_id,
                     expires_at = excluded.expires_at`,
      [principal.id, principal.email]
    );
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "42P01") {
      return;
    }

    throw error;
  }
}

export async function principalHasPermission(principalId: string, permissionKey: string) {
  const result = await query<{ allowed: boolean }>(
    `select exists (
       select 1
         from role_assignments ra
         join role_permissions rp on rp.role_id = ra.role_id
         join permissions p on p.id = rp.permission_id
        where ra.principal_id = $1
          and p.permission_key = $2
          and (ra.expires_at is null or ra.expires_at > now())
       union
       select 1
         from permission_grants pg
         join permissions p on p.id = pg.permission_id
        where pg.principal_id = $1
          and p.permission_key = $2
          and (pg.expires_at is null or pg.expires_at > now())
     ) as allowed`,
    [principalId, permissionKey]
  );

  return result.rows[0]?.allowed ?? false;
}

export async function requirePermission(
  permissionKey: string,
  options?: RequirePermissionOptions
): Promise<Principal> {
  const principal = await getCurrentPrincipal();

  if (!principal) {
    if (canUsePublicPrototypeRead(permissionKey, options)) {
      return publicPrototypePrincipal;
    }

    redirect("/sign-in");
  }

  const allowed = await principalHasPermission(principal.id, permissionKey);

  if (!allowed && canUsePublicPrototypeRead(permissionKey, options)) {
    return { ...principal, accessMode: "public-readonly" };
  }

  await recordAuditEvent({
    actorPrincipalId: principal.id,
    action: allowed ? "authorization.allowed" : "authorization.denied",
    targetType: "permission",
    targetId: permissionKey,
    metadata: { permissionKey }
  });

  if (!allowed) {
    redirect("/sign-in");
  }

  return principal;
}
