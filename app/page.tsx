import Link from "next/link";
import { query } from "@/lib/db";
import { publicGrantProjectionFields } from "@/lib/public-projection";

export const dynamic = "force-dynamic";

type ProgressRow = {
  application_count: string;
  funded_grant_count: string;
  warning_count: string;
  knowledge_document_count: string;
};

const capabilities = [
  {
    title: "Mirror public evidence",
    body: "GitHub applications and comments, two operational Google Sheet tabs, linked Forum topics, and Community Grants Updates are preserved with source identity and provenance."
  },
  {
    title: "Reconcile grant history",
    body: "Related records become canonical applications, funded-grant records, normalized labels, decision history, confidence scores, and explicit review issues."
  },
  {
    title: "Keep reviewer judgment durable",
    body: "Manual source links, dismissals, and application relationships are audited and replayed after generated reconciliation instead of disappearing on refresh."
  },
  {
    title: "Search grounded evidence",
    body: "Full-text and vector retrieval connect applications, source evidence, labels, and meeting decisions, with optional citation-grounded answer composition."
  }
];

const principles = [
  {
    title: "Migrate before replacing",
    body: "The prototype reads existing public systems first. ZCG can evaluate a unified data model without requiring an immediate workflow cutover."
  },
  {
    title: "Make provenance first-class",
    body: "Source IDs, URLs, checksums, payloads, confidence, relationship roles, and reviewer rationale stay attached to the records they support."
  },
  {
    title: "Surface uncertainty",
    body: "Missing and ambiguous relationships belong in a visible review queue. The system should not manufacture certainty or silently discard conflicting evidence."
  },
  {
    title: "Separate public and private data",
    body: "Public projections are allowlisted. KYC, agreements, payment instructions, custody, and internal deliberation require explicit private boundaries."
  }
];

async function getProgress() {
  try {
    const result = await query<ProgressRow>(
      `select (select count(*)::text from grant_applications) as application_count,
              (select count(*)::text from grants) as funded_grant_count,
              (select count(*)::text
                 from reconciliation_issues
                where status in ('open', 'assigned')
                  and severity in ('warning', 'error')) as warning_count,
              (select count(*)::text from grant_knowledge_documents) as knowledge_document_count`
    );
    return result.rows[0] ?? null;
  } catch {
    return null;
  }
}

function countText(value: string | null | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString("en-US") : "—";
}

export default async function HomePage() {
  const progress = await getProgress();

  return (
    <main className="home-shell">
      <section className="hero home-hero">
        <div>
          <p className="eyebrow">Independent working prototype</p>
          <h1>A provenance-first operating system for Zcash Community Grants</h1>
          <p className="lead">
            ZCG currently operates across GitHub, the Zcash Community Forum, Google Sheets,
            and private operational workflows. This prototype mirrors the public evidence,
            reconciles it into a coherent grant history, and makes uncertainty reviewable
            without asking ZCG to replace its current tools first.
          </p>
          <div className="home-actions" aria-label="Prototype links">
            <Link className="home-link primary" href="/dashboard">Explore the dashboard</Link>
            <Link className="home-link" href="/admin/knowledge">Search grant evidence</Link>
            <a
              className="home-link"
              href="https://github.com/paulbrigner/ZCG"
              rel="noreferrer"
              target="_blank"
            >
              View source on GitHub
            </a>
          </div>
          <p className="home-disclaimer">
            This is an independent prototype and architecture proposal, not an official ZCG
            production system unless relevant Zcash ecosystem stakeholders adopt it.
          </p>
        </div>

        <aside className="panel home-status-panel" aria-label="Current prototype status">
          <span className="badge active">Live prototype</span>
          <h2>Current corpus</h2>
          <div className="home-progress-grid">
            <div>
              <strong>{countText(progress?.application_count)}</strong>
              <span>canonical applications</span>
            </div>
            <div>
              <strong>{countText(progress?.funded_grant_count)}</strong>
              <span>funded-status grants</span>
            </div>
            <div>
              <strong>{countText(progress?.warning_count)}</strong>
              <span>open warnings/errors</span>
            </div>
            <div>
              <strong>{countText(progress?.knowledge_document_count)}</strong>
              <span>knowledge documents</span>
            </div>
          </div>
          <p className="home-status-note">
            Live reconciliation outputs are prototype observations, not authoritative ZCG
            production totals.
          </p>
        </aside>
      </section>

      <section className="section home-section">
        <div className="home-section-heading">
          <p className="eyebrow">Working now</p>
          <h2>From scattered public records to traceable grant data</h2>
        </div>
        <div className="home-capability-grid">
          {capabilities.map((item, index) => (
            <article className="card home-capability-card" key={item.title}>
              <span className="home-step">0{index + 1}</span>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section home-section home-rationale">
        <div className="home-section-heading">
          <p className="eyebrow">Why this approach</p>
          <h2>Modernize the data layer without breaking public trust</h2>
          <p>
            Today, people are the integration layer keeping application intake, discussion,
            decisions, milestone reporting, and financial tracking aligned. The prototype
            makes those relationships explicit while retaining the original evidence.
          </p>
        </div>
        <div className="home-principle-list">
          {principles.map((item) => (
            <article key={item.title}>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section home-section">
        <div className="home-coverage-grid">
          <article className="panel">
            <p className="eyebrow">Connected today</p>
            <h2>Current source coverage</h2>
            <ul className="home-list">
              <li>GitHub grant issues, labels, and comments</li>
              <li>ZCG All Grants and milestone/payment-detail Sheet tabs</li>
              <li>Forum topics discovered from applications and registry records</li>
              <li>Community Grants Updates and meeting-decision history</li>
            </ul>
          </article>
          <article className="panel">
            <p className="eyebrow">Explicit boundary</p>
            <h2>Not yet normalized</h2>
            <ul className="home-list">
              <li>Milestones, progress updates, payment requests, and disbursements</li>
              <li>Jotform RFP intake and website content</li>
              <li>KYC, agreements, attachments, and private operations</li>
              <li>Applicant workflows and controlled writeback to current systems</li>
            </ul>
          </article>
        </div>
      </section>

      <section className="section home-section home-explore">
        <div>
          <p className="eyebrow">Explore the prototype</p>
          <h2>Inspect the data, evidence, and reviewer workflow</h2>
          <p>
            Public read-only views expose selected operational surfaces. Writes, richer
            retrieval modes, synchronization, indexing, and user management remain permissioned.
          </p>
        </div>
        <nav className="home-surface-links" aria-label="Prototype surfaces">
          <Link href="/dashboard">ZCG Grants Dashboard <span aria-hidden="true">→</span></Link>
          <Link href="/admin/reconciliations">Reconciliation workspace <span aria-hidden="true">→</span></Link>
          <Link href="/admin/knowledge">Grant knowledge search <span aria-hidden="true">→</span></Link>
          <Link href="/api/public/grants">Public grants API <span aria-hidden="true">→</span></Link>
        </nav>
      </section>

      <section className="section home-section home-public-projection">
        <h2>Deliberate public projection</h2>
        <p>
          Public pages and exports use an explicit allowlist rather than exposing raw operational
          rows: <span className="code">{publicGrantProjectionFields.join(", ")}</span>.
        </p>
      </section>
    </main>
  );
}
