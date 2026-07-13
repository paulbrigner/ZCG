import Link from "next/link";
import {
  isPublicPrototypePrincipal,
  principalHasRole,
  principalHasPermission,
  requirePermission
} from "@/lib/authorization";
import { knowledgeProviderStatus } from "@/lib/knowledge/config";
import { KnowledgeSearchPanel } from "./knowledge-search-panel";

export default async function GrantKnowledgePage() {
  const principal = await requirePermission("knowledge:search", { allowPublicPrototypeRead: true });
  const providerStatus = knowledgeProviderStatus();
  const publicViewer = isPublicPrototypePrincipal(principal);
  const canComposeAi =
    !publicViewer &&
    (await principalHasPermission(principal.id, "knowledge:compose"));
  const canIndex =
    !publicViewer &&
    (await principalHasRole(principal.id, "admin"));
  const canUseSemantic = publicViewer
    ? providerStatus.semanticSearchEnabled
    : await principalHasPermission(principal.id, "knowledge:semantic");

  return (
    <main className="admin-shell">
      <section className="admin-header">
        <div>
          <p className="eyebrow">Decision support</p>
          <h1>Grant knowledge retrieval</h1>
          <p className="lead">
            {publicViewer ? (
              <>
                Public read-only prototype view. <Link className="table-link" href="/sign-in">Sign in</Link> for dashboard operations.
              </>
            ) : (
              <>
                Signed in as <span className="code">{principal.email}</span>.
              </>
            )}
          </p>
        </div>
      </section>

      <KnowledgeSearchPanel
        canComposeAi={canComposeAi}
        canIndex={canIndex}
        canUseSemantic={canUseSemantic}
        isPublicViewer={publicViewer}
        initialAiConfigured={providerStatus.aiConfigured}
        initialSemanticEnabled={providerStatus.semanticSearchEnabled}
      />
    </main>
  );
}
