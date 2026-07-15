import { NextRequest, NextResponse } from "next/server";
import { recordAuditEvent } from "@/lib/audit";
import {
  isPublicPrototypePrincipal,
  principalHasPermission,
  principalHasRole,
  requirePermission
} from "@/lib/authorization";
import { query } from "@/lib/db";
import {
  createGrantKnowledgeAnswerJob,
  failGrantKnowledgeAnswerJob
} from "@/lib/knowledge/answer-jobs";
import { invokeKnowledgeAnswerWorker } from "@/lib/knowledge/answer-worker";
import {
  COMMITTEE_BRIEFING_TEMPLATE_KEY,
  COMMITTEE_BRIEFING_TEMPLATE_VERSION,
  CUSTOM_GRANT_ANALYSIS_TEMPLATE_KEY,
  CUSTOM_GRANT_ANALYSIS_TEMPLATE_VERSION,
  normalizeCustomGrantAnalysisPrompt
} from "@/lib/knowledge/briefing";
import { grantAnalysisAiModel } from "@/lib/knowledge/config";
import {
  attachGrantAnalysisReportJob,
  createGrantAnalysisReport,
  failGrantAnalysisReport,
  getGrantAnalysisReportFreshnessDetails,
  listGrantAnalysisReportEvidence,
  listGrantAnalysisReports,
  type GrantAnalysisReport,
  type GrantAnalysisReportVisibility
} from "@/lib/knowledge/reports";
import { normalizeRetrievalMode } from "@/lib/knowledge/search";

export const dynamic = "force-dynamic";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reportTitleMaxChars = 160;

type ApplicationRow = {
  id: string;
  title: string;
  normalized_status: string;
  officially_assigned: boolean;
};

function validApplicationId(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

function normalizeReportTitle(value: unknown, fallback: string) {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }

  return value.trim().slice(0, reportTitleMaxChars);
}

function normalizeVisibility(value: unknown): "temporary" | GrantAnalysisReportVisibility {
  if (value === "temporary" || value === "private" || value === "shared") {
    return value;
  }

  return "private";
}

function reportRetrievalMode(report: GrantAnalysisReport) {
  const value = report.generationMetadata.retrievalMode;
  return value === "keyword" || value === "semantic" || value === "hybrid" ? value : null;
}

async function serializeReport(report: GrantAnalysisReport) {
  const committeeBriefing = report.reportType === "committee_briefing";
  const [freshnessDetails, evidence] = await Promise.all([
    getGrantAnalysisReportFreshnessDetails({
      report,
      currentTemplateKey: committeeBriefing
        ? COMMITTEE_BRIEFING_TEMPLATE_KEY
        : CUSTOM_GRANT_ANALYSIS_TEMPLATE_KEY,
      currentTemplateVersion: committeeBriefing
        ? COMMITTEE_BRIEFING_TEMPLATE_VERSION
        : CUSTOM_GRANT_ANALYSIS_TEMPLATE_VERSION,
      currentModel: grantAnalysisAiModel(report.reportType)
    }),
    listGrantAnalysisReportEvidence(report.id)
  ]);

  return {
    ...report,
    retrievalMode: reportRetrievalMode(report),
    freshnessStatus: freshnessDetails.status,
    freshnessDetails,
    evidence
  };
}

async function getApplication(applicationId: string) {
  const result = await query<ApplicationRow>(
    `select ga.id::text,
            ga.title,
            ga.normalized_status,
            exists (
              select 1
                from grant_application_github_labels application_label
               where application_label.application_id = ga.id
                 and application_label.label_status = 'grant_application'
            ) and exists (
              select 1
                from grant_application_github_labels review_label
               where review_label.application_id = ga.id
                 and review_label.label_status = 'ready_for_zcg_review'
            ) as officially_assigned
       from grant_applications ga
      where ga.id = $1
      limit 1`,
    [applicationId]
  );

  return result.rows[0] ?? null;
}

