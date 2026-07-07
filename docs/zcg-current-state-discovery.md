# ZCG grants systems current-state discovery

Date: 2026-06-28

This is a first-pass map of the public Zcash Community Grants systems for grant application, review, tracking, reporting, and related RFP idea intake. It is based on live public sources inspected on 2026-06-28. Private/operational systems such as KYC, grant agreements, payment approvals, treasury custody, internal committee notes, and GitHub Projects require follow-up with system owners.

## Executive takeaways

- The current system is not just "GitHub issues plus a Google Sheet." It is a network of public website routing, GitHub issue intake, GitHub labels as workflow state, required Discourse forum threads, a large Google Sheet ledger/dashboard, Jotform RFP idea intake, and FPF/ZCG manual processes.
- The public website and the issue-intake repository are separate repos:
  - Live website: `ZcashCommunityGrants/zcashcommunitygrants.github.io`, served at https://zcashcommunitygrants.org.
  - Issue intake: `ZcashCommunityGrants/zcashcommunitygrants`, where grant applications are submitted as GitHub issues.
- The Google Sheet is a broader treasury and portfolio system with 24 tabs, including live dashboards, grants ledgers, IC payouts, liquidity, discretionary budgets, stipends, fund distribution summaries, all-grants tracking, coinholder-grant equivalents, inputs, and archived snapshots.
- The grant process is partly public and partly manual. Public artifacts record application text, community discussion, labels, and payment/milestone summaries; private/manual artifacts likely include KYC, grant agreements, payment approvals, meeting notes, identity data, bank/wallet operations, and perhaps GitHub Projects.
- A rebuild should start with a source-of-truth and data-boundary exercise, not UI design. The main design problem is coordinating public transparency, applicant workflow, private compliance/payment operations, and historical reporting without duplicating records across GitHub, Discourse, and Sheets.

## Public systems inventory

| System | Current role | Evidence |
| --- | --- | --- |
| ZCG public website | Public program site, grant process explanation, submit links, dashboard links, RFP PDFs, committee/news pages | https://zcashcommunitygrants.org and https://github.com/ZcashCommunityGrants/zcashcommunitygrants.github.io |
| GitHub issue-intake repo | Grant applications are submitted as issues using a YAML issue form; labels act as workflow/status markers | https://github.com/ZcashCommunityGrants/zcashcommunitygrants/issues and `.github/ISSUE_TEMPLATE/grant_application.yaml` |
| Google Sheet | Treasury dashboard, grants/milestone ledger, IC payouts, liquidity, discretionary budgets, stipends, fund distributions, all-grants tracking, inputs, archives | https://docs.google.com/spreadsheets/d/1FQ28rDCyRW0TiNxrm3rgD8ai2KGUsXAjPieQmI1kKKg/edit |
| Zcash Community Forum | Required public thread for applications, community review, ongoing monthly/status updates, and updates before milestone payouts | https://forum.zcashcommunity.com/c/grants/33 and https://forum.zcashcommunity.com/c/grants/applications/36 |
| Jotform RFP idea form | Separate RFP idea intake, with ZCG/FPF review and possible RFP bounty workflow | https://form.jotform.com/252475280529058 |
| Financial Privacy Foundation | Eligibility review, applicant communication, KYC/grant agreement facilitation, likely payment/compliance operations | Named in the grant process page and Jotform text |
| Legacy zcashgrants.org gallery links | Historical funded-project links still appear on the website; the root domain redirects to `zfnd.org` as of discovery | https://zcashgrants.org |

## Grant application workflow, public view

The live Grant Process page describes this flow:

