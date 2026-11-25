# PR #7 release readiness
Objective: close the review conditions and prepare, not execute, the production rollout. Branch: `fix/conversation-and-ai-reliability`; delivery: `ask-on-risk`; forecast: ~650 authored lines.
Runner: `bun run test`, focused `tsx --test`, `bun run typecheck`; database checks require a separately authorized isolated target. RDD is globally off.

## Specs
- S1: "Comprueba si las extracciones históricas contienen importes negativos o incompatibles con el contrato actual. Define cómo tratarlos sin modificar silenciosamente los datos ni consumir cuotas de Gemini."
- S2: "Corrige la incoherencia del detalle del lead cuando la extracción seleccionada pertenece a una conversación diferente de la mostrada."
- S3: "Documenta que el hash inicial de la migración procede de extracciones anteriores y que la correspondencia con el transcript real se verifica durante la reconciliación."
- S4: "Comprueba que las extracciones históricas no se presenten como evidencia verificada cuando todavía no lo están."
- S5: "Añade las pruebas de regresión correspondientes."
- S6: "Después, prepara el despliegue siguiendo estrictamente docs/deployment-runbook.md:" "Backup independiente de producción." "Branch desechable para el ensayo." "Verificación de migraciones pendientes." "Ensayo de la migración y del pipeline." "Desactivar explícitamente Gemini." "Desactivar la asignación durante la reconciliación." "Comparar hashes, conteos y registros históricos." "Informar cuántos mensajes se eliminarían y cuántas extracciones dejarían de estar vigentes." "Verificar la idempotencia." "Esperar autorización humana antes de migrar producción." "Aplicar la migración antes del merge." "Verificar el health check y el dashboard después del despliegue."
- S7: "No modifiques producción, no consumas cuotas de Gemini y no realices merge sin mi aprobación." "Mantén el alcance acotado. Estamos cerrando las mejoras funcionales del proyecto para preparar su presentación profesional."

## Tasks
- T1 (S1-S5,S7): inline; partial (local implementation/checks complete; actual historical audit and DB integration proof pending); historical eligibility, coherent detail, read-time evidence verification and regressions. Risk: item 3 (shared extraction eligibility affects scoring and dashboard). Commit: d432536.
- T2 (S1,S3,S5-S7): inline; partial (tools/runbook locally verified; actual audit/rehearsal pending); read-only audit and guarded disposable-copy rehearsal. Risk: item 3 (reuse shared eligibility/normalization); no DB mutation. Commit: 92e41bb.
- T3 (S6-S7): inline; blocked on authorized destination/session and operator prerequisites; independent backup and disposable DB rehearsal, actual counts, idempotence, human production/merge approvals. No production operation authorized. Commit: N/A.

## Log
### L1 — original request (2026-11-24)
El PR #7 ha sido revisado favorablemente, condicionado a las siguientes comprobaciones antes del despliegue.

1. Comprueba si las extracciones históricas contienen importes negativos o incompatibles con el contrato actual. Define cómo tratarlos sin modificar silenciosamente los datos ni consumir cuotas de Gemini.
2. Corrige la incoherencia del detalle del lead cuando la extracción seleccionada pertenece a una conversación diferente de la mostrada.
3. Documenta que el hash inicial de la migración procede de extracciones anteriores y que la correspondencia con el transcript real se verifica durante la reconciliación.
4. Comprueba que las extracciones históricas no se presenten como evidencia verificada cuando todavía no lo están.
5. Añade las pruebas de regresión correspondientes.

Después, prepara el despliegue siguiendo estrictamente docs/deployment-runbook.md:

- Backup independiente de producción.
- Branch desechable para el ensayo.
- Verificación de migraciones pendientes.
- Ensayo de la migración y del pipeline.
- Desactivar explícitamente Gemini.
- Desactivar la asignación durante la reconciliación.
- Comparar hashes, conteos y registros históricos.
- Informar cuántos mensajes se eliminarían y cuántas extracciones dejarían de estar vigentes.
- Verificar la idempotencia.
- Esperar autorización humana antes de migrar producción.
- Aplicar la migración antes del merge.
- Verificar el health check y el dashboard después del despliegue.

No modifiques producción, no consumas cuotas de Gemini y no realices merge sin mi aprobación.

Mantén el alcance acotado. Estamos cerrando las mejoras funcionales del proyecto para preparar su presentación profesional.