async function permissionsFor(principalId: string) {
  const [canGenerate, canPublish, canUseSemanticSearch, canReadAllPrivateReports] = await Promise.all([
    principalHasPermission(principalId, "grant:analysis:generate"),
    principalHasPermission(principalId, "grant:analysis:publish"),
    principalHasPermission(principalId, "knowledge:semantic"),
    principalHasRole(principalId, "admin")
  ]);

  return { canGenerate, canPublish, canUseSemanticSearch, canReadAllPrivateReports };
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const principal = await requirePermission("grant:analysis:read", { allowPublicPrototypeRead: true });
  const { id: applicationId } = await context.params;

  if (!validApplicationId(applicationId)) {
    return NextResponse.json({ error: "A valid application ID is required." }, { status: 400 });
  }

  const application = await getApplication(applicationId);

  if (!application) {
    return NextResponse.json({ error: "Grant application not found." }, { status: 404 });
  }

  const publicViewer = isPublicPrototypePrincipal(principal);
  const permissions = publicViewer
    ? { canGenerate: false, canPublish: false, canUseSemanticSearch: false, canReadAllPrivateReports: false }
    : await permissionsFor(principal.id);
  const reports = await listGrantAnalysisReports({
    applicationId,
    access: {
      principalId: publicViewer ? null : principal.id,
      canReadAllPrivateReports: permissions.canReadAllPrivateReports
    },
    reportType: publicViewer ? "committee_briefing" : undefined
  });
  const visibleReports = publicViewer
    ? reports.filter((report) =>
        report.visibility === "shared" && report.status === "succeeded" && Boolean(report.answerText)
      )
    : reports;

  return NextResponse.json({
    reports: await Promise.all(visibleReports.map(serializeReport)),
    permissions: {
      canRead: true,
      canGenerate: permissions.canGenerate,
      canPublish: permissions.canPublish
    }
  });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const principal = await requirePermission("grant:analysis:generate");
  const { id: applicationId } = await context.params;

  if (!validApplicationId(applicationId)) {
    return NextResponse.json({ error: "A valid application ID is required." }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));

  if (body?.action !== undefined && body.action !== "generate") {
    return NextResponse.json({ error: "Unsupported grant analysis action." }, { status: 400 });
  }

  const reportType = body?.reportType === "committee_briefing" ? "committee_briefing" :
    body?.reportType === "custom" ? "custom" : null;

  if (!reportType) {
    return NextResponse.json({ error: "Choose committee briefing or custom analysis." }, { status: 400 });
  }

  const generationModel = grantAnalysisAiModel(reportType);
  const generationTemplateKey = reportType === "committee_briefing"
    ? COMMITTEE_BRIEFING_TEMPLATE_KEY
    : CUSTOM_GRANT_ANALYSIS_TEMPLATE_KEY;
  const generationTemplateVersion = reportType === "committee_briefing"
    ? COMMITTEE_BRIEFING_TEMPLATE_VERSION
    : CUSTOM_GRANT_ANALYSIS_TEMPLATE_VERSION;

  const application = await getApplication(applicationId);

  if (!application) {
    return NextResponse.json({ error: "Grant application not found." }, { status: 404 });
  }

  if (
    reportType === "committee_briefing" &&
    (application.normalized_status !== "under_review" || !application.officially_assigned)
  ) {
    return NextResponse.json(
      {
        error:
          "Committee briefings can be generated only after FPF assigns the proposal with both the Grant Application and Ready For ZCG Review GitHub labels."
      },
      { status: 409 }
    );
  }

  const permissions = await permissionsFor(principal.id);
  const requestedVisibility = body?.visibility === undefined && reportType === "committee_briefing"
    ? "shared"
    : normalizeVisibility(body?.visibility);

  if (reportType === "committee_briefing" && requestedVisibility !== "shared") {
    return NextResponse.json(
      { error: "Committee briefings are saved and shared by design; temporary or private briefing requests are not accepted." },
      { status: 400 }
    );
  }

  const visibility = reportType === "committee_briefing" ? "shared" : requestedVisibility;
  const retrievalMode = normalizeRetrievalMode(body?.retrievalMode);

  if (visibility === "shared" && !permissions.canPublish) {
    return NextResponse.json({ error: "Publishing a shared analysis requires publish access." }, { status: 403 });
  }

  if (retrievalMode !== "keyword" && !permissions.canUseSemanticSearch) {
    return NextResponse.json({ error: "Semantic or hybrid retrieval requires semantic-search access." }, { status: 403 });
  }

  let customPrompt: string | null = null;

  if (reportType === "custom") {
    try {
      customPrompt = normalizeCustomGrantAnalysisPrompt(body?.prompt);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "A custom analysis prompt is required." },
        { status: 400 }
      );
    }
  }

  const title = normalizeReportTitle(
    body?.title,
    reportType === "committee_briefing" ? "Committee briefing" : "Custom grounded analysis"
  );
  let report: GrantAnalysisReport | null = null;
  let jobId: string | null = null;
  let supersededReportId: string | null = null;
  let invocationAccepted = false;
  const requestedRegenerationReason = typeof body?.regenerationReason === "string"
    ? body.regenerationReason.trim().slice(0, 500) || null
    : null;

  try {
    if (visibility !== "temporary") {
      const existingReports = await listGrantAnalysisReports({
        applicationId,
        access: {
          principalId: principal.id,
          canReadAllPrivateReports: permissions.canReadAllPrivateReports
        },
        reportType
      });
      const superseded = reportType === "committee_briefing" ? existingReports[0] ?? null : null;
      supersededReportId = superseded?.id ?? null;

      report = await createGrantAnalysisReport({
        applicationId,
        reportType,
        visibility,
        title,
        requestedByPrincipalId: principal.id,
        customPrompt,
        templateKey: generationTemplateKey,
        templateVersion: generationTemplateVersion,
        supersedesReportId: superseded?.id ?? null,
        regenerationReason: superseded
          ? requestedRegenerationReason ?? "Regenerated from the current evidence set."
          : null,
        generationMetadata: {
          retrievalMode,
          requestedModel: generationModel
        }
      });
    }

    const job = await createGrantKnowledgeAnswerJob({
      principalId: principal.id,
      request: {
        searchText: `${reportType === "committee_briefing" ? "Committee briefing" : title}: ${application.title}`,
        limit: 20,
        answerMode: "ai",
        retrievalMode,
        allowAiAnswer: true,
        allowSemanticSearch: permissions.canUseSemanticSearch,
        purpose: reportType === "committee_briefing" ? "committee_briefing" : "custom_analysis",
        applicationId,
        reportId: report?.id,
        customPrompt,
        model: generationModel,
        templateKey: generationTemplateKey,
        templateVersion: generationTemplateVersion
      }
    });
    jobId = job.id;

    if (report) {
      const attached = await attachGrantAnalysisReportJob(report.id, job.id);

      if (!attached) {
        throw new Error("The saved analysis could not be linked to its generation job.");
      }

      report = attached;
    }

    const invocation = await invokeKnowledgeAnswerWorker(job.id);
    invocationAccepted = true;

    await recordAuditEvent({
      actorPrincipalId: principal.id,
      action: "grant.analysis.requested",
      targetType: "grant_application",
      targetId: applicationId,
      metadata: {
        reportId: report?.id ?? null,
        jobId: job.id,
        reportType,
        visibility,
        retrievalMode,
        model: generationModel,
        ...invocation
      }
    }).catch((auditError) => {
      console.error("Failed to record grant analysis request audit event", auditError);
    });

    if (supersededReportId && report) {
      await recordAuditEvent({
        actorPrincipalId: principal.id,
        action: "grant.analysis.regenerated",
        targetType: "grant_analysis_report",
        targetId: report.id,
        metadata: {
          applicationId,
          supersedesReportId: supersededReportId,
          regenerationReason: report.regenerationReason,
          jobId: job.id
        }
      }).catch((auditError) => {
        console.error("Failed to record grant analysis regeneration audit event", auditError);
      });
    }

    let responseReport: Awaited<ReturnType<typeof serializeReport>> | GrantAnalysisReport | null = report;

    if (report) {
      responseReport = await serializeReport(report).catch((serializationError) => {
        console.error("Failed to serialize an accepted grant analysis report", serializationError);
        return report;
      });
    }

    return NextResponse.json(
      {
        accepted: true,
        jobId: job.id,
        report: responseReport
      },
      { status: 202 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Grounded grant analysis could not be started.";

    if (invocationAccepted && jobId) {
      console.error("Grant analysis was accepted but its API response could not be completed", error);
      return NextResponse.json(
        { accepted: true, jobId, report, warning: "Generation started, but report metadata could not be fully loaded." },
        { status: 202 }
      );
    }

    if (jobId) {
      await failGrantKnowledgeAnswerJob(jobId, message).catch((jobError) => {
        console.error("Failed to mark grant analysis answer job failed", jobError);
      });
    }

    if (report) {
      await failGrantAnalysisReport(report.id, message, { jobId }).catch((reportError) => {
        console.error("Failed to mark grant analysis report failed", reportError);
      });
    }

    console.error("Grant analysis enqueue failed", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
