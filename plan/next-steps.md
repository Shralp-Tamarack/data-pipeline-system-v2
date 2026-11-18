# Next implementation steps

## Where we stopped

Paused on November 18, 2026, **before editing the normal Raw loader to handle deletion metadata**. The user is building the source code with step-by-step guidance; the assistant handles delegated test updates. Do not treat the last proposed loader changes as implemented.

Completed capabilities and verification boundaries are described in [architecture](../documentation/architecture.md), [data flow](../documentation/data-flow.md) and [setup and commands](../documentation/setup-and-commands.md#what-has-been-verified):

- Raw Toast ingestion and manual Raw-only sync.
- Reusable processing executer, standalone `process -- toast-locations`, revision-safe bounded location writes, and optional finalization inside the tracked execution.
- Reviewed location-type mapping applied even with zero pending Raw. The user reported successful experimental processing, no duplicate locations on repeat, and successful type application/repeat checks.
- Additive `0002` migration renaming the Processed column to `type`; source code and offline fixtures use `Location_Type`. Live migration history was not independently inspected.
- Shared `mark_raw_records_deleted` helper and offline tests. It marks confirmed existing Raw identities deleted and pending; **no source pipeline calls it automatically**.
- Optional `deleted? : boolean` on `Raw_Record_Input`. **`load_raw_records` currently ignores that field.**

There are no Processed orders, complete-inventory deletion detection, normal-ingestion restoration, Refined reports or scheduled worker. Do not rerun migrations, source ingestion or a backfill merely to resume this step.

## 1. Finish deletion-aware Raw loading

Continue in [raw-pipeline-loader.ts](../core/system/raw-pipeline-loader.ts), using the existing [input type](../core/system/ingestion-types.ts). Keep the implementation small and reusable, not a configurable reconciliation platform.

### Required behavior

| Incoming deletion metadata | New Raw row | Existing Raw row |
| --- | --- | --- |
| `true` | Insert deleted and pending | Mark deleted if status changed |
| `false` | Insert active and pending | Restore if previously deleted |
| Omitted | Default active | Preserve existing deletion status |

1. Include the supplied deletion status on insert.
2. On conflict, distinguish explicit `false` from omission for each record, including mixed batches.
3. Update when payload **or effective deletion status** changes. Preserve the existing context-conflict guard.
4. A real change increments revision, clears `processed`, updates execution/time metadata, and contributes once to history. Identical replay changes nothing.
5. Keep Raw writes and history counts in the existing transaction. Preserve identity, payload provenance and the existing confirmed-deletion helper.

The last proposed implementation used the IDs with explicitly supplied status to build a parameterized SQL `CASE`: use `excluded.deleted` only for those IDs, otherwise preserve the stored flag. Confirm the current code before coaching the edit; do not assume it has been pasted. No schema migration is required.

### Acceptance checks

The assistant should add focused offline loader tests for active-to-deleted and deleted-to-active transitions with unchanged content, omitted status preserving a deleted row even when content changes, mixed-status batches, new deleted rows, no-op replay, context-conflict rollback and history failure rollback. Run type-check and affected tests; make no live requests during this stage.

## 2. Connect source deletion detection and Processed propagation

The common outcome is simple: confirmed source deletion marks Raw deleted and pending; successful processing carries the flag to Processed; analytics excludes deleted data. Restoration follows the same revision-safe processing path and preserves identities.

- Translate verified source deletion flags into the shared input metadata at the adapter boundary. Validate the external values there; do not put Toast-specific payload inspection in the shared loader.
- Use `mark_raw_records_deleted` for confirmed deleted IDs whose full payload is not available. It accepts at most 100 IDs per transaction; larger sets require bounded batches. It does not discover deletions or advance the ingestion watermark.
- Verify Toast's actual order-deletion contract before claiming the modification-time feed catches every deletion. The API exposes deletion fields, but field existence alone is not evidence of delivery/retention guarantees.
- The location mapper currently uses `raw.deleted OR content.deleted`. Verify delete/restore behavior with consistent source flags; Raw restoration cannot override a payload that still says deleted.
- Later Processed order/check/selection writers must handle relevant deletion and child-disappearance semantics. A removed child is not automatically a deleted parent; voids and refunds are different business states.
- Verify deletion reaches Processed through the real workflow, then verify report queries exclude it. There are no current analytics views enforcing this.

### Sources that omit deleted records

Only infer deletion from a complete, authoritative current list for the same source scope. Never use an incremental response or a date-filtered orders list as that proof.

Start with the first concrete source that needs this. Share only the comparison/write behavior that is actually reusable. Require successful scan completion, correct scope, bounded identity storage and safeguards for empty/truncated inventories or changed permissions. Do not buffer an unbounded inventory or add a generic framework in anticipation of all sources. The Raw `execution_id` is not a last-seen marker because unchanged upserts do not refresh it.

**Gate before financial reporting:** deletion and restoration are covered for the selected source scope, processing propagates the state, failures remain recoverable, and gaps in source detection are explicit. Do not promise every Processed row is current while processing is failing.

## 3. Process orders and reconcile one completed day

Resume order/check field inspection only after the deletion-loading foundation is in place. Inspect the minimum necessary structure without sharing customer/payment details.

- Candidate pilot: November 17, 2026 at 7 Devils; a user-supplied aggregate query showed 28 Raw orders. Verify coverage before treating that count as complete. No order/check payload inspection or financial reconciliation has happened.
- Resolve location lineage without silently dropping orders with unknown locations.
- Design useful Processed order/check records from actual source contracts, not a copy of every Raw field. Use exact decimal handling for money and the existing transactional processing pattern.
- Reconcile against Toast Sales Summary for the same completed business day/location, including discounts, refunds, voids, split checks, tax and service-charge treatment.
- A future-business-date catering record was observed. It may be scheduled; inspect its semantics rather than discard it or diagnose it from the date alone.
- Add processing-version replay and invalid-record recovery where needed; changing a version constant alone does not select already-processed Raw.

Once one day reconciles, build the [first usable chart](project-plan.md#first-usable-chart-daily-food--beverage-net-sales): daily net sales at reviewed F&B locations over the latest 30 completed business days, a location filter and visible `Data through` date. Distinguish missing coverage from verified zero sales. Weekly year-over-year remains later.

## 4. Deferred ingestion and operational work

- Wire processing into combined sync only as an explicit, tested behavior change. `sync -- toast` currently remains Raw-only.
- Add processing freshness only with a clear meaning; `last_successful_processing_at` is not currently advanced.
- Verify connected checkpoint/fresh-process restart behavior with the isolated [synthetic restart check](../sandbox/check-ingestion-restart.ts), without advancing real Toast progress. Full historical coverage and older-range replay for newly visible locations remain separate work.
- Retain Toast pacing. Measure before optimizing and verify historical spacing requirements before adding concurrency.
- Add `node-cron` and a supervised Render worker after standalone behavior is verified. Do not allow overlapping independent writers under the process-local guard.
- Prove broader reuse with a second real source before generalizing. Preserve existing identities, progress and applied migrations.
