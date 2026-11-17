# Setup, commands and validation

## Runtime and project layout

[package.json](../package.json) uses Node ES modules. Use a Node version supporting native TypeScript execution with the syntax in this project; Node 22.18.0 or later supports the intended direct-execution approach.

[tsconfig.json](../tsconfig.json) enables strict application checking, `noUncheckedIndexedAccess`, NodeNext modules and erasable TypeScript syntax. Source imports use `.ts`; `rewriteRelativeImportExtensions` changes them to `.js` in compiled output. `skipLibCheck` skips dependency declaration internals, not application source checking.

Source code is in [core](../core/). Manually invoked checks and offline tests are in [sandbox](../sandbox/), and deliberate maintenance scripts are in [scripts](../scripts/). All three TypeScript areas are included in checking/build output. Compiled output goes to `dist/`; builds do not execute sandbox files. A manual pipeline CLI exists; there is no scheduler start command.

## Required settings

[System configuration](../core/system/system-configuration.ts) requires all five names:

| Name | Purpose |
| --- | --- |
| `system_environment` | Exactly `experimental` or `operational` |
| `data_warehouse_connection_string` | Private connection setting for the selected warehouse |
| `toast_api_host` | Toast HTTPS API host |
| `toast_client_id` | Private Toast client credential |
| `toast_client_secret` | Private Toast client credential |

Missing/blank entries or an invalid environment name fail explicitly. The current shared configuration requires Toast settings even for warehouse checks and Drizzle commands that do not contact Toast.

dotenv automatically loads `.env` relative to the configuration module, without overriding process-provided values and without printing its loading banner. In source execution this resolves to the repository root, regardless of the sandbox working directory.

Optional `log_format` is `json` (default) or `pretty`. Set `log_format=pretty` in the local `.env` for repeatable terminal use or in the experimental Render service's settings when deployed. A process-provided value overrides `.env`. Pretty mode shows UTC time, level, pipeline, execution ID and message, hiding extra fields. Use JSON for counts, date bounds and retry details; Render can text-search event names and execution IDs in JSON logs. Warehouse execution history is the durable record.

The directory expression supports both ES-module execution and Drizzle Kit's CommonJS configuration loader. In compiled `dist/core/system/` execution, the same relative lookup resolves to `dist/.env`, **not** the repository-root file. Prefer injected process settings for deployment or deliberately configure the compiled environment-file location.

Keep private settings in an ignored local file or an approved deployment secret store. Never include secret values, connection strings, tokens or source payloads in documentation or diagnostic output. Confirm local secret files are excluded and untracked before committing.

The standard's environment variable is `system_environment`. Do not infer the warehouse target from `NODE_ENV`.

## Source ingestion configuration

[Toast configuration](../core/toast/toast-configuration.ts) sets June 1, 2026 at midnight UTC as the orders start date, with 28-day windows and 100 orders per page. These are source settings, not environment variables.

Configured orders ingestion starts one day before the saved pipeline watermark, otherwise at the source start date, and captures now once for the run end. The first run can be a long historical catch-up; changing the start date does not reset a saved watermark. JSON `ingestion_range_selected` shows the selected range, lookback, and window size.

[Orders ingestion](../core/toast/toast-orders.ts) loads every discovered location before checkpointing a completed window. [Locations ingestion](../core/toast/toast-locations.ts) refreshes a Raw snapshot instead. Neither is an ordinary setup check: both contact live Toast and write the warehouse.

Explicit-date sandbox checks still use the same window/extractor/loader path without advancing normal progress. They have their own bounded check ranges; their two-minute budgets are not a system-wide historical-ingestion limit.

## Commands and their effects

Run these from the repository root after installing the declared dependencies with npm as needed. Do not execute all sandbox checks as a blanket test suite: some access live sources and others write warehouse metadata.

