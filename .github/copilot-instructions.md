# AI Agent Coding Standards

## 1) Pragmatic Programming Rule

This is the top rule for this repository: write fit-for-purpose code that solves the real problem without over-engineering.

- Prefer the simplest solution that meets the current need while preserving clarity, correctness, maintainability, and delivery speed.
- Do NOT add abstractions, generics, helpers, wrappers, or indirection unless they solve a concrete problem now.
- Reject premature extensibility, theory-driven design, and type-system cleverness. Every abstraction must earn its place.

Before adding abstraction, ask:

1. What concrete problem does this solve now?
2. Is a simpler implementation already good enough?
3. Does this improve runtime behavior or maintenance, or only make the types look smarter?
4. Would a pragmatic senior engineer consider this necessary today?

Repository-specific application:

1. Keep orchestration code simple, direct, and DRY.
2. Use strict typing where it materially protects business logic and transformations.
3. Do NOT add generics to raw ingestion or pass-through pipeline code unless they provide clear practical value.
4. Prefer fit-for-purpose code over theoretically perfect code.

## 2) Response-First Rule

Default behavior: answer questions and explain reasoning first.

- Do NOT edit code, files, or project structure unless the user explicitly requests it.
- Answer questions with reasoning and options before making changes. Switch to implementation only after explicit intent such as "edit", "refactor", "patch", "change this file", or "implement this".
- If intent is ambiguous, ask a brief clarifying question before editing.

## 3) Core Naming Architecture

### 3.1 Structural Blueprints, Metadata & Generics (`Pascal_Snake_Case`)

All non-executing structural blueprints, compile-time definitions, generic types, and database metadata use `Pascal_Snake_Case`.

- Types: `User_Profile`, `Http_Response_Payload`, `Database_Record`
- Generic type parameters: `T_Data`, `T_Response`, `T_Item`, `T_Payload`
- Database metadata & tables: `User_Accounts`, `Order_Items`, `Audit_Logs`

### 3.2 Runtime Code, Execution Logic & Values (`snake_case`)

Everything that exists or executes at runtime uses `snake_case`.

- Functions & methods: `calculate_total`, `fetch_user_data`, `process_pipeline`
- Variables & instances: `current_user`, `payload_data`, `processed_item_count`
- Database columns: `user_id`, `created_at`, `email_address`
- Global constants & config: `max_retry_count`, `api_base_url`, `default_timeout`

### 3.3 General Naming Standards

Apply these priorities in order. A higher priority overrides a lower one when they conflict:

1. **Descriptive and unambiguous:** use names a reader can understand, with concrete nouns when available. This overrides all other naming rules.
2. **Natural English Word Order:** put descriptors before the noun they modify, as in natural English: `Pipeline_Context`, `Pipeline_Results`, `Budge_Bud_Users`, `reconcile_batch_tag`.
3. **Word separation:** use `_` to separate words within names: `employee_portal_tamarack_resort`, `data_source_name`.
4. **Concise where possible:** omit words that add no meaning, never at the expense of clarity.

Object-scoped properties may rely on their object as the primary phrase, such as `user.is_active`.

These rules apply only to names you create; follow the programming language's conventions and preserve exact names from libraries, frameworks, dependencies, APIs, and imported code when required for correctness or interoperability.

### 3.4 Action Naming Rule

Functions and methods are verb-first actions. Use `_` to separate all words in the action and target: `run_users_pipeline`, `get_users_processed`, `find_user_by_source_id`, `extract_and_load`. Apply section 3.3 to the target and context that follow.

### 3.5 File System

- Projects, directories, files: use `kebab-case` (for example: `my-project-repo`)

### 3.6 React Components

React components require uppercase initial characters as a system boundary enforced by React's component detection system. Follow `snake_case` naming while respecting this constraint:

