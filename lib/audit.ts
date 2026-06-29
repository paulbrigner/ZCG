import { query } from "@/lib/db";

export type AuditEventInput = {
  actorPrincipalId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  requestContext?: Record<string, unknown>;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  publicProjectionImpact?: Record<string, unknown> | null;
};

export async function recordAuditEvent(input: AuditEventInput) {
  const result = await query<{ id: string }>(
    `insert into audit_events (
       actor_principal_id,
       action,
       target_type,
       target_id,
       request_context,
       before_values,
       after_values,
       metadata,
       public_projection_impact
     )
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb)
     returning id`,
    [
      input.actorPrincipalId ?? null,
      input.action,
      input.targetType,
      input.targetId ?? null,
      JSON.stringify(input.requestContext ?? {}),
      input.before ? JSON.stringify(input.before) : null,
      input.after ? JSON.stringify(input.after) : null,
      JSON.stringify(input.metadata ?? {}),
      input.publicProjectionImpact ? JSON.stringify(input.publicProjectionImpact) : null
    ]
  );

  return result.rows[0]?.id;
}
