import { recordAuditEvent } from "@/lib/audit";
import { query } from "@/lib/db";

export type AdminRole = {
  roleKey: string;
  name: string;
  description: string | null;
};

export type UserRoleGrant = {
  roleKey: string;
  roleName: string;
  source: "principal" | "email";
  createdAt: string;
  expiresAt: string | null;
  reason: string | null;
};

export type AdminUserAccess = {
  principalId: string;
  email: string;
  displayName: string | null;
  authProvider: string;
  authSubject: string;
  createdAt: string;
  updatedAt: string;
  roles: UserRoleGrant[];
};

export type PendingEmailGrant = {
  email: string;
  roles: UserRoleGrant[];
};

export type UserAccessOverview = {
  roles: AdminRole[];
  users: AdminUserAccess[];
  pendingEmailGrants: PendingEmailGrant[];
};

export class AdminUserActionError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "AdminUserActionError";
    this.status = status;
  }
}

type PrincipalRoleRow = {
  principal_id: string;
  email: string;
  display_name: string | null;
  auth_provider: string;
  auth_subject: string;
  created_at: string;
  updated_at: string;
  role_key: string | null;
  role_name: string | null;
  role_created_at: string | null;
  role_expires_at: string | null;
  role_reason: string | null;
};

type EmailGrantRow = {
  email: string;
  role_key: string;
  role_name: string;
  created_at: string;
  expires_at: string | null;
  reason: string | null;
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeAdminEmail(value: unknown) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";

  if (!email || !emailPattern.test(email)) {
    throw new AdminUserActionError("Enter a valid email address.", 400);
  }

  if (email.length > 320) {
    throw new AdminUserActionError("Email must be 320 characters or fewer.", 400);
  }

  return email;
}

function normalizeRoleKey(value: unknown) {
  const roleKey = typeof value === "string" ? value.trim() : "";

  if (!roleKey) {
    throw new AdminUserActionError("Select a role.", 400);
  }

  return roleKey;
}

async function getRole(roleKey: string) {
  const result = await query<{ id: string; role_key: string; name: string }>(
    `select id::text, role_key, name
       from roles
      where role_key = $1`,
    [roleKey]
  );

  const role = result.rows[0];

  if (!role) {
    throw new AdminUserActionError("Role not found.", 404);
  }

  return role;
}

function addRoleGrant(target: UserRoleGrant[], grant: UserRoleGrant) {
  if (!target.some((role) => role.roleKey === grant.roleKey && role.source === grant.source)) {
    target.push(grant);
  }
}

