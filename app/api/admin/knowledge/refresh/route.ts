import { randomUUID } from "node:crypto";
import { ListExecutionsCommand, SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "@/lib/audit";
import { principalHasRole, requirePermission } from "@/lib/authorization";

export const dynamic = "force-dynamic";

const stepFunctions = new SFNClient({});

export async function POST(request: NextRequest) {
  const principal = await requirePermission("knowledge:index");
  const isAdmin = await principalHasRole(principal.id, "admin");

  if (!isAdmin) {
    return NextResponse.json({ error: "Corpus refresh requires the Administrator role." }, { status: 403 });
  }

  const stateMachineArn = process.env.ZCG_CORPUS_REFRESH_STATE_MACHINE_ARN;

  if (!stateMachineArn) {
    return NextResponse.json(
      { error: "Corpus refresh is not configured for this deployment." },
      { status: 503 }
    );
  }

  const requestedAt = new Date().toISOString();
  const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
  const requestMetadata = {
    requestId,
    route: request.nextUrl.pathname,
    method: request.method,
    userAgent: request.headers.get("user-agent")
  };
  const payload = {
    trigger: "admin",
    requestedAt,
    requestedByPrincipalId: principal.id
  };
  const executionName = `corpus-refresh-${randomUUID()}`;
  let executionArn: string | null = null;

  try {
    const active = await stepFunctions.send(
      new ListExecutionsCommand({
        stateMachineArn,
        statusFilter: "RUNNING",
        maxResults: 1
      })
    );

    if (active.executions?.length) {
      return NextResponse.json(
        {
          accepted: false,
          busy: true,
          error: "A full corpus refresh is already running. Progress is available on the Telemetry page."
        },
        { status: 409 }
      );
    }
  } catch (error) {
    // The workflow's own durable lease remains the authoritative concurrency
    // guard. A transient read failure should not prevent an Administrator from
    // submitting a refresh that the workflow can safely accept or skip.
    console.error("Could not check for an active corpus refresh execution", { error, requestId });
  }

  try {
    const result = await stepFunctions.send(
      new StartExecutionCommand({
        stateMachineArn,
        name: executionName,
        input: JSON.stringify(payload)
      })
    );
    executionArn = result.executionArn ?? null;
  } catch (error) {
    console.error("Grant knowledge corpus refresh failed to start", error);
    return NextResponse.json(
      { error: "Corpus refresh could not be started. No refresh request was accepted; try again." },
      { status: 500 }
    );
  }

  try {
    await recordAuditEvent({
      actorPrincipalId: principal.id,
      action: "knowledge.corpus_refresh.requested",
      targetType: "grant_knowledge",
      requestContext: requestMetadata,
      metadata: {
        stateMachineArn,
        executionArn,
        executionName,
        trigger: payload.trigger,
        requestedAt,
        requestedByPrincipalId: principal.id
      }
    });
  } catch (error) {
    // The Step Functions execution has already been accepted. Audit
    // persistence is best-effort here so a database outage cannot turn a
    // successful request into a misleading 500 response that encourages a
    // duplicate refresh.
    console.error("Corpus refresh was accepted, but its request audit could not be recorded", {
      error,
      requestId
    });
  }

  return NextResponse.json(
    {
      accepted: true,
      requestId,
      executionArn,
      message:
        "Corpus refresh started. Bounded source batches will run in sequence, followed by reconciliation and knowledge indexing."
    },
    { status: 202 }
  );
}
