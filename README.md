# Tamarack data pipeline system

A Node.js and TypeScript system for bringing Tamarack's source data into a Neon PostgreSQL warehouse, using Drizzle and the **Raw -> Processed -> Refined** layers. The goal is reliable, reusable pipelines that support clear business insights across source systems.

## Current usable scope

Toast locations can be refreshed as a Raw snapshot, and Toast orders can be loaded into Raw in bounded modification-time windows. Use `npm run ingest -- toast` to ingest both, locations first. `npm run sync -- toast-locations` ingests and processes locations. Full `sync -- toast` is unavailable until orders processing is registered; it does not fall back to Raw-only ingestion. See [command effects](documentation/setup-and-commands.md#commands-and-their-effects) before running connected commands.

Toast orders use **one flow for initial history and ongoing updates**: start at June 1, 2026, midnight UTC if no watermark exists, otherwise reread from one day before the saved watermark. Toast uses windows of up to 28 days; the shared fallback for other callers is seven days. The watermark advances only after all locations in a window finish.

`npm run process -- toast-locations` processes all pending Raw locations in bounded transactions, then applies the reviewed location-type mapping even when no Raw work is pending. It writes the warehouse but does not contact Toast or advance the ingestion watermark. The user reported successful processing, repeat execution without duplicates, and application of the location types on the experimental target.

Raw loading handles explicit deletion and restoration flags. Toast Developer Support confirms that order deletions update `modifiedDate` and can be returned with `deleted = true` by modification-time ingestion; retention is unspecified. No separate Toast reconciler is registered, and loss of location access is not proof of deletion. There are no Processed orders, Refined reports or scheduled worker. Workflow overlap protection is process-local.

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
   npm test
   ```

`npm run build` compiles into `dist/`; it does not start the application or run pipelines. Automated tests live in [tests](tests/) and use synthetic configuration/persistence without credentials or live access. Connected checks and experiments remain in [sandbox](sandbox/) and are not included in `npm test`.

**Do not run all sandbox files indiscriminately.** Some contact live Toast, some write warehouse metadata or Raw records, and the reset command is destructive. Review [command effects and target protection](documentation/setup-and-commands.md#commands-and-their-effects) first. No operational execution is part of the quick start.

## Documentation and continuation

- [Architecture](documentation/architecture.md): current modules, source configuration, schemas and reliability limits.
- [Data flow](documentation/data-flow.md): ingestion, processing, deletion boundaries and failure/replay behavior.
- [Setup, commands and verification](documentation/setup-and-commands.md): configuration, command effects, migrations, reset safeguards and evidence.
- [Next steps](plan/next-steps.md): where to resume and the next acceptance checks.
- [Project plan](plan/project-plan.md): future delivery, business requirements and open decisions.

**Resume here:** [tomorrow's first steps](plan/next-steps.md#start-here-tomorrow). Inspect the existing Raw order/check structure, build an orders writer using shared processing, and register it to enable full Toast sync. Build the report as a draft, then compare one completed day against Toast.