### L2 — evidence and routing
- Read-only explorer completed; configured unavailable model replaced with gpt-6.1-sol after explicit user reply "SI". Paths-injected skills loaded.
- No historical export is available; actual historical incidence and rollout counts are unknown until an authorized audit.
- Migration hash is initialized from newest extraction, not verified message content. Do not edit migration bytes.
- Full-row Conversation fingerprints necessarily change when adding transcriptHash. Prove old columns separately; do not weaken comparisons for other tables.
- No remote operation, credentials/session inspection, database connection, Gemini call, push, merge or production mutation performed.
- Work stays inline: no independent writer units requiring parallel work. Independent verifier required for shared eligibility after own checks.

### L3 — local implementation and observed checks
- Baseline: d8d23ee. T1 RED: three historical money/evidence/conversation tests failed under Bun; cache no-paid-retry guard passed at baseline. GREEN: canonical Node/tsx focused run 28 passed, 0 failed; full suite 264 tests, 210 passed, 54 DB integrations skipped, 0 failed. New audit tests first failed with missing module, then passed.
- Node shim initially had no active version; used existing installed Node 24.21.0 via process PATH only. No install or persistent environment change. `bun run typecheck` passes.
- New read-only release audit reports monetary incompatibilities, message add/remove forecast, hash-current/usable extraction expiry, distinct leads losing usable candidates and legacy Conversation-column fingerprint. Missing pre-migration column is distinct from a stored NULL.
- Disposable-only rehearsal command target-guards and excludes the operator-named production endpoint, forces empty AI_API_KEY, AI_MAX_CONVERSATIONS=0, PIPELINE_SKIP_ASSIGNMENT=1, PIPELINE_SKIP_SCORING=1 before loading pipeline. Ingestion and audit reuse source normalization, hashing and message IDs.
- No live historical audit, backup, disposable branch, migration, pipeline, health/dashboard deployment check, push or merge has been executed. No production or provider connection. Historical incidence/deletion/expiry counts remain unknown.
- Independent verification/build pending. RDD off; no native review started. Generated tsconfig.tsbuildinfo must not be committed.

### L4 — independent verification and local handoff
- Final own suite: 266 tests, 212 passed, 54 DB integration skips, 0 failures; focused additional regression probes: 8 passed; typecheck `bun run typecheck --incremental false` passed; `git diff --check` passed.
- First independent verifier could not complete sandbox scratch setup. A new bounded verifier used a different hypothesis: create/copy/execute within one process because Windows sandbox TEMP namespaces change between tool invocations. Seven independent probe groups passed (0 skipped), including baseline selector A→B→A and source-normalization differential, malformed evidence, coherent detail, multi-row versus distinct-lead expiry and guard refusals. Both CLI help commands exited 0; both mismatched dummy-target commands exited 1 before connection and no audit report was written. Independent typecheck passed after correcting its initially incomplete scratch copy. No implementation defect found; returned regression probes were added and passed.
- Production build was not run: existing `next/font/google` imports fetch Google fonts; network/file-transfer authorization is absent. This is missing build proof, not a pass. All 54 DB integrations, actual migration rehearsals and deployed health/dashboard checks remain unexecuted.
- RDD remains globally disabled/unmanaged; no review consent or lifecycle initiated. No CI status claimed for these local commits; no push/PR mutation performed.
- Local work units: d432536 (222 authored lines: compatible historical extraction selection and transcript/evidence detail), 92e41bb (335 authored lines: audit/rehearsal tools and runbook). Running count: 557 before this tracking document. No delivery-chain decision needed until publication is requested.
- Rollback boundaries: revert d432536 for read-path policy/detail changes; revert 92e41bb for additive ops tooling/source-normalizer extraction and its docs/tests. Migration files were never changed. Neither commit touched stored data.
- Generated tsconfig.tsbuildinfo restored byte-for-byte using HEAD blob (ordinary git restore was sandbox-denied, no index mutation). Pre-existing .atl/ preserved. Verifier scratch paths live in separate tool sandboxes and were not visible for parent cleanup; no workspace scratch remains. One interrupted verifier scratch locator was unavailable.
- Next human input: authorize exact Neon project/endpoints, operations and credential/session for read-only production inventory and separate backup/rehearsal setup. Do not inspect ambient credentials. Actual historical incompatibility/deletion/expiry counts remain UNKNOWN. Production migration, production reconciliation and merge each remain separately unauthorized.
- Final runbook readback clarifies that pipeline metadata's message-addition counter covers changed existing conversations, while audit additions also cover new conversations: compare total count deltas and exact removal counts, not mismatched addition metrics.
