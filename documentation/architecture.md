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
| [pipeline-orchestrator.ts](../core/system/pipeline-orchestrator.ts) | Executes supplied work with a process-local per-pipeline busy guard |
| [ingestion-types.ts](../core/system/ingestion-types.ts) | Shared Raw record input and source ingestion configuration types |
| [ingestion-windows.ts](../core/system/ingestion-windows.ts) | Generates consecutive source-time windows |
| [ingestion-executer.ts](../core/system/ingestion-executer.ts) | Sequentially extracts/loads windows and checkpoints configured ingestion |
| [raw-pipeline-loader.ts](../core/system/raw-pipeline-loader.ts) | Commits bounded Raw upserts and history counts together |
| [toast-configuration.ts](../core/toast/toast-configuration.ts) | Toast's source-level `data_start_date` |
| [toast-schema.ts](../core/toast/toast-schema.ts) | Stable `toast_orders` pipeline name and Raw table |
| [toast-ingestion.ts](../core/toast/toast-ingestion.ts) | Coordinates all discovered restaurants for configured orders ingestion |
| [toast-orders.ts](../core/toast/toast-orders.ts) | Business-date page reader, modification-time extractor and Raw adapter |
| [toast-order-pagination.ts](../core/toast/toast-order-pagination.ts) | Validates the next-page link and unchanged extraction filters |
| [toast-authentication.ts](../core/toast/toast-authentication.ts), [toast-restaurants.ts](../core/toast/toast-restaurants.ts), [toast-response.ts](../core/toast/toast-response.ts) | Authentication, discovery and bounded JSON reads |
| [sandbox](../sandbox/) | Manually invoked connected checks and focused offline tests |
| [system-scheduler.ts](../core/system/system-scheduler.ts) | Empty placeholder; no scheduling behavior |

Reports and analytics will be organized around users' business questions and decisions, not these technical folders or source names.

## Configuration and database boundary

[Shared environment configuration](../core/system/system-configuration.ts) exports one typed `env_vars` object after required-value and environment-name checks. It currently holds warehouse and Toast connection/authentication settings. Source ingestion settings are separate: `Source_System_Configuration` currently requires only `data_start_date : Date`, and Toast exports its own `toast_configuration`.

Toast's date is `2026-01-01T00:00:00.000Z`, selected by the user, not independently verified as the first available record date. It is used only when a pipeline has no watermark. Changing this setting does not reset existing progress. Future integrations should own their own configuration; no unused source configurations or configuration inheritance were added.

The `pg.Pool` allows five connections with a 10-second connection timeout and a 30-second statement timeout. Constructing clients/importing modules does not execute queries, run pipelines or apply migrations. The configured Neon endpoint was previously classified as pooled without connecting; application pooling and Neon endpoint pooling are different boundaries.

The environment name must be `experimental` or `operational`. This is not proof of actual target identity, credential isolation or mutation authorization. These checks remain deliberate operational responsibilities.

## One ingestion flow

Configured `execute_ingestion`:

1. Captures an end time once at run start.
2. Enters the orchestrator's per-pipeline guard.
3. Reads the pipeline watermark; otherwise uses its source's `data_start_date`.
4. Generates consecutive windows and consumes source-provided bounded batches sequentially.
5. Commits each Raw batch before requesting more records.
6. Saves progress only after the entire window extractor completes.

The shared default window is 24 elapsed hours, with an optional per-pipeline `ingestion_window_hours` override. Fractional hours are supported if they resolve to a positive safe whole-millisecond duration. The final window is shortened; an equal start/end yields no windows. These are not calendar/business-day windows.

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

[create_raw_table](../core/system/system-schema.ts) returns fresh Drizzle column builders. [Raw_Toast_Orders](../core/toast/toast-schema.ts) defines `raw.toast_orders`.

| Group | Columns |
| --- | --- |
| Internal identity/provenance | `id`, `execution_id` |
| Source identity/payload | `source_record_id`, nullable `source_context`, `content`, `record_source` |
| State/metadata | `deleted`, `content_revision`, `processed`, `created_at`, `updated_at` |

