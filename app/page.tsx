import { publicGrantProjectionFields } from "@/lib/public-projection";

const foundations = [
  {
    title: "Sync-first foundation",
    body: "Phase 0 creates the app, runtime, database, worker, and deployment surface before replacing any current ZCG source system."
  },
  {
    title: "Private by design",
    body: "Authorization, audit events, and public projection rules are part of the foundation, not hardening work postponed until later."
  },
  {
    title: "Portable deployment",
    body: "CDK packaging provisions the runtime, private database, storage, worker, secrets, logs, and alarms for a new AWS account."
  }
];

export default function HomePage() {
  return (
    <main>
      <section className="hero">
        <div>
          <p className="eyebrow">Phase 0 foundation</p>
          <h1>ZCG grants operating system prototype</h1>
          <p className="lead">
            A deployable shell for moving from human-synchronized GitHub, Discourse,
            Sheets, Jotform, and FPF workflows into a structured grants platform with
            clear public/private boundaries.
          </p>
        </div>
        <aside className="panel" aria-label="Phase 0 status">
          <h2>Foundation checks</h2>
          <div className="status-list">
            <p className="status-item">
              <span className="dot green" />
              Node 24 runtime pinned
            </p>
            <p className="status-item">
              <span className="dot green" />
              Better Auth route mounted
            </p>
            <p className="status-item">
              <span className="dot blue" />
              Audit and RBAC schema scaffolded
            </p>
            <p className="status-item">
              <span className="dot amber" />
              Source importers start in Phase 1
            </p>
          </div>
        </aside>
      </section>

      <section className="section">
        <div className="grid">
          {foundations.map((item) => (
            <article className="card" key={item.title}>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section">
        <h2>Public grant projection allowlist</h2>
        <p>
          Public pages and exports should only use explicitly approved fields. The
          current scaffold allowlists{" "}
          <span className="code">{publicGrantProjectionFields.join(", ")}</span>.
        </p>
      </section>
    </main>
  );
}
