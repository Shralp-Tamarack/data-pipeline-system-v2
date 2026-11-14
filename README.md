# Tamarack data pipeline system

A Node.js and TypeScript system for bringing Tamarack's source data into a Neon PostgreSQL warehouse, using Drizzle and the **Raw -> Processed -> Refined** layers. The goal is reliable, reusable pipelines that support clear business insights across source systems.

## Current usable scope

Toast orders can be extracted in bounded modification-time windows and loaded into Raw with replay-safe identities and transactional committed-change counts. Configured ingestion uses **one flow for initial history and ongoing updates**: start at the saved pipeline watermark, otherwise the source's `data_start_date`, and work toward the time captured at run start.

Toast's configured start is **January 1, 2026, midnight UTC**. Its configured ingestion covers all discovered restaurants before checkpointing each window. Checkpoint/resume behavior has passed offline synthetic tests; connected checkpoint persistence and the full historical load have **not** been verified.

There are no concrete Processed business tables, Refined models, reports, scheduled worker or application start command yet. `node-cron` is the chosen scheduler, not an installed or implemented capability. Same-pipeline overlap protection works within one Node process only.

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

**Next session:** verify completed-window persistence and restart/replay against an explicitly approved experimental warehouse, using synthetic records before any full historical Toast run. No reset or migration is required by the latest ingestion changes.
