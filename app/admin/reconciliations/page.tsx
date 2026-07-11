import Link from "next/link";
import { isPublicPrototypePrincipal, principalHasPermission, requirePermission } from "@/lib/authorization";
import { getReconciliationWorkspace } from "@/lib/reconciliation/decisions";
import { ReconciliationManagementPanel } from "../reconciliation-management-panel";

export default async function AdminReconciliationsPage() {
  const principal = await requirePermission("reconciliation:read", { allowPublicPrototypeRead: true });
  const canWrite =
    !isPublicPrototypePrincipal(principal) &&
    (await principalHasPermission(principal.id, "reconciliation:write"));
  const workspace = await getReconciliationWorkspace();

  return (
    <main className="admin-shell">
      <section className="admin-header">
        <div>
          <p className="eyebrow">Dashboard</p>
          <h1>Reconciliations</h1>
          <p className="lead">
            {isPublicPrototypePrincipal(principal) ? (
              <>
                Public read-only prototype view. <Link className="table-link" href="/sign-in">Sign in</Link> for reconciliation operations.
              </>
            ) : (
              <>
                Signed in as <span className="code">{principal.email}</span>.{" "}
                <Link className="table-link" href="/dashboard">
                  Dashboard
                </Link>
              </>
            )}
          </p>
        </div>
      </section>

      <ReconciliationManagementPanel canWrite={canWrite} initialWorkspace={workspace} />
    </main>
  );
}
