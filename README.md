# Tamarack data pipeline system

A Node.js and TypeScript system for bringing Tamarack's source data into a Neon PostgreSQL warehouse, using Drizzle and the **Raw -> Processed -> Refined** layers. The goal is reliable, reusable pipelines that support clear business insights across source systems.

## Current usable scope

Toast locations can be refreshed as a Raw snapshot, and Toast orders can be loaded into Raw in bounded modification-time windows. The manual `npm run sync -- toast` command refreshes locations first, then ingests orders. Each pipeline can also be run on its own. These commands contact Toast and write to the experimental warehouse; see [command effects](documentation/setup-and-commands.md#commands-and-their-effects) before running them.

Toast orders use **one flow for initial history and ongoing updates**: start at June 1, 2026, midnight UTC if no watermark exists, otherwise reread from one day before the saved watermark. Toast uses windows of up to 28 days; the shared fallback for other callers is seven days. The watermark advances only after all locations in a window finish.

The first Processed table, `processed.locations`, and its Toast mapper are defined. The user confirmed the table exists in the experimental warehouse, but there is no writer or processing command yet. There are no Refined reports or scheduled worker. The existing per-pipeline overlap guard works within one Node process only.

## Safe getting started

1. Use a supported Node.js release with native TypeScript execution; this project uses direct `.ts` execution.
2. Install declared dependencies:

   ```powershell
   npm install
   ```

3. For commands that load application configuration, supply the five required settings described in [setup and commands](documentation/setup-and-commands.md#required-settings). Keep credentials in an ignored local environment file or the deployment secret store. Validate the actual experimental target before connected work.
4. Check the project without accessing source systems or the warehouse:

   ```powershell
   npm run type-check
   node --test .\sandbox\ingestion-executer.test.ts .\sandbox\pipeline-progress.test.ts .\sandbox\ingestion-windows.test.ts .\sandbox\pipeline-orchestrator.test.ts .\sandbox\toast-order-extractor.test.ts .\sandbox\toast-order-pagination.test.ts .\sandbox\toast-response.test.ts
   ```

`npm run build` compiles into `dist/`; it does not start the application or run pipelines. The selected offline tests use synthetic configuration/persistence and do not require credentials.

**Do not run all sandbox files indiscriminately.** Some contact live Toast, some write warehouse metadata or Raw records, and the reset command is destructive. Review [command effects and target protection](documentation/setup-and-commands.md#commands-and-their-effects) first. No operational execution is part of the quick start.

## Documentation and continuation

- [Architecture](documentation/architecture.md): current modules, source configuration, schemas and reliability limits.
- [Data flow](documentation/data-flow.md): extraction, Raw transactions, completed-window checkpoints and failure/replay behavior.
- [Setup, commands and verification](documentation/setup-and-commands.md): configuration, command effects, migrations, reset safeguards and evidence.
- [Next steps](plan/next-steps.md): where to resume and the next acceptance checks.
- [Project plan](plan/project-plan.md): future delivery, business requirements and open decisions.

**Next session:** build the [Processed locations writer](plan/next-steps.md#1-build-the-processed-locations-writer), then run it on its own and check that a rerun is a no-op. No new Toast calls, orders backfill, or additional migration is needed for that step on the verified experimental target.
