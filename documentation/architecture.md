# Implemented architecture

Read [data flow](data-flow.md) for transaction/recovery boundaries, [setup and commands](setup-and-commands.md) for operation and evidence, and the [project plan](../plan/project-plan.md) for future work.

## Organization and ownership

Shared execution and persistence live in `core/system/`; source knowledge is colocated in `core/toast/`. The current implementation uses plain functions and small types, not a plugin framework, inheritance hierarchy or separate historical-ingestion subsystem.

| Module | Responsibility |
| --- | --- |
| [system-configuration.ts](../core/system/system-configuration.ts) | Loads and validates shared environment settings |
| [pgsql-warehouse.ts](../core/system/pgsql-warehouse.ts) | Constructs the PostgreSQL pool and Drizzle connection |
| [system-schema.ts](../core/system/system-schema.ts) | Defines system metadata and reusable Raw/Processed schema builders |
| [pipeline-progress.ts](../core/system/pipeline-progress.ts) | Registers progress and persists completed-window checkpoints |
| [pipeline-history.ts](../core/system/pipeline-history.ts) | Records execution starts and terminal outcomes |
| [pipeline-orchestrator.ts](../core/system/pipeline-orchestrator.ts) | Owns durable execution outcomes, per-run log context and the process-local per-pipeline busy guard |
| [pipeline-cli.ts](../core/system/pipeline-cli.ts), [pipeline-registry.ts](../core/system/pipeline-registry.ts) | Separate ingestion/processing registries, manual `ingest`, `process` and `sync` routing, cancellation and pool cleanup |
| [system-logger.ts](../core/system/system-logger.ts) | Pino JSON stdout with optional compact `pino-pretty` output |
| [ingestion-types.ts](../core/system/ingestion-types.ts) | Shared Raw record input and source ingestion configuration types |
| [ingestion-windows.ts](../core/system/ingestion-windows.ts) | Generates consecutive source-time windows |
| [ingestion-executer.ts](../core/system/ingestion-executer.ts) | Sequentially extracts/loads windows and checkpoints configured ingestion |
| [processing-executer.ts](../core/system/processing-executer.ts) | Drains pending batches under one execution; invokes optional finalization before success, including with no pending rows |
| [raw-pipeline-loader.ts](../core/system/raw-pipeline-loader.ts) | Bounded Raw upserts and a separate confirmed-deletion helper, each transactional with history counts |
| [toast-configuration.ts](../core/toast/toast-configuration.ts) | Toast start date, orders window size and page size |
| [toast-schema.ts](../core/toast/toast-schema.ts) | Raw orders and locations, and `processed.locations` |
| [toast-sync.ts](../core/toast/toast-sync.ts) | Runs Raw locations before Raw orders; no processing or scheduling yet |
| [toast-orders.ts](../core/toast/toast-orders.ts) | Business-date pilot reader, modification-time extractor and configured orders ingestion |
| [toast-locations.ts](../core/toast/toast-locations.ts) | Discovery, Raw snapshots, revision-safe Processed writes and application of location types |
| [toast-location-type-map.ts](../core/toast/toast-location-type-map.ts) | Reviewed GUID-to-type mapping, independent of source payloads and Raw revisions |
| [toast-order-pagination.ts](../core/toast/toast-order-pagination.ts) | Validates the next-page link and unchanged extraction filters |
| [toast-authentication.ts](../core/toast/toast-authentication.ts), [toast-request.ts](../core/toast/toast-request.ts), [toast-response.ts](../core/toast/toast-response.ts) | Token reuse/refresh, bounded retries, pacing and bounded JSON reads |
| [tests](../tests/) | Automated offline tests using synthetic persistence and source responses |
| [sandbox](../sandbox/) | Manually invoked connected checks and experiments; excluded from `npm test` |
| [system-scheduler.ts](../core/system/system-scheduler.ts) | Empty placeholder; no scheduling behavior |

Reports and analytics will be organized around users' business questions and decisions, not these technical folders or source names.

## Configuration and database boundary

[Shared environment configuration](../core/system/system-configuration.ts) exports one typed `env_vars` object after required-value and environment-name checks. It currently holds warehouse and Toast connection/authentication settings. Source ingestion settings are separate: `Source_System_Configuration` requires `data_start_date` and `window_size_in_days`, with optional `request_page_size`; Toast exports its own `toast_configuration`.

Toast's date is `2026-06-01T00:00:00.000Z`, selected by the user, not independently verified as the first available record date. It is used only when the orders pipeline has no watermark. Changing this setting does not reset existing progress. `log_format` is separate from target selection and defaults to `json`.

The `pg.Pool` allows five connections with a 10-second connection timeout and a 30-second statement timeout. Constructing clients/importing modules does not execute queries, run pipelines or apply migrations. The configured Neon endpoint was previously classified as pooled without connecting; application pooling and Neon endpoint pooling are different boundaries.

The environment name must be `experimental` or `operational`. This is not proof of actual target identity, credential isolation or mutation authorization. These checks remain deliberate operational responsibilities.

## One ingestion flow

