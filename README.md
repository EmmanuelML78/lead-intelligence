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

The `pipeline` command runs the full flow end to end: read → validate → normalize → persist reference data → resolve customers → persist leads → persist conversations/messages → **AI conversation extraction** → record data-quality issues → finalize the `PipelineRun`. Rerunning it is idempotent (see `docs/architecture.md`). Scoring execution and assignment execution are not implemented yet.

### AI conversation extraction (Milestone 3)

Structured commercial intelligence (`AiExtraction`) is extracted from persisted `Conversation`/`Message` rows — motorcycle interest, budget, down payment, payment method, purchase intent, main objection, appointment/quote requests, confidence, and auditable evidence. Full design in `docs/architecture.md` ("Milestone 3"). Key points:

- **Never blocks ingestion.** If `AI_API_KEY` is not set, the pipeline still completes successfully; the AI stage reports `SKIPPED` (see the console summary and `PipelineRun.metadata.aiExtraction`) instead of throwing.
- **Cached/idempotent.** Re-running the pipeline against an unchanged conversation never calls the model twice — see the `(conversationId, conversationHash, promptVersion, model)` cache key in `docs/architecture.md`.
- **Provider-agnostic business logic.** Only `src/lib/ai/providers/gemini.ts` is implemented today, behind the `AiExtractionProvider` interface.
- **The LLM never invents a SKU.** `motorcycleInterest` is free text; a deterministic catalog matcher (the same one used in Milestone 2) resolves it afterwards.
- **Manual evaluation fixture:** `data/eval/conversation-extraction-eval.json` (18 hand-labeled conversations, human-reviewable, not used by automated tests).

To exercise it: set `AI_API_KEY` (and optionally `AI_MODEL`, `AI_CONCURRENCY`) in `.env`, then run `bun run pipeline`. Without a key, `bun run pipeline` still ingests everything and prints an `AI conversation extraction stage: SKIPPED` summary.

### Historical propensity validation (Milestone 4)

Run the complete offline analysis and regenerate all versioned outputs:

```bash
bun run analysis:propensity
```

The script uses Python's standard library only. It trains an L2-regularized logistic regression, performs deterministic stratified 5-fold validation, and writes:

- `artifacts/propensity-model-v1.json` — transparent coefficients, encoders, target, exclusions, and metrics consumed by TypeScript;
- `artifacts/propensity-analysis-v1.json` — full descriptive evidence, leakage ledger, baselines, and Model A/B sensitivity;
- `artifacts/propensity-parity-v1.json` — Python probabilities used by the TypeScript parity test.

Primary target (Model A): `Cerrado = 1`; `Perdido` and `Sin gestión = 0`. Sensitivity Model B excludes the 179 `Sin gestión` rows; all have missing first-contact time and zero contacts. Model A reaches ROC-AUC 0.557, Average Precision 0.109, Lift@10 1.47, and Lift@20 1.24. Model B reaches ROC-AUC 0.539, Average Precision 0.118, Lift@10 1.42, and Lift@20 1.24. A three-rule intake heuristic ranks slightly better than the logistic model, reinforcing that model signal is modest rather than strong.

`horas_al_primer_contacto` and `numero_contactos` are excluded from training and runtime input because they are post-treatment leakage. First-contact time appears only in descriptive buckets. Python is not needed by the Next.js runtime; `src/lib/scoring/propensity.ts` validates and evaluates the JSON coefficients deterministically.

**Historical tabular data has limited predictive signal. The propensity model is therefore one component of prioritization, not an autonomous sales decision-maker.**

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

AI extraction failures are recorded the same way: `AI_EXTRACTION_PROVIDER_FAILED` (transport/API error after exhausting retries) and `AI_EXTRACTION_VALIDATION_FAILED` (provider response didn't pass the Zod contract) are `WARNING`-severity `PipelineIssue` rows, never a fabricated `AiExtraction`. The AI stage's own aggregate counters (`conversationsEligible`, `cacheHits`, `modelCalls`, `successes`, `validationFailures`, `providerFailures`, `skippedNoApiKey`) are printed at the end of `bun run pipeline` and stored on `PipelineRun.metadata.aiExtraction`.

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