export async function getUserAccessOverview(): Promise<UserAccessOverview> {
  const [rolesResult, principalRolesResult, emailGrantsResult] = await Promise.all([
    query<{
      role_key: string;
      name: string;
      description: string | null;
    }>(
      `select role_key, name, description
         from roles
        order by role_key`
    ),
    query<PrincipalRoleRow>(
      `select p.id::text as principal_id,
              p.email,
              p.display_name,
              p.auth_provider,
              p.auth_subject,
              p.created_at::text,
              p.updated_at::text,
              r.role_key,
              r.name as role_name,
              ra.created_at::text as role_created_at,
              ra.expires_at::text as role_expires_at,
              ra.reason as role_reason
         from principals p
         left join role_assignments ra on ra.principal_id = p.id
         left join roles r on r.id = ra.role_id
        order by p.updated_at desc, p.email, r.role_key`
    ),
    query<EmailGrantRow>(
      `select era.email,
              r.role_key,
              r.name as role_name,
              era.created_at::text,
              era.expires_at::text,
              era.reason
         from email_role_assignments era
         join roles r on r.id = era.role_id
        order by era.email, r.role_key`
    )
  ]);

  const usersById = new Map<string, AdminUserAccess>();

  for (const row of principalRolesResult.rows) {
    const user =
      usersById.get(row.principal_id) ??
      ({
        principalId: row.principal_id,
        email: row.email,
        displayName: row.display_name,
        authProvider: row.auth_provider,
        authSubject: row.auth_subject,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        roles: []
      } satisfies AdminUserAccess);

    if (row.role_key && row.role_name && row.role_created_at) {
      addRoleGrant(user.roles, {
        roleKey: row.role_key,
        roleName: row.role_name,
        source: "principal",
        createdAt: row.role_created_at,
        expiresAt: row.role_expires_at,
        reason: row.role_reason
      });
    }

    usersById.set(row.principal_id, user);
  }

  const users = Array.from(usersById.values());
  const existingEmails = new Set(users.map((user) => user.email.toLowerCase()));
  const pendingByEmail = new Map<string, PendingEmailGrant>();

  for (const row of emailGrantsResult.rows) {
    const grant: UserRoleGrant = {
      roleKey: row.role_key,
      roleName: row.role_name,
      source: "email",
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      reason: row.reason
    };

    const matchingUser = users.find((user) => user.email.toLowerCase() === row.email);

    if (matchingUser) {
      addRoleGrant(matchingUser.roles, grant);
      continue;
    }

    if (!existingEmails.has(row.email)) {
      const pending =
        pendingByEmail.get(row.email) ??
        ({
          email: row.email,
          roles: []
        } satisfies PendingEmailGrant);

      addRoleGrant(pending.roles, grant);
      pendingByEmail.set(row.email, pending);
    }
  }

  return {
    roles: rolesResult.rows.map((role) => ({
      roleKey: role.role_key,
      name: role.name,
      description: role.description
    })),
    users,
    pendingEmailGrants: Array.from(pendingByEmail.values())
  };
}

export async function grantEmailRole(params: {
  email: string;
  roleKey: string;
  actorPrincipalId: string;
  reason?: string | null;
}) {
  const email = normalizeAdminEmail(params.email);
  const roleKey = normalizeRoleKey(params.roleKey);
  const role = await getRole(roleKey);
  const reason = params.reason?.trim() || "Granted from admin user utility";

  await query(
    `insert into email_role_assignments (email, role_id, granted_by_principal_id, reason)
     values ($1, $2, $3, $4)
     on conflict (email, role_id)
     do update set granted_by_principal_id = excluded.granted_by_principal_id,
                   reason = excluded.reason,
                   updated_at = now()`,
    [email, role.id, params.actorPrincipalId, reason]
  );

  await query(
    `insert into role_assignments (principal_id, role_id, granted_by_principal_id, reason)
     select p.id, $2, $3, $4
       from principals p
      where lower(p.email) = $1
     on conflict (principal_id, role_id)
     do update set granted_by_principal_id = excluded.granted_by_principal_id,
                   reason = excluded.reason`,
    [email, role.id, params.actorPrincipalId, reason]
  );

  await recordAuditEvent({
    actorPrincipalId: params.actorPrincipalId,
    action: "role.email_grant.upserted",
    targetType: "email_role_assignment",
    targetId: `${email}:${roleKey}`,
    metadata: { email, roleKey, reason }
  });

  return { email, roleKey };
}

export async function revokeEmailRole(params: {
  email: string;
  roleKey: string;
  actorPrincipalId: string;
}) {
  const email = normalizeAdminEmail(params.email);
  const roleKey = normalizeRoleKey(params.roleKey);
  const role = await getRole(roleKey);

  await query(
    `delete from email_role_assignments
      where email = $1
        and role_id = $2`,
    [email, role.id]
  );

  await query(
    `delete from role_assignments ra
      using principals p
      where ra.principal_id = p.id
        and lower(p.email) = $1
        and ra.role_id = $2`,
    [email, role.id]
  );

  await recordAuditEvent({
    actorPrincipalId: params.actorPrincipalId,
    action: "role.email_grant.revoked",
    targetType: "email_role_assignment",
    targetId: `${email}:${roleKey}`,
    metadata: { email, roleKey }
  });

  return { email, roleKey };
}
