# Next implementation steps

Read [current status](../documentation/README.md) first. This file is the short continuation guide; the [project plan](project-plan.md) retains the broader requirements.

## 1. Prove the bounded Toast-to-Raw path

**Starting point:** [get_toast_order_page](../core/toast/toast-orders.ts) reads one page; [load_raw_records](../core/system/raw-pipeline-loader.ts) exists and type-checks. No sandbox connects them and no Raw write/replay has been verified.

**Outcome:** one explicitly authorized, manually run experimental page load with repeatable assertions. Do not add full pagination, processing, scheduling or watermark advancement in this step.

Before writing:

- Verify the actual isolated experimental database/credential target and the necessary applied migrations. A label alone is insufficient.
- Confirm the approved source-data scope and access controls. Do not broaden a pilot-page approval into backfill or operational ingestion.
- Establish an unambiguous stable key containing restaurant context and order GUID. Proposed representation: `JSON.stringify([restaurant_guid, order_record.guid])`. Confirm it before implementation; do not add a mandatory scope column or modify the source payload.

Add a narrowly scoped manual Raw check in [sandbox](../sandbox/):

1. Fetch the already selected pilot page once, outside a database transaction, with at most ten orders.
2. Convert records to loader inputs with complete source keys and unchanged source content.
3. Use the stable pipeline name from [toast-schema.ts](../core/toast/toast-schema.ts) and start history through the existing orchestrator.
4. Load the page, capture affected Raw records/counts, then replay the **same in-memory inputs**.
5. Close the warehouse pool in `finally`. Log safe counts/assertion outcomes only.

### Acceptance checks

- A new identity creates one row at revision 1 and remains pending processing.
- Replaying identical inputs adds zero changes and preserves Raw ID, creation/update times, execution ID, revision and processing state.
- The first load is not assumed to insert ten rows: existing pilot records may already match or differ. Assert history increments against actual committed insert/change counts.
- A controlled synthetic payload change preserves identity, increments revision exactly once and resets `processed`; repeating that changed payload does not increment it again.
- Duplicate/blank identities, excessive batches, and missing/finished/wrong-pipeline executions fail explicitly without committed data/count changes.
- An actual mid-transaction database failure rolls back both Raw changes and the history increment. Use a controlled experimental integration case, not just pre-transaction invalid-input rejection as a proxy.
- Pipeline watermark and successful-stage timestamps remain unchanged throughout this page-only test.

Use synthetic records in the isolated experimental warehouse for mutation/rollback cases; never alter live Toast records or source systems. Avoid leaking payloads through assertion diagnostics. Document the resulting evidence and remaining gaps in [documentation](../documentation/README.md) when this gate passes.

## 2. Make complete ingestion recoverable

After the Raw batch gate, implement these in small verified steps:

1. Decide source identity/version semantics, supported historical coverage, and fixed modification-time windows. Keep business-date samples separate from incremental watermarks.
2. Add bounded pagination: parse `Link`, validate permitted HTTPS origin/path, detect repeated pages/cursors, and bound pages, response bytes, batch size and total work.
3. Reuse a token within bounded work, handle expiry explicitly, and add bounded retries/backoff with `Retry-After`, timeouts and cancellation. Bound authentication response bytes too.
4. Prevent full-execution overlap through a reviewed database-backed locking approach. Verify direct Neon connection support before choosing session advisory locks; batch row locks and process-local cron settings are insufficient.
5. Test lock loss and stop/reject subsequent work before permitting multiple workers. Prevent older backfill/source revisions from overwriting newer Raw content.
6. Commit resumable batch progress atomically where implemented, and advance the completed-window watermark only after all required restaurant pages are durable. Start from one progress row per pipeline; introduce finer-grained state only for concrete recovery/concurrency needs.
7. Add late-change lookback/correction handling and separate bounded backfill progress before allowing backfill alongside live sync.

**Gate:** replay, interruptions, later-page failures, source/database outages and lock loss do not skip records or claim uncompleted coverage. Committed counts remain accurate.

## 3. Build useful Processed records

Before choosing business columns, inspect authorized source evidence and agree on order/check reconstruction, business date/timezone, exact monetary values, discounts, refunds, voids, taxes and service charges.

- Define the first concrete Processed table using [create_processed_columns](../core/system/system-schema.ts); add needed business identity constraints and foreign-key lookup indexes.
- Implement bounded pending-record selection and a specific mapper, not an abstract processing platform.
- Commit Processed output and acknowledgment of the exact Raw revision together.
- Prove that a newer Raw revision remains pending if it arrives during processing.
- Add mapping-version replay and recoverable record-level error handling.

**Gate:** a completed day's records reconcile to a trusted Toast report, including explicit refund/void/split-check cases. Do not equate payment totals with net sales or silently treat missing amounts as zero.

## 4. Continue the broader plan

Build business-oriented Refined models and report freshness, verify historical/second-source coverage, then scheduling and operational readiness with restart/catch-up/shutdown checks. A second real source and a file/database case must demonstrate reuse before generalizing the framework.

Resolve deployment, cadence, retention, publication behavior, alerting and measurable volume/memory/freshness targets before their relevant implementation gates. See [delivery sequence](project-plan.md#10-delivery-sequence-and-acceptance-gates).

Do not enable operational schedules, run broad backfills or apply operational migrations without specific user approval and recovery preparation.
