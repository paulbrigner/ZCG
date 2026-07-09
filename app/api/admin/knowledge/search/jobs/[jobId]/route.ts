import { NextResponse } from "next/server";
import { principalHasRole, requirePermission } from "@/lib/authorization";
import {
  getGrantKnowledgeAnswerJob,
  serializeGrantKnowledgeAnswerJob
} from "@/lib/knowledge/answer-jobs";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> }
) {
  const principal = await requirePermission("knowledge:search");
  const { jobId } = await context.params;

  if (!jobId) {
    return NextResponse.json({ error: "jobId is required." }, { status: 400 });
  }

  const job = await getGrantKnowledgeAnswerJob(jobId);

  if (!job) {
    return NextResponse.json({ error: "Knowledge answer job not found." }, { status: 404 });
  }

  const isAdmin = await principalHasRole(principal.id, "admin");

  if (job.principalId !== principal.id && !isAdmin) {
    return NextResponse.json({ error: "Knowledge answer job not found." }, { status: 404 });
  }

  return NextResponse.json(serializeGrantKnowledgeAnswerJob(job));
}
