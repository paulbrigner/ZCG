import Link from "next/link";
import { query } from "@/lib/db";
import { publicGrantProjectionFields } from "@/lib/public-projection";
import { fundedGrantMetricHelp } from "./grant-metric-copy";
import { MetricLabel } from "./admin/metric-help";

export const dynamic = "force-dynamic";

type ProgressRow = {
  application_count: string;
  funded_grant_count: string;
  paid_ledger_row_count: string;
  historical_disbursement_amount_usd: string;
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
    body: "Related records become canonical applications, funded-grant records, normalized FPF milestone/disbursement ledger rows, labels, decision history, confidence scores, and explicit review issues."
  },
  {
    title: "Keep reviewer judgment durable",
    body: "Manual source links, dismissals, and application relationships are audited and replayed after generated reconciliation instead of disappearing on refresh."
  },
  {
    title: "Search and brief from grounded evidence",
    body: "Full-text and vector retrieval connect applications, source evidence, labels, meeting decisions, and open review issues. Authorized reviewers can generate versioned committee briefings or temporary, private, and shared custom analyses with citation snapshots."
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
              (select count(*)::text
                 from grants g
                 join grant_applications ga_funded on ga_funded.id = g.application_id
                where ga_funded.normalized_status in ('approved', 'active', 'completed')) as funded_grant_count,
              (select count(*)::text
                 from source_records sr_paid
                where sr_paid.source_kind = 'google_sheet_row'
                  and sr_paid.metadata->>'gid' = '803214474'
                  and nullif(trim(sr_paid.raw_payload->>'Paid Out'), '') is not null) as paid_ledger_row_count,
              (select coalesce(
                        sum(
                          nullif(
                            regexp_replace(sr_paid.raw_payload->>'Amount (USD)', '[^0-9.-]', '', 'g'),
                            ''
                          )::numeric
                        ),
                        0
                      )::text
                 from source_records sr_paid
                where sr_paid.source_kind = 'google_sheet_row'
                  and sr_paid.metadata->>'gid' = '803214474'
                  and nullif(trim(sr_paid.raw_payload->>'Paid Out'), '') is not null)
                as historical_disbursement_amount_usd,
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

function compactCurrencyText(value: string | null | undefined) {
  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        notation: "compact",
        maximumFractionDigits: 1
      })
    : "—";
}

function currencyText(value: string | null | undefined) {
  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      })
    : "—";
}

export default async function HomePage() {
  const progress = await getProgress();

  return (
    <main className="home-shell">
      <section className="hero home-hero">
        <div>
          <p className="eyebrow">Working prototype</p>
          <h1>Zcash Community Grants Decision Support</h1>
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
              <MetricLabel
                body={fundedGrantMetricHelp}
                label="Funded-status grants"
                text="funded-status grants"
              />
            </div>
            <div>
              <strong>{countText(progress?.warning_count)}</strong>
              <span>open warnings/errors</span>
            </div>
            <div>
              <strong>{countText(progress?.knowledge_document_count)}</strong>
              <span>knowledge documents</span>
            </div>
            <div className="home-progress-total">
              <strong>{compactCurrencyText(progress?.historical_disbursement_amount_usd)}</strong>
              <MetricLabel
                body={`This prototype sums Amount (USD) for ${countText(
                  progress?.paid_ledger_row_count
                )} rows with a Paid Out date in the mirrored FPF ZCG Grants ledger, producing ${currencyText(
                  progress?.historical_disbursement_amount_usd
                )}. FPF’s official dashboard calculates $19,272,719.425 for the same regular-grant milestone scope and displays $19,272,719. The half-cent difference comes from one source adjustment that exports at two-decimal precision, so the totals reconcile. This excludes Coinholder grants, independent-contractor payouts, committee stipends, and discretionary-budget spending. OpenZcash currently shows $23.7M across 753 payments; that broader, differently aggregated figure is not substituted for this evidence-derived metric.`}
                label="Historical grant payments"
                text="historical grant payments"
              />
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
          <h2>From public records to traceable grant data</h2>
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
              <li>ZCG All Grants plus normalized FPF milestone and recorded-disbursement ledger rows</li>
              <li>Forum topics discovered from applications and registry records</li>
              <li>Community Grants Updates and meeting-decision history</li>
            </ul>
          </article>
          <article className="panel">
            <p className="eyebrow">Explicit boundary</p>
            <h2>Not yet first-class workflows</h2>
            <ul className="home-list">
              <li>Progress updates, payment requests, approvals, and settlement verification</li>
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
          <Link href="/admin/knowledge">Grant knowledge search <span aria-hidden="true">→</span></Link>
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
