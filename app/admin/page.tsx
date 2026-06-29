import { requirePermission } from "@/lib/authorization";

export default async function AdminPage() {
  const principal = await requirePermission("admin:dashboard:view");

  return (
    <main>
      <section className="hero">
        <div>
          <p className="eyebrow">Admin console</p>
          <h1>Protected Phase 0 admin shell</h1>
          <p className="lead">
            This page proves server-side authorization is wired before operational
            workflows are added. The authenticated principal is{" "}
            <span className="code">{principal.email}</span>.
          </p>
        </div>
        <aside className="panel">
          <h2>Next surfaces</h2>
          <div className="status-list">
            <p className="status-item">
              <span className="dot blue" />
              Sync health dashboard
            </p>
            <p className="status-item">
              <span className="dot blue" />
              Reconciliation inbox
            </p>
            <p className="status-item">
              <span className="dot blue" />
              Audit event viewer
            </p>
            <p className="status-item">
              <span className="dot blue" />
              Source mirror inspector
            </p>
          </div>
        </aside>
      </section>
    </main>
  );
}
