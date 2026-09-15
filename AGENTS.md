# ZCG Agent Guide

## Start with the relevant context

- Run `git status --short --branch` and preserve unrelated local changes and
  untracked artifacts. Stage only files belonging to the requested change.
- Read the relevant part of `README.md`, then inspect affected code and callers.
  Use `rg` and targeted reads; generated `output/`, `tmp/`, `.next/`, and
  `cdk.out/` directories are not current application source.
- For deployment work, inspect `amplify.yml`, the relevant runbook in
  `docs/deployment/`, and live AWS state before deciding on an action.
- Use the established `zodldashboard` AWS profile and `us-east-1` region unless
  the user specifies a different target. Never print or commit secret values.

## Application boundaries

- Preserve sync-first operation: source mirroring is read-only at the upstream
  GitHub, Google Sheets, and Forum boundaries. Keep source evidence and provenance
  intact; a display fix must not discard stored evidence.
- Preserve server-side authorization and the distinction between public
  prototype reads, private analyses, and authenticated operational actions.
- Amplify SSR uses the RDS Data API to access private Aurora. Select only fields
  needed by each page; large raw source payloads do not belong in summary queries.
- Do not send production email or run migrations, reconciliation, or other
  data-changing workers as part of routine validation. Use local fixtures or
  read-only checks unless those operations are authorized for the task.

## Independent review before merge or deployment

Every change, including documentation-only changes, requires review by a separate
agent before recommending, enabling, or performing a merge or deployment. This
includes direct pushes to auto-deploying branches, preview deployments, manual
Amplify releases/redeployments, and CDK deployments. Complete the review before
the action that triggers deployment; a review after pushing to `main` is too late.

This is a required agent workflow alongside validation. It does not configure
GitHub branch protection, required checks, or an AWS deployment lock, and it does
not independently authorize commits, pushes, merges, or production operations.
Follow the user's authorized scope without requesting approval again when it has
already been given.

1. **Prepare an immutable review.** Complete implementation and scope-appropriate
   checks. Record the repository, target branch, immutable base and head commit
   SHAs, and PR URL when there is a PR. Check whether pushing a feature branch or
   opening a PR would trigger a preview deployment before doing so. Delegate to
   an agent that did not author the change, with fresh context and no inherited
   implementation conversation (`fork_turns: "none"`). Supply the user's
   requirements and accepted clarifications, this guide, revisions to compare,
   validation results, failures, skipped checks, and intended deployment scope.
   For infrastructure/configuration changes, also supply the exact proposed
   diff, target, context/parameters, and relevant read-only preflight evidence.
2. **Review independently.** The reviewer inspects pinned revisions, relevant
   callers, contracts, and tests for correctness, regressions, security/privacy,
   architecture, deployment implications, and missing coverage. Scale depth to
   the change and distinguish defects from optional improvements. The reviewer
   must not edit source, switch the shared worktree, commit, push, merge, deploy,
   mutate production data/configuration, or send email. Use read-only inspection
   or an isolated checkout for checks that could interfere with the author.
3. **Return evidence and an outcome.** Record reviewer identity, reviewed base/head
   SHAs, scope, checks performed, and limitations. Each finding must include
   severity, file/line references, impact, supporting evidence, and whether it
   blocks release or is advisory. Give an explicit outcome: **ready**, **changes
   required**, or **incomplete**. Confirmed consequential correctness, regression,
   security/privacy, or deployment defects block release. A timeout, unavailable
   reviewer, partial review, or silence is incomplete, never approval.
4. **Resolve findings.** The author validates findings, fixes confirmed defects,
   and reruns affected checks. Return fixes and reasoned responses to the reviewer
   for verification; do not dismiss blocking findings unilaterally. Bring
   unresolved disagreements or proposed acceptance of a blocking risk to the
   user. Record advisory items and their disposition without automatically
   expanding scope.
5. **Verify the final release.** Any change to the head, target base, or proposed
   deployment configuration requires reviewer verification of the updated
   revisions and affected interactions. Immediately before a merge, direct push,
   or deployment, verify the live refs match the reviewed base/head, required
   checks pass, no blocking findings remain, and the deployment inputs match
   the reviewed proposal. Use an exact-head merge guard when available; do not
   bypass review with auto-merge or a direct push. After a merge creates a new
   commit, verify its parents and resulting tree correspond to the reviewed
   revisions; substantive changes require renewed review before deployment.
6. **Record and verify the outcome.** Keep review evidence in the task and include
   it on the PR when authorized. If review cannot finish, complete other
   authorized work and report the release blocker without claiming readiness.
   After release, verify the deployed revision and affected live behavior, and
   report the review outcome, validation results, and material limitations.

## Validation and release

- During iteration, run focused checks for affected behavior. Add regression
  coverage when it exercises the failure; avoid tests that only restate code.
- For application code releases, run `npm test` and `npm run check` (typecheck,
  lint, production build). Report skipped database integration tests explicitly;
  use `npm run test:postgres` only against the intended isolated test database.
- For documentation-only changes, verify referenced commands and links and run
  `git diff --check`. They still require independent review.
- For infrastructure changes, also run relevant tests, CDK synth, and a diff
  against the intended live target. Have the reviewer assess the exact proposed
  deployment, including database, IAM, cost, and outage implications.
- For browser-visible fixes, verify the affected page or flow after deployment.
  A successful build alone does not prove the live issue is resolved.
- Check current Amplify branch/build settings. `main` is the established live
  branch, but confirm the current target and auto-deploy behavior before pushing
  or merging. Do not deploy unreviewed local modifications.
