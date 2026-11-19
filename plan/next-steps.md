# Next implementation steps

## Where we stopped

Paused at the end of November 19, 2026, **after completing the shared processing refactor and focused naming cleanup**. The code is at a completed development milestone, not halfway through a refactor. The next milestone is Processed orders and the first draft sales report.

### Start here tomorrow

1. Inspect order/check field names from a small sample of existing experimental Raw orders. Verify the target first; do not dump customer/payment values or rerun ingestion just to inspect structure. This inspection has not happened yet.
2. Choose the smallest Processed order/check model needed for daily F&B net sales.
3. Build the mapper and writer using the shared processor, then register orders processing.
4. Build the draft report and compare one completed day with Toast before trusting its totals.

The user wants simple, incremental explanations and normally writes application code with guidance; assistant implementation and test updates are delegated explicitly. Keep the next step small. Follow the [Pragmatic Testing standards](../.github/copilot-instructions.md#pragmatic-testing), not an exhaustive test matrix.

Completed capabilities and verification boundaries are described in [architecture](../documentation/architecture.md), [data flow](../documentation/data-flow.md) and [setup and commands](../documentation/setup-and-commands.md#what-has-been-verified):

- Raw Toast ingestion at pipeline and source scope. Use `ingest -- toast` for the former Raw-only sync behavior.
- `sync -- toast-locations` composes ingestion and processing. The full source and order syncs reject before work until orders processing is registered. See the [command matrix](../documentation/setup-and-commands.md#commands-and-their-effects).
- Shared `process_pending_raw_records` in [processing.ts](../core/system/processing.ts) now owns Raw selection/locking, one batch transaction, exact revision acknowledgment and history counts. Each pipeline supplies a writer using that same transaction; locations is the working example.
- [pipeline-operation.ts](../core/system/pipeline-operation.ts) tracks one operation, not a whole sync. [pipeline-workflow.ts](../core/system/pipeline-workflow.ts) orders operations and pipelines; the future scheduler only decides when source sync runs.
- Reviewed location-type mapping applied even with zero pending Raw. The user reported successful experimental processing, no duplicate locations on repeat, and successful type application/repeat checks.
- Additive `0002` migration renaming the Processed column to `type`; source code and offline fixtures use `Location_Type`. Live migration history was not independently inspected.
- Shared `mark_raw_records_deleted` helper and offline tests. It marks confirmed existing Raw identities deleted and pending; **no source pipeline calls it automatically**.
- Ordinary Raw loading applies optional deletion metadata: explicit `true` deletes, explicit `false` restores, omission preserves an existing flag. Payload or effective status changes queue processing; repeat input does not.
- Toast order and location schemas require boolean `deleted` and forward it as Raw input metadata while preserving source content. Missing/null/string flags fail explicitly.
- Latest type-check and **70 affected offline tests** passed after the naming cleanup. Earlier Raw deletion tests passed separately; see [verification evidence](../documentation/setup-and-commands.md#what-has-been-verified). No latest full-suite or live deletion result is claimed.

Current module names are `ingestion.ts`, `processing.ts` and `pipeline-operation.ts`; imports and documentation links were updated. Existing test/sandbox filenames and public commands were deliberately retained. Naming defaults are in [the coding standards](../.github/copilot-instructions.md#name-by-meaning-and-role): responsibility-based module names, action-based functions/scripts, and optional boolean prefixes. Avoid another naming/refactoring pass before building orders.

There are no Processed orders, complete-inventory deletion detection, Refined reports or scheduled worker. No live source deletion/restoration has been verified. The foundation is ready to build on, not certified for unattended operational use; a second real source still needs to prove broader reuse. Today's processing/CLI/naming changes required no migration. Do not rerun migrations, ingestion or a backfill merely to resume.

## 1. Use Toast's returned deletion flags

The user shared a reply from Toast Developer Support's AI agent: order deletion changes `modifiedDate`, making the order eligible for that window with `deleted = true`; retention and exceptions weren't specified. Use the existing feed for normal ingestion. Do not add a full-ID scan, a webhook or a no-op `reconcile` handler. See [the documented contract](../documentation/architecture.md#toast-deletion-contract-and-access-limits).

Before relying on deletion handling in reports, check existing experimental Raw flags against the saved source flags and verify that Processed locations reflect current Raw revisions. Older rows may predate the flag wiring. No deleted examples means the check is inconclusive; don't delete live source data to make a test case.

## 2. Preserve deletion and historical-data correctness

- Retain the completed [Raw loader](../core/system/raw-pipeline-loader.ts) and Toast adapter wiring. `Raw_Record_Input.deleted?` is input metadata, not a new database column.
- Use `mark_raw_records_deleted` only when a source supplies confirmed deleted IDs without full payloads. It accepts at most 100 IDs per transaction and neither discovers deletions nor advances ingestion progress.
- The location mapper uses `raw.deleted OR content.deleted`. Real-workflow delete/restore verification remains outstanding; both flags must say active to restore Processed.
- Do not mark historical orders deleted simply because a location closes or our integration loses access. Future reporting must distinguish inactive locations, access/coverage loss and actual transaction deletion.
- Later Processed order/check/selection writers must preserve the relevant deletion and child-disappearance semantics. A removed child is not automatically a deleted parent; voids and refunds are different business states.
- Verify downstream behavior before trusting reports. No analytics views currently enforce deletion or historical-location policies.

### Sources that omit deleted records

Only infer deletion from a complete, authoritative current list for the same source scope. Never use an incremental response or a date-filtered orders list as that proof.

Start with the first concrete source that needs this. Share only the comparison/write behavior that is actually reusable. Require successful scan completion, correct scope, bounded identity storage and safeguards for empty/truncated inventories or changed permissions. Do not buffer an unbounded inventory or add a generic framework in anticipation of all sources. The Raw `execution_id` is not a last-seen marker because unchanged upserts do not refresh it.

**Gate before financial reporting:** source delivery guarantees and any coverage limits are established for the selected scope, processing propagates state, historical-location handling is correct, and failures remain recoverable. Do not promise every Processed row is current while processing is failing.

## 3. Process orders and reconcile one completed day

The deletion-loading foundation is now in place. The next implementation milestone is Processed orders; begin with a small order/check field review and explain each step before asking the user to build it. Inspect the minimum necessary structure without sharing customer/payment details. Any live source access or warehouse work remains separately deliberate and target-verified.

- Candidate pilot: November 17, 2026 at 7 Devils; a user-supplied aggregate query showed 28 Raw orders. Verify coverage before treating that count as complete. No order/check payload inspection or financial reconciliation has happened.
- Resolve location lineage without silently dropping orders with unknown locations.
- Design useful Processed order/check records from actual source contracts, not a copy of every Raw field. Use exact decimal handling for money and the existing transactional processing pattern.
- Follow `process_toast_locations` and `write_processed_locations` in [toast-locations.ts](../core/toast/toast-locations.ts). Supply the orders Raw table and a writer to [process_pending_raw_records](../core/system/processing.ts). The writer maps and writes through the supplied transaction; it must not open another transaction, acknowledge Raw, or increment history itself. One Raw record may produce multiple output records, but `records_processed` counts acknowledged Raw records.
- Register the orders processing handler in the [pipeline registry](../core/system/pipeline-registry.ts). Verify that `process -- toast-orders`, `process -- toast`, `sync -- toast-orders` and `sync -- toast` then run in dependency order. A deleted order must remain traceable but stop contributing to sales after its new revision is processed.
- Build the draft daily net sales report, then compare one completed day/location against Toast Sales Summary, including discounts, refunds, voids, split checks, tax and service-charge treatment. The comparison gates trust and publication, not starting the draft.
- A future-business-date catering record was observed. It may be scheduled; inspect its semantics rather than discard it or diagnose it from the date alone.
- Add processing-version replay and invalid-record recovery where needed; changing a version constant alone does not select already-processed Raw.

Once one day reconciles, validate and expand the [first usable chart](project-plan.md#first-usable-chart-daily-food--beverage-net-sales) to the latest 30 completed business days, with an F&B location filter and a visible `Data through` date. Distinguish missing coverage from verified zero sales. Weekly year-over-year remains later.

## 4. Deferred ingestion and operational work

- Add processing freshness only with a clear meaning; `last_successful_processing_at` is not currently advanced.
- Verify connected checkpoint/fresh-process restart behavior with the isolated [synthetic restart check](../sandbox/check-ingestion-restart.ts), without advancing real Toast progress. Full historical coverage and older-range replay for newly visible locations remain separate work.
- Retain Toast pacing. Measure before optimizing and verify historical spacing requirements before adding concurrency.
- Add `node-cron` and a supervised Render worker after full manual sync is verified. Call the shared source-sync dispatcher directly, with deliberate target checks, non-overlapping ticks per source and bounded concurrency across independent sources. Do not run separate terminal writers alongside the worker.
- Prove broader reuse with a second real source before generalizing. Preserve existing identities, progress and applied migrations.
