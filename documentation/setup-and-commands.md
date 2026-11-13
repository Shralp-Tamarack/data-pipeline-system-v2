# Setup, commands and validation

## Runtime and project layout

[package.json](../package.json) uses Node ES modules. Use a Node version supporting native TypeScript execution with the syntax in this project; Node 22.18.0 or later supports the intended direct-execution approach.

[tsconfig.json](../tsconfig.json) enables strict application checking, `noUncheckedIndexedAccess`, NodeNext modules and erasable TypeScript syntax. Source imports use `.ts`; `rewriteRelativeImportExtensions` changes them to `.js` in compiled output. `skipLibCheck` skips dependency declaration internals, not application source checking.

Source code is in [core](../core/). Manually invoked checks and offline tests are in [sandbox](../sandbox/). Compiled output goes to `dist/`. There is no scheduler start command or implemented application entry point yet.

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

The directory expression supports both ES-module execution and Drizzle Kit's CommonJS configuration loader. In compiled `dist/core/system/` execution, the same relative lookup resolves to `dist/.env`, **not** the repository-root file. Prefer injected process settings for deployment or deliberately configure the compiled environment-file location.

Keep private settings in an ignored local file or an approved deployment secret store. Never include secret values, connection strings, tokens or source payloads in documentation or diagnostic output. Confirm local secret files are excluded and untracked before committing.

The standard's environment variable is `system_environment`. Do not infer the warehouse target from `NODE_ENV`.

## Commands and their effects

Run these from the repository root after installing the declared dependencies with npm as needed. Do not execute all sandbox checks as a blanket test suite: some access live sources and others write warehouse metadata.

| Command | Effect / requirements |
| --- | --- |
| `npm run type-check` | Compile-time checking only; no emitted files or pipeline execution |
| `npm run build` | Writes compiled output to `dist/`; does not run the application |
| `node --test .\sandbox\toast-response.test.ts` | Four offline synthetic-data tests; no configuration import, credentials, network or warehouse |
| `npm run sandbox check-warehouse.ts` | Experimental-label guard; executes read-only `SELECT 1` |
| `npm run sandbox check-pipeline-progress.ts` | Experimental-label guard; inserts missing synthetic pipeline progress and verifies repeated registration |
| `npm run sandbox check-pipeline-execution.ts` | Experimental-label guard; writes synthetic progress/history, checks lifecycle and duplicate-finish rejection |
| `npm run sandbox check-pipeline-orchestrator.ts` | Experimental-label guard; writes synthetic success/failure history and a simulated committed count |
| `npm run sandbox check-toast-authentication.ts` | Experimental-label guard; live Toast login; token not printed |
| `npm run sandbox check-toast-restaurants.ts` | Experimental-label guard; live login and discovery; prints accessible restaurant identifiers/names and count |
| `npm run sandbox check-toast-orders.ts` | Experimental-label guard; live login and one pilot order page; no warehouse writes |
| `npm run gen-drizzle-ddl` | Loads required configuration and generates migration files locally; does not apply them |
| `npm run exe-drizzle-ddl` | Loads required configuration and applies migrations to the selected database; **consequential warehouse mutation** |

The sandbox npm script changes directory into `sandbox` and invokes Node, so pass a bare filename rather than a repository-root path. There is no Raw-loader sandbox check yet.

Metadata checks leave their synthetic records in the selected database and append history on repeated runs. They are not rollback-only tests. They close the pool in `finally`.

## Migrations

[drizzle.config.ts](../drizzle.config.ts) discovers exported definitions in [system-schema.ts](../core/system/system-schema.ts) and [toast-schema.ts](../core/toast/toast-schema.ts), with generated output in [drizzle-generated-ddl](../drizzle-generated-ddl/).

| Generated migration | Content |
| --- | --- |
| [0000_spicy_ronan.sql](../drizzle-generated-ddl/0000_spicy_ronan.sql) | System schema, execution-status enum, progress/history, foreign key and index |
| [0001_salty_prima.sql](../drizzle-generated-ddl/0001_salty_prima.sql) | Raw schema and `raw.toast_orders`, identity/pending/execution indexes and history foreign key |
| [0002_unusual_random.sql](../drizzle-generated-ddl/0002_unusual_random.sql) | Processed schema only; no Processed tables |

Drizzle builders do not create database objects during import. Export schemas, enums and concrete table definitions so Kit can discover them. Reusable functions are not substitutes for exported concrete tables.

Generate, inspect and deliberately apply migrations. Preserve applied SQL and migration metadata; do not reset/recreate migrations for convenience or file moves. Live application status was not independently inspected during the documentation refresh.

## Before live access or any database mutation

1. Confirm the selected application environment and the **actual** Neon project/branch/database using safe diagnostic context, not a printed connection string.
2. Confirm experimental credentials cannot write to the operational warehouse and do not share operational checkpoints, locks or publication state.
3. Confirm source-system access scope and rate limits separately. An experimental application can still call a live Toast source.
4. Prefer synthetic data for tests. Copying live source payloads into the experimental warehouse requires explicit scope approval, appropriate access controls and sanitization where required.
5. Review migration SQL before application. Operational migrations, deployments, data corrections, backfills, resets, schedule changes or service interruptions require explicit approval for that target and scope.
6. Before difficult-to-reverse operational actions, confirm a usable restore point and recovery plan; code rollback alone cannot undo data/schema changes.

The current code validates names and places experimental guards in sandbox checks. It does **not** automatically verify isolation, credential privileges, backups or operational authorization. Follow the [Cautious Development Standards](../.github/copilot-instructions.md#10-cautious-development-standards).

## What has been verified

See the [status and evidence](README.md#verification-evidence) for the last local checks and earlier user-reported live results. Passing type-check or response-reader tests is not proof of transaction behavior, complete source coverage, financial correctness or operational readiness.
