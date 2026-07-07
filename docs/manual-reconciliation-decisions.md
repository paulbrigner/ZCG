# Manual Reconciliation Decisions

Manual reconciliation decisions are durable reviewer inputs. They are not raw
edits to generated source links or generated reconciliation issues.

## Operating Model

1. Mirror public source systems into `source_records`.
2. Run automatic grant reconciliation.
3. Review generated `reconciliation_issues`.
4. Create active `reconciliation_decisions` for reviewer judgments.
5. Reapply active decisions after every reconciliation run.
6. Rebuild derived links and relationships from source records plus active
   decisions.

`reconciliation_issues` is the work queue. `reconciliation_decisions` is the
durable manual source of truth.

## Decision Types

- `link_source`: attach a stable source record to a canonical application.
- `unlink_source`: remove an incorrect source link.
- `relate_applications`: record application lineage, such as a later attempt.
- `merge_applications`: record that two application records represent the same
  grant lineage.
- `override_field`: reserve durable reviewer field overrides.
- `dismiss_issue`: document why a generated issue does not require data changes.

## Replay And Portability

To recreate a reconciled prototype database in another AWS account:

1. Run migrations.
2. Mirror current source systems.
3. Import manual decisions:

   ```bash
   npm --silent run reconciliation:import -- ./reconciliation-decisions.json
   ```

4. Run grant reconciliation.
5. Rebuild the knowledge index.

Export decisions from an existing environment:

```bash
npm --silent run reconciliation:export > reconciliation-decisions.json
```

The export uses stable `decision_key` values and source/canonical keys rather
than environment-specific UUIDs wherever possible.