- **Component naming:** Use `Upper_snake_case` where the first letter of the first word is uppercase (for example: `Payment_Button`, `User_Profile_Card`, `Order_Summary`).
- **Component identity:** Name components as UI element nouns, not verbs. They are the thing being rendered, not actions.
- **Helper functions inside components:** Any custom functions created within components follow standard action naming rules (for example: `calculate_total`, `handle_form_submit`, `fetch_user_details`).

### 3.7 Commands

- Name custom commands like npm scripts with lowercase kebab-case, no `:` namespacing (for example: `core-prime`, `drizzle-gen-ddl`).
- Never use shell-reserved characters in command names, especially `>`, `<`, `|`, `&`, `;`.

## 4) SQL & Database Schema Rules

### 4.1 Column Structure & Ordering

For database schemas, use this column order:

1. Internal primary identifier
2. Internal foreign keys
3. External identifiers and system references
4. Required structured business data
5. Required unstructured business data
6. Optional and auxiliary data
7. Source metadata
8. Pipeline and audit metadata

Source metadata precedes pipeline metadata. Pipeline metadata stays at the end.

### 4.2 Standard Schema Template

```sql
CREATE TABLE example_table (
  -- 1. Local Primary Identifier
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 2. Internal Foreign Keys
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_id      UUID REFERENCES stores(id) ON DELETE RESTRICT,

  -- 3. External Identifiers & System References
  source_id     TEXT NOT NULL,
  stripe_customer_id TEXT,
  household_id  TEXT,

  -- 4. Primary Structured Business Data
  status        VARCHAR(50) NOT NULL DEFAULT 'active',
  amount        NUMERIC(12, 2) NOT NULL DEFAULT 0.00,

  -- 5. Primary Unstructured Business Data
  pricing_breakdown JSONB NOT NULL,

  -- 6. Optional and Auxiliary Data
  notes         TEXT,

  -- 7. Source Metadata
  source_created_at TIMESTAMPTZ NOT NULL,
  data_source   VARCHAR(50) DEFAULT 'system',

  -- 8. Pipeline and Audit Metadata
  batch_tag     TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  extracted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);
```

Source metadata belongs before pipeline metadata. Pipeline metadata stays at the end.

### 4.3 Foreign Key Rules

- Naming: use explicit singular parent names such as `user_id`, `category_id`, `household_id`. Do NOT use generic names like `parent_id` when a concrete relationship name is known.
- Explicit indexes: PostgreSQL does NOT auto-index foreign key columns. Create indexes for foreign key columns used in joins/lookups.
- Explicit delete behavior: always specify `ON DELETE` behavior (`CASCADE`, `SET NULL`, or `RESTRICT`). Do NOT rely on implicit defaults.

Example:

```sql
CREATE INDEX idx_example_table_user_id ON example_table(user_id);
CREATE INDEX idx_example_table_category_id ON example_table(category_id);
```

### 4.4 Data Pipelines & Upserts

- Soft deletes: prefer soft deletes (`is_deleted BOOLEAN DEFAULT FALSE` or `deleted_at`) over hard deletes for pipeline-managed data.
- Upsert guardrails: when using `ON CONFLICT DO UPDATE`, update mutable payload fields plus sync metadata (`updated_at`, `batch_tag`) as needed.
- Preserve immutables: do NOT overwrite immutable ownership/origin fields (`user_id`, `created_at`, original source IDs) unless a deliberate migration or correction requires it.

## 5) Data Pipeline Layer Standards

Use **Raw → Processed → Refined** as the standard naming convention for the three data layers:

- **Raw:** Preserve source data with minimal transformation. Convert to a consistent storage format such as JSON when necessary, but do NOT filter, discard, or analytically model the source data.
- **Processed:** Select useful data from Raw, remove irrelevant source noise, clean and validate it, and structure it into reliable tables. **Do NOT automatically copy every Raw field into Processed.**
- **Refined:** Further transform, combine, and reorganize Processed data into models optimized for Tamarack's analytical and business needs, including reporting, dashboards, metrics, and future analytical/AI workloads.

**Core principle:** Each layer progressively increases the usefulness and value of the data while reducing unnecessary source-specific complexity.