1. Applicant uses a GitHub account and completes the ZCG Grant Application issue form.
2. Applicant posts a link to the grant on the Zcash Community Forum Applications category.
3. FPF reviews the application for eligibility before ZCG review.
4. Community and ecosystem stakeholders have at least one week to comment.
5. ZCG reviews applications after community review, may include outside experts, reviews prior grant outcomes, and discusses applications in biweekly meetings.
6. FPF works with the applicant to finalize/improve the application if needed.
7. ZCG makes an approval decision by simple majority, 3 of 5.
8. FPF notifies the grantee via the Zcash Community Forum.
9. FPF facilitates KYC and grant agreement documentation.
10. Forum updates on the grant proposal thread are required before milestone payouts are made.

The issue form itself also requires applicants to agree to grant agreement terms, KYC above $50,000, conflict disclosure, code of conduct/communication guidelines, forum posting, milestone validation by intended users or representatives, and contribution-guideline expectations for open-source work.

## GitHub issue intake

Repository: https://github.com/ZcashCommunityGrants/zcashcommunitygrants

Observed repository settings:

- Public repo.
- Issues enabled.
- Projects enabled, but GitHub Projects v2 could not be inspected because the local GitHub token lacks `read:project`.
- Discussions disabled.
- No GitHub Actions workflows in the issue-intake repo.
- No milestones returned by the public REST API.

Issue-form fields captured:

- Terms and conditions checkboxes.
- Application owners by GitHub username.
- Organization name and discovery source.
- Requested grant amount and category.
- Project lead and additional team members.
- Project summary, description, problem, solution, format, dependencies, technical approach, upstream merge opportunities.
- Hardware/software, service, compensation, and total budget fields.
- Previous ZCG funding and other funding sources.
- Implementation risks, side effects, success metrics.
- Startup funding and milestone details.
- Supporting documents.

Issue history snapshot from the GitHub API:

- 319 issues total, from issue #1 on 2024-12-12 to issue #338 on 2026-06-27.
- 286 closed, 33 open.
- Created by year: 2024: 6, 2025: 161, 2026: 152.
- Extracted requested amounts from 279 issue bodies total about $26.63M. This is application-request data, not approved funding.
- Category counts extracted from issue bodies are led by Infrastructure, Community, Education, Wallets, Integration, Research and Development, Non-Wallet Applications, Media, and Event Sponsorships.

Workflow labels observed:

| Label family | Current meaning inferred |
| --- | --- |
| Pending Grant Application | Initial submission state; only 2 issues currently had this label in the API sample |
| Grant Application | Validated application |
| Ready For ZCG Review | Ready for committee evaluation |
| Does Not Meet Criteria | Failed eligibility/requirements check |
| Forum Post Missing | Forum-post requirement not fulfilled |
| Changes Pending Review / Changes Approved | Revision loop |
| Grant Approved / Grant Declined / Grant Withdrawn / Grant Cancelled Before Completion | Application or grant outcome |
| KYC Required / KYC Verified | Compliance gating |
| Startup Payment Completed | Startup funding paid |
| Grant Milestone Payment Request / Pending Grant Milestone Payment Request / Milestone Payment Approved / Milestone Payment Complete | Payment-request workflow |
| Milestone N Complete | Milestone completion, currently labels exist through Milestone 24 |
| Progress Update Required | Status report needed |
| Grant Complete | Grant completed |
| Bounty Payment Completed | Bounty paid |

Label counts show that most historical issues are marked `Grant Application` and `Ready For ZCG Review`, with many closed issues labeled declined and a smaller set approved. Open approved issues often carry accumulated milestone-completion labels.

Open questions:

- Are labels applied manually, by GitHub UI saved query, by project automation, or by an external script?
- Why were the newest open issues #337 and #338 label-less at discovery time, even though the website submit link pre-fills a pending label?
- Is GitHub Projects v2 used for internal triage/status? Verification needs `read:project`.
- Are comments used as the canonical approval/payment log, or only as public communication?

## Google Sheet inventory

Sheet: https://docs.google.com/spreadsheets/d/1FQ28rDCyRW0TiNxrm3rgD8ai2KGUsXAjPieQmI1kKKg/edit