Configured `execute_ingestion`:

1. Captures an end time once at run start.
2. Enters the orchestrator's per-pipeline guard.
3. Reads from the saved watermark minus the configured lookback (one elapsed day by default), or uses the source's `data_start_date` when there is no watermark.
4. Generates consecutive windows and consumes source-provided bounded batches sequentially.
5. Commits each Raw batch before requesting more records.
6. Saves progress only after the entire window extractor completes and the window ends after the existing watermark. Replay-only windows do not move it.

The shared default window is seven elapsed days. Toast orders directly supplies `ingestion_window_days = 28`, so the defaults do not stack. Fractional days are supported within the millisecond bounds. The last window can be shorter. The Raw locations snapshot does not use or advance a time watermark.

Initial history and subsequent updates use the same code and one watermark. Explicit `start_at`/`end_at` calls remain available for controlled checks/replay and never advance normal progress. They are not a separate backfill implementation. Configured ingestion and explicit ranges cannot be combined in the typed settings contract.

## System schema: progress versus history

### `system.pipeline_progress`

[Pipeline_Progress](../core/system/system-schema.ts) has an internal UUID, unique `pipeline_name`, nullable ingestion watermark, independent successful-ingestion/processing timestamps, and creation/update timestamps. There is one row per pipeline, not per restaurant or work kind.

`get_or_create_pipeline_progress` never resets existing state. `record_ingestion_window_completion` verifies a running execution for the pipeline, locks its history/progress rows and compares the expected prior watermark. In one transaction it advances the watermark, updates successful-ingestion/update timestamps, and stores the same watermark in execution history.

The watermark is a completed source-time boundary, not job finish time or report freshness. `last_successful_ingestion_at` records a successfully checkpointed window; an overall run may subsequently fail. No current helper advances processing freshness. Timestamp defaults are not automatic update triggers.

### `system.pipeline_history`

[Pipeline_Execution_History](../core/system/system-schema.ts) stores UUID execution IDs, progress foreign keys (`ON DELETE RESTRICT`), operation/status, watermarks before/after, safe error summary, committed counts and start/finish timestamps. It has an index on progress ID/start time.

Start captures existing progress. Completion requires a running attempt and preserves omitted optional counts/watermark fields. A failed run can retain both committed counts and its last completed-window watermark.

The enum includes `running`, `succeeded`, `partial`, `failed`, `cancelled` and `abandoned`; not every state has an implemented lifecycle. Current thrown cancellation is recorded as `failed`. Abandoned-run recovery is not implemented. Counts are PostgreSQL integers, narrower than JavaScript safe integers. Duration is derived from timestamps.

## Raw storage

[create_raw_table](../core/system/system-schema.ts) returns fresh Drizzle column builders. The [Toast schema](../core/toast/toast-schema.ts) defines `raw.toast_orders` and `raw.toast_locations`.

| Group | Columns |
| --- | --- |
| Internal identity/provenance | `id`, `execution_id` |
| Source identity/payload | `source_record_id`, nullable `source_context`, `content`, `record_source` |
| State/metadata | `deleted`, `content_revision`, `processed`, `created_at`, `updated_at` |

JSONB preserves the selected source record's content, not response bytes or every past revision. Source context is kept immediately before content in the fresh baseline. Toast stores `{restaurant_guid}` separately without modifying order payloads.

Identity is `record_source` + `source_record_id`. Toast uses the exact order or location GUID. Toast's [order guide](https://doc.toasttab.com/doc/devguide/apiOrdersOrderObjectSummary.html) describes unique Toast-generated order GUIDs and its [identifier guide](https://doc.toasttab.com/doc/devguide/portalToastIdentifiers.html) describes globally unique GUIDs; the reviewed text did not explicitly state cross-restaurant order uniqueness. Context is provenance, not identity.

Each table has source-identity, pending-processing and execution-ID indexes; history foreign keys use `ON DELETE RESTRICT`. The loader verifies the execution's pipeline, rejects blank/duplicate identities and batches above 100 records, and:

- Inserts new rows with revision 1.
- Updates changed payloads while preserving internal/source identity and creation time.
- Increments revision, clears `processed`, and changes execution/update metadata only for changed payloads in the ordinary upsert path.
- Leaves unchanged payloads untouched and counts them as zero changes.
- Stores context on insert; omission on replay preserves it.
- Rejects the entire transaction if supplied context conflicts, including stored SQL NULL.
- Commits Raw changes and the history change count atomically.

Row-count bounds do not replace producer byte bounds. The loader does not advance checkpoints; the executer calls the separate completed-window transaction after all batches finish. User-reported synthetic warehouse checks cover mutation, replay, context rollback and rollback after a history-count overflow. Concurrent context writes and source-version ordering remain unverified.

Current Raw has no source-version guard, full revision archive, automatic deletion detection, normal-ingestion restoration or automatic NULL-context correction. Applying the existing baseline was user-reported, not independently inspected live.

### Confirmed-deletion helper: partial implementation