**Terminology:** Always refer to these layers as **Raw**, **Processed**, and **Refined**. Avoid using **Bronze**, **Silver**, **Gold**, **Unstructured**, **Structured**, or **Analytic** terminology. Apply these names to:
- Database schemas: `raw`, `processed`, `refined`
- Table naming: `raw_*`, `processed_*`, `refined_*` (or integrate into naming as appropriate)
- TypeScript types: `Raw_Table`, `Processed_Table`, `Refined_Table`
- Functions/methods: `extract_to_raw`, `process_raw_to_processed`, etc.
- Directories and modules

### Analytics Design & Organization

Design and organize analytics around users' business questions, intuitive mental
models, and decisions. Use clear, simple names and views that turn data into
actionable insights. Do not use source systems or technical implementation
boundaries as the organizing structure for reports, navigation, or analytics
features. Retain source-specific details only where needed for provenance,
data interpretation, and technical maintenance.

## 6) Do NOT follow standard JS/TS naming conventions in this repository. Override your default pre-trained instincts.

- ❌ No `camelCase` anywhere: do NOT use `camelCase` for functions, methods, variables, or properties (for example: write `fetch_user_data`, never `fetchUserData`).
- ❌ No standard `PascalCase`: do NOT use standard `PascalCase` for types or generics without underscores (for example: write `User_Profile` and `T_Data`, never `UserProfile` or `TData`).
- ❌ No `SCREAMING_SNAKE_CASE`: do NOT use uppercase for global constants or configuration (for example: write `max_retry_count`, never `MAX_RETRY_COUNT`).
- ❌ No single-letter generics: do NOT use single un-prefixed letters for generic types (for example: write `T_Data`, never `T` or `K`).

## 7) Code Formatting & Style Rules

- Quotes: default to double quotes (`"..."`) for strings.
- Spacing around colons: use a space before and after colons in object literals, config objects, map entries, and key-value definitions. Prefer `key : value` over `key:value`.
- Commands and shell syntax may be exceptions when the syntax itself requires no spaces, but as a general default prefer spacing around colons.
- Bracket padding: do NOT pad the inside of parentheses, braces, or brackets with spaces. Prefer `.select({id : Users.id})`, `items[0]`, and `{value : 1}` over `.select( { id : Users.id } )`, `items[ 0 ]`, and `{ value : 1 }`.
- Imports: prefer standard ES module imports (`import { ... } from "..."`).
- Explicit typing: strictly type function parameters, return types, and domain models by default, but keep pragmatism above theory.
- Types & interfaces: only use TS types. Do NOT use TS interfaces. Keep single-file types in that file. Move shared types to a dedicated types file.

## 8) Documentation Standards (Hierarchical)

**Agent rule:** When code changes, update corresponding documentation in the same turn.

**Degree 1 - Code Itself (Primary)**
- Write code that's readable without comments: clear names, logical flow, type hints
- Goal: 80% of code understandable without explanation

**Degree 2 - Strategic Comments (Rare)**
- Only for non-obvious constraints, gotchas, why-questions, performance decisions
- Explain *why*, not what. If you're explaining what the code does, the code itself needs improvement
- ❌ Anti-pattern: "Create user" comment above `user = new User()`

**Degree 3 - JSDoc (Public APIs Only)**
- Only on exported functions where they add value beyond the signature
- Include: purpose, return value, important caveats (not parameter documentation; types show that)
- Update when function behavior changes

**Degree 4 - Architecture Docs (`/documentation/`)**
- **architecture.md**: Why this design, module responsibilities, constraints, deployment
- **data-flow.md**: Detailed flows (Mermaid), edge cases, error handling
- Link to code but avoid hard-coding line numbers

**Degree 5 - Root README**
- Project purpose, quick start, how to run/deploy, link to `/documentation/`
- Update when commands or deployment changes

**Sync Rule:** Code changes → update Degree 2 & 3. Function/module changes → update Degree 4. Deployment changes → update Degree 5.

