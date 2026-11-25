# Deployment runbook: database migrations with Vercel and Neon

How to ship a change that needs a database migration without breaking production or losing history. Written for a Windows workstation using Windows PowerShell 5.1, with PowerShell 7 as an alternative.

The first release it covered was the pair of migrations from PR #2 and PR #3. That release caused an outage because the merge happened before the migration; read [Incident record: 2026-11-24](#incident-record-2026-11-24) before your first deployment. The procedure is general; the release-specific facts are in [Release notes for PR #2 and PR #3](#release-notes-for-pr-2-and-pr-3).

## Rules that always apply

- **Never merge a pull request whose code needs a migration before that migration is applied to production.** Merging deploys. This is the rule the 2026-11-24 incident broke.
- **An independent backup and a rehearsal on a disposable copy are mandatory before every production migration.** They are not optional steps to skip when the change looks small. The only exception is an explicit, recorded decision by the project owner during an outage; see [Code that needs a migration was deployed before the migration](#code-that-needs-a-migration-was-deployed-before-the-migration).
- No production migration, recalculation or rollback starts until the [approval checklist](#0-approval-checklist) is complete.
- Migrate with `prisma migrate deploy` only. Never run `prisma db push`, `prisma migrate dev` or `prisma migrate reset` against a shared database.
- Never edit or delete a migration that has been applied anywhere. Never delete rows from `_prisma_migrations` by hand.
- Every operational command names the database it expects with `--expect-host`. If `DATABASE_URL` points elsewhere, the command refuses to run.
- Never put a connection string in a command line, a file inside the repository, a chat, a ticket, a screenshot or a pull request. See [Handling credentials](#handling-credentials).
- One operator, one target per PowerShell window. Close the window when you finish with that target.
- Do not run `bun run pipeline` during a deployment. It ingests, may call the AI provider if a key is configured, and assigns advisors.
- The snapshot release has a **disposable-copy-only** exception: use `ops:reconcile-rehearsal` as described in its release notes. It forces Gemini, scoring and assignment off. This is not permission to reconcile production.

## How deployments happen

| Fact | Evidence |
| --- | --- |
| Vercel deploys through its Git integration: every push to `main` creates a Production deployment and every pull request commit creates a Preview deployment | GitHub deployment records created by `vercel[bot]` |
| The build is `prisma generate && next build`. It never runs migrations | `package.json` |
| There is no `vercel.json` and `main` has no branch protection, so merging is deploying | repository |
| Preview deployments are behind Vercel Authentication | unauthenticated requests are redirected |
| The pipeline is not scheduled anywhere in the repository; it is run by hand | no cron or workflow |

Consequence: **a migration is always applied by a person, and the order relative to the merge is a decision, not something the platform does.**

## Guardrails and their limits

### Recommended protection for `main`

`main` is currently unprotected. In GitHub → repository → **Settings → Branches** (or **Rules → Rulesets**), add a rule for `main` with:

- **Require a pull request before merging.** No direct pushes.
- **Require status checks to pass**, selecting the CI job `Build, test and verify pipeline`, and require the branch to be up to date before merging.
- **Require approvals: 1**, once a second collaborator is available. With a single maintainer this cannot be satisfied without bypassing the rule, so leave it off until then and use the [approval checklist](#0-approval-checklist) as the review.
- Do not allow force pushes or branch deletion.
- Apply the rule to administrators too, so the protection is not bypassed out of habit.

These are settings of the repository, changed by its owner. Nothing in this repository applies them.

### What CI and branch protection do not guarantee

A green CI run and a protected branch do **not** make a deployment safe on their own:

- CI builds a fresh database from every migration in the pull request and tests the code against it. It proves that the code and its migrations work **together**. It knows nothing about the production database.
- The Vercel check on a pull request reports that the build compiled. A preview or a production deployment can be marked successful while every page fails at runtime because a table is missing.
- Branch protection controls who can merge and under which checks. It does not know whether a migration has been applied, so it cannot enforce the order of migration and merge.

On 2026-11-24 CI was green, the Vercel deployment was reported as successful, and the dashboard was down. The order of migration and merge is enforced by this runbook and its checklist, by a person, and by nothing else.

## Tooling

| Command | What it does | Writes? |
| --- | --- | --- |
| `bun run ops:db-status --expect-host <host>` | Applied, pending and failed migrations for this checkout; row counts; pipeline runs and their recorded scoring instant; the instant from which scores no longer depend on time | No |
| `bun run ops:fingerprint snapshot <file> --expect-host <host>` | Row count and MD5 of the full contents of every table | No (writes the local file) |
| `bun run ops:fingerprint compare <file> --expect-host <host> --must-match <tables\|all>` | Reports each table as unchanged, changed, new or removed; fails if a required table differs | No |
| `bun run ops:rescore --expect-host <host> --decision-at <ISO instant>` | Prints the scoring plan only | No |
| `bun run ops:rescore ... --apply --report <file>` | Recalculates scores only: no ingestion, no AI call, no assignment | `LeadScore`, `LeadCurrentScore` |
| `bun run ops:release-audit --expect-host <host> --report <file>` | Historical monetary incompatibilities, reconciliation forecast and a fingerprint of pre-existing Conversation columns; works before or after the snapshot migration | No (local report only; database transaction is read-only) |
| `bun run ops:reconcile-rehearsal --expect-host <copy-host> --production-host <production-host>` | Runs ingestion/reconciliation on the disposable copy, with Gemini, scoring and assignment forced off | Yes: disposable copy only; refuses the named production endpoint |

All of them print only the host, the database name, whether the connection is pooled and a 12-character fingerprint of the URL. They never print the user, the password or row contents.

### Why not `bun run analysis:priority`

It was evaluated as the score-only command and it does run only the scoring stage. It was not chosen because it evaluates at the wall clock with no way to fix the instant, has no target guard, and prints sample leads. `ops:rescore` runs the same stage with an explicit instant.

## Evaluation instant and reproducibility

The score depends on time through one input only: the urgency of an **uncontacted** lead with a **trusted** registration time, which moves through buckets during its first 24 hours. After 24 hours it stays in the top bucket.

Measured on the synthetic dataset:

| Run | Result |
| --- | --- |
| Same instant, twice | Identical result digest; all 14 tables byte-identical, `LeadScore` included |
| Two different instants, both after the stable instant | Identical result digest (same scores, bands and input fingerprints), 0 rows created. `LeadScore` rows differ only in the lead age stored in the explanation |
| An instant within 24 hours of a recent registration | The plan reports how many leads are time-sensitive and warns |

`ops:db-status` prints the **stable instant** of a database: 24 hours after the newest trusted registration of an uncontacted lead. Any evaluation instant at or after it gives the same scores.

Choosing `--decision-at`:

1. Run `ops:db-status` and read the stable instant and the `scoringDecisionAt` of the latest successful pipeline run.
2. If that recorded instant exists and is at or after the stable instant, use it. The stored explanations then stay identical too.
3. Otherwise choose any instant at or after the stable instant.
4. Use the **same** instant in the rehearsal and in production, and write it in the deployment record.

`ops:rescore` does not create a `PipelineRun`, so the instant is recorded in its `--report` file, not in the database. Keep that file with the deployment record.

## Manual setup

These steps need access that only a project owner has.

### Vercel: confirm what the previews connect to

1. Project → **Settings → Environment Variables**. Find `DATABASE_URL` and read which environments it applies to.
   - Applies to Production only: previews have no database or use another variable.
   - Applies to Production and Preview with one value: **previews read the production database.** They only read, but a preview whose code needs a migration looks broken until the migration is applied.
2. Confirm `AI_API_KEY` is not defined in any environment.
3. Project → **Settings → Git**. Confirm the production branch is `main`.
4. Check whether a Neon integration is installed for the project. If it is, it may create a database branch per preview deployment; note it in the deployment record.
5. Cross-check, signed in: open the preview of the pull request and compare `/data-quality` with production. The same latest pipeline run on both means the same database.

Do not change any setting as part of this check.

### Neon: one untouched backup and one disposable copy

Create both while the freeze is in effect, one right after the other, so they hold the same data.

Console → project → **Branches → New branch**, twice:

| Field | Backup | Rehearsal copy |
| --- | --- | --- |
| Parent branch | the production branch | the production branch |
| Name | `backup-pre-deploy-YYYYMMDD` | `rehearsal-YYYYMMDD` |
| Include | Current data | Current data |
| Automatically delete branch after | **Uncheck it.** The console default deletes the branch after 1 day | Leave checked, 7 days |

Then:

- **Backup:** do not copy its connection string and never connect to it. Mark it as protected if your plan allows. It is used only to restore.
- **Rehearsal copy:** open **Connect**, turn connection pooling **off** to get the direct string (its host does not contain `-pooler`), and note the endpoint id, the first label of the host, for example `ep-cool-rain-123456`. That value is what you pass to `--expect-host`.
- **Production:** note its endpoint id the same way. It must differ from the rehearsal one.

If the database is not on Neon, take the backup with `pg_dump -Fc` to a file outside the repository and restore that dump into a separate database for the rehearsal.

## Handling credentials

The connection string contains the database password. Treat it as the password.

- Copy it from the provider's console straight into the masked prompt below. Do not paste it anywhere else first.
- Never put it in a command line (it would be stored in the shell history), in the repository, in a `.env` file you might commit, in a chat, a ticket, a pull request or a screenshot. Do not take screenshots of the window while pasting.
- Share only what the tooling prints: the host, the database name and the URL fingerprint. The endpoint id identifies a database but does not grant access to it.
- Use the **direct** connection string (host without `-pooler`) for migrations and for the read-only option below.
- If someone else has to run a step for you, do not send them the string. Store it in a file **outside the repository**, readable only by your user, let them load it from there into the process environment, and delete the file when the deployment is closed.
- When the deployment is closed: remove the variable, close the window, and delete any file that holds the string.
- If the string was ever displayed, pasted in the wrong place or captured in a screenshot, rotate the role's password in the provider's console and update `DATABASE_URL` in Vercel. Rotating is cheap; assuming nobody saw it is not a control.

### First look at production: read-only

The first connection to production in any deployment only inspects it, so make the session unable to write. After loading the connection string as described in the next section, append the option and confirm it took effect:

```powershell
$sep = if ($env:DATABASE_URL.Contains("?")) { "&" } else { "?" }
$env:DATABASE_URL = "$($env:DATABASE_URL)${sep}options=-c%20default_transaction_read_only%3Don"

bun -e 'import { prisma } from ''./src/lib/db/client''; const r = await prisma.$queryRaw`SHOW transaction_read_only`; console.log(''transaction_read_only = '' + r[0].transaction_read_only); await prisma.$disconnect();'
```

It must print `transaction_read_only = on`. In that session PostgreSQL rejects every write: `prisma migrate deploy` fails with `cannot execute ... in a read-only transaction` and `ops:rescore --apply` fails for every lead, while `ops:db-status` and `ops:fingerprint` work normally. Use a direct connection; a pooled one may not pass the option through.

Open a new window, without the option, when it is time to migrate.

## PowerShell session

Open a **new** PowerShell window for each target. The commands below work in Windows PowerShell 5.1, which is what Windows opens by default, and in PowerShell 7.

```powershell
$ErrorActionPreference = "Stop"
Set-Location <path-to-your-checkout>

# Stops at the first failing command instead of carrying on.
function Step { param([scriptblock]$Command) & $Command; if ($LASTEXITCODE -ne 0) { throw "Step failed (exit code $LASTEXITCODE). Stop and investigate." } }

# Paste the DIRECT connection string of THIS window's target. Nothing is shown or stored in history.
$secure = Read-Host "Direct connection string" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$env:DATABASE_URL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
Remove-Variable secure, bstr

$ExpectHost = "ep-xxxx-xxxx-00000000"   # endpoint id of this target, from the Neon console
```

While you paste, the prompt shows asterisks.

PowerShell 7.1 or later accepts a shorter form. Run `$PSVersionTable.PSVersion` to see which one you have, or start PowerShell 7 with `pwsh` if it is installed:

```powershell
$env:DATABASE_URL = Read-Host "Direct connection string" -MaskInput
```

**Do not use `-MaskInput` in Windows PowerShell 5.1.** It is not a parameter there: it becomes part of the prompt text (the prompt ends in `-MaskInput:`) and whatever you paste is shown in clear text. If you see that prompt, press `Ctrl+C` and use the 5.1 form above.

Verify the window before anything else:

```powershell
Step { bun run ops:db-status --expect-host $ExpectHost }
bunx prisma migrate status   # exits with a non-zero code while migrations are pending; that is expected here
```

- The first line of `ops:db-status` must show the host you expect and `connection=direct`.
- `prisma migrate status` prints `Datasource "db": PostgreSQL database "...", schema "public" at "<host>:5432"`. That host must be the same one. This confirms that Prisma is using the window's variable and not a local `.env` file. (A variable set in the window takes precedence over `.env` for both Bun and Prisma.)
- Everywhere else in this runbook `prisma migrate status` runs inside `Step`, after migrating, where a non-zero exit code means something is wrong.

When you finish with the target:

```powershell
Remove-Item Env:DATABASE_URL
exit
```

## Procedure

`<RELEASE_SHA>` is the commit that contains both the migrations to apply and this tooling. Use the same checkout of that commit for the rehearsal and for production; Prisma stores a hash of each migration file's bytes.

```powershell
git fetch origin
git switch --detach <RELEASE_SHA>
bun install --frozen-lockfile
git status --short   # must print nothing except untracked local files
```

### 0. Approval checklist

Complete this before step 1 and keep it in the deployment record. Every line needs a yes. A "no" or an "unknown" stops the deployment.

Before touching anything:

- [ ] The pull request is **not merged**, and nobody will merge it until step 6.
- [ ] CI is green on `<RELEASE_SHA>`, and that commit contains the migrations and this tooling.
- [ ] The release notes state, for each migration, whether it is compatible with the code currently in production. If one is not, the plan says how the gap is covered.
- [ ] Vercel was checked: which environments use `DATABASE_URL`, and `AI_API_KEY` is not defined.
- [ ] A rollback path is written down for this release: which Production deployment to roll back to, and the reversing SQL for each migration.
- [ ] One named operator runs the deployment, and the freeze has been announced.

Before migrating production (after step 4):

- [ ] `ops:db-status` on production lists exactly the expected pending migrations, none failed, no pipeline run `RUNNING`.
- [ ] The independent backup exists, is not set to expire, and has not been connected to.
- [ ] The rehearsal on the disposable copy finished: migrations applied, `prisma migrate diff` clean, every existing table byte-identical, recalculation with 0 failures and `Assignment` unchanged.
- [ ] The evaluation instant for the recalculation is chosen and recorded.
- [ ] The project owner has given explicit approval to migrate production, after seeing the rehearsal result.

Before merging (after step 5):

- [ ] Production migrations are applied and verified, and production is healthy on the previous code.
- [ ] The project owner has given explicit approval to merge.

Approval for one step is not approval for the next. A step that was skipped is recorded as skipped, with who decided it and why.

### 1. Freeze

- Announce that nobody runs the pipeline or merges until the deployment is finished.
- In a production window: `Step { bun run ops:db-status --expect-host $ExpectHost }`. `Pipeline runs currently RUNNING` must be 0. A `RUNNING` row that never finishes is a crashed run: stop and decide what it is before continuing.

Writers exclude each other technically: `bun run pipeline`, `ops:rescore --apply`, `analysis:priority` and `analysis:assignment` take the same exclusive lock, and a second one exits with code 75 naming the operation that is running. The lock needs a direct connection, which this runbook already uses. If `DIRECT_URL` is set in your environment it must name the same database as the window's `DATABASE_URL`; the command checks this and refuses otherwise, so remove a leftover value with `Remove-Item Env:DIRECT_URL`. The freeze is still required: the lock does not cover `prisma migrate deploy` or a merge.

A `RUNNING` row with no live process is the leftover of an interrupted run. The next pipeline run closes it as `FAILED` by itself.

### 2. Establish what is really pending

Do this in a [read-only session](#first-look-at-production-read-only). Read the `Migrations` block of `ops:db-status`:

| Reported | Meaning | Action |
| --- | --- | --- |
| Pending lists exactly the migrations you intend to ship | Expected | Continue |
| Pending lists fewer | Some were already applied | Continue; the remaining steps apply only what is pending |
| Pending lists more, or an older one | The database is behind in a way nobody planned | **Stop** |
| Failed is not empty | A previous attempt failed | **Stop**; see [Rollback](#rollback) |
| Applied but missing from this checkout is not empty | The database has a migration this commit does not know | **Stop**; you are on the wrong commit |

Write the pending list in the deployment record. Do not assume it.

### 3. Create the backup and the rehearsal copy

**Mandatory.** Follow [Neon: one untouched backup and one disposable copy](#neon-one-untouched-backup-and-one-disposable-copy). Close the production window.

The backup and the rehearsal copy are two different things and neither replaces the other. The backup is what you restore from; nobody connects to it. The rehearsal copy is where the migration is tried first; it is thrown away. A database provider's own history window is a last resort, not the backup: it expires, and restoring from it discards everything written after the chosen point.

### 4. Rehearse on the disposable copy

New window, rehearsal connection string and endpoint id.

```powershell
Step { bun run ops:db-status --expect-host $ExpectHost }        # same pending list as production
Step { bun run ops:fingerprint snapshot rehearsal-before.json --expect-host $ExpectHost }

Step { bun run ops:db-status --expect-host $ExpectHost }; Step { bun run db:deploy }

Step { bunx prisma migrate status }                             # "Database schema is up to date!"
Step { bunx prisma migrate diff --from-url $env:DATABASE_URL --to-schema-datamodel prisma/schema.prisma --exit-code }
Step { bun run ops:fingerprint compare rehearsal-before.json --expect-host $ExpectHost --must-match all }
```

`--must-match all` requires every table that existed before the migration to be byte-identical. New tables are reported as `new` and do not fail the check.

**Snapshot migration exception:** adding/backfilling `Conversation.transcriptHash` changes the full-row hash of `Conversation`. For that release only, replace this comparison with the two-part proof in [Snapshot release rehearsal](#snapshot-release-rehearsal); do not waive a changed pre-existing column or any other existing table.

Then rehearse the recalculation with the instant chosen in [Evaluation instant and reproducibility](#evaluation-instant-and-reproducibility):

```powershell
$DecisionAt = "<ISO instant>"
Step { bun run ops:fingerprint snapshot rehearsal-migrated.json --expect-host $ExpectHost }
Step { bun run ops:rescore --expect-host $ExpectHost --decision-at $DecisionAt }                       # plan only
Step { bun run ops:rescore --expect-host $ExpectHost --decision-at $DecisionAt --apply --report rehearsal-rescore.json }
Step { bun run ops:fingerprint compare rehearsal-migrated.json --expect-host $ExpectHost --must-match Assignment,Lead,Customer,Conversation,Message,Advisor,PipelineRun,PipelineIssue }
Step { bun run ops:rescore --expect-host $ExpectHost --decision-at $DecisionAt --apply }                # second run
```

Expected:

- The plan reports 0 time-sensitive leads. If it does not, the instant is too early: choose a later one.
- `failures` is 0.
- `Assignment` is `unchanged`. `LeadScore` and `LeadCurrentScore` may be `CHANGED`; that is the recalculation.
- The second run reports `created: 0` and the same `resultDigest` as the first.

Optionally point a local build at the copy to look at the pages: `bun run build`, then `bun run start`, and open `/`, `/leads`, `/capacity`, `/data-quality` and one lead.

Keep `rehearsal-rescore.json`. Close the window.

Against a remote database the recalculation takes several minutes per run for about 1,500 leads, because each lead is a few round trips. Let it finish; do not start a second one in parallel.

**Go / no-go:** continue only if every expectation above held and the second block of the [approval checklist](#0-approval-checklist) is complete. If not, stop: production has not been touched.

### 5. Migrate production, before merging

New window, production connection string and endpoint id.

```powershell
Step { bun run ops:db-status --expect-host $ExpectHost }        # pending list unchanged, RUNNING is 0
Step { bun run ops:fingerprint snapshot production-before.json --expect-host $ExpectHost }

Step { bun run ops:db-status --expect-host $ExpectHost }; Step { bun run db:deploy }

Step { bunx prisma migrate status }
Step { bunx prisma migrate diff --from-url $env:DATABASE_URL --to-schema-datamodel prisma/schema.prisma --exit-code }
Step { bun run ops:fingerprint compare production-before.json --expect-host $ExpectHost --must-match all }
```

For the snapshot migration use the same two-part migration-only proof as in [Snapshot release rehearsal](#snapshot-release-rehearsal), with `production-before.json` and fresh pre/post-migration audit reports. This changes the comparison, not the requirement for production migration approval.

Then check that production, still running the previous code, is healthy:

```powershell
(Invoke-WebRequest https://lead-intelligence-iota.vercel.app/api/health).Content   # {"status":"ok","database":"reachable","schema":"compatible"}
```

and open `/leads` in a browser: it must not show "Panel no disponible".

Migrating first is only valid when the migrations are compatible with the code currently in production. That is a property of each release; see the release notes below.

### 6. Merge and verify the deployment

Only now, with the last block of the [approval checklist](#0-approval-checklist) complete:

- Merge the pull request. Vercel builds and deploys Production by itself.
- Wait for the Production deployment of the merge commit to finish.
- Check `/api/health`, `/`, `/leads`, `/capacity`, `/data-quality`, one lead detail, and the company switch.

### 7. Recalculate the scores in production

From an up-to-date `main` checkout, in the production window, with the **same** `$DecisionAt` as the rehearsal:

```powershell
git switch main; git pull --ff-only; bun install --frozen-lockfile
$DecisionAt = "<same ISO instant as the rehearsal>"
Step { bun run ops:fingerprint snapshot production-migrated.json --expect-host $ExpectHost }
Step { bun run ops:rescore --expect-host $ExpectHost --decision-at $DecisionAt }
Step { bun run ops:rescore --expect-host $ExpectHost --decision-at $DecisionAt --apply --report production-rescore.json }
Step { bun run ops:fingerprint compare production-migrated.json --expect-host $ExpectHost --must-match Assignment,Lead,Customer,Conversation,Message,Advisor,PipelineRun,PipelineIssue }
```

### 8. Post-deployment checks

```powershell
Step { bun run ops:db-status --expect-host $ExpectHost }
Step { bun run verify:isolation }
Step { bun run ops:rescore --expect-host $ExpectHost --decision-at $DecisionAt --apply }
```

- No pending or failed migration; no `RUNNING` pipeline run.
- `Current scores` reports as many recorded scores as lead/version pairs with history.
- `Assignment` was `unchanged` in step 7.
- `resultDigest` in `production-rescore.json` equals the one in `rehearsal-rescore.json`. It can only differ if production data changed after the copy was taken.
- The repeated recalculation reports `created: 0` and the same digest.
- `verify:isolation` reports 0 cross-company violations.
- In the dashboard: the queue is ordered by score, a lead detail opens, the company switch works.

`bun run verify:counts` compares against the fixed counts of the synthetic dataset; use it only if production holds exactly that dataset.

### 9. Close

- Lift the freeze.
- Delete the rehearsal branch. Keep the backup branch until the next successful pipeline run has been reviewed, then delete it.
- File the deployment record.

## Rollback

Roll back the smallest thing that fixes the problem, in this order.

### Code that needs a migration was deployed before the migration

Symptom: pages show "Panel no disponible" while the Vercel deployment is marked successful. `/api/health` answers 503 with `"schema":"incompatible"`; `Invoke-WebRequest` reports that as an error, which is the signal. This is what happened on 2026-11-24, when the health endpoint only checked reachability and still answered 200.

First confirm the cause in a [read-only session](#first-look-at-production-read-only): `ops:db-status` lists the migration under `Pending`.

Then restore service. **The default is to roll back the deployment**, because it fixes the outage in seconds without touching the database and leaves time to do the migration properly:

1. In Vercel → **Deployments**, find the previous Production deployment (the last one whose code works with the current database) → **⋯** → **Instant Rollback**.
2. Confirm the pages work again.
3. Vercel now keeps the production domain on that deployment and stops assigning it to new ones. That is useful here: production is frozen while you work.
4. Run the normal procedure from step 1: freeze, status, backup, rehearsal, migrate.
5. Undo the rollback in Vercel by promoting the deployment of the already merged commit, which also restores automatic assignment of the production domain. Do not merge anything new for this.
6. Continue with steps 6 to 9.

Fixing forward, that is, migrating production immediately while it is down, also restores service, because the deployed code is already the one that needs the migration. It is acceptable only when **all** of these hold, and it must be recorded as a deliberate exception:

- the project owner explicitly decides it, knowing that it skips the mandatory backup and rehearsal;
- `ops:db-status` shows exactly the expected pending migrations and none failed;
- every pending migration is additive or catalog-only and was already applied to an empty database by CI;
- table fingerprints are taken before and compared after, with `--must-match all`.

Fixing forward trades a shorter outage for the loss of both safety nets. If any condition is not met, roll back.

### A migration fails while being applied

Verified on a disposable database: a failing migration leaves no partial objects, is recorded as failed, and blocks every later `migrate deploy` with error `P3009`.

1. Run `ops:db-status`; the migration is listed under `Failed`.
2. Confirm nothing from it exists (for example, the new table is absent).
3. `bunx prisma migrate resolve --rolled-back <migration_name>`
4. Fix the cause in a **new** commit and start again from the rehearsal.

### The new code misbehaves after the merge

Roll back the code and **leave the migrations applied**.

1. Fastest: in Vercel, **Instant Rollback** to the previous Production deployment. After a rollback Vercel stops assigning the production domain to new deployments until the rollback is undone, so follow it with step 2 and then undo the rollback.
2. Revert the application code in Git while keeping the schema and the migration files:

```powershell
git switch -c revert/<short-name> origin/main
git revert -m 1 --no-commit <merge_commit_sha>    # omit "-m 1" when reverting a non-merge commit
git checkout HEAD -- prisma                       # keep schema.prisma and every migration file as deployed
git commit -m "revert: <what and why>"
```

Open a pull request with that branch. Do **not** use the "Revert" button on GitHub: it would also delete the migration file and the model from `schema.prisma`, leaving the repository behind the database.

This was verified for PR #3: with the previous application code and the new schema, type checking passes, all 127 tests of the previous code pass, `prisma migrate diff` reports no difference, and the pipeline and the build succeed.

The previous code does not maintain `LeadCurrentScore`. After such a rollback the table goes stale but is not read. Before deploying the fix again, run `ops:rescore` once after the new code is live.

### The schema itself must be undone

Write a **new** migration that reverses it, review it, rehearse it and apply it with `migrate deploy`, together with the matching change to `schema.prisma`. The repository and `_prisma_migrations` then tell the same story. For this release:

```sql
-- reverses 20261124010000_lead_current_score
DROP TABLE "LeadCurrentScore";
DROP INDEX "LeadScore_id_leadId_scoreVersion_key";

-- reverses 20261124000000_assignment_drop_residual_defaults
ALTER TABLE "Assignment"
  ALTER COLUMN "reasonCode" SET DEFAULT 'ASSIGNED',
  ALTER COLUMN "explanation" SET DEFAULT '';
```

### Data was damaged

Restore the production branch from `backup-pre-deploy-YYYYMMDD` using Neon's restore. This discards everything written after the backup, so it is the last resort. Neither migration of this release modifies an existing row, and `ops:rescore` writes only to `LeadScore` and `LeadCurrentScore`.

## Deployment record

Fill this in and keep it with the two `*-rescore.json` reports and the fingerprint files. None of these contain credentials or row contents.

```text
Date and operator:
Approval checklist: before touching anything: complete / incomplete
                    before migrating (who approved, when):
                    before merging (who approved, when):
Steps skipped, who decided and why:
Release commit (<RELEASE_SHA>):
Production endpoint id:                 Rehearsal endpoint id:
Backup branch name and creation time:
Vercel: DATABASE_URL environments:      Previews share production database: yes / no
Migrations pending in production (from ops:db-status):
Stable instant reported by ops:db-status:
Evaluation instant used (--decision-at):
Rehearsal:  fingerprints match all: yes / no    rescore created / reused / failures:    digest:
Production: fingerprints match all: yes / no    rescore created / reused / failures:    digest:
Assignment unchanged after rescore: yes / no
Merge commit and Production deployment URL:
Problems and decisions:
```

## Release notes for PR #2 and PR #3

| Migration | From | Effect | Compatible with the code in production before the merge |
| --- | --- | --- | --- |
| `20261124000000_assignment_drop_residual_defaults` | PR #2, already in `main` | Drops two column defaults on `Assignment`. Catalog only | Yes: every writer supplies both values |
| `20261124010000_lead_current_score` | PR #3 | Creates `LeadCurrentScore`, adds a unique index on `LeadScore`, backfills the new table | Yes: additive, and the previous code does not read the new table |

- The code of PR #3 is **not** compatible with a database that lacks the second migration: its queries read `LeadCurrentScore`. That is why the migration goes before the merge.
- The recalculation in step 7 is what corrects any lead affected by the A to B to A defect. Until then such a lead keeps showing score B, exactly as before.
- Creating the unique index blocks writes to `LeadScore` while it builds. With about 1,500 rows this is well under a second.
- With the new queue order, recomputing assignments from scratch would change 46 of 1,352 rows on the synthetic dataset. This runbook does not recompute assignments.

**Status: both migrations were applied to production on 2026-11-24**, out of order with the merge. What happened and what was verified is in the incident record below.

## Release notes for the conversation snapshot migration

| Migration | Effect | Compatible with the code in production before the merge |
| --- | --- | --- |
| `20261125000000_conversation_transcript_snapshots` | Adds the nullable column `Conversation.transcriptHash` and the table `ConversationSnapshot`; fills the new column from the newest extraction of each conversation | Yes: additive, and the previous code reads neither |

- **Order: migrate before merging.** The new code selects `Conversation.transcriptHash` in every score-reading query. Deployed against a database without the column, those pages fail and `/api/health` answers 503.
- **The initial hash is provisional.** The backfill copies the newest historical extraction's hash; it does not hash `Message` rows and does not verify evidence. Reconciliation computes the canonical hash of the real source transcript, atomically makes stored messages match it, and records a snapshot. A historical transcript never captured cannot be reconstructed by this migration. The migration is additive; its old-column preservation must be proved on this release's copy, not inferred from an earlier rehearsal.
- **The first pipeline run after the deployment is where behavior changes.** It sets `transcriptHash` from the real messages, writes one snapshot per conversation, and removes message rows the source no longer contains. From then on an extraction made from a transcript that no longer exists stops being used: that lead shows no AI extraction and is scored with the neutral fallback until the conversation is analysed again.
- **Take the backup before that first pipeline run**, not only before the migration: it is the step that deletes rows. Use `ops:fingerprint` before and after; `Message` and `Conversation` are expected to change, `AiExtraction` must not.
- `ops:rescore` can be run before or after reconciliation. Before, it uses provisional backfilled hashes. The new reader also excludes incompatible historical monetary values, so scores can differ from the previous release even before reconciliation. Preserve those rows unchanged, document the exclusions and use the neutral fallback; do not round/clamp amounts, bump AI versions or automatically re-extract them.
- Rollback of the schema, as a new migration: `DROP TABLE "ConversationSnapshot"; ALTER TABLE "Conversation" DROP COLUMN "transcriptHash";`. Rolling back only the code keeps both and is safe.

### Snapshot release rehearsal

**Gate:** first complete steps 0–3: confirmed green CI on the immutable release SHA, freeze, actual pending migration list, an independent unexpired untouched backup and a separate disposable copy. Record the production endpoint as a deny-list value; do not connect to the backup. Use the same release SHA and source files throughout. Actual counts are **unknown until these commands run**. Reports contain hashes, counts and extraction IDs/reasons, not credentials or message text. Keep them outside the checkout.

In the disposable copy's window, after the normal target/credential setup:

```powershell
$ProductionHost = "<verified production endpoint id>"  # deny-list only
$Evidence = "<absolute operator evidence directory outside the checkout>"
Step { bun run ops:db-status --expect-host $ExpectHost }
Step { bun run ops:release-audit --expect-host $ExpectHost --report "$Evidence/audit-before.json" }
Step { bun run ops:fingerprint snapshot "$Evidence/before.json" --expect-host $ExpectHost }
Step { bun run db:deploy }
Step { bunx prisma migrate status }
Step { bunx prisma migrate diff --from-url $env:DATABASE_URL --to-schema-datamodel prisma/schema.prisma --exit-code }
Step { bun run ops:release-audit --expect-host $ExpectHost --report "$Evidence/audit-migrated.json" }

# Migration-only proof: every old table except Conversation is byte-identical.
$Before = Get-Content "$Evidence/before.json" -Raw | ConvertFrom-Json
$Required = ($Before.tables.PSObject.Properties.Name | Where-Object { $_ -ne 'Conversation' }) -join ','
Step { bun run ops:fingerprint compare "$Evidence/before.json" --expect-host $ExpectHost --must-match $Required }
# All pre-existing Conversation columns and its row count must ALSO match.
$A = Get-Content "$Evidence/audit-before.json" -Raw | ConvertFrom-Json
$B = Get-Content "$Evidence/audit-migrated.json" -Raw | ConvertFrom-Json
if ($A.conversationLegacyFingerprint.rows -ne $B.conversationLegacyFingerprint.rows -or $A.conversationLegacyFingerprint.md5 -ne $B.conversationLegacyFingerprint.md5) { throw 'Pre-existing Conversation data changed' }
if ($A.sourceSha256 -ne $B.sourceSha256) { throw 'Source changed during rehearsal' }

# Explicit controls, also forced inside the guarded rehearsal command.
$env:AI_API_KEY = ''
$env:AI_MAX_CONVERSATIONS = '0'
$env:PIPELINE_SKIP_ASSIGNMENT = '1'
$env:PIPELINE_SKIP_SCORING = '1'
Step { bun run ops:fingerprint snapshot "$Evidence/migrated.json" --expect-host $ExpectHost }
Step { bun run ops:reconcile-rehearsal --expect-host $ExpectHost --production-host $ProductionHost }
Step { bun run ops:release-audit --expect-host $ExpectHost --report "$Evidence/audit-reconciled.json" }
Step { bun run ops:fingerprint compare "$Evidence/migrated.json" --expect-host $ExpectHost --must-match AiExtraction,Assignment,LeadScore,LeadCurrentScore }
Step { bun run ops:fingerprint snapshot "$Evidence/reconciled.json" --expect-host $ExpectHost }
Step { bun run ops:reconcile-rehearsal --expect-host $ExpectHost --production-host $ProductionHost }
Step { bun run ops:release-audit --expect-host $ExpectHost --report "$Evidence/audit-repeated.json" }
$StableTables = ($Before.tables.PSObject.Properties.Name | Where-Object { $_ -notin @('PipelineRun','PipelineIssue') }) + @('ConversationSnapshot')
Step { bun run ops:fingerprint compare "$Evidence/reconciled.json" --expect-host $ExpectHost --must-match ($StableTables -join ',') }
```

Review and record **before authorizing production**:

- `incompatibleExtractions`: count and IDs with per-field reasons. An audit success means the report was produced, not that every row is compatible. The exclusion policy preserves history; any correction or paid re-analysis is a separate human decision. Fractional values already truncated by older writers cannot be recovered or detected from integer columns alone.
- `messagesWouldRemove` / `messagesWouldAdd` in the migrated audit: the forecast for the first reconciliation. Compare it to `PipelineRun.metadata.conversations.messagesRemoved/messagesAdded` and actual before/after Message counts. Stop on a discrepancy. Conversations absent from the source are untouched, not deleted.
- `hashCurrentExtractionsWouldExpire`: historical rows losing hash currency. `usableExtractionsWouldExpire`: compatible rows losing it. `leadsWouldLoseUsableExtraction`: distinct leads losing every usable candidate. These are different quantities; report all three, not just leads. The reports use the same COP predicate and canonical hashing as readers/ingestion.
- `transcriptsNotMatchingRecordedHash`: independently detected mismatch between stored messages and recorded/bootstrap hashes, **not verified extraction evidence**. Historical quotes are checked locally only when the displayed transcript's independent hash matches; otherwise they are hidden as unverified.
- First and second runs: AI `modelCalls = 0`, assignment/scoring `SKIPPED`, no failures. Repeated audit: zero pending message removals/additions and zero additional hash-current expiry; all stable-table fingerprints unchanged. New PipelineRun history and issue observation counters are expected, not an idempotence defect. Require the same `sourceSha256` in every audit.
- Run the step-4 `ops:rescore` plan/apply/repeat at the same recorded `--decision-at`, take fresh pre-rescore fingerprints and require `Assignment`, `AiExtraction`, `Message`, `Conversation`, `ConversationSnapshot` and all other non-score tables unchanged. Require zero failures, second `created: 0` and identical result digest. Do not use the unguarded pipeline to score.
- Inspect the disposable-copy dashboard: lead with multiple conversations, excluded historical amount, evidence status, queue, company switch and `/api/health`. CI must execute the integration regressions with **zero skipped tests**; a local DB-less run is not that proof.

**STOP here for human approval.** Supply the reports, backup identity/expiry, exact pending migrations, message deletion forecast, extraction expiry counts and idempotence results. A synthetic empty-database CI run is not a rehearsal of production history. This release is not deployment-ready while any of these proofs is missing.

After separate approval, apply the migration **before merge** using step 5 and the same migration-only two-part proof. Confirm the old code is healthy. Obtain separate merge approval; then follow steps 6–8, verifying `/api/health`, dashboard routes, one multi-conversation lead and company switching after deployment. **Production reconciliation is not authorized by rehearsal or merge approval**: it deletes messages and requires its own explicit scope/approval after the forecast. Never use the disposable-copy command on production.

## Incident record: 2026-11-24

Dashboard outage of approximately 29 minutes, caused by merging PR #3 before its migration was applied to production.

### Timeline (UTC)

| Time | Event |
| --- | --- |
| 23:09 | PR #4 (this runbook and its tooling) merged. Production redeployed with unchanged application code. Healthy |
| 23:15 | PR #3 merged. Its migration had not been applied to production |
| 23:16 | Vercel recorded the Production deployment of that commit as successful. `/`, `/leads` and `/capacity` started showing "Panel no disponible" |
| by 23:21 | Detected by a manual check of the public pages. `/api/health` returned 200 with the database reachable; `/data-quality` worked |
| before 23:45 | Read-only `ops:db-status` on production confirmed the cause: 5 migrations applied, 2 pending, none failed, no pipeline run in progress |
| 23:45 | Both pending migrations applied to production with `prisma migrate deploy`. The pages recovered without a new deployment |
| 23:46 | Scores recalculated with `ops:rescore` at a fixed evaluation instant |

### Impact

- The overview, the lead queue and the capacity page of the public demo were unavailable for about 29 minutes, from the deployment at 23:16 to the migration at 23:45.
- No data was lost or modified. The dataset is synthetic.
- The health endpoint and the data-quality page kept working throughout.

### Root cause

PR #3 changed every score-reading query to use the new `LeadCurrentScore` table. The runbook, merged six minutes earlier, required applying the migration before merging. The pull request was merged first. Because merging to `main` deploys to production and the build does not run migrations, the new code went live against a database without the table.

### Why nothing stopped it

- CI was green: it tests the code against a database built from the pull request's own migrations, not against production.
- The Vercel deployment was reported as successful: the build compiled. The failure only appears at request time.
- `/api/health` stayed green: it checks that the database is reachable, not that the schema matches the code.
- `main` had no branch protection, and the required order existed only as prose in a document that had just been merged.

### Resolution

The project owner chose to fix forward instead of rolling the deployment back, and explicitly decided to skip the backup and the rehearsal. Before migrating, the pending list was confirmed in a read-only session and table fingerprints were taken.

Verified afterwards:

- Both migrations applied; `prisma migrate status` up to date; `prisma migrate diff` reported no difference.
- All 14 tables that existed before the migration were byte-identical after it. `LeadCurrentScore` was created with one row per lead.
- Recalculation: 1,501 leads scored, 0 created, 1,501 reused, 0 failures, no AI provider call. `Assignment` and every ingested table byte-identical before and after. `LeadCurrentScore` unchanged, so no lead in production had been affected by the A to B to A defect.
- A second recalculation at the same instant changed nothing in any table.
- 0 cross-company violations; public pages and a lead detail loading.

### What went well

- The cause was confirmed with read-only tooling before any change was made.
- Fingerprints proved that the migration and the recalculation left existing data untouched.
- Every production action waited for an explicit decision by the owner.

### What went wrong

- The merge happened before the migration.
- The migration was applied without an independent backup and without a rehearsal. It went well; that is not evidence that skipping them is safe.
- An Instant Rollback would have restored service in seconds. It was not used, so the outage lasted until the migration.
- The first PowerShell instructions used `-MaskInput`, which Windows PowerShell 5.1 does not support and which would have displayed the connection string. It was caught before anything was pasted.
- Whether preview deployments share the production database was still unknown during the incident.

### Changes made because of it

- The order of migration and merge, the backup and the rehearsal are now rules at the top of this runbook, with an approval checklist before the procedure.
- A rollback section for exactly this situation, with rolling back as the default.
- Windows PowerShell 5.1 is the primary set of commands, with a warning about `-MaskInput`.
- A read-only first look at production, and a section on handling credentials.
- Recommended protection for `main`, with an explicit statement of what CI and branch protection cannot guarantee.

### Still open

- Protect `main` as recommended above.
- Confirm which Vercel environments use `DATABASE_URL`.

Resolved since:

- `/api/health` now answers 503 when the database lacks a migration or an object the deployed code needs, and a regression test reproduces this incident. It reports the problem; it does not prevent the wrong order.
- Overlapping writers are refused by an exclusive database lock.
