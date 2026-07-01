import Link from "next/link";
import {
  isPublicPrototypePrincipal,
  principalHasRole,
  principalHasPermission,
  requirePermission
} from "@/lib/authorization";
import { knowledgeProviderStatus } from "@/lib/knowledge/config";
import { getGrantKnowledgeOverview } from "@/lib/knowledge/search";
import { KnowledgeSearchPanel } from "./knowledge-search-panel";

function numberText(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed.toLocaleString("en-US") : "0";
}

function dateText(value: string | null) {
  if (!value) {
    return "-";
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "-"
    : parsed.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
}

export default async function GrantKnowledgePage() {
  const principal = await requirePermission("knowledge:search", { allowPublicPrototypeRead: true });
  const [overview, providerStatus] = await Promise.all([
    getGrantKnowledgeOverview(),
    Promise.resolve(knowledgeProviderStatus())
  ]);
  const canComposeAi =
    !isPublicPrototypePrincipal(principal) &&
    (await principalHasPermission(principal.id, "knowledge:compose"));
  const canIndex =
    !isPublicPrototypePrincipal(principal) &&
    (await principalHasRole(principal.id, "admin"));
  const canUseSemantic =
    !isPublicPrototypePrincipal(principal) &&
    (await principalHasPermission(principal.id, "knowledge:semantic"));

  return (
    <main className="admin-shell">
      <section className="admin-header">
        <div>
          <p className="eyebrow">Decision support</p>
          <h1>Grant knowledge retrieval</h1>
          <p className="lead">
            {isPublicPrototypePrincipal(principal) ? (
              <>
                Public read-only prototype view. <Link className="table-link" href="/sign-in">Sign in</Link> for admin operations.
              </>
            ) : (
              <>
                Signed in as <span className="code">{principal.email}</span>.
              </>
            )}
          </p>
        </div>
      </section>

      <section className="metric-grid" aria-label="Grant knowledge summary">
        <article className="metric-card">
          <span className="metric-label">Knowledge documents</span>
          <strong>{numberText(overview.documentCount)}</strong>
        </article>
        <article className="metric-card">
          <span className="metric-label">Applications covered</span>
          <strong>{numberText(overview.applicationCount)}</strong>
        </article>
        <article className="metric-card">
          <span className="metric-label">Latest index</span>
          <strong>{dateText(overview.latestIndexedAt)}</strong>
        </article>
        <article className="metric-card">
          <span className="metric-label">Embeddings</span>
          <strong>{numberText(overview.embeddingCount)}</strong>
          <span className="metric-note">{providerStatus.embeddingModel}</span>
        </article>
        <article className="metric-card">
          <span className="metric-label">AI answers</span>
          <strong>{providerStatus.aiConfigured ? "Configured" : "Not set"}</strong>
          <span className="metric-note">{providerStatus.aiModel}</span>
        </article>
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2>Indexed sources</h2>
        </div>
        <div className="source-counts compact-source-counts">
          {overview.sourceKinds.length ? (
            overview.sourceKinds.map((sourceKind) => (
              <div className="source-count" key={sourceKind.sourceKind}>
                <span>{sourceKind.sourceKind}</span>
                <strong>{numberText(sourceKind.documentCount)}</strong>
              </div>
            ))
          ) : (
            <p>No knowledge documents indexed yet.</p>
          )}
        </div>
      </section>

      <KnowledgeSearchPanel
        canComposeAi={canComposeAi}
        canIndex={canIndex}
        canUseSemantic={canUseSemantic}
        initialAiConfigured={providerStatus.aiConfigured}
        initialSemanticEnabled={providerStatus.semanticSearchEnabled}
      />
    </main>
  );
}
