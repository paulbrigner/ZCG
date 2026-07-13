import Link from "next/link";
import { principalHasPermission, requirePermission } from "@/lib/authorization";
import { getReconciliationWorkspace } from "@/lib/reconciliation/decisions";
import { ReconciliationManagementPanel } from "../reconciliation-management-panel";

export default async function AdminReconciliationsPage() {
  const principal = await requirePermission("reconciliation:read");
  const canWrite = await principalHasPermission(principal.id, "reconciliation:write");
  const workspace = await getReconciliationWorkspace();

  return (
    <main className="admin-shell">
      <section className="admin-header">
        <div>
          <p className="eyebrow">Dashboard</p>
          <h1>Reconciliations</h1>
          <p className="lead">
            Signed in as <span className="code">{principal.email}</span>.{" "}
            <Link className="table-link" href="/dashboard">
              Dashboard
            </Link>
          </p>
        </div>
      </section>

      <ReconciliationManagementPanel canWrite={canWrite} initialWorkspace={workspace} />
    </main>
  );
}