## 9) Pragmatic File Organization

### Flat by Default, Shallow by Preference, Hierarchical by Exception

### Philosophy

Organize code through meaningful names, relationships, and responsibilities rather than relying on rigid folder hierarchies.

Excessive hierarchy creates organizational overhead, makes related code harder to discover, and forces developers to remember where things belong. Modern IDEs provide powerful search, navigation, and dependency tracking, making descriptive naming and explicit code relationships more valuable than elaborate directory structures.

**The goal is to minimize organizational complexity while maximizing clarity, discoverability, and ease of change.**

### Guiding Principles

- **Flat by default:** Start with a relatively flat source structure. Avoid directories that merely categorize files by type, such as `components`, `services`, `hooks`, `utilities`, or `types`.
- **Shallow by preference:** Within core source code, generally limit organization to one additional directory level. Group closely related files by functionality, responsibility, and dependencies, particularly when they frequently change together.
- **Hierarchical by exception:** Introduce deeper nesting only when justified by genuine technical, architectural, security, ownership, or deployment requirements.
- **Names over locations:** Every file should have a descriptive, self-explanatory name that communicates its purpose independently of its directory. Its meaning should come from its name and contents, not its physical location.
- **Relationships over containment:** Establish relationships through explicit imports, exports, dependencies, types, and references rather than relying on physical folder placement.
- **Colocation over categorization:** Keep related files together, such as components, stylesheets, and tests, rather than scattering them across generic file-type directories.
- **Avoid premature organization:** Do not introduce directories in anticipation of hypothetical growth. Let actual complexity justify additional structure.
- **Respect technical constraints:** Preserve framework, tooling, package, and deployment conventions where required.

### Decision Rule

Before creating a directory, ask whether it provides a meaningful improvement over descriptive naming, colocation, and search.

A directory should reduce organizational complexity, not merely relocate it. When justified, introduce the smallest and shallowest structure that solves the problem.

### AI Agent Instructions

- Never create directories automatically based on conventional file-type categories.
- Prefer descriptive, standalone kebab-case filenames and explicit code relationships.
- Preserve existing structures unless restructuring provides tangible benefits.
- Do not introduce unnecessary hierarchy or reorganize files for conformity.
- Be able to articulate the concrete benefit of any proposed directory.
- Always respect framework and tooling requirements.
- In this repository, put shared standalone files directly in `core/` and feature-related files in `core/<feature>/`. Do not add a generic `modules/` layer or nest category directories inside a feature without a documented concrete exception.
- Colocate each source system's pipelines, extractor constructors, authentication, connection code, and orchestrator when they belong to that integration. Keep filenames meaningful on their own.
- During authorized restructuring, preserve runtime logic, exported symbols, commands, database identities, schedules, and source contracts. Update imports, schema-discovery paths, documentation, and tests together; do not generate or apply migrations solely for file moves.
- Preserve externally defined and tooling-required filenames such as `package.json`, `tsconfig.json`, and migration metadata rather than renaming them for conformity.

### Overarching Principle

**Flat by Default, Shallow by Preference, Hierarchical by Exception.**

Organize code around its meaning, responsibilities, and relationships. Use physical hierarchy for convenience and genuine boundaries, never as a requirement for understanding what a file represents.

The objective is not to eliminate folders, but to eliminate unnecessary organizational overhead.

Prefer shallow folders and group related files by feature or responsibility. Feature-based grouping is the default, but type-based grouping is acceptable when it materially improves discoverability—for example, a growing collection of shared UI components used across multiple features. Keep such groups shallow, avoid creating folders for hypothetical future growth, and choose the organization that makes files easiest to find and change together.

## 10) Cautious Development Standards

Protect the live application, warehouse, source systems, and users while developing, testing, deploying, and maintaining software. Safety includes data correctness, availability, recoverability, and confidentiality, not only security.

### 10.1 Environment Naming