The Sheet is publicly readable by CSV for individual tabs. The unauthenticated Google Sheets metadata API is blocked, but tab names and gids were discoverable from the public page model.

| # | gid | Tab | Populated rows | Columns | Purpose inferred |
| --- | --- | --- | ---: | ---: | --- |
| 0 | 135980745 | ZCG Dashboard | 56 | 5 | ZCG treasury/status dashboard |
| 1 | 808560406 | Coinholder Dashboard | 39 | 4 | Coinholder grants treasury/status dashboard |
| 2 | 803214474 | ZCG Grants | 811 | 12 | Grant/milestone ledger |
| 3 | 1267338970 | ZCG IC Payouts | 58 | 24 | Independent contractor payout ledger |
| 4 | 722519692 | Coinholder Grants | 7 | 9 | Coinholder grants ledger |
| 5 | 1024670602 | ZCG Liquidity | 7 | 9 | Liquidity transfers and KPIs |
| 6 | 2000960834 | ZCG 2025 Disc. Budget (Closed) | 30 | 7 | Discretionary budget ledger |
| 7 | 2043949055 | ZCG 2026 Disc. Budget | 31 | 7 | Current discretionary budget ledger |
| 8 | 214399476 | ZCG 2025 Stipend (Closed) | 62 | 6 | Stipend payments |
| 9 | 598263567 | ZCG 2026 Stipend | 27 | 6 | Current stipend payments |
| 10 | 164877840 | ZCG Funds Distribution | 85 | 18 | Distribution summary by recipient/classification |
| 11 | 1885743444 | Coinholder Funds Distribution | 18 | 18 | Coinholder distribution summary |
| 12 | 1164534734 | ZCG All Grants Tracking | 611 | 11 | Comprehensive historical proposal/application tracking |
| 13 | 1114900636 | ZCG 2024 Disc. Budget (closed) | 15 | 7 | Historical discretionary budget |
| 14 | 1677818060 | ZCG 2023 Disc. Budget (closed) | 50 | 7 | Historical discretionary budget |
| 15 | 958969131 | ZCG 2022 Disc. Budget (closed) | 43 | 7 | Historical discretionary budget |
| 16 | 1107563376 | ZCG 2024 Stipend (closed) | 55 | 7 | Historical stipend payments |
| 17 | 1310518877 | ZCG Ambassador Details (archived) | 10 | 3 | Archived ambassador details |
| 18 | 1847584751 | Coinholder All Grants Tracking | 31 | 12 | Coinholder proposal/application tracking |
| 19 | 892150625 | Inputs | 21 | 4 | Shared inputs: block height, prices, balances, etc. |
| 20 | 7542155 | ZCG Dashboard (Archived 8.15.25) | 29 | 5 | Archived dashboard snapshot |
| 21 | 1871548102 | Grants (archived 8.15.25) | 564 | 11 | Archived grant ledger |
| 22 | 1521309413 | ZCG Funds Distribution (archived 8.15.25) | 69 | 17 | Archived distribution snapshot |
| 23 | 804329245 | Inputs (archived 8.15.25) | 18 | 3 | Archived inputs |

Key current dashboard values observed:

- Status: Updates required.
- Coinbase address balance as of block height 3,389,320.
- Block time: 2026-06-24 17:27:23 UTC.
- ZECUSD price: $386.44.
- Current ZEC balance: 77,641 ZEC.
- Current USD balance: $8,938,876.
- USD value of current holdings: about $38.94M.
- Future grant liabilities: about $1.89M.
- USD value available current holdings: about $37.05M.
- Future ZEC donations receivable: 127,135 ZEC.
- USD value of current available holdings plus future donations: about $86.18M.

ZCG Grants tab summary:

- 810 populated grant/milestone ledger rows.
- 171 unique project names.
- Project statuses by row: 542 Completed, 201 Open, 67 Cancelled.
- Unique projects by status: 129 Completed, 26 Open, 16 Cancelled.
- Sum of `Amount (USD)` rows: about $21.01M.
- Sum of `ZEC Disbursed` rows: about 396,911 ZEC.

