# Next implementation steps

## Where we stopped

As of the November 13, 2026 documentation refresh:

- Shared ingestion, bounded Toast pagination/Raw loading, and a one-process per-pipeline busy guard are implemented.
- Initial history and ongoing ingestion use one flow and one pipeline watermark.
- Each source owns its `data_start_date`; Toast starts at January 1, 2026, midnight UTC when no watermark exists.
- Configured Toast orders ingestion covers all discovered restaurants before checkpointing each window.
- Type-check and the selected 39 offline tests passed. Prior connected checks were user-run; full evidence is in [setup and commands](../documentation/setup-and-commands.md#what-has-been-verified).
- Connected completed-window checkpoint/restart behavior and full historical Toast ingestion have **not** been verified.

Read [architecture](../documentation/architecture.md) and [data flow](../documentation/data-flow.md#4-resumable-ingestion) before continuing. No reset, new schema or migration is required by the latest ingestion changes.

## 1. Verify checkpoints and restart against the experimental warehouse

**Next coding task:** add a focused synthetic connected check for configured ingestion. Do not start by running all historical Toast data.

Use a dedicated synthetic pipeline/Raw table or another explicitly reviewed isolated fixture. Do not advance the real `toast_orders` watermark with synthetic records; doing so could skip source data on the next real run. Review any fixture DDL before applying it, and preserve unrelated warehouse state.

The existing [executer check](../sandbox/check-ingestion-executer.ts) verifies explicit-range work and intentionally leaves progress unchanged. It is not the new connected checkpoint check.

### Acceptance checks

1. With no watermark, extraction starts at the source's `data_start_date`.
2. Each completed window saves matching progress/history boundaries after all required pages/scopes finish, including a valid empty-data window.
3. A second-window or later-restaurant failure retains the first completed checkpoint and already committed Raw batches.
4. A fresh process resumes at the saved boundary, replays incomplete work without duplicate identities, and does not re-fetch completed windows.
5. A checkpoint transaction failure cannot leave progress ahead of history or durable data.
6. Success, failure and cancellation retain accurate committed-change counts and honest status.
7. Explicit-range checks do not advance normal progress.
8. Cleanup targets only named synthetic fixtures; preserve real progress/history/source records.

Before connected execution, the user approves the actual experimental target, fixture scope and mutations. Use synthetic data, verify actual database/credential isolation, and keep one writer. Report any incomplete verification honestly; offline fake persistence is not proof of PostgreSQL transaction behavior.

## 2. Prepare a controlled real Toast ingestion

After the connected checkpoint gate:

- Reconfirm the desired `data_start_date`, accessible restaurants and any preexisting watermark/context. Do not silently reset them.
- Confirm historical availability and modification-time behavior. January 1 is the user-selected default, not independently verified source history.
- Bound the first approved run's work/cancellation budget and source request rate. Loading from January to now can make many requests with the current ten-record pages.
- Add required bounded transient retries, `Retry-After` handling, token-expiry handling and authentication response bounds before relying on unattended long-running work.
- Decide source-version and late-change correction behavior from source evidence; do not claim complete freshness from a changing pagination stream alone.
- Handle changing restaurant scope deliberately: a new accessible restaurant needs older-date replay, not silently inheriting previous all-restaurant coverage.
- Verify saved coverage, Raw identities/counts, and interruption/resume before authorizing broader history or operational use.

Keep the default model simple: **saved watermark or source start -> captured now -> completed-window checkpoints**. No separate historical executer or default backfill state.

## 3. Build useful Processed records

Agree on trusted source comparisons, original-order/split-check relationships, business dates/timezones, exact monetary values, discounts, refunds, voids, taxes and service charges.

- Define the first concrete Processed table using the existing metadata builder and explicit business identities/indexes.
- Implement bounded pending-record selection and a specific mapper.
- Commit output and acknowledgment of the exact Raw revision together.
- Prove newer revisions stay pending and mapping-version replay works.
- Record recoverable failures with safe diagnostic context.

**Gate:** a completed day's results reconcile to a trusted Toast report. Payment totals are not automatically net sales.

## 4. Scheduling, second-source proof and operational readiness

- Add the chosen `node-cron` dependency only when implementing the scheduler; use an explicit registry and one supervised worker.
- Reuse the same ingestion functions for scheduled and manual invocation.
- Add bounded shutdown, catch-up, abandoned-history recovery, structured safe diagnostics and practical freshness alerts.
- Preserve the one-process guard: no standalone ingestion while the worker runs; stop the old worker before its replacement starts. Revisit database-wide coordination only if multiple processes become a requirement.
- Prove reuse with a second integration and later a real file/database case before generalizing.
- Build business-oriented Refined models, reporting queries and published freshness after Processed correctness.

See the [project plan](project-plan.md#10-delivery-sequence-and-acceptance-gates) for broader gates. Operational schedules, migrations, corrections, resets and historical runs require specific target/scope approval and recovery preparation.

## Working agreement

The assistant implements requested code changes and explains what changed and why for user review. Source access and consequential database/operational actions need separate authorization. Refresh documentation/plans in an explicitly requested batch, not as a routine per-step chore.
