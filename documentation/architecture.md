# Implemented architecture

For future capabilities, see the [project plan](../plan/project-plan.md). For execution details, see [data flow](data-flow.md).

## Organization and ownership

The system separates source knowledge from shared persistence and execution metadata. This keeps the first integration direct without requiring a plugin framework or inheritance hierarchy.

| Files | Responsibility |
| --- | --- |
| [system-configuration.ts](../core/system/system-configuration.ts) | Loads and validates the shared settings object |
| [pgsql-warehouse.ts](../core/system/pgsql-warehouse.ts) | Owns the PostgreSQL pool and Drizzle connection |
| [system-schema.ts](../core/system/system-schema.ts) | Defines system tables and reusable Raw/Processed schema builders |
| [pipeline-progress.ts](../core/system/pipeline-progress.ts) | Registers progress without resetting existing state |
| [pipeline-history.ts](../core/system/pipeline-history.ts) | Starts and completes historical execution attempts |
| [pipeline-orchestrator.ts](../core/system/pipeline-orchestrator.ts) | Executes a callback and records its outcome |
| [raw-pipeline-loader.ts](../core/system/raw-pipeline-loader.ts) | Commits bounded Raw upserts and history counts together |
| [toast-schema.ts](../core/toast/toast-schema.ts) | Derives the stable Toast orders pipeline name and defines its Raw table |
| [Toast integration](../core/toast/) | Owns authentication, restaurant discovery and one-page order reading |
| [sandbox](../sandbox/) | Holds manually invoked checks and focused offline tests |
| [system-scheduler.ts](../core/system/system-scheduler.ts) | Empty placeholder; no scheduling behavior yet |

The shared database helpers currently live in `core/system/`; Toast-specific code is colocated in `core/toast/`. Reports will be organized around business questions and decisions, not these technical folders or source-system names.

## Configuration and database boundary

Configuration exports one typed `env_vars` object after checking required values and the `experimental`/`operational` environment name. External Toast responses use Zod where a runtime shape is useful; configuration uses simple explicit checks.

The pool allows five connections, with a 10-second connection timeout and a 30-second PostgreSQL statement timeout. Constructing the pool does not execute a query. Importing the connection module does not apply migrations.

An environment label is validated; actual Neon branch/database identity and credential isolation are **not automatically enforced**. See [setup and commands](setup-and-commands.md) for required settings, command effects and target verification.

## System schema: progress versus history

### `system.pipeline_progress`

[Pipeline_Progress](../core/system/system-schema.ts) represents current durable state:

- Internal UUID and unique `pipeline_name`.
- Nullable `ingestion_watermark`.
- Independent nullable `last_successful_ingestion_at` and `last_successful_processing_at`.
- Creation/update timestamps.

There is currently **one row per pipeline**, not one row per restaurant, partition or work kind. `get_or_create_pipeline_progress` inserts missing state without changing an existing checkpoint.

The intended watermark is the end of fully completed source-time coverage. It is not the execution finish time. No current helper advances it or the successful-stage timestamps automatically. Timestamp defaults initialize rows; they are not automatic update triggers.

### `system.pipeline_history`

[Pipeline_Execution_History](../core/system/system-schema.ts) stores attempts:

- UUID execution ID, also used as the batch tag.
- Required progress foreign key with `ON DELETE RESTRICT`.
- Operation, status, watermark before/after and safe error summary.
- Loaded/processed counts and start/finish timestamps.
- Index on progress ID and start time.

The status enum permits `running`, `succeeded`, `partial`, `failed`, `cancelled` and `abandoned`. Having these values in the schema does not implement cancellation or abandoned-run recovery.

Start captures the existing watermark. Completion only updates a running execution, rejecting missing or already-finished attempts. Omitted optional counts/watermark fields remain unchanged. Counts are checked as nonnegative safe integers when supplied; the database columns are PostgreSQL integers, so their storage range is narrower than JavaScript's safe-integer range.

Duration is derived from timestamps rather than stored separately. History is an audit of attempts, not a replacement for current progress.

## Raw storage and reusable tables