| Command | Effect / requirements |
| --- | --- |
| `npm run type-check` | Compile-time checking only; no emitted files or pipeline execution |
| `npm run build` | Writes compiled output to `dist/`; does not run the application |
| `node --test .\sandbox\toast-response.test.ts` | Four offline synthetic-data tests; no configuration import, credentials, network or warehouse |
| `node --test .\sandbox\reset-database.test.ts` | Offline reset-guard tests with a fake database client; no real configuration, network or warehouse |
| `node --test .\sandbox\ingestion-executer.test.ts .\sandbox\pipeline-progress.test.ts .\sandbox\ingestion-windows.test.ts .\sandbox\pipeline-orchestrator.test.ts .\sandbox\toast-order-extractor.test.ts .\sandbox\toast-order-pagination.test.ts .\sandbox\toast-response.test.ts .\sandbox\toast-request.test.ts .\sandbox\toast-token-cache.test.ts` | Focused offline checks for the mapper, workflow, checkpoint logic, busy guard, bounded extraction, retries and token cache; no live source or warehouse |
| `npm run ingest -- toast-locations` | Experimental-label guard; live Toast discovery, Raw location snapshot writes and execution history. No time watermark movement |
| `npm run ingest -- toast-orders` | Experimental-label guard; live Toast order reads, Raw and history writes, and completed-window watermark updates |
| `npm run sync -- toast` | Experimental-label guard; runs the two Raw stages in order, not Processed. Orders starts only after locations succeeds |
| `npm run sandbox check-warehouse.ts` | Experimental-label guard; executes read-only `SELECT 1` |
| `npm run sandbox check-pipeline-progress.ts` | Experimental-label guard; inserts missing synthetic pipeline progress and verifies repeated registration |
| `npm run sandbox check-pipeline-execution.ts` | Experimental-label guard; writes synthetic progress/history, checks lifecycle and duplicate-finish rejection |
| `npm run sandbox check-pipeline-orchestrator.ts` | Experimental-label guard; writes synthetic success/failure history and a simulated committed count; verifies duplicate rejection, independent pipeline and restart |
| `npm run sandbox check-toast-authentication.ts` | Experimental-label guard; live Toast login; token not printed |
| `npm run sandbox check-toast-locations.ts` | Experimental-label guard; live login and discovery; prints accessible location identifiers/names and count |
| `npm run sandbox check-toast-orders.ts` | Experimental-label guard; live login and one pilot order page; no warehouse writes |
| `npm run sandbox check-toast-raw-loading.ts` | Experimental-label guard; live pilot page read, Raw writes and same-payload replay assertions; leaves records/history in the warehouse |
| `npm run sandbox check-raw-loader-safety.ts` | Synthetic warehouse writes/deletes and history updates; checks revisions/replay/context rollback and count-overflow rollback; restores artificial count, removes exact synthetic Raw records, retains history; no Toast access |
| `npm run sandbox check-toast-order-window.ts` | Live Toast read of one configured pilot restaurant/window; page/count logs only, no warehouse import or progress write |
| `npm run sandbox check-toast-window-ingestion.ts` | Live pilot-window Toast reads and Raw writes; explicit range leaves normal progress unchanged; earlier batches may remain on failure |
| `npm run sandbox check-ingestion-executer.ts` | Synthetic Raw/history writes for explicit-range success, second-window failure and cancellation; deletes exact synthetic Raw records, retains history and leaves normal progress unchanged |
| `npm run sandbox check-ingestion-restart.ts` | Experimental-label guard; creates an isolated synthetic table and metadata, runs interruption/resume in child processes and cleans up the fixture; no Toast calls or intended changes to real progress |
| `npm run gen-drizzle-ddl` | Loads required configuration and generates migration files locally; does not apply them |
| `npm run exe-drizzle-ddl` | Loads required configuration and applies migrations to the selected database; **consequential warehouse mutation** |
| `npm run gen-exe-drizzle-ddl` | Existing combined script; bypasses the review pause and may attempt application even after some generator errors. Prefer separate generate, review and apply steps |
| `npm run reset-db` | **Irreversible:** interactively drops experimental project schemas and deletes local generated migrations; see below |

The sandbox npm script changes directory into `sandbox` and invokes Node, so pass a bare filename rather than a repository-root path.

[The Raw loading check](../sandbox/check-toast-raw-loading.ts) reads the same pilot restaurant/business date as the order-page check. It stores exact order GUIDs, separate restaurant context and unchanged payloads. It compares the first load to existing rows, verifies new/changed/unchanged behavior, replays the same in-memory records, checks committed history counts and asserts that pipeline progress is unchanged. Empty pages fail rather than claiming replay was verified. Assertions compare payloads as booleans so failure diagnostics do not dump source data.