JSONB preserves the selected source record's content, not response bytes or every past revision. Source context is kept immediately before content in the fresh baseline. Toast stores `{restaurant_guid}` separately without modifying order payloads.

Identity is `record_source` + `source_record_id`. Toast uses the exact order GUID. Toast's [order guide](https://doc.toasttab.com/doc/devguide/apiOrdersOrderObjectSummary.html) describes unique Toast-generated order GUIDs and its [identifier guide](https://doc.toasttab.com/doc/devguide/portalToastIdentifiers.html) describes globally unique GUIDs; the reviewed text did not explicitly state cross-restaurant order uniqueness. Context is provenance, not identity.

Each table has source-identity, pending-processing and execution-ID indexes; history foreign keys use `ON DELETE RESTRICT`. The loader verifies the execution's pipeline, rejects blank/duplicate identities and batches above 100 records, and:

- Inserts new rows with revision 1.
- Updates changed payloads while preserving internal/source identity and creation time.
- Increments revision, clears `processed`, and changes execution/update metadata only for changed payloads.
- Leaves unchanged payloads untouched and counts them as zero changes.
- Stores context on insert; omission on replay preserves it.
- Rejects the entire transaction if supplied context conflicts, including stored SQL NULL.
- Commits Raw changes and the history change count atomically.

Row-count bounds do not replace producer byte bounds. The loader does not advance checkpoints; the executer calls the separate completed-window transaction after all batches finish. User-reported synthetic warehouse checks cover mutation, replay, context rollback and rollback after a history-count overflow. Concurrent context writes and source-version ordering remain unverified.

Current Raw has no source-version guard, full revision archive, deletion/reappearance handling or automatic NULL-context correction. Applying the existing baseline was user-reported, not independently inspected live.

## Toast extraction boundary

- Authentication validates HTTPS/no embedded credentials/no redirects, status and token shape; accepts caller cancellation and a 20-second request timeout. It does not print tokens.
- Discovery has a 1 MiB response cap and optional cancellation. Configured ingestion additionally requires nonempty, unique, valid restaurant GUIDs.
- The original business-date reader still reads page 1/page size 10 and reports `Link` presence; its date check validates format, not calendar validity.
- Modification-time extraction uses `[startDate, endDate)`, one token per restaurant window, page size 10, a 4 MiB page cap, and a 20-second request timeout plus caller cancellation.
- The extractor rejects invalid/oversized pages, within-page duplicate identities, empty continuing pages, malformed or unsafe links, changed filters and nonsequential page numbers.
- The Raw adapter preserves the source payload and adds restaurant context.
- Configured orders ingestion discovers restaurants once per run and finishes all of them in each window before checkpointing.

There is no global token cache, expiry refresh, bounded retry/backoff or rate-limit policy. Authentication still uses `response.json()` without the shared byte cap. Pagination does not establish snapshot consistency or reject repeats across different pages. Discovery scope is not durably versioned: newly accessible restaurants do not automatically receive earlier history once the shared watermark has advanced.

## Processed, Refined and reliability limits

The Processed schema and [create_processed_columns](../core/system/system-schema.ts) exist, with fresh identity/metadata builders, Raw revision and processing-version fields, and explicit restricted foreign keys. Concrete tables must supply business columns, identities, relationship indexes and constraints.

There are no concrete Processed tables, mappers, revision-safe acknowledgments, processing backlog, Refined models or reports yet.

The central busy guard prevents the same exact pipeline name from overlapping **within one Node process**, before history registration. Different pipelines may run independently. The guard clears in `finally`, including persistence failures. Use one worker, do not run standalone ingestion while it is active, and stop the old worker before starting its replacement. This does not coordinate different terminals/processes; database-backed whole-execution locking is deferred unless deployment requirements change.

Cancellation checks prevent further source/window work but do not immediately cancel in-flight warehouse queries or undo committed batches. There is no scheduler/supervisor, application shutdown lifecycle, startup abandoned-history recovery, structured diagnostic logger, late-change correction or publication freshness. Sandbox checks close their own pools; executers do not own pool shutdown. Live configured checkpoint/restart behavior is the next verification gate.