`mark_raw_records_deleted` accepts a Raw table, a running execution ID and at most 100 unique nonblank source IDs. It locks and verifies history/progress before updating matching, currently active rows in that pipeline. It sets `deleted = true`, increments `content_revision`, clears `processed`, and updates execution/time metadata without replacing content, context or identity. The same transaction increments history `records_loaded` by changed rows; this counter includes Raw deletion changes when this helper is used.

Repeated deletion is a no-op. Unknown IDs are not inserted. An empty batch still requires a valid execution. Synthetic tests cover scope predicates, replay, batch/input validation and rollback; live PostgreSQL behavior of this helper has not been tested.

`Raw_Record_Input.deleted?` exists as a type declaration only. **`load_raw_records` does not read it yet**, so supplying `true` or `false` currently has no effect on Raw deletion metadata. The helper is not called by current Toast pipelines, and there is no complete-inventory comparison or restoration path. This is not end-to-end deletion reconciliation. See [the next implementation step](../plan/next-steps.md#1-finish-deletion-aware-raw-loading).

## Toast extraction boundary

- Authentication validates HTTPS/no embedded credentials/no redirects, caps login responses at 64 KiB, and reuses a token across locations. It refreshes near expiry or once after a `401`; authentication `429` fails immediately.
- Discovery has a 1 MiB response cap and optional cancellation. Configured ingestion additionally requires nonempty, unique, valid restaurant GUIDs.
- The original business-date reader still reads page 1/page size 10 and reports `Link` presence; its date check validates format, not calendar validity.
- Modification-time extraction supplies `startDate` and `endDate`, requests up to 100 orders per page, and enforces a 4 MiB page cap and a 20-second request timeout plus caller cancellation.
- The extractor rejects invalid/oversized pages, within-page duplicate identities, empty continuing pages, malformed or unsafe links, changed filters and nonsequential page numbers.
- The Raw adapter preserves the source payload and adds restaurant context.
- Configured orders ingestion discovers restaurants once per run and finishes all of them in each window before checkpointing.

Eligible transient failures have up to three attempts with bounded backoff and `Retry-After` handling. Order request starts are spaced at least five seconds apart across locations in one process. Snapshot ingestion warns about newly visible GUIDs, including its initial seed; warnings are not backfills or alerts. Pagination does not guarantee snapshot consistency. Newly accessible locations do not automatically receive earlier order history once the shared watermark has advanced.

## Processed, Refined and reliability limits

The [Processed locations schema](../core/toast/toast-schema.ts) uses shared provenance columns and a unique `(source_system, source_record_id)` key. Its Raw foreign key currently points to `raw.toast_locations`. The Toast mapper validates and chooses `locationName` with `restaurantName` as a fallback. It records the Raw revision and maps deletion as `raw.deleted OR content.deleted`.

The shared processing executer repeatedly invokes a transactional batch callback until it returns zero. Each location batch locks history/progress before up to 100 pending Raw rows in stable ID order. It commits Processed upserts, exact Raw ID/revision acknowledgments and `records_processed` together. There is no 100-record limit on the complete execution. The upsert preserves Processed identity, creation time, source ownership and `type`; failures roll back that batch, not earlier commits.

`processed.locations.type` uses `Location_Type`: `food_and_beverage`, `retail` or `unclassified`. Migration `0002` renames the former `business_type` column without recreating the table. The mapper leaves this business-owned field alone. The separate [location type map](../core/toast/toast-location-type-map.ts) explicitly maps 18 source GUIDs: four retail and fourteen F&B. El Pueblo is provisionally retail by user instruction; The Market is F&B. These are user-reviewed decisions, not independently verified Finance classifications. Names are comments for maintenance, not lookup keys.

After Raw batches drain, `apply_toast_location_types` runs as the optional finalization callback inside the same tracked processing execution and busy guard. Its separate transaction updates only changed `type`/`updated_at` values, including when Raw has no pending changes. Missing mapped locations, an empty map, invalid target environment or write failure prevent success. New unmapped locations stay `unclassified`; existing unmapped classifications are not reset. This step logs `location_types_applied` with `locations_updated`; it does not inflate Raw `records_processed` or overwrite processing provenance.

If finalization fails, committed processing batches remain saved and the execution fails. A later execution retries finalization even with zero pending Raw. No processing-version replay selector, record-error recovery mechanism, Processed order writer, Refined model or report exists. Advancing `location_processing_version` alone does not reprocess acknowledged Raw rows.

The central busy guard prevents the same exact pipeline name from overlapping **within one Node process**, before history registration. Different pipelines may run independently. The guard clears in `finally`, including persistence failures. Use one worker, do not run standalone ingestion while it is active, and stop the old worker before starting its replacement. This does not coordinate different terminals/processes; database-backed whole-execution locking is deferred unless deployment requirements change.

The CLI forwards `SIGINT` and `SIGTERM` to a shared abort signal and closes its pool on exit. Cancellation does not immediately cancel in-flight warehouse queries or undo committed batches. There is no scheduled worker, cross-process exclusion, startup abandoned-history recovery, comprehensive late-change correction or publication freshness.
