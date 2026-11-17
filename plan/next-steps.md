# Next implementation steps

## Where we stopped

As of November 17, 2026, the two Raw Toast pipelines and manual Toast sync are implemented. The user inspected 18 Raw location records and confirmed `processed.locations` exists in the experimental warehouse. The [schema](../core/toast/toast-schema.ts) and [location mapper](../core/toast/toast-locations.ts) are ready; **nothing writes the mapped rows to Processed yet**. See [setup and commands](../documentation/setup-and-commands.md#what-has-been-verified) for the evidence and its limits.

## 1. Build the Processed locations writer

Start in [toast-locations.ts](../core/toast/toast-locations.ts). Add `process_toast_locations` using the existing pipeline orchestrator with pipeline name `toast_locations` and operation `processing`. Do not add a generic processing framework yet.

1. In a bounded transaction, select pending Raw locations (`record_source = 'toast_locations'`, `processed = false`) in stable ID order and lock those rows.
2. Map and upsert on `(source_system, source_record_id)`. Update the name, deletion flag and processing metadata on conflict. Preserve the existing Processed ID, creation time, and `business_type`; new rows can default to `unclassified`.
3. In the same transaction, acknowledge the exact Raw IDs and revisions written and increment the execution's `records_processed`. If mapping, upsert or acknowledgment fails, roll back the batch; report a safe error without dumping the payload. Earlier committed batches remain durable.
4. Add a standalone **planned** `npm run process -- toast-locations` command to the [pipeline CLI](../core/system/pipeline-cli.ts), with its existing target guard and shutdown behavior. Do not wire it into Toast sync until the standalone run is verified.

### Acceptance checks

- Valid Raw locations become queryable by name in `processed.locations`; deleted locations remain available for historical joins.
- A second run without Raw changes processes zero rows and creates no duplicates.
- A renamed location keeps its stable Processed ID and reviewed `business_type`.
- Failed output or acknowledgment leaves the batch pending; an older revision cannot mark a newer revision as processed.
- The command neither calls Toast nor changes the ingestion watermark. Test offline first, then verify on the approved experimental target. No new migration or orders backfill is required for this step if the expected table already exists.

## 2. Add reviewed location classifications

Confirm each outlet's classification with the business or Finance. Maintain a small mapping keyed by Toast location GUID, not name; keep it separate from Raw and provide a deliberate way to apply classification changes without needing a new source revision. Keep `unclassified` locations visible. Use one locations catalog for food and beverage and retail; use item-level sales categories later when the question is what was sold rather than which outlet sold it.

## 3. Process orders and reconcile one day

Join a known day's orders to the catalog without dropping orders with unknown locations. Then build version-aware Processed orders and reconcile sales, refunds, voids, split checks, tax and service-charge treatment, and business dates against a trusted Toast report before relying on financial totals. Mapping-version replay and invalid-record recovery still need a deliberate policy.

## 4. Deferred ingestion and operational work

- Verify connected checkpoint and fresh-process restart behavior with the isolated [synthetic restart check](../sandbox/check-ingestion-restart.ts), without advancing real Toast progress. Connected ingestion samples are not proof of full historical coverage. New locations may need a deliberate older-range replay.
- Keep current Toast pacing. If ongoing sync remains slow after catch-up, measure limiter, request/retry and database-write time before optimizing. Confirm Toast's historical spacing rules before introducing cross-location concurrency.
- Add `node-cron` and a supervised Render worker after standalone behavior is verified. Reuse the source workflow, prevent overlapping writers, and validate shutdown, recovery, and freshness. Do not run independent processes against the same pipeline under the current process-local guard.
- Prove reuse with a second source before generalizing the framework. See the [project plan](project-plan.md) for broader acceptance gates.
