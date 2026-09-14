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
cp .env.example .env
bun install
bun run db:generate
bun run db:migrate
bun run pipeline
```

The current `pipeline` command performs the preflight/quality stage and prints detected issues. The next implementation stages are persistence, AI extraction, scoring, and assignment.

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
