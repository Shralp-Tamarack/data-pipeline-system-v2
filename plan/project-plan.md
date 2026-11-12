# Tamarack Data Warehouse and Pipeline System Plan

## 1. Purpose and scope

Build a clean, reliable Node.js and TypeScript system that keeps Tamarack's Neon PostgreSQL warehouse accurate and fresh across APIs, source databases, CSV/JSON files, and other formats as needed.

This is a foundational system, not only a restaurant-report prototype. The restaurant sales chart is the first end-to-end use case that will prove the foundation. Add reusable capabilities deliberately, without building a plugin platform or speculative framework.

This document is the working reference for implementation. Requirements below are targets, not claims about capabilities already implemented. Proposed defaults can change when source evidence warrants it; record those changes here.

### Primary priorities

1. Accurate data and explainable business numbers.
2. Safe retries, idempotent writes, and recovery from interruptions.
3. Bounded memory, concurrency, and database work.
4. Simple source onboarding and maintenance.
5. Centralized scheduling, observability, and freshness tracking.

### Agreed technologies and conventions

- Node.js with TypeScript and explicit ES module imports.
- Local source imports use `.ts` extensions for direct Node execution; TypeScript's `rewriteRelativeImportExtensions` rewrites them to `.js` during compilation.
- TypeScript uses `skipLibCheck` to avoid checking declaration-file internals, including Drizzle's optional database-driver declarations. Application source and its use of dependency types remain checked.
- TypeScript-first compile-time checking; explicit runtime validation for external input. Use Zod only when a concrete runtime schema adds value, not for every internal value or simple configuration check.
- Neon PostgreSQL for warehouse data and durable pipeline metadata.
- Drizzle for typed schema definitions, migrations, and appropriate queries; use parameterized SQL where clearer.
- `node-cron` for centralized schedules.
- Raw -> Processed -> Refined, with business-oriented Refined models and reports.
- Runtime names use `snake_case`; types and table metadata use `Pascal_Snake_Case`; files use kebab-case.
- Flat shared files in `core/`, with shallow feature/source groups where meaningful.
- Environment names: `experimental` for building and testing; `operational` for the live system in use. Follow the [Cautious Development Standards](../.github/copilot-instructions.md#10-cautious-development-standards) for isolation, target verification, secret handling, and controlled operational changes.

### Implemented configuration boundary

[System configuration](../core/system/system-configuration.ts) loads the project-root `.env` through dotenv when imported, independently of the command's working directory, without overriding variables already supplied by the process environment. It builds one settings object, checks all its entries for missing or blank values, then exports typed `env_vars` after validation, using plain runtime checks without Zod. Empty strings are temporary missing-value markers only; they cannot pass validation or reach the export. Required settings are `system_environment` and `data_warehouse_connection_string`; local commands do not need `--env-file`. Compiled code retains the same module-relative lookup, so a deployment running compiled output must supply settings through its process environment or deliberately configure its environment-file location.

Missing or blank settings stop startup with a simple missing-environment-variable error. The environment must be `experimental` or `operational`, as required by the environment safety standards. Connection string syntax is not validated here. The module does not connect to a database, authorize operational execution, or prove target isolation. Add future required application settings to the `Env_Vars` type and `env_vars` object; the missing-value check automatically covers every object entry.

## 2. Architecture

```text
Manual commands / central node-cron scheduler
                     |
             Shared execution runner
      run tracking, lock, cancellation, errors
                     |
             Source-specific adapter
      authentication, pagination, query/file reading
                     |
           Bounded extraction batches
                     |
                    Raw
       source payload + identity + revision
                     |
        Bounded, replayable processing
                     |
                 Processed
       useful, validated source-specific records
                     |
          Dependency-aware transformations
                     |
                  Refined
         Tamarack dimensions and facts
                     |
            Reports and analytics
```

One central scheduler can invoke ingestion, backfill chunks, reconciliation, processing retries, and Refined refreshes. It does not implement their business logic. Manual commands invoke the same execution paths.

### Small shared responsibilities

- **Runner:** execution lifecycle, cancellation, bounded concurrency, locking, and run outcomes.
- **Extraction contract:** an async iterable of bounded batches plus source-specific progress information; never require a full-dataset array.
- **Raw loader:** validated identities, bulk upserts, revision tracking, and atomic progress commits.
- **Processing runner:** bounded reads, transformation failures, replay, and transaction-safe acknowledgments.
- **Scheduler:** explicit task registry, source defaults, task overrides when needed, and dependency ordering.
- **Logger:** structured events correlated to durable run history.

Source-specific code owns authentication, endpoint/query details, record identity, paging semantics, source time semantics, and mappings. Reuse an HTTP requester, parser, or loader where behavior actually matches; do not pretend every API paginates or every source supports incremental extraction.

Start with small types and plain functions. No inheritance hierarchy, universal query DSL, unnecessary generics, or automatic discovery of executable jobs.

## 3. Correctness guarantees

### Identity and idempotency

- Define each dataset's source key before loading it. Include tenant/location scope and compound-key fields where required; do not assume an order ID is globally unique.
- Enforce identity through database unique constraints. Missing/invalid keys fail validation rather than becoming strings such as `"undefined"`.
- Use at-least-once extraction with idempotent database effects, not an unprovable exactly-once claim.
- Replaying a page, file, date window, or run must not create duplicate logical records.
- Preserve immutable internal IDs and origin fields on updates.
- Compare payload revisions deterministically so unchanged payloads do not trigger needless processing.
- Prevent older backfill data from overwriting newer records using reliable source versions/timestamps where available. If a source has neither, serialize overlapping work and define an explicit re-read policy.

### Atomic progress and separate watermarks

- Commit each Raw batch and its extraction checkpoint in one database transaction. Never checkpoint before its records are durable.
- Persist run history separately from mutable dataset state.
- Distinguish extraction progress, processing completion, and Refined publication/freshness.
- Raw extraction may succeed while processing fails; do not label the complete sync successful or the report current in that case.
- Advance a completed incremental window only after all its pages/partitions are durably loaded.
- Process a Raw revision and acknowledge that same revision atomically. Never mark a newer revision processed because an older revision finished.
- Do not hold a database transaction open during remote API requests.

### Failure behavior

- Record invalid items and transformation errors with safe context. They remain recoverable and make the run partial/failed, not silently successful.
- Retry transient timeouts, rate limits, and suitable server/database failures with bounded exponential backoff and jitter; honor `Retry-After`.
- Authentication, invalid payloads, mapping bugs, and invalid configuration require explicit handling, not unlimited retries.
- Configure request/query timeouts and cancellation. Propagate cancellation through extraction and processing.
- Use exact decimal storage/calculation for money. Distinguish missing values from legitimate zeroes.

## 4. Raw, Processed, and Refined

### Raw

Proposed initial storage is one current payload per logical source record, with source scope/key, source modification/version when available, payload revision, observation/run metadata, and deletion state.

- Preserve all fields in the selected source record, including fields not selected for Processed.
- Keep warehouse provenance separate from the source payload; do not replace original source fields for internal naming convenience.
- JSONB preserves source record content, not byte-for-byte file formatting. Retain original file bytes in PostgreSQL only where a concrete audit/replay requirement calls for it.
- Latest-state Raw is not a complete history of every payload version. If full change history is required, decide and implement retention explicitly before relying on it.
- Support reprocessing from Raw without another source request.

### Processed

- Select useful fields; validate and normalize them into source-specific typed tables.
- Include the relationships and financial/status information needed to explain Refined measures.
- Retain source references and reversible source-deletion state.
- Upsert Processed output and acknowledge the matching Raw revision in one transaction.
- Process pending rows using stable, indexed keyset batches, not full-table arrays or progressively growing offsets.
- Mapping changes require an explicit processing version/replay mechanism so unchanged Raw records can be rebuilt.

### Refined

- Use stable Tamarack dimensions and business facts across systems.
- Avoid double-counting overlapping source coverage through explicit location/date ownership rules.
- Prefer ordinary views when adequate; use materialized views or maintained tables where freshness/performance requires them.
- Refresh dependencies in order and publish a model's freshness only after successful completion.
- Do not drop/recreate materialized views on every refresh. Choose transactional publication or supported concurrent refresh behavior deliberately.
- Default reports to excluding source-deleted records, with explicit business exceptions for historical facts. Source deletion is not automatically a void or refund.

## 5. Historical ingestion and source capabilities

- Configure historical coverage per source/dataset. The resort launch date may be a default where appropriate, but must not manufacture history or override actual availability.
- Manual backfills accept explicit date ranges. Changing a configured start date must not silently reset a live checkpoint.
- Divide large date ranges into bounded windows, initially days where supported.
- Persist progress per dataset and partition, such as location plus date window, so completed work survives restarts.
- Keep backfill progress separate from live incremental progress. Prioritize live freshness and prevent overlapping jobs from racing.
- Use fixed extraction-window boundaries where sources support them, with source-specific overlap/lookback for late changes.
- Historical corrections and refunds may arrive outside a short lookback. Document each source's mechanism for catching them: updated-time queries, periodic re-reads, or explicit correction ingestion.
- An opaque paging cursor is not necessarily durable or stable. Restart its bounded window safely when it expires; do not resume an invalid cursor or claim snapshot consistency the source does not provide.
- Database sources use streaming/keyset queries where supported; file adapters use streaming parsers. Snapshot-only sources declare that limitation rather than inventing watermarks.
- Define maximum page/file-record payload sizes, bounded bulk-write sizes, and concurrency. Avoid buffering a whole file or all API pages. Batch counts alone do not bound memory when an individual response is unbounded.
- For sources without bounded reads, implement a specific safe strategy or reject unsupported volumes explicitly.

## 6. Reconciliation and deletion

- Reconciliation is an explicit source capability, enabled only when a complete inventory of the intended scope can be obtained.
- Incremental responses or date-filtered order lists are not complete deletion inventories.
- Stage inventory keys in PostgreSQL in batches; do not build an unbounded in-memory set.
- Persist snapshot scope and completion. No deletions are applied until the full inventory succeeds and safety checks pass.
- Guard against empty/truncated inventories, excessive deletion ratios, and source instability. Document approved handling of legitimate empty sources.
- Coordinate reconciliation with ingestion and use its snapshot cutoff so new arrivals are not mistaken for missing records.
- Apply corresponding Raw/Processed soft deletes atomically. For large inventories, use bounded transactions with durable progress; do not claim whole-run atomicity if updates commit in chunks.
- Handle reappearance explicitly and preserve internal identities.
- Keep deletion reconciliation disabled for Toast orders until a reliable inventory is verified.

## 7. Central scheduling and execution safety

- One explicit registry defines tasks, enabled state, cron expression, timezone, and source-specific settings.
- Source-level sync cadence is the default; override particular tasks only for concrete requirements.
- A sync coordinates extraction followed by processing. Independent replay/retry tasks use the same processing logic.
- Schedule reconciliation and Refined refreshes independently where needed; do not base their correctness on an in-memory ingest counter.
- `node-cron` triggers tasks but is not a durable queue. On startup, inspect durable progress and resume/re-run eligible work using an explicit catch-up policy.
- Prevent overlap through database-backed locks, not only `node-cron`'s process-local overlap setting.
- Proposed lock strategy: session advisory locks on a dedicated direct PostgreSQL connection held for the execution. Do not use session locks through transaction pooling or release the connection to a pool mid-run.
- Keep the dedicated connection bounded and monitored; on lock-connection loss, abort the job and reject further writes from it. Test this path before allowing multiple workers. Lease/fencing designs are an alternative only if deployment needs justify them.
- Start with one scheduler process and bounded task concurrency. A slow or failing source must not block unrelated sources.
- On shutdown, stop new tasks, cancel remote work as needed, allow bounded in-flight commits, and close connections. Recover abandoned runs on startup.
- A service supervisor restarts the Node process after crashes; cron scheduling alone does not provide process reliability.

## 8. Centralized logging and auditability

Use one structured logging API everywhere. Proposed implementation: a standard JSON logger such as Pino for stdout, with readable output in the experimental environment, plus durable run records in each environment's Neon database.

### Durable metadata

- `Pipeline_Runs`: run ID, task/dataset, operation, trigger, timestamps, status, counts, safe error summary, and configuration/mapping version.
- `Pipeline_State`: durable checkpoints and independently tracked stage freshness.
- `Pipeline_Run_Events`: bounded lifecycle/checkpoint/warning/error events linked to runs.
- `Pipeline_Item_Errors`: source key/revision, processing version, safe error context, and resolution/retry state.

Use explicit foreign keys, delete behavior, indexes for lookups, and retention rules. Run status is historical; current state is not a replacement for an audit trail.

### Logging rules

- Correlate events with run ID, source, dataset, operation, partition, stage, and batch when relevant.
- Log summaries, durations, retries, checkpoints, and failures. Avoid logging every successful record.
- Redact credentials, tokens, connection strings, personal data, and source payloads by default.
- Keep log buffers bounded. Persist selected events in batches, not an unbounded fire-and-forget queue.
- Failure to persist required run/checkpoint/audit metadata fails execution explicitly. Optional diagnostic-event failures are reported to stderr with their durability gap, never silently swallowed or allowed to grow memory indefinitely.
- Capture committed batch counts/progress so crash recovery can explain partial work.
- Expose last successful extraction, processing, and Refined refresh, coverage gaps, pending/error counts, and retry backlog.
- Report freshness follows published data coverage, not merely the most recent job start time.
- Operational logs are not tamper-proof audit history or full source-version retention; do not claim otherwise.

## 9. First business use case

Weekly restaurant net sales versus comparable weeks last year, with a location filter and visible coverage/freshness.

- `Dim_Location`: stable business locations.
- `Dim_Date`: business dates and agreed comparable-period rules.
- `Fact_Restaurant_Transactions`: one original order with split checks combined.
- Source-location mappings and source ownership by location/date.

Verify original-order reconstruction in Toast and Info Genesis before implementing the fact. Agree on sales, discounts, refunds, taxes, service charges, voids, timezone, and business-date meanings. Do not assume payment totals equal sales.

The current Toast mapping does not subtract refunds; the current Info Genesis item mapping has no business date. Existing code is reference material, not verified evidence that these gaps are solved.

## 10. Delivery sequence and acceptance gates

### Phase 1 - Contracts and experimental foundation

- Confirm a pilot restaurant, source access, sample records, historical availability, and metric definitions.
- Set up the isolated experimental database, validated configuration, migrations, structured logger, and test runner.
- Define source keys, extraction-batch contract, run outcomes, and checkpoint semantics.
- Review the old implementation for reusable source knowledge; remove old code only deliberately, not as a prerequisite.
- **Gate:** no operational connection/write path is used accidentally; actual target isolation is verified, and assumptions and unresolved source semantics are documented.

### Phase 2 - Durable ingestion core

- Implement runner, run/state metadata, locks, cancellation, Raw bulk upserts, and transactional checkpoints.
- Add the Toast adapter with bounded location/date/page traversal.
- **Gate:** replay and interrupted-run tests produce no duplicates or skipped records; expired cursors safely replay a window.

### Phase 3 - Processing and first report

- Implement revision-safe processing, item errors, replay, and Processed Toast records.
- Build restaurant Refined models and the chart's reporting query; choose the report UI tool separately.
- **Gate:** a completed day's totals reconcile with a trusted Toast report, including explicit refund/void cases.

### Phase 4 - Historical and second-source proof

- Add Info Genesis extraction, validate its actual keys/relationships, and process historical records.
- Build persistent bounded backfill and location/source coverage mapping.
- **Gate:** totals reconcile for both sources; combined history has no unexplained gaps or overlapping sales.

### Phase 5 - Scheduling and operational readiness

- Register sync, processing retries, backfill continuation, reconciliation where supported, and Refined refresh tasks.
- Implement catch-up, graceful shutdown, freshness summaries, and practical alerts.
- **Gate:** restart, missed schedule, concurrent invocation, source outage, and database outage tests preserve recoverability and accurate status.

### Phase 6 - Broader source reuse and scale

- Add a real CSV/file or database use case to prove the contract beyond REST pagination.
- Refactor demonstrated duplication; keep source exceptions local.
- Define expected volumes, maximum payloads, memory budget, and freshness targets; benchmark against those exact targets.
- **Gate:** a representative historical load stays within the agreed memory budget and does not starve live sync.

## 11. Required verification

Focused offline tests cover:

- Scoped/compound keys, invalid identities, duplicate/replayed records, unchanged and older revisions.
- Commit/checkpoint failure boundaries, retries, cancellation, and interrupted resume.
- Processing replay, one-to-many output where actually needed, and newer Raw revisions arriving during processing.
- Pagination completion, expired/repeated cursors, malformed records, rate limits, and bounded streaming.
- Reconciliation partial inventories, legitimate emptiness, deletion guards, reappearance, and concurrent arrivals.
- Scheduler overlap, timezone, restart/catch-up, and lock-loss behavior.
- Money calculations, refunds, split checks, business dates, and report coverage.

Use integration tests against a separate Neon experimental database for transactions, constraints, locking, and migrations. Use trusted source reports for business reconciliation; unit tests alone cannot validate source accounting semantics.

## 12. Working rules and open decisions

- Before each change, state its outcome, narrow scope, and acceptance check.
- Implement and verify one coherent capability at a time; update this plan and directly related documentation together.
- Treat existing source contracts, database identities, and historical data deliberately; no operational resets or migrations for file moves.
- Do not add abstractions until a concrete shared need demonstrates their value.
- Keep an explicit record of decisions and evidence rather than relying on chat memory.

Resolve before the relevant implementation:

1. Pilot location, trusted comparison reports, and accessible Info Genesis history.
2. Source key uniqueness, version semantics, date windows, and original-order reconstruction.
3. Metric/refund definitions, week alignment, timezone, and source cutover coverage.
4. Latest-state Raw versus required full payload/file history and retention.
5. Per-source cadence, freshness targets, acceptable partial-data publication, and alert destination.
6. Deployment supervisor/hosting, direct Neon lock connection support, and report UI.
7. Realistic volume, payload-size, memory, and backfill throughput budgets.

**Immediate next step:** resolve source identity/metric questions while building the small experimental foundation. Do not start by deleting everything or designing every future integration.