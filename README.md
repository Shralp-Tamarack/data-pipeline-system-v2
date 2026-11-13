# Project documentation

This folder explains **what exists now and how it works**. The [development plan](../plan/project-plan.md) describes future requirements; [next steps](../plan/next-steps.md) gives the immediate implementation sequence.

## Returning to the project

1. Read the status below.
2. Read [data flow](data-flow.md) to understand the execution and transaction boundaries.
3. Open [next steps](../plan/next-steps.md) and work through the first unfinished gate.
4. Consult [architecture](architecture.md) for schema/module decisions and [setup and commands](setup-and-commands.md) before running anything.

## Current implementation

| Area | Built | Still missing |
| --- | --- | --- |
| Project foundation | Strict TypeScript, native Node `.ts` execution, compiled output, validated configuration, PostgreSQL pool and Drizzle | A supervised application entry point and deployment setup |
| Execution metadata | One progress row per pipeline, historical attempts, start/completion helpers, callback orchestrator | Whole-execution locks, recovery, cancellation propagation, automatic stage-progress updates |
| Raw | Shared table constructor, `raw.toast_orders`, transactional batch upserts and committed-change counts | A connected Toast-to-Raw check, verified replay/rollback, source-version protection, completed-window checkpoints |
| Processed | Schema and reusable identity/metadata column builders | Concrete business tables, mappers, revision-safe processing and replay |
| Toast | Authentication, restaurant discovery, one bounded order page | Full pagination, modification-time windows, token reuse, bounded retries |
| Refined and reporting | Business goals in the plan | Models, metric reconciliation and reporting |
| Scheduling | Reserved scheduler file | `node-cron` dependency, registry and scheduler implementation |

This is **not yet an end-to-end ingestion system**. The Raw loader exists separately from the Toast reader; no sandbox currently connects them. Reading ten orders does not prove complete ingestion or report freshness.

## Verification evidence

During this documentation refresh:

- `npm run type-check` passed, including the newly added Raw loader.
- `node --test .\sandbox\toast-response.test.ts` passed all four offline tests.
- No live source requests, warehouse queries, migrations or data writes were executed.

Earlier in the walkthrough, the user reported successful warehouse connectivity, progress registration, execution lifecycle and orchestrator checks, Toast authentication, discovery of 18 restaurants, and a page containing 10 orders. These are manual observations, not automated coverage of the complete pipeline. The orchestrator check's committed count is synthetic metadata, not evidence of a Raw load.

Three migration SQL files are generated. Live migration application and actual database/credential isolation were not independently rechecked during this refresh. Confirm them before the next warehouse write.

## First unfinished step

Build and manually verify the bounded Toast-to-Raw sandbox check described in [next steps](../plan/next-steps.md): establish the restaurant/order source key, load one page, replay the **same fetched payload**, and verify stable identities, zero-change replay and atomic counts. Leave the ingestion watermark unchanged.

## Maintenance

Keep these documents factual and synchronize relevant plans when implementation changes. Follow [the documentation standards](../.github/copilot-instructions.md#8-documentation-standards-hierarchical); do not rely on conversation history as the only record.
