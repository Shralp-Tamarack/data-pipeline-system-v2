# Tamarack Data Warehouse and Pipeline System Plan

## 1. Purpose and scope

Build a clean, reliable Node.js and TypeScript system that keeps Tamarack's Neon PostgreSQL warehouse accurate and fresh across APIs, source databases, CSV/JSON files, and other formats as needed.

This is a foundational system, not only a restaurant-report prototype. The restaurant sales chart is the first end-to-end use case that will prove the foundation. Add reusable capabilities deliberately, without building a plugin platform or speculative framework.

This document is the working reference for implementation. Requirements below are targets, not claims about capabilities already implemented. Proposed defaults can change when source evidence warrants it; record those changes here.

For what has actually been built, read [project documentation](../README.md). For the immediate continuation, read [next steps](next-steps.md). Keep implementation explanations in `documentation/` and future work, open decisions and acceptance gates in `plan/`.

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
- `node-cron` for centralized schedules (chosen, not yet installed or implemented).
- Raw -> Processed -> Refined, with business-oriented Refined models and reports.
- Runtime names use `snake_case`; types and table metadata use `Pascal_Snake_Case`; files use kebab-case.
- Flat shared files in `core/`, with shallow feature/source groups where meaningful.
- Environment names: `experimental` for building and testing; `operational` for the live system in use. Follow the [Cautious Development Standards](../.github/copilot-instructions.md#10-cautious-development-standards) for isolation, target verification, secret handling, and controlled operational changes.

### Current delivery position

As of November 18, 2026, the manual Toast workflow refreshes Raw locations, then ingests Raw orders using the same checkpointed flow for initial history and ongoing updates. Standalone locations processing, revision-safe batches, tracked finalization and the reviewed location-type mapping are implemented. The user reported successful experimental processing and repeat/type-application checks. Combined sync remains Raw-only; there are no Processed orders, Refined reports or scheduled worker.

The shared confirmed-deletion helper is implemented and offline-tested, and `Raw_Record_Input.deleted?` exists. Normal loading does not yet consume that field or restore records; no automatic deletion detector is connected. Continue with [deletion-aware Raw loading](next-steps.md#1-finish-deletion-aware-raw-loading), not a framework rewrite, new backfill or database reset. See [setup and commands](../documentation/setup-and-commands.md#what-has-been-verified) for evidence and outstanding live checks.

## 2. Target architecture

```text
Manual commands / future central node-cron scheduler
                     |
              Source sync workflow
                     |
             Shared ingestion executer
 execution tracking, busy guard, windows, checkpoints
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

The planned central scheduler invokes the same source workflows as manual execution, plus independent reconciliation, processing retries and Refined refreshes where needed. The scheduler decides when; a source workflow orders its own steps. The first orders ingestion naturally loads history; later runs start from the saved checkpoint with a lookback. There is no separate default backfill subsystem.

### Small shared responsibilities

- **Orchestrator:** execution lifecycle, process-local per-pipeline exclusion and outcomes.
- **Ingestion executer:** source-start/watermark selection, fixed run end, sequential windows/batches and completed-window checkpoints.
- **Extraction contract:** an async iterable of bounded record batches; the source adapter owns paging and scope traversal.
- **Raw loader:** validated identities, bulk upserts, revision tracking and atomic committed counts.
- **Processing executer:** drains transactional batches under one tracked execution and supports finalization before success, including no-pending-work executions. Locations supplies the first writer; general mapping-version replay remains planned.
- **Scheduler (planned):** explicit task registry and source cadences; leaves step ordering to the source workflow.
- **Logger:** structured events correlated to durable run history.

Source-specific code owns authentication, endpoint/query details, record identity, paging semantics, source time semantics, and mappings. Reuse an HTTP requester, parser, or loader where behavior actually matches; do not pretend every API paginates or every source supports incremental extraction.

Start with small types and plain functions. No inheritance hierarchy, universal query DSL, unnecessary generics, or automatic discovery of executable jobs.

## 3. Required correctness guarantees

These are acceptance requirements. The current implementation does not enforce all of them; see [implemented reliability boundaries](../documentation/architecture.md#processed-refined-and-reliability-limits).

### Identity and idempotency

- Define each dataset's source key before loading it. Include tenant/location scope and compound-key fields where required; do not assume an order ID is globally unique.
- Enforce identity through database unique constraints. Missing/invalid keys fail validation rather than becoming strings such as `"undefined"`.
- Use at-least-once extraction with idempotent database effects, not an unprovable exactly-once claim.
- Replaying a page, file, date window, or run must not create duplicate logical records.
- Preserve immutable internal IDs and origin fields on updates.
- Compare payload revisions deterministically so unchanged payloads do not trigger needless processing.
- Prevent older backfill data from overwriting newer records using reliable source versions/timestamps where available. If a source has neither, serialize overlapping work and define an explicit re-read policy.

### Durable progress and separate stage freshness

- Commit each Raw batch and its history count in one transaction. After all batches/scopes of a window are durable, save the window watermark and matching history watermark in a separate transaction. A crash before that checkpoint replays the window; never checkpoint ahead of durable records.
- Persist run history separately from mutable dataset state.
- Distinguish extraction progress, processing completion, and Refined publication/freshness.
- Raw extraction may succeed while processing fails; do not label the complete sync successful or the report current in that case.
- Advance a completed ingestion window only after all required pages/partitions are durably loaded, for both initial history and ongoing updates.
- Process a Raw revision and acknowledge that same revision atomically. Never mark a newer revision processed because an older revision finished.
- Do not hold a database transaction open during remote API requests.

### Failure behavior

- Record invalid records and transformation errors with safe context. They remain recoverable and make the run partial/failed, not silently successful.
- Retry transient timeouts, rate limits, and suitable server/database failures with bounded exponential backoff and jitter; honor `Retry-After`.
- Authentication, invalid payloads, mapping bugs, and invalid configuration require explicit handling, not unlimited retries.
- Configure request/query timeouts and cancellation. Propagate cancellation through extraction and processing.
- Use exact decimal storage/calculation for money. Distinguish missing values from legitimate zeroes.

## 4. Raw, Processed, and Refined

### Raw

Retain the chosen latest-state model: one current payload per logical source record. The complete source key includes scope where necessary; there is no mandatory scope column. Reliable source modification/version guards and richer observation metadata remain to be implemented where needed.

- Preserve all fields in the selected source record, including fields not selected for Processed.
- Keep warehouse provenance separate from the source payload; do not replace original source fields for internal naming convenience.
- JSONB preserves source record content, not byte-for-byte file formatting. Retain original file bytes in PostgreSQL only where a concrete audit/replay requirement calls for it.
- Latest-state Raw is not a complete history of every payload version. If full change history is required, decide and implement retention explicitly before relying on it.
- Support reprocessing from Raw without another source request.

### Processed

- Select useful fields and normalize them into typed records with clear source provenance. Keep one location catalog for food and beverage and retail; use a reviewed business classification instead of separate tables. Do not infer the category from the Toast name or metadata.
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

## 5. One ingestion flow and source capabilities

- Each source owns a `data_start_date`. Toast orders uses June 1, 2026, midnight UTC by user choice; confirm actual available history before claiming completeness.
- For configured time-window ingestion, start at the saved watermark minus the lookback (one day by default), otherwise the source's start date, and ingest toward now captured once at run start.
- The first run naturally loads history; later runs naturally load newer changes. Use the same functions, windows, extractor and loader, not separate historical/incremental executers or default backfill progress.
- The shared window fallback is seven elapsed days; Toast orders explicitly overrides it with 28 days. Keep window size separate from lookback and request pacing. Do not introduce automatic resizing without a concrete need.
- Save each fully completed window so interrupted work can safely replay from the last durable boundary. Keep the existing one-row-per-pipeline state unless a concrete requirement justifies finer-grained progress.
- Explicit older-date checks/corrections reuse the same execution code without changing normal progress. Changing `data_start_date` must not reset an existing watermark.
- Finish all required restaurant pages before advancing a shared Toast checkpoint. A newly accessible restaurant needs deliberate earlier-range replay; do not assume existing coverage includes it.
- Use fixed extraction-window boundaries where sources support them, with source-specific overlap/lookback for late changes where evidence requires it.
- Historical corrections and refunds may arrive outside a short lookback. Document each source's mechanism for catching them: updated-time queries, periodic re-reads, or explicit correction ingestion.
- An opaque paging cursor is not necessarily durable or stable. Restart its bounded window safely when it expires; do not resume an invalid cursor or claim snapshot consistency the source does not provide.
- Database sources use streaming/keyset queries where supported; file adapters use streaming parsers. Snapshot-only sources declare that limitation rather than inventing watermarks.
- Define maximum page/file-record payload sizes, bounded bulk-write sizes, and concurrency. Avoid buffering a whole file or all API pages. Batch counts alone do not bound memory when an individual response is unbounded.
- For sources without bounded reads, implement a specific safe strategy or reject unsupported volumes explicitly.

## 6. Reconciliation and deletion

Keep the design simple: **detect a confirmed deletion, mark Raw deleted/pending, process that revision, and exclude the deleted Processed data from analytics.** Use the same path for different sources; only deletion detection needs source-specific knowledge. Prefer small shared functions over a generic reconciliation engine.

The [implemented helper and current limits](../documentation/architecture.md#confirmed-deletion-helper-partial-implementation) are not end-to-end reconciliation. Remaining work:

- Teach normal loading the optional deletion metadata: explicit `true` deletes, explicit `false` restores, omission preserves an existing flag. Payload or effective status changes must queue processing; repeat input must be a no-op.
- Preserve internal identities and original content when marking known IDs deleted. Commit each Raw change and history count atomically.
- Each Processed writer must propagate deletion/restoration and acknowledge the exact Raw revision in its own transaction. Raw and Processed changes are separate stages, not one whole-pipeline atomic transaction. Failed processing leaves pending work and stale downstream state that must be visible.
- Verify source-specific explicit deletion delivery before claiming coverage. A reliable deletion flag/change feed does not require a separate full inventory solely to apply its confirmed deletions.
- For sources that remove records without a deletion signal, compare only a successfully completed, authoritative inventory of the same scope. Incremental/date-filtered responses are not complete deletion inventories.
- Implement bounded identity storage and completion/scope evidence when a concrete inventory use case needs them. Never use Raw `execution_id` as a last-seen marker or buffer an unbounded inventory.
- Guard against truncated/empty inventories, permission/filter changes, excessive deletion counts and concurrent arrivals. Coordinate scans and writes; no missing-record deletions after a failed scan.
- Handle removed children within their verified parent scope when flattening nested records. Keep deletion, void and refund meanings separate.
- Verify report/model filters explicitly; storing `deleted = true` alone does not exclude a row from SQL results.

Toast missing-order reconciliation remains disabled until its inventory or other deletion-detection contract is verified. Complete the next loader step and focused tests before adding source calls or inventory infrastructure.

## 7. Central scheduling and execution safety

- One explicit registry defines tasks, enabled state, cron expression, timezone, and source-specific settings.
- Source-level sync cadence is the default; override particular tasks only for concrete requirements.
- A sync coordinates extraction followed by processing. Independent replay/retry tasks use the same processing logic.
- Schedule reconciliation and Refined refreshes independently where needed; do not base their correctness on an in-memory ingest counter.
- `node-cron` triggers tasks but is not a durable queue. On startup, inspect durable progress and resume/re-run eligible work using an explicit catch-up policy.
- Use the implemented central process-local per-pipeline busy guard for the agreed one-worker deployment. It rejects duplicate exact pipeline names before registering history and releases on every exit.
- Do not run standalone ingestion while the worker is active. Stop the old worker before starting its replacement; different pipeline names may run independently within bounded task concurrency.
- Database-backed whole-execution coordination is deferred, not a prerequisite for the agreed deployment. Revisit it before allowing multiple ingestion processes or overlapping worker replacement; the current guard cannot coordinate them.
- If that requirement arises, review Neon connection/pooling constraints and test coordination loss before multi-process use. Do not add session advisory locks through a transaction-pooled endpoint or introduce leases/fencing without a concrete deployment need.
- A slow or failing source must not block unrelated sources.
- On shutdown, stop new tasks, cancel remote work as needed, allow bounded in-flight commits, and close connections. Recover abandoned runs on startup.
- A service supervisor restarts the Node process after crashes; cron scheduling alone does not provide process reliability.

## 8. Centralized logging and auditability

Keep the implemented Pino logger and durable Neon execution records. Emit JSON by default; `log_format=pretty` is an explicit readability option, not a different warehouse or execution mode.

### Durable metadata

- Extend the existing `system.pipeline_history` only as needed: execution ID, pipeline, operation, trigger, timestamps, status, counts, safe error summary, and configuration/mapping version.
- Retain `system.pipeline_progress` for durable checkpoints and independently tracked stage freshness; do not rename/recreate current database identities.
- Add bounded lifecycle/checkpoint/warning/error event persistence where a concrete operational need requires it.
- Add recoverable record-level error state with source key/revision, processing version, safe context, and resolution/retry state.

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

## 9. Reporting milestones

### First usable chart: Daily Food & Beverage Net Sales

Show one line for daily net sales across reviewed food-and-beverage locations over the latest 30 completed business days, with an optional location filter and a visible `Data through` date. This answers whether recent sales are rising or falling without requiring prior-year data.

- Use the source business date, not the ingestion timestamp. Exclude the current incomplete business day.
- Treat a verified day with no sales as zero; show missing or incomplete coverage as a gap. Do not silently include unclassified locations or assume all expected locations are covered.
- This first chart measures net sales **at F&B locations**, not sales of F&B items across the resort. Item-level categories are needed if mixed outlets must separate food and merchandise.
- Reconcile one completed day at one location against Toast Sales Summary before widening the scope. Agree on the net sales definition, including discounts, refunds, voids, taxes and service charges; do not use payment totals as a substitute.

### Later: Weekly Restaurant Net Sales vs. Last Year

Compare weekly restaurant net sales against comparable weeks last year, with a location filter and visible coverage/freshness. Add this once comparable prior-year coverage is verified; missing prior-year periods are unavailable, not zero.

- `Dim_Location`: stable business locations.
- `Dim_Date`: business dates and agreed comparable-period rules.
- `Fact_Restaurant_Transactions`: one original order with split checks combined.
- Source-location mappings and source ownership by location/date.

Verify original-order reconstruction in Toast and Info Genesis before implementing the fact. Agree on sales, discounts, refunds, taxes, service charges, voids, timezone, and business-date meanings. Do not assume payment totals equal sales.

The Toast mapping in the previous project does not subtract refunds; its Info Genesis item mapping has no business date. That code is reference material, not evidence that these gaps are solved. This project has a working locations writer and reviewed type mapping but no Processed order mapping or verified financial model yet.

## 10. Delivery sequence and acceptance gates

### Phase 1 - Contracts and experimental foundation

- Retain the completed configuration/schema/execution/read foundation; do not rebuild it.
- Verify the actual experimental target and required applied migrations before the next write.
- Retain the user-reported bounded Raw load/replay and synthetic mutation/rollback evidence; do not repeat completed work as a prerequisite without a new reason.
- Confirm complete source keys, source versions, historical availability, and metric definitions; a pilot and read samples already exist.
- Retain the implemented structured logging; add test support where the next concrete behavior needs it.
- Review the old implementation for reusable source knowledge; remove old code only deliberately, not as a prerequisite.
- **Gate:** actual target isolation is verified; the bounded Raw proof passes without watermark changes; source assumptions and unresolved business semantics are documented.

### Phase 2 - Durable ingestion core

- Retain the implemented shared windows/executer, per-pipeline busy guard, Toast pagination/all-restaurant traversal and completed-window checkpoint code.
- Verify connected checkpoint transactions and fresh-process resumption with synthetic records without moving real Toast progress.
- Retain the implemented Toast retries, token-expiry handling and byte/rate bounds. Verify historical coverage, late-change handling and source-version safeguards before unattended operational use.
- **Gate:** connected replay, checkpoint failure and interrupted-run tests produce no duplicates or skipped coverage; history/counts stay accurate. Full source history requires separate approved verification.

### Phase 3 - Processing and first report

- Retain the completed locations writer and mapping finalization, focused offline transaction/failure tests, and basic user-reported experimental processing/repeat results. Real PostgreSQL revision/concurrency and rollback checks remain separate evidence gaps.
- Finish deletion-aware Raw loading, source detection and Processed propagation/restoration before relying on financial reports. Reuse the confirmed-deletion helper; add complete-inventory comparison only for a verified source scope that needs it.
- Then implement Processed orders, mapping-version replay and record-error handling as needed. Reconcile one completed day/location before expanding.
- Build the Refined daily net sales query and 30-day F&B trend chart; choose the report UI tool separately. Defer the year-over-year chart until comparable history is verified.
- **Gate:** a completed day's totals reconcile with a trusted Toast report, including explicit refund/void cases, and the chart distinguishes missing coverage from verified zero sales.

### Phase 4 - Historical coverage and second-source proof

- Add Info Genesis extraction, validate its actual keys/relationships, and process historical records.
- Reuse source-start/watermark ingestion for initial history and ongoing updates; add location/source coverage mapping and explicit older-range corrections only where needed.
- **Gate:** totals reconcile for both sources; combined history has no unexplained gaps or overlapping sales.

### Phase 5 - Scheduling and operational readiness

- Register ingestion continuation, processing retries, reconciliation where supported and Refined refresh tasks.
- Implement catch-up, graceful shutdown, freshness summaries, and practical alerts.
- **Gate:** restart, missed schedule, concurrent invocation, source outage, and database outage tests preserve recoverability and accurate status.

### Phase 6 - Broader source reuse and scale

- Add a real CSV/file or database use case to prove the contract beyond REST pagination.
- Refactor demonstrated duplication; keep source exceptions local.
- Define expected volumes, maximum payloads, memory budget, and freshness targets; benchmark against those exact targets.
- **Gate:** a representative historical load stays within the agreed memory budget and does not starve live sync.

## 11. Required verification

Existing offline tests live in `tests/` and run through `npm test`; connected/ad hoc checks remain in `sandbox/` and are excluded. Coverage includes windows, Toast pagination/response bounds/retries, process-local overlap, ingestion/checkpoints, CLI routing, processing/finalization, type-application failure/replay, and confirmed Raw deletion. The reset-guard suite uses fake persistence. See [verification evidence](../documentation/setup-and-commands.md#what-has-been-verified) for actual command results; normal-loader deletion/restoration is not yet implemented or tested. Broader required cases below are not all implemented:

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
- Implement and verify one coherent capability at a time, explain changes for user review, and batch documentation/planning refreshes only when explicitly requested.
- Keep source access, warehouse mutations and operational actions separately authorized; a code-edit request does not authorize connected execution.
- Treat existing source contracts, database identities, and historical data deliberately; no operational resets or migrations for file moves.
- Do not add abstractions until a concrete shared need demonstrates their value.
- Keep an explicit record of decisions and evidence rather than relying on chat memory.

Resolve before the relevant implementation:

1. Trusted pilot comparison reports and accessible Info Genesis history; pilot Toast read access is established.
2. Source key uniqueness, version semantics, date windows, and original-order reconstruction.
3. Metric/refund definitions, week alignment, timezone, and source cutover coverage.
4. Latest-state Raw versus required full payload/file history and retention.
5. Per-source cadence, freshness targets, acceptable partial-data publication, and alert destination.
6. Deployment supervisor/hosting and report UI; cross-process database coordination only if the one-worker assumption changes.
7. Realistic volume, payload-size, memory, and backfill throughput budgets.

**Immediate next step:** finish [deletion-aware Raw loading](next-steps.md#1-finish-deletion-aware-raw-loading), preserving explicit-status versus omitted-status semantics and the existing context guard. Add focused offline tests before connecting source detection. No new migration, source call, backfill or warehouse mutation is needed for that edit. Keep combined sync's Raw-only behavior unchanged until processing integration is deliberately requested and tested.