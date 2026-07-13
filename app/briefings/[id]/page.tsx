import Link from "next/link";
import { notFound } from "next/navigation";
import { getGrantApplicationHeading } from "@/lib/admin/dashboard";
import { requirePermission } from "@/lib/authorization";
import {
  COMMITTEE_BRIEFING_TEMPLATE_KEY,
  COMMITTEE_BRIEFING_TEMPLATE_VERSION
} from "@/lib/knowledge/briefing";
import { grantAnalysisAiModel } from "@/lib/knowledge/config";
import {
  getGrantAnalysisReport,
  getGrantAnalysisReportFreshness,
  isPublishedCommitteeBriefing,
  listGrantAnalysisReportEvidence
} from "@/lib/knowledge/reports";
import {
  CommitteeBriefingDocument,
  type GrantAnalysisReport as ClientGrantAnalysisReport
} from "../../admin/grants/[id]/grant-analysis-panel";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function CommitteeBriefingPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  if (!uuidPattern.test(id)) {
    notFound();
  }

  await requirePermission("grant:analysis:read", { allowPublicPrototypeRead: true });

  const report = await getGrantAnalysisReport({
    reportId: id,
    access: { principalId: null }
  });

  if (!report || !isPublishedCommitteeBriefing(report)) {
    notFound();
  }

  const [application, evidence, freshnessStatus] = await Promise.all([
    getGrantApplicationHeading(report.applicationId),
    listGrantAnalysisReportEvidence(report.id),
    getGrantAnalysisReportFreshness({
      report,
      currentTemplateKey: COMMITTEE_BRIEFING_TEMPLATE_KEY,
      currentTemplateVersion: COMMITTEE_BRIEFING_TEMPLATE_VERSION,
      currentModel: grantAnalysisAiModel("committee_briefing")
    })
  ]);

  if (!application) {
    notFound();
  }

  const retrievalMode = report.generationMetadata.retrievalMode;
  const clientReport: ClientGrantAnalysisReport = {
    ...report,
    version: report.versionNumber,
    retrievalMode:
      retrievalMode === "keyword" || retrievalMode === "semantic" || retrievalMode === "hybrid"
        ? retrievalMode
        : null,
    freshnessStatus,
    evidence: evidence.map((item) => ({
      id: `${report.id}:${item.citationNumber}`,
      citationNumber: item.citationNumber,
      title: item.title ?? `Evidence ${item.citationNumber}`,
      excerpt: item.contentSnapshot,
      sourceKind: item.sourceKind,
      sourceId: item.sourceId,
      sourceUrl: item.sourceUrl,
      applicationId: item.applicationId,
      knowledgeDocumentId: item.knowledgeDocumentId,
      evidenceRole: item.evidenceRole,
      contentHash: item.contentHash
    }))
  };

  return (
    <main className="admin-shell briefing-page">
      <section className="admin-header grant-detail-header briefing-page-header">
        <nav aria-label="Briefing navigation" className="briefing-page-links">
          <Link className="under-review-link" href="/dashboard">
            Back to dashboard
          </Link>
          <Link className="under-review-link primary" href={`/admin/grants/${application.id}`}>
            View grant details
          </Link>
        </nav>
        <div>
          <p className="eyebrow">Committee briefing</p>
          <h1>{application.title}</h1>
          <p className="lead">
            Evidence-grounded decision support for committee review. This briefing does not recommend or make a
            funding decision.
          </p>
        </div>
      </section>

      <CommitteeBriefingDocument report={clientReport} />
    </main>
  );
}
