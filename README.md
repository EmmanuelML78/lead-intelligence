# Lead Intelligence Hub

MVP for the Analista IA technical assessment. It turns raw multi-channel leads into an explainable, prioritized daily workload per advisor.

## Business goal

Prioritize scarce commercial capacity using three signals:

1. historical propensity;
2. intent extracted from WhatsApp;
3. operational urgency based on how long a lead has been waiting.

## Pipeline

```text
sources -> validation -> normalization -> deduplication -> database
        -> AI extraction -> catalog enrichment -> hybrid score
        -> capacity-aware advisor assignment -> dashboard
```

## Key design decisions

- The LLM extracts structured facts; it does not decide the final score.
- Customer deduplication is scoped by company.
- Raw values are retained for auditability.
- Ambiguous dates are flagged instead of silently treated as certain.
- Orphan conversations are quarantined instead of crashing the pipeline.
- Scoring is versioned and explainable.

## Quick start

```bash
cp .env.example .env   # set a real DATABASE_URL
bun install
bun run db:generate
bunx prisma migrate deploy   # applies the prepared migrations in prisma/migrations
bun run pipeline
```

The `pipeline` command now runs the full milestone-2 flow end to end: read → validate → normalize → persist reference data → resolve customers → persist leads → persist conversations/messages → record data-quality issues → finalize the `PipelineRun`. Rerunning it is idempotent (see `docs/architecture.md`). AI extraction, scoring execution, and assignment execution are not implemented yet.

### Database migrations

Migrations are prepared under `prisma/migrations/` using Prisma's migration format. Because this repository is developed without a live `DATABASE_URL` in some environments, the initial migration was generated with `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script` (which only needs the schema file, not a live connection) rather than `prisma migrate dev`. Once `DATABASE_URL` points at a real Postgres instance:

```bash
bunx prisma migrate deploy   # apply the prepared migration to a fresh database
bun run pipeline
bun run pipeline              # rerun to verify idempotency
```

`prisma db push` is not used as the schema management strategy.

### Data-quality metric semantics

`PipelineRun.ambiguousDateFields` counts ambiguous date **field** occurrences (a lead ambiguous on both `fecha_registro` and `fecha_primer_contacto` counts twice); `leadsWithAmbiguousDates` is the distinct-lead count instead. `unresolvedMotorcycles` (issue `UNRESOLVED_MOTORCYCLE`) means non-empty motorcycle-interest text that couldn't be safely matched to the catalog; `missingMotorcycleInterest` (issue `MISSING_MOTORCYCLE_INTEREST`) means no interest text was stated at all — the two are never conflated. `PipelineIssue.reobservedRunCount` counts pipeline **executions** that re-detected the same issue, not source occurrences. Full rationale in `docs/architecture.md`.

## Repository milestones

Suggested real commits:

1. `chore: initialize lead intelligence project`
2. `feat: add relational data model`
3. `feat: normalize lead source data`
4. `feat: detect duplicate customers and data quality issues`
5. `feat: persist normalized entities`
6. `feat: extract structured intent from conversations`
7. `feat: add explainable hybrid scoring`
8. `feat: assign leads by advisor capacity`
9. `feat: add daily leads dashboard`
10. `docs: document architecture and decisions`