ZCG All Grants Tracking tab summary:

- 611 titled proposal/application rows as of the 2026-07-07 CSV export.
- Status counts after normalization: 318 Declined, 161 Approved, 77 Filtered by FPF / Outside of Scope, 36 Application Withdrawn, 10 Cancelled, 9 ZCG to discuss / under review.
- This tab is the most comprehensive public historical registry of ZCG proposals considered, including older grants that may not have GitHub issue records.

Open questions:

- Who edits each tab, and what is the cadence?
- Which formulas are authoritative for liabilities, balances, USD/ZEC conversions, and dashboards?
- Which fields are manually entered versus derived from GitHub, Discourse, treasury records, or external APIs?
- Are archived snapshots manual forks or controlled reporting checkpoints?
- Are there hidden/protected tabs, Apps Script automations, or external connectors not visible from public CSV?
- What should be public, committee-private, FPF-private, applicant-private, and finance-private?

## Website and public routing

Live repo: https://github.com/ZcashCommunityGrants/zcashcommunitygrants.github.io

Observed live site behavior:

- Home page links `Submit a Grant` to the GitHub issue form in `ZcashCommunityGrants/zcashcommunitygrants`.
- Home page links `Submit an RFP Idea` to Jotform form `252475280529058`.
- Home page links dashboard references to the `1FQ28...` Google Sheet.
- Navigation points Contact to the Zcash Community Forum grants category.
- The live site uses the Google Sheets API to fetch a value from the current dashboard sheet for treasury display.

Important source split:

- `ZcashCommunityGrants/zcashcommunitygrants.github.io` is the public site repo and has GitHub Pages enabled.
- `ZcashCommunityGrants/zcashcommunitygrants` is the issue-intake repo and has the grant application issue template.
- The issue-intake repo's `main/index.html` is stale compared with the live site. It still points to old dashboard sheet `1O5f...` and `zcashgrants.org` for Submit a Grant.

Potential stale/broken references:

- The issue form links category definitions to `https://zcashcommunitygrants.org/categories`, which returned GitHub Pages 404 during discovery.
- Legacy funded-project links still point to `zcashgrants.org/gallery/...`; `https://zcashgrants.org` redirected to `https://zfnd.org/` during discovery. Individual gallery-link behavior should be checked before migration.

## Forum workflow

Forum parent category: https://forum.zcashcommunity.com/c/grants/33

Application subcategory used by the process page: https://forum.zcashcommunity.com/c/grants/applications/36

Observed:

- The process page requires applicants to post a link to the GitHub issue on the forum.
- If applicants cannot post due to new-user restrictions, they are instructed to comment on the grant issue so posting permissions can be adjusted.
- Community review lasts at least one week.
- Monthly status updates are strongly expected and forum updates are required before milestone payouts.
- The public Discourse category index reports Community Grants with 237 topics and 3,292 posts.

Open questions:

- Are forum threads manually cross-linked to GitHub issues and Sheet rows?
- Who verifies forum update completion before milestone payouts?
- Are meeting minutes or decision explanations reliably linked back to issue/forum/sheet records?

## RFP idea workflow

Form: https://form.jotform.com/252475280529058

The Jotform page is titled `ZCG RFP Idea Form`. It says ZCG, with support from FPF, will collect and evaluate ideas, solicit additional context, obtain community comment if necessary, and solicit RFP submissions if the idea is of funding interest.

Captured fields:

- Name.
- Email.
- Affiliation.
- Problem description.
- Problem impact.
- Desired outcomes.
- Detailed explanation/background/specifications/supporting materials.
- Optional PDF upload.
- Additional comments.

The form also describes a $500 USD in ZEC bounty for the idea originator once ZCG accepts an RFP proposal generated from the idea and someone is building it.

Open questions:

