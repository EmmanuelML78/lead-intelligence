# Deployment runbook: database migrations with Vercel and Neon

How to ship a change that needs a database migration without breaking production or losing history. Written for a Windows workstation using PowerShell.

The first release it covers is the pair of migrations from PR #2 and PR #3. The procedure is general; the release-specific facts are in [Release notes for PR #2 and PR #3](#release-notes-for-pr-2-and-pr-3).

## Rules that always apply

- Migrate with `prisma migrate deploy` only. Never run `prisma db push`, `prisma migrate dev` or `prisma migrate reset` against a shared database.
- Never edit or delete a migration that has been applied anywhere. Never delete rows from `_prisma_migrations` by hand.
- Every operational command names the database it expects with `--expect-host`. If `DATABASE_URL` points elsewhere, the command refuses to run.
- Never type a connection string into a command line, a file inside the repository, a chat or a ticket.
- One operator, one target per PowerShell window. Close the window when you finish with that target.
- Do not run `bun run pipeline` during a deployment. It ingests, may call the AI provider if a key is configured, and assigns advisors.

## How deployments happen

| Fact | Evidence |
| --- | --- |
| Vercel deploys through its Git integration: every push to `main` creates a Production deployment and every pull request commit creates a Preview deployment | GitHub deployment records created by `vercel[bot]` |
| The build is `prisma generate && next build`. It never runs migrations | `package.json` |
| There is no `vercel.json` and `main` has no branch protection, so merging is deploying | repository |
| Preview deployments are behind Vercel Authentication | unauthenticated requests are redirected |
| The pipeline is not scheduled anywhere in the repository; it is run by hand | no cron or workflow |

Consequence: **a migration is always applied by a person, and the order relative to the merge is a decision, not something the platform does.**

## Tooling

| Command | What it does | Writes? |
| --- | --- | --- |
| `bun run ops:db-status --expect-host <host>` | Applied, pending and failed migrations for this checkout; row counts; pipeline runs and their recorded scoring instant; the instant from which scores no longer depend on time | No |
| `bun run ops:fingerprint snapshot <file> --expect-host <host>` | Row count and MD5 of the full contents of every table | No (writes the local file) |
| `bun run ops:fingerprint compare <file> --expect-host <host> --must-match <tables\|all>` | Reports each table as unchanged, changed, new or removed; fails if a required table differs | No |
| `bun run ops:rescore --expect-host <host> --decision-at <ISO instant>` | Prints the scoring plan only | No |
| `bun run ops:rescore ... --apply --report <file>` | Recalculates scores only: no ingestion, no AI call, no assignment | `LeadScore`, `LeadCurrentScore` |

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

## PowerShell session

Open a **new** PowerShell window for each target. In it:

```powershell
$ErrorActionPreference = "Stop"
Set-Location D:\GitHub\lead-intelligence

# Stops at the first failing command instead of carrying on.
function Step { param([scriptblock]$Command) & $Command; if ($LASTEXITCODE -ne 0) { throw "Step failed (exit code $LASTEXITCODE). Stop and investigate." } }

# Paste the DIRECT connection string of THIS window's target. Nothing is shown or stored in history.
$env:DATABASE_URL = Read-Host "Direct connection string" -MaskInput
$ExpectHost = "ep-xxxx-xxxx-00000000"   # endpoint id of this target, from the Neon console
```

`-MaskInput` needs PowerShell 7.1 or later. On Windows PowerShell 5.1 use:

```powershell
$secure = Read-Host "Direct connection string" -AsSecureString
$env:DATABASE_URL = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
```

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

### 1. Freeze

- Announce that nobody runs the pipeline or merges until the deployment is finished.
- In a production window: `Step { bun run ops:db-status --expect-host $ExpectHost }`. `Pipeline runs currently RUNNING` must be 0. A `RUNNING` row that never finishes is a crashed run: stop and decide what it is before continuing.

Nothing technical prevents two pipeline runs at once. The freeze is a procedural control, and `ops:rescore` refuses to start while a run is `RUNNING`.

### 2. Establish what is really pending

Still in the production window, read the `Migrations` block of `ops:db-status`:

| Reported | Meaning | Action |
| --- | --- | --- |
| Pending lists exactly the migrations you intend to ship | Expected | Continue |
| Pending lists fewer | Some were already applied | Continue; the remaining steps apply only what is pending |
| Pending lists more, or an older one | The database is behind in a way nobody planned | **Stop** |
| Failed is not empty | A previous attempt failed | **Stop**; see [Rollback](#rollback) |
| Applied but missing from this checkout is not empty | The database has a migration this commit does not know | **Stop**; you are on the wrong commit |

Write the pending list in the deployment record. Do not assume it.

### 3. Create the backup and the rehearsal copy

Follow [Neon: one untouched backup and one disposable copy](#neon-one-untouched-backup-and-one-disposable-copy). Close the production window.

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

**Go / no-go:** continue only if every expectation above held. If not, stop: production has not been touched.

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

Then check that production, still running the previous code, is healthy:

```powershell
(Invoke-WebRequest https://lead-intelligence-iota.vercel.app/api/health).Content   # {"status":"ok","database":"reachable"}
```

and open `/leads` in a browser: it must not show "Panel no disponible".

Migrating first is only valid when the migrations are compatible with the code currently in production. That is a property of each release; see the release notes below.

### 6. Merge and verify the deployment

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

- Whether both are still pending in production must be read from `ops:db-status` in step 2. It has not been checked.
- The code of PR #3 is **not** compatible with a database that lacks the second migration: its queries read `LeadCurrentScore`. That is why the migration goes before the merge.
- Order for this release: merge this runbook's pull request, bring PR #3 up to date with `main` so its head contains the tooling and both migrations, let CI pass, and use that head as `<RELEASE_SHA>`.
- The recalculation in step 7 is what corrects any lead affected by the A to B to A defect. Until then such a lead keeps showing score B, exactly as before.
- Creating the unique index blocks writes to `LeadScore` while it builds. With about 1,500 rows this is well under a second.
- With the new queue order, recomputing assignments from scratch would change 46 of 1,352 rows on the synthetic dataset. This runbook does not recompute assignments.