Run only against an independently verified isolated experimental target with approved source-data scope. Existing records with missing/conflicting context cause rejection; no automatic correction is performed. A failed assertion does not undo a previously committed first load.

The central busy guard protects calls through the orchestrator within one process only. Some lower-level sandbox checks call history/loader helpers directly. Do not run any connected writer alongside the worker or another terminal writer. Stop the old worker before replacing it; cross-process coordination is not implemented.

Metadata checks leave their synthetic progress/history in the selected database and append history on repeated runs. The two synthetic Raw safety/executer checks remove their named synthetic Raw rows, not all metadata. These are not rollback-only tests. Connected warehouse scripts own pool shutdown.

## Migrations

[drizzle.config.ts](../drizzle.config.ts) discovers exported definitions in [system-schema.ts](../core/system/system-schema.ts) and [toast-schema.ts](../core/toast/toast-schema.ts), with generated output in [drizzle-generated-ddl](../drizzle-generated-ddl/).

| Generated migration | Content |
| --- | --- |
| [0000_clever_dark_phoenix.sql](../drizzle-generated-ddl/0000_clever_dark_phoenix.sql) | Current baseline: system/progress/history, both Raw Toast tables and the Processed schema |
| [0001_add-processed-locations.sql](../drizzle-generated-ddl/0001_add-processed-locations.sql) | Adds `processed.locations`, its constraints, foreign keys and indexes; no existing Raw table changes |

Drizzle builders do not create database objects during import. Export schemas, enums and concrete table definitions so Kit can discover them. Reusable functions are not substitutes for exported concrete tables.

The experimental baseline was regenerated during development. Verify the database's applied migration history against the current local journal before future migrations; a matching table name alone does not establish a matching history. The user confirmed `processed.locations` exists in the experimental database. Its live migration records and credential isolation were not independently inspected.

Generate, inspect and deliberately apply migrations. Preserve applied SQL and migration metadata; do not reset/recreate migrations for convenience or file moves. Live application status was not independently inspected during the documentation refresh.

## Experimental database reset

`npm run reset-db` uses [reset-database.ts](../scripts/reset-database.ts). It refuses any environment except `experimental`, requires an interactive terminal and proceeds only when the input is exactly `reset`. Cancellation and non-interactive input do not open a database connection. The application environment and all other required shared configuration must still be valid.

If confirmed, one `DROP SCHEMA IF EXISTS ... CASCADE` statement drops `system`, `raw`, `processed`, `refined`, and `drizzle` with their tables, data and database migration history. `CASCADE` can also remove dependent objects in other schemas. `public`, other schemas, PostgreSQL system schemas and the database itself are not explicitly dropped.

After a successful database reset and pool shutdown, the command recursively deletes the repository's `drizzle-generated-ddl` folder, including its SQL files, metadata and any uncommitted changes. It refuses to delete a migration path that is a symbolic link or not a directory. It does not delete the folder if the database reset fails or its outcome is unknown. If folder deletion or pool shutdown fails after the database reset, it reports the partial failure; inspect both states before taking recovery action.

This removes local migration history used for **all** environments, not just the experimental database. Preserve a usable backup of the folder and coordinate migration history with any other databases before resetting. Recreate and review migration files deliberately for the reset database; do not blindly apply a new baseline to a database that has the old history. Never reset operational data or delete shared migration history as a shortcut for file moves.

**The environment label and confirmation are not proof of isolation or target identity.** Before running the command, independently verify the actual Neon project/branch/database and credential scope without printing the connection string. Confirm the full scope and dependencies, a usable backup/restore point and recovery plan. Do not run this command against operational data. Offline guard tests use a fake client; the user subsequently confirmed an experimental reset and baseline application, not an agent-run live test.

## Before live access or any database mutation