- Where do Jotform submissions land?
- Who triages and approves RFP ideas?
- How are accepted ideas converted to public RFPs?
- How are RFP bounties approved, paid, and reflected in the Sheet or GitHub?

## Main design implications

A clean rebuild should probably model the program as a public/private workflow system, not simply as a grant application portal.

Core public records:

- Application/proposal.
- Applicant-facing public status.
- Forum thread and community-review window.
- Committee decision summary.
- Approved scope, milestones, deliverables, reporting cadence, public status updates.
- Public payment/milestone completion summary.

Core private records:

- Applicant identity and KYC status.
- Grant agreement status and signed documents.
- Payment approval packet.
- Treasury/wallet/bank execution details.
- Internal committee notes, conflicts, diligence, and votes if not intended for public release.

Candidate data model:

- Applicant.
- Organization.
- GrantApplication.
- ApplicationVersion.
- ForumThread.
- EligibilityReview.
- CommitteeReview.
- Decision.
- GrantAgreement.
- Milestone.
- Deliverable.
- ProgressUpdate.
- PaymentRequest.
- Payment.
- LedgerTransaction.
- BudgetScenario.
- RFPIdea.
- RFP.
- Bounty.
- Attachment.
- PublicAuditEvent.

## Recommended path before redesign

1. Confirm source ownership and permissions.
   - Website repo ownership.
   - Issue repo ownership.
   - Sheet owner/editors/protected ranges.
   - Jotform owner and notification/storage settings.
   - Forum moderator/admin workflow.
   - GitHub Projects usage.

2. Build a cross-source data map.
   - Match GitHub issue number to forum thread, Sheet row/project, grant agreement, milestone rows, payment rows, and final status.
   - Identify records that cannot be matched automatically due to name drift.

3. Define the public/private boundary.
   - Decide which status, documents, comments, KYC flags, payment events, and voting/decision details are public.
   - Decide who can see/edit each object.

4. Document current operational runbooks.
   - New application triage.
   - Eligibility/out-of-scope handling.
   - Community review start/end.
   - Committee vote/decision entry.
   - Revision loop.
   - KYC and grant agreement.
   - Milestone update request.
   - Payment approval and execution.
   - Cancellation/withdrawal.
   - Completion.
   - RFP idea to RFP to bounty.

5. Reconcile historical data.
   - Export GitHub issues and labels.
   - Export Discourse application threads.
   - Export all Sheet tabs.
   - Normalize categories, statuses, dates, applicants, amounts, milestones, and links.

6. Choose a rebuild strategy.
   - Low-risk phase 1: preserve public GitHub/forum transparency, but create an internal normalized database and importer/exporter around Sheets and issues.
   - Medium-risk phase 2: add an admin dashboard for FPF/ZCG triage, reviews, milestones, payments, reporting, and cross-linking.
   - Higher-risk phase 3: replace GitHub issue intake with a purpose-built applicant portal while continuing to publish public audit records to GitHub/forum or a public transparency site.

## Evidence links

- Live website: https://zcashcommunitygrants.org
- Live website repo: https://github.com/ZcashCommunityGrants/zcashcommunitygrants.github.io
- Grant process page: https://zcashcommunitygrants.org/selection/
- Issue-intake repo: https://github.com/ZcashCommunityGrants/zcashcommunitygrants
- GitHub issues: https://github.com/ZcashCommunityGrants/zcashcommunitygrants/issues
- Grant application issue template: https://github.com/ZcashCommunityGrants/zcashcommunitygrants/blob/main/.github/ISSUE_TEMPLATE/grant_application.yaml
- Google Sheet: https://docs.google.com/spreadsheets/d/1FQ28rDCyRW0TiNxrm3rgD8ai2KGUsXAjPieQmI1kKKg/edit
- Forum grants category: https://forum.zcashcommunity.com/c/grants/33
- Forum applications category: https://forum.zcashcommunity.com/c/grants/applications/36
- RFP idea form: https://form.jotform.com/252475280529058