[create_raw_table](../core/system/system-schema.ts) creates a Drizzle table definition with **fresh column builders** each time. [Raw_Toast_Orders](../core/toast/toast-schema.ts) uses it to define `raw.toast_orders`.

Common columns:

| Group | Columns |
| --- | --- |
| Internal identity/provenance | `id`, `execution_id` |
| Source identity/payload | `source_record_id`, `content`, `record_source` |
| State and metadata | `deleted`, `content_revision`, `processed`, `created_at`, `updated_at` |

`content` is JSONB. It preserves the selected source record's fields, not the original response bytes or every past payload version.

The database identity constraint is **`record_source` + `source_record_id`**. There is no `source_scope_id` column. A producer must include any necessary location/tenant context in the complete, stable source key. The Toast restaurant/order compound key is the next implementation decision; the current reader does not create it or inject restaurant context into the payload.

Each Raw table has a source-identity unique index, a pending-processing index on `processed, id`, and an execution-ID index. The history foreign key uses `ON DELETE RESTRICT`. `record_source` defaults to the pipeline name but the database does not constrain it to equal that name.

The loader:

- Accepts at most 100 records and rejects blank or duplicate source identities.
- Verifies that the execution is running and belongs to the table's pipeline.
- Inserts new records or updates changed JSONB payloads.
- Preserves internal identity, original source identity and creation timestamp.
- Increments `content_revision`, clears `processed`, and updates execution/update metadata only for changed payloads.
- Adds the inserted/changed row count to history in the same transaction.

An unchanged payload has no Raw update and contributes zero to `records_loaded`. This count is **committed changes**, not fetched-record count. Producer byte bounds remain necessary; a row limit alone does not bound memory.

Current limitations: no source-version ordering guard, full revision archive, deletion/reappearance handling, checkpoint update, or verified Raw replay integration check. Batch row locks do not prevent whole executions from overlapping.

## Processed and Refined

The `processed` schema exists in the generated DDL, but there are **no concrete Processed tables**.

[create_processed_columns](../core/system/system-schema.ts) returns two fresh builder groups:

- `identity_columns`: internal `id` and `raw_record_id` foreign key.
- `metadata_columns`: deletion state, required `raw_content_revision` and `processing_version`, execution foreign key, and timestamps.

A concrete table spreads these groups around its selected business columns. The helper creates neither a table nor database columns by itself. Raw-to-Processed relationships are not automatically unique, allowing one-to-many output where justified. Concrete tables must explicitly define business identities, foreign-key lookup indexes and constraints.

Schema definitions describe database objects; only applying reviewed migrations creates them in PostgreSQL.

No Processed mapper, revision-safe acknowledgment, processing error backlog, Refined model or report is implemented yet.

## Toast read boundary

- [Authentication](../core/toast/toast-authentication.ts): one login request per call; HTTPS URL without embedded credentials, no redirects, 20-second request timeout, HTTP and Zod response checks. The token is returned unchanged and not logged.
- [Restaurant discovery](../core/toast/toast-restaurants.ts): reads accessible connections; validates nonblank `restaurantGuid` and retains additional source fields. Response cap: 1 MiB.
- [Order reader](../core/toast/toast-orders.ts): validates the restaurant GUID and eight-digit business-date format, requests page 1/page size 10, validates at most ten records with nonblank `guid`, and retains their fields. Response cap: 4 MiB.
- [Response reader](../core/toast/toast-response.ts): counts streamed bytes, handles UTF-8 across chunks, cancels oversized bodies, releases the reader lock and redacts JSON parse errors.

Order reading returns records and whether a `Link` header exists. It does not interpret that header or follow pagination. The business-date check validates format, not calendar validity. A business-date sample is not a modification-time incremental window.

Authentication uses `response.json()` without the shared byte cap. Token caching/expiry handling, bounded retries, rate-limit handling and cancellation propagation are not implemented.

## Reliability boundary

Current execution history and bounded reads are useful building blocks, not a complete reliability guarantee. There is no whole-run database lock, scheduler/supervisor, crash recovery, graceful application shutdown, structured logger, automatic checkpointing or publication freshness.

Sandbox warehouse checks close the pool in `finally`; the orchestrator does not own pool shutdown. A pool idle-error listener and application-level lifecycle handling still need implementation.