1. Confirm the selected application environment and the **actual** Neon project/branch/database using safe diagnostic context, not a printed connection string.
2. Confirm experimental credentials cannot write to the operational warehouse and do not share operational checkpoints, locks or publication state.
3. Confirm source-system access scope and rate limits separately. An experimental application can still call a live Toast source.
4. Prefer synthetic data for tests. Copying live source payloads into the experimental warehouse requires explicit scope approval, appropriate access controls and sanitization where required.
5. Review migration SQL before application. Operational migrations, deployments, data corrections, backfills, resets, schedule changes or service interruptions require explicit approval for that target and scope.
6. Before difficult-to-reverse operational actions, confirm a usable restore point and recovery plan; code rollback alone cannot undo data/schema changes.

The current code validates names and places experimental guards in sandbox checks. It does **not** automatically verify isolation, credential privileges, backups or operational authorization. Follow the [Cautious Development Standards](../.github/copilot-instructions.md#10-cautious-development-standards).

## What has been verified

### Local offline verification

On November 13, 2026, after configured ingestion/checkpoint implementation:

- `npm run type-check` passed.
- The then-current seven-file test selection passed **39 tests**, including parent test counts.
- Coverage includes initial source-date loading, fixed run end, watermark resumption, later-page/restaurant failure, cancellation/load/checkpoint failure, explicit-range compatibility, expected-checkpoint predicates and synthetic transaction rollback, overlap release paths, window boundaries, strict links and bounded JSON reads.
- The reset-guard tests passed earlier using copied code and a fake database client; they were not part of the 39-test command.

On November 17, type-check and 49 focused offline tests passed for the manual workflow and ingestion behavior; Drizzle's local migration check passed after adding `processed.locations`. The latest mapper check passed type-check and 30 tests in `ingestion-executer.test.ts`, including preferred/fallback names, deletion, provenance and invalid payload handling. These are separate runs, not a new full-suite result.

These tests use synthetic persistence/configuration. The checkpoint suite exercises the real helper against a fake transaction; it does not establish actual PostgreSQL locking/rollback behavior. The documentation-only refresh did not rerun tests or make live requests.

### User-reported connected results

The following successful outputs were supplied during development on November 13:

| Check | Reported result / boundary |
| --- | --- |
| Experimental baseline | User confirmed reset, generated baseline application and target verification; no agent live inspection |
| Warehouse/progress/history foundation | Connectivity, repeated progress registration and execution lifecycle checks succeeded |
| Toast discovery/page | Accessible restaurant discovery and a ten-order pilot page succeeded |
| Pilot Raw load/replay | 10 fetched, 10 Raw changes, zero same-payload replay changes; identity/context/history/progress assertions passed |
| Synthetic Raw safety | Payload revision/reset/replay, whole-batch context rollback, actual PostgreSQL count-overflow rollback and finished-execution rejection passed; progress unchanged |
| Read-only Toast window | November 11-12 UTC: five nonempty pages (10, 10, 10, 10, 4), 44 orders; no warehouse writes |
| Explicit-window Toast ingestion | 38 Raw changes; progress unchanged and no processing |
| Synthetic explicit-window executer | Success: 2 committed records; later-window failure: 1; cancellation: 1; expected history/boundaries, unchanged progress |
| Process-local overlap | Duplicate rejected, independent pipeline completed and same pipeline restarted |

The 44 fetched orders and 38 Raw changes are different measures, not evidence of missing records: unchanged existing payloads contribute zero changes. They are separate reported runs, not a source snapshot/reconciliation.

Later user-reported checks included configured Raw order runs with 5,819 and 67 changed records, a spot check of 107 orders across six locations for one day, inspection of 18 Raw location records, and confirmation that `processed.locations` exists. These are samples and table-existence evidence, not proof of complete coverage or a working writer.

### Still unverified or unresolved

- Controlled connected checkpoint interruption/fresh-process recovery and full historical/all-location coverage.
- Concurrent context conflicts, source-version ordering, late-arriving changes and changes in accessible restaurant scope.
- The Processed writer and its database transaction behavior, financial correctness, report freshness, operational isolation enforcement and deployment readiness.
- Abandoned-running-history recovery, structured original-cause diagnostics and immediate database-query cancellation.

The supplied connected output repeatedly included the tail of a PostgreSQL SSL compatibility warning. The full warning/cause has not been inspected; no SSL setting was changed or warning suppressed. Checks completed despite the warning. Investigate it separately without printing the connection string or weakening certificate verification.
