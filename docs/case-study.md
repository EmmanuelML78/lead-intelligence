# Lead Intelligence Hub — Engineering case study

An explainable sales-operations demo built from inconsistent lead files and conversation history. The project demonstrates data modeling, deterministic business rules, optional LLM integration, regression testing and controlled database releases—not proven commercial uplift.

[Live demo](https://lead-intelligence-iota.vercel.app) · [Repository overview](../README.md) · [Architecture](architecture.md)

## Problem and scope

A motorcycle-sales team has more incoming leads than advisors can work immediately. Leads arrive through multiple channels, customer identities repeat, conversation data changes, and advisor capacity differs by company and sales point. A useful queue must explain both **why a lead comes next** and **why it can or cannot be assigned**.

The implementation covers ingestion, relational persistence, structured conversation extraction, historical propensity analysis, hybrid prioritization, capacity-aware assignment and a read-only dashboard. It was built for a technical assessment using synthetic data. It is not an authenticated production CRM.

The supplied operational fixture contains 1,503 incoming lead rows, resolving to 1,501 canonical leads, 1,452 customers, 677 conversations and 4,310 messages, with 42 advisors and 24 catalog motorcycles. These are [fixture expectations](../scripts/verify-canonical-counts.ts), not current production counters. The **separate historical modeling dataset contains 2,200 records**.

## Design decisions and tradeoffs

| Decision | Why | Tradeoff |
| --- | --- | --- |
| Next.js dashboard and TypeScript pipeline sharing PostgreSQL/Prisma | Keep persistence and business rules inspectable without extra services | Batch ingestion is an explicit operator task, not a real-time event platform |
| Deterministic customer identity within each company | Prefer normalized phone, then email, then a lead-specific fallback; avoid unsafe fuzzy merges | Some imperfect identities stay separate rather than being guessed together |
| LLM extraction separated from scoring | Gemini extracts validated facts; deterministic rules compute operational priority | Optional AI coverage can be incomplete; missing intent gets an explicit neutral fallback |
| Transparent hybrid priority | Combine historical propensity, intent, urgency and catalog availability with inspectable contributions | Weights are business starting values, not optimized conversion guarantees |
| Capacity-aware greedy assignment | Respect company, sales point, active status, business date and daily capacity | It is not a globally optimal scheduler; an existing assignment is not silently reshuffled |
| Company-scoped demo context | Demonstrate query isolation and cross-company not-found behavior | The selector is **not authentication**, role-based access control or production IAM |

Catalog availability is global reference data. It must never be represented as stock at a particular company or store. The [architecture](architecture.md) records the implementation boundaries and rationale.

## Reliability challenge: historical analysis is not current evidence

An extraction can be valid JSON and still describe an older conversation. Selecting the newest database row alone is therefore insufficient.

The implementation ties usable extractions to the conversation's current canonical transcript hash and the current monetary contract. A transcript returning from A to B to A may reuse an older compatible extraction rather than paying for another provider call. Historical rows with incompatible amounts are excluded from current use, not silently rewritten or deleted.

The lead detail follows the selected extraction's conversation. It does not attach an extraction from one thread to the text of another. Quotation evidence is checked locally against the independently matching displayed transcript; unavailable or unverified evidence is not presented as verified. These checks do **not** prove that every inferred fact is correct or eliminate hallucination risk.

The snapshot migration's initial hash comes from previous extractions—not an independent verification of stored messages. Reconciliation computes the real transcript hash and updates messages atomically, retaining distinct observed transcripts as snapshots. Migration approval does not authorize reconciliation, which can remove messages from the current snapshot.

Evidence: [current extraction selector](../src/lib/ai/current-extraction.ts), [conversation persistence](../src/pipeline/persist/conversations.ts), [evidence regressions](../tests/ai-evidence.test.ts), and [release procedure](deployment-runbook.md#snapshot-release-rehearsal).

## Reliability challenge: idempotence includes unchanged timestamps

A populated-copy rehearsal exposed an important distinction: stable row counts are not sufficient proof of idempotence. Replaying unchanged leads still upserted Customer rows, advancing `updatedAt`; it could also overwrite a shared customer profile with older lead data.

The narrow correction checks the existing Lead fingerprint **before** resolving or upserting Customer. Unchanged input returns the existing customer link, including a nullable link, without rewriting either row. New and changed input still uses the existing transactional persistence path.

Regression checks cover complete-row preservation and replay after another lead updates the shared profile. On the disposable production-backup copy, all 1,452 Customer rows remained identical to the original backup after both guarded replays. All 14 core-table fingerprints were stable between those replays; pipeline-run and issue-observation history are intentionally separate.

Evidence: [scoped correction](https://github.com/EmmanuelML78/lead-intelligence/commit/4f8cd8ee86673e74e10e34fbbebb7d0272560164) and [reviewer-facing rehearsal results](https://github.com/EmmanuelML78/lead-intelligence/pull/7#issuecomment-7160767356).

## Model results: honest signal, not an accuracy claim

Historical propensity uses an interpretable L2-regularized logistic regression, evaluated with deterministic stratified five-fold out-of-fold predictions. Post-treatment fields such as first-contact delay and contact count are excluded to avoid leakage. Versioned JSON coefficients are evaluated in TypeScript, with Python/TypeScript parity tests.

| Historical Model A metric | Logistic regression | Random ranking expectation |
| --- | ---: | ---: |
| ROC-AUC | 0.556745 | 0.500000 |
| Average precision | 0.109499 | 0.089545 |
| Lift in the top 10% | 1.472081 | 1.000000 |

The historical population has 197 positive outcomes among 2,200 records. An exploratory intake heuristic ranks slightly better here: ROC-AUC 0.565970 and Lift@10 1.725888. Because that heuristic followed descriptive inspection, it is not an independently validated operating policy either.

The conclusion is deliberately modest: the available synthetic history provides limited predictive discrimination. Propensity is only 20% of the operational priority; intent is 35%, urgency 40% and catalog availability 5%. Priority is **not a purchase probability**, and Lift@10 is **not measured sales improvement**.

Sources: [model artifact](../artifacts/propensity-model-v1.json), [analysis artifact](../artifacts/propensity-analysis-v1.json), [training script](../analysis/train_propensity.py), [scoring design](architecture.md).

## Validation and release evidence

Checkpoint: **2026-11-25**, application commit `4f8cd8ee86673e74e10e34fbbebb7d0272560164`. These are recorded results for that commit, not a claim about every future run.

- [Exact-head GitHub Actions run](https://github.com/EmmanuelML78/lead-intelligence/actions/runs/45601557382): **267 tests passed, zero skipped**; production build, type checking and migration/schema checks passed. Dependency audit at that checkpoint reported 124 packages and zero vulnerabilities.
- A fresh disposable restoration of the independent backup passed migration-only checks, preserving old tables and old Conversation columns. Subsequent guarded copy-only reconciliation ran twice with **zero model calls**, scoring and assignment disabled, and stable core-table fingerprints. Its forecast and actual message removals were both zero; extraction-expiry counts were zero for this dataset.
- A later local Windows full-suite run had **266 passes and one existing concurrency-test cleanup `EPIPE` failure**. The focused test and exact-head CI passed. This remains a documented local portability/reliability follow-up, not a hidden green result.

CI is not deployment proof. An earlier migration-order incident showed that a successful build and a database-reachable health check could coexist with a broken dashboard. The release procedure now requires an independent backup, a disposable rehearsal, fingerprint comparisons, explicit approval, migration before merge, schema-aware health checks and dashboard verification. See the [incident record](deployment-runbook.md#incident-record-2026-11-24).

**Production migration completed on 2026-11-25 at 17:46 UTC.** Only `20261125000000_conversation_transcript_snapshots` was applied, for application commit `4f8cd8e`. Verification found eight successful migrations, zero pending or failed migrations and no Prisma schema differences. Existing table contents, legacy Conversation columns and migration history were preserved; the new snapshot table remained empty. The health endpoint and four dashboard routes returned HTTP 200 with the previous application code still deployed. The independent backup remained intact.

The initial production preflight stopped safely because its catalog comparison treated physical column-slot gaps as schema drift. A read-only audit traced those gaps to three historical DROP/ADD operations and logical restoration. The corrected comparison preserves active column order and every other attribute across restored copies; same-production pre/post comparisons remain exact. Regression tests, independent negative probes and a fresh disposable restoration passed before the separately authorized retry. No applied migration SQL was changed.

**The PR's application code is not yet deployed.** Merge, production reconciliation, rescoring, assignment and Gemini calls remain outside the migration authorization. A completed database migration must not be described as a completed application rollout.

## Outcome and limits

The delivered artifact is an inspectable operational workflow: normalized inputs, explainable priorities, capacity-constrained assignments, auditable history and a dashboard that reads persisted results without calling Gemini. The strongest demonstrated result is reproducibility and data integrity—not predictive superiority.

No conversion uplift, time savings, real-customer adoption, load-test capacity or commercial ROI has been measured. The dataset is synthetic, AI coverage is partial, weights need business validation, the company selector is not authentication, and the application release still requires an authorized merge and post-deployment checks. No paid infrastructure or provider calls are necessary to review the repository or run its zero-provider local demo; external services retain their own limits and pricing.

## Portfolio summary

> Built an explainable lead-prioritization demo with Next.js, TypeScript, PostgreSQL and Prisma. Separated optional LLM fact extraction from deterministic scoring and capacity-aware assignment; implemented company-scoped identity, transcript-aware AI history and regression-tested no-write ingestion. Validated with 267 passing CI tests and an independent-backup rehearsal, while documenting weak model signal, demo authentication limits and the pending production release explicitly.

For a walkthrough, follow the [five-minute demo](../README.md#five-minute-demo). For configuration and algorithms, use the [implementation guide](implementation-guide.md).