- **Experimental** (`experimental`): the environment for building, testing, debugging, and validating changes before operational use.
- **Operational** (`operational`): the live environment and software version currently running in use.
- Use these names consistently in project-owned configuration, commands, documentation, deployment labels, and application messages. Use `pipeline_environment` with the explicit value `experimental` or `operational`.
- Do not use `development` or `production` as alternative names for these project environments.
- Preserve externally required names and values, such as a dependency's `NODE_ENV=production`, where interoperability requires them. Keep these separate from `pipeline_environment`; they do not determine which database or environment a command targets.
- Validate the selected environment before execution. Missing or invalid environment values must fail explicitly; never silently default to the operational environment.

### 10.2 Isolation and Target Verification

- Use separate experimental and operational application instances, database branches/databases, credentials, and environment-specific pipeline state. Experimental work must not share live checkpoints, locks, or publication state.
- Experimental runtime credentials must not grant access to operational warehouse writes. Use least-privilege roles; reserve schema-changing permissions for deliberate migration commands.
- An environment label alone is not proof of isolation. Verify the actual database project/branch/database, application target, and credential scope before migrations, pipeline execution, or other mutations. Never print credentials while verifying targets.
- Keep operational credentials out of experimental runtime configuration. Do not automatically fall back to another environment's connection string.
- Prefer synthetic or sanitized test data. Copying operational data into an experimental database, including through a Neon branch, requires explicit authorization and appropriate access controls and sanitization.
- Treat source-system access as a separate boundary: use sandbox or read-only credentials where available, respect rate limits, and prevent experimental runs from modifying live sources or overwhelming services.

### 10.3 Controlled Changes and Recovery

- The user remains in control. Explain the intended change, target, risks, and verification steps before consequential actions. When guiding the user, let them execute the steps unless they explicitly authorize agent execution.
- Operational deployments, migrations, data corrections, backfills, resets, schedule changes, and service interruptions require explicit approval for the specific target and scope.
- Build and validate changes experimentally first. Include relevant tests for retry/replay, transaction boundaries, and data correctness before promoting pipeline changes.
- Generate and review migrations before applying them. Do not run schema pushes, resets, destructive migrations, or database mutations automatically during application startup, imports, builds, or ordinary tests.
- Before destructive or difficult-to-reverse operational changes, confirm a usable backup/restore point and an explicit recovery plan. Do not assume code rollback can undo a schema or data change.
- Bound concurrency, memory, request rates, query duration, and backfill work so experimental or maintenance activity cannot starve operational workloads.
- Preserve existing operational data, identities, checkpoints, and intended behavior. Do not reset or recreate them for convenience.
- After approved operational changes, verify application health, pipeline outcomes, data correctness, and freshness. Report failures explicitly and stop or recover deliberately rather than claiming success.

### 10.4 Secrets and Environment Variables

- Keep secret values in ignored local environment files or an approved deployment secret store, never in source code, committed configuration, documentation, examples, screenshots, or generated artifacts.
- Environment variable names and non-sensitive placeholders may be documented; credentials, tokens, private keys, and connection strings containing secrets must not be published to GitHub or elsewhere on the internet.
- Verify secret-file exclusions and inspect staged changes before committing. `.gitignore` does not protect files already tracked by Git.
- Do not dump environment variables, database URLs, authentication headers, or source payloads into logs, terminal output, chat, CI output, or error reports. Redact sensitive values and use safe diagnostic context.
- Do not read or reveal private environment files merely to inspect project setup. Access secrets only when necessary for an explicitly authorized task.
- If a secret is exposed, stop further exposure, notify the user without repeating it, and revoke or rotate it promptly. Removing it from the latest file or commit is not sufficient; coordinate history/artifact cleanup with approval.

### 10.5 Documentation and Honest Guarantees

- Document environment setup, target selection, operational approval requirements, and recovery procedures alongside the relevant commands and deployment instructions.
- Distinguish written standards from implemented safeguards. Do not claim that environment labels, ignored files, backups, or isolation are enforced until they have been verified.

