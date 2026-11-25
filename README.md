# Lead Intelligence Hub

Explainable lead prioritization and capacity-aware advisor assignment, built with **Next.js, TypeScript, PostgreSQL and Prisma**. Optional Gemini extraction turns conversation text into structured facts; deterministic business rules—not the LLM—decide operational priority.

[Live demo](https://lead-intelligence-iota.vercel.app) · [Engineering case study](docs/case-study.md) · [Architecture](docs/architecture.md) · [Implementation guide](docs/implementation-guide.md)

> Technical-assessment demo with synthetic data. The company selector demonstrates query scoping, **not production authentication**. Operational priority is **not purchase probability**. The public dashboard reads persisted data and does not call Gemini.

## What it does

- **Normalize unreliable inputs:** validate multi-channel lead files, resolve company-scoped customer identities, retain source values and record data-quality issues.
- **Explain the queue:** combine historical propensity, conversation intent, waiting-time urgency and global catalog availability into versioned score components.
- **Respect real operating constraints:** assign eligible leads within their company and sales point, honoring active advisors, daily capacity and a pinned business date.
- **Keep history trustworthy:** tie AI results to transcript versions, preserve extraction history and distinguish verified quotations from unavailable evidence.
- **Make failures visible:** expose pipeline runs, distinct data-quality issues, capacity bottlenecks and schema-aware health status.

The supplied operational fixture resolves **1,503 input rows into 1,501 canonical leads**, with 1,452 customers, 677 conversations, 4,310 messages and 42 advisors. The separate historical modeling dataset has 2,200 records. These are fixture expectations, not live production measurements.

## Five-minute demo

Open the [public dashboard](https://lead-intelligence-iota.vercel.app):

1. **Overview:** identify waiting leads and saturated sales-point pools.
2. **Lead queue:** filter by company context, sales point, priority band or assignment status.
3. **Lead detail:** inspect score contributions, conversation context, available AI evidence and assignment reasons.
4. **Capacity:** compare advisor utilization and see why a lead may remain unassigned.
5. **Data quality:** inspect the latest pipeline run and issue categories.

The demo uses the historical business date `2026-09-14` in `America/Bogota` so assignment and capacity remain reproducible. The live deployment can lag the feature branch; see the dated [validation and release checkpoint](docs/case-study.md#validation-and-release-evidence).

## Architecture at a glance

```text
CSV / JSON -> validate / normalize / deduplicate -> PostgreSQL
          -> optional structured AI extraction
          -> explainable hybrid priority -> capacity-aware assignment
          -> read-only Next.js dashboard
```

A shared TypeScript codebase keeps ingestion, AI contracts, scoring and assignment boundaries explicit. PostgreSQL stores operational state and history. A Python standard-library analysis produces versioned propensity artifacts; Python is not part of the dashboard runtime. There are no queues, Redis, vector databases or microservices to provision.

The model has modest retrospective discrimination (Model A ROC-AUC **0.557**); an exploratory intake heuristic performs slightly better on the synthetic history. The system therefore treats propensity as one limited signal, not an autonomous decision-maker. See [results and limitations](docs/case-study.md#model-results-honest-signal-not-an-accuracy-claim).

## Run locally without Gemini

Prerequisites: **Node.js 24.21.0**, **Bun 1.4.2** (the CI versions), and an **empty disposable PostgreSQL database**. Docker is an optional local database host; a cloud account or Gemini key is not required.

**PowerShell quick start:** edit the copied `.env` to point `DATABASE_URL` at your local disposable database. Check that inherited `DATABASE_URL` or `DIRECT_URL` shell values do not override it. **Do not use a production or shared database:** the pipeline below writes data, scores and assignments.

```powershell
Copy-Item .env.example .env
# Edit .env: local DATABASE_URL; keep ASSIGNMENT_BUSINESS_DATE=2026-09-14.
# Do not proceed until the database target is confirmed local and disposable.
$env:AI_API_KEY = ""
$env:AI_MAX_CONVERSATIONS = "0"
$env:ASSIGNMENT_BUSINESS_DATE = "2026-09-14"

bun install --frozen-lockfile
bun run db:generate
bun run db:deploy
bun run pipeline
bun run dev
```

Open [localhost:3000](http://localhost:3000). With no key, provider extraction is skipped; the rest of the local demo still works with an explicit neutral intent fallback. Missing extraction is never fabricated. Initial dependency installation and the production build may require network access, but this workflow does not call Gemini.

The [implementation guide](docs/implementation-guide.md) documents all environment variables, algorithms and optional provider-backed setup. Never put secrets in `NEXT_PUBLIC_*`, source control, screenshots or command arguments. Keep provider keys out of the Vercel dashboard environment.

## Verification

Use a **separate disposable test database**, apply the migrations there and set `DATABASE_URL` for that target before running integration tests. Never run the test suite against the demo or production database.

```powershell
bun run typecheck
bun run test
bun run build
bun audit
```

Database-less runs can skip integration tests and are not full validation. [CI](.github/workflows/ci.yml) provisions PostgreSQL, rejects skipped tests, checks migrations against the Prisma schema, builds for production and exercises repeat pipeline execution and guarded operations.

Recorded checkpoint for application commit `4f8cd8e`: **267 CI tests passed, zero skipped**; build, type checking and dependency audit passed. This is a dated result, not a perpetual guarantee. The [case study](docs/case-study.md#validation-and-release-evidence) links the exact run, copy-rehearsal proof and an outstanding Windows test-cleanup advisory.

## Repository map

| Path | Responsibility |
| --- | --- |
| [`src/app`](src/app) / [`src/components/dashboard`](src/components/dashboard) | Dashboard routes and UI |
| [`src/pipeline`](src/pipeline) | Ingestion orchestration and persistence |
| [`src/lib/ai`](src/lib/ai) | Provider interface, validation, transcript hashing and evidence |
| [`src/lib/scoring`](src/lib/scoring) / [`src/lib/assignment`](src/lib/assignment) | Deterministic business rules |
| [`src/lib/dashboard`](src/lib/dashboard) / [`src/lib/health`](src/lib/health) | Company-scoped queries and readiness checks |
| [`prisma`](prisma) | Relational schema and versioned migrations |
| [`analysis`](analysis) / [`artifacts`](artifacts) | Reproducible historical model and evaluation outputs |
| [`scripts/ops`](scripts/ops) / [`tests`](tests) | Guarded operations and regression coverage |

## Deployment and boundaries

The public demo uses Vercel and Neon. A successful build is not proof that a database migration has been applied. For any shared-database release, follow the [deployment runbook](docs/deployment-runbook.md): independent backup, disposable rehearsal, exact pending-migration checks, explicit authorization, **migration before merge**, and verification with both health and dashboard checks.

`GET /api/health` reports database reachability and compatibility with the deployed schema. It does not replace dashboard verification. A migration approval never authorizes a pipeline run, reconciliation, rescoring, assignment, provider call or merge.

This is not a production-ready authenticated CRM: it has synthetic data, partial AI coverage, a demo company context and unvalidated business weights. No conversion uplift, commercial ROI or load-test capacity is claimed. The [case study](docs/case-study.md) explains both the engineering results and the limits.
