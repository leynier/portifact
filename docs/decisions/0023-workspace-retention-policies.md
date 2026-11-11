# 0023 Workspace retention policies

- Status: accepted for the maximum life of artifacts; comment retention is designed here and ships in a later change
- Date: 2026-11-11
- Feature: premium plan E3, last part (`policies` in `PLANS`, Enterprise, live): "Retention policies: maximum life of an artifact, automatic archive and comment retention"

## Question

A workspace's admins want their own data-minimization rules: no artifact stays online longer than some time, stale artifacts are archived on their own, and old comments go away. These rules archive and delete customers' data on a schedule, so the worst outcome is losing something the workspace did not mean to lose. What does each rule measure, what does it archive or delete, how does it compose with the expiry, pins, the archive, the plan and its grace, how is it enforced without a new read on any request path, and what keeps a restore from bringing back a rule an admin had removed?

## Facts: an artifact's life today

Read from the code, not assumed:

- **Expiry.** Every publish (`commitPublish`), rollback (`rollbackArtifact`, a new version), renewal (`renewArtifact`), restore (`restoreArtifact`) and unpin (`unpinArtifact`, and `unpinLapsedPlans` when a plan loses `pin`) sets `artifacts.expires_at` to now plus `LIMITS.activeDays` (30), the same on every plan. Nothing else moves it. Delivery treats an active artifact past `expires_at` as archived at once (`effectiveState`), so nothing depends on the scan's timing.
- **Pins** (P2, feature `pin`): a pinned artifact has `expires_at` null and never expires; pinning needs the plan, unpinning never does; archiving clears the pin; `unpinLapsedPlans` unpins the artifacts of owners whose plan (and grace, decision 0022) lost `pin`, with a fresh 30-day expiry.
- **Archive.** `archiveExpired` (every 15 minutes, per region, 50 a run) archives active artifacts past their expiry, with `archived_at` the expiry itself and `purge_at` fixed then from the owner's `archiveMonths` (6 on free, 12 on paid, held by a grace). It writes a `lifecycle_events` row and no audit event; a manual archive (`archiveArtifact`) records `artifact.archived`. The lifecycle triggers free the active slot. The content search triggers drop the artifact's index (decision 0012). Custom domains stay attached (only purge, suspension and deletion release them). Archived means: not served, every version, byte, comment, reader, share link and access log row kept, restorable by an admin or editor until `purge_at` (if a slot is free).
- **Restore** brings it back at the same URL with the same access for another 30 days and re-indexes it.
- **Purge.** `purgeArchived` claims archived artifacts past `purge_at` as `purging` and `deleteArtifactData` deletes them for good: the artifact row and, by cascade, versions, files, readers, threads and messages, share links, review requests; its R2 objects through `releaseOrphans`; its access log and view counters through `erase_access_events`; an `artifact` tombstone so a restore cannot bring it back. Nothing of a purged artifact can be recovered.
- **What can be undone:** an expiry by renewing (before it) or restoring (after it, until `purge_at`); a manual archive by restoring; nothing after the purge.

## Decision in short

- **One setting, the maximum life of artifacts** (`artifactMaxDays`, 7 to 3,650 days, null for none, in `workspaces.policy` with its effective date `artifactMaxDaysFrom`). An artifact of the workspace is archived that many days after its **last publish** (a rollback counts, it is a new version) **or restore**, whatever its renewals. It only caps `expires_at`; archiving is the usual expiry, never a new path, and nothing is deleted by it.
- **Automatic archive of inactivity is not a second setting.** Today's expiry already archives an artifact 30 days after its last publish, renewal or restore when nobody renews it. Measured honestly on the data every workspace has (no per-delivery write, analytics only on some plans and only as daily counts, the access log only for `restricted` artifacts), "inactivity" would be "time since the last publish, renewal, restore or comment". A shorter inactivity window and a maximum life counted from the last publish differ only in whether a renewal or a comment keeps an artifact alive, and a renewal is exactly what a retention rule exists to override. Two settings that look different and behave almost the same would mislead admins, so there is one, named for what it measures: "Archive each artifact a number of days after its last publish or restore".
- **Comment retention ships separately** (see "Comment retention, designed" below): it deletes rows for good and needs its own tombstones, so it gets its own reviewable change.
- **Nothing happens at the save.** A new or shorter maximum takes effect `retentionNoticeDays` (7) after the save; the server sets `artifactMaxDaysFrom`, ignoring what a client sends (`retentionTiming`). No deadline is ever earlier than that date. A longer one keeps the date the current one had (lengthening during the notice period never makes it bind sooner); removing it clears it. Loosening applies at once.
- **Pins:** while a maximum life is set (pending or in effect), pinning is refused (`policy_refused`, `checkPolicyPin`), and the policy's job unpins pinned artifacts with their deadline. A pin means "never expires", which the admin's rule rules out; refusing it is predictable, and the Policies page and the artifact page say so.
- **Restore starts a new life**, like a publish: an archived artifact restored by an admin or editor gets `min(now + 30 days, its deadline from now)`. Restoring is a deliberate act, logged, and the same person could publish a new version anyway.
- **Renewals are capped** at the deadline counted from the last publish or restore, and a renewal that the deadline would put in the past is refused (`policy_refused`, "publish a new version"), never turned into an archive.
- **Plan and grace.** Setting or shortening needs `policies` in the plan; lengthening or removing never does. A lapsed plan keeps the maximum running: it is the customer's own data-minimization rule, and stopping it silently would break their compliance. The grace of decision 0022 holds what a plan kept (the archive length among it); it does not suspend the workspace's own rule. They compose simply: the maximum life decides when an artifact is archived, the plan or its grace how long the archive is kept (`purge_at`, fixed at archiving).

## How the cap works

`maxLifeDeadline(life, lifeStart) = max(from, lifeStart + days)` and `policyExpiry(policy, planExpiry, lifeStart) = min(planExpiry, deadline)` in `packages/domain/src/workspace-policies.ts`; their SQL twins `maxLifeDeadlineSql` and `cappedExpirySql` are in `packages/services/src/max-life.ts`. The life start is the later of the current version's `committed_at` (its `created_at` for an older row) and `artifacts.restored_at` (new column, migration 0062, written only by `restoreArtifact`), so the cap reads no other table and needs no backfill. Properties (tested with fast-check): the cap never extends an expiry, never puts a deadline before the effective date, and never gives a just-published artifact less than 7 days.

Every write path computes it with the policy it already has, so no request gains a read or a round trip: `Actor.policy` comes with the membership (`authorizeUploadOn` in `commitPublish`, `managedArtifact` in `rollbackArtifact`, `authorizeOn` in the lifecycle actions). Publish, rollback and restore start the life now and compute in JS; renew and unpin keep it and compute in the update statement itself (`cappedExpirySql` reads the row's own columns). Measured: a renewal and an archive cost the same D1 calls with and without a maximum life (`packages/services/test/workspace-retention.test.ts`), and the existing request-path cost tests (`write-costs`, `introspection-cost`, the keyed adapters, the content Worker) are unchanged.

## Enforcement

The maximum only moves `expires_at` earlier; `archiveExpired` archives as for any expiry. Two places move it for existing artifacts:

- **The `workspace_policy` job**, written in the save's global batch (as decision 0015's). It now runs on the workspace's own region (`workspaceRegionDb`): with a separate EU database the job used to run only on the default one, which left EU workspaces to the scan. One step (`enforceMaxLife`, its own batch, 50 artifacts) unpins pinned artifacts and caps the expiry of those expiring after their deadline, each recomputed from the row as it is now, so an artifact published or restored since the selection keeps its later deadline; it moves the lifecycle generation (a racing renewal answers `version_conflict`).
- **The scan** `enforceWorkspacePolicies` (every 15 minutes, per region, capped and resumed by its cursor as in decision 0015) finds workspaces with an artifact over its deadline in the same one regional query (the flags travel in its single JSON parameter: 4 bound parameters whatever the number of workspaces) and runs a step, catching a write that read the old policy.

Statements select their own rows (`overMaxLifeIds`, `giveBackIds`, at most 5 bound parameters each, never a list of IDs). With the workspace and its artifacts in one database (production today), every statement of the step is conditioned on the revision read (`exists (... policy_revision = ?)`, through `bothSides`), so a policy loosened between the read and the write stops the batch. With a separate regional database no batch can say that: the step reads the revision again after its batch, and if it moved to a policy that lengthened or removed the maximum, gives back at once what it capped. The window of a stale cap ends with the step itself.

**Loosening** gives time back: the job's payload carries the replaced maximum (`replacedMaxLife`), and the step raises the expiry of active artifacts whose expiry is exactly the deadline that maximum gave them (the cap, not an expiry of their own) and still in the future, to the later of their expiry and `min(new deadline, now + 30 days)`: never earlier than it was, at most what a renewal gives. Artifacts already archived are not restored by a loosening; an admin restores them.

**Trail.** Each step records `policy.enforced` by the system with counts (`deadlinesSet`, `deadlinesExtended`); each unpin `artifact.unpinned` by the system with `policy: artifactMaxDays` and its `lifecycle_events` row; each artifact archived because it reached its deadline (its expiry is exactly the deadline) `artifact.archived` by the system with `policy: artifactMaxDays` in the archive's own batch (other expiries record nothing, as before). Search, active slots and custom domains follow from the archive as for any expiry. **No new webhook event:** `artifact.expiring` already fires from the expiry notice scan before an artifact archives, and no automatic archive has an event today; one can be appended to `WEBHOOK_EVENTS` later without changing this design.

**Expiry notices** need no new kind: the policy moves `expires_at` during the notice period (never before the effective date), so the usual notice goes out three days before, with `noticeDetail(region)` deciding names as for any expiry. The notice does not say the deadline comes from the policy: that would need the policy in the notice job (a read per owner) and a new text in 8 languages for a fact the artifact page and the Policies page already show; left out.

## The preview, the confirmation and the admins' notice

The preview (and the save, refused again if it grew) counts, only for a new or shorter maximum: active artifacts it archives the day it takes effect (`artifactsAtStart`), those it archives within 30 days after that earlier than their own expiry would have (`artifactsSoon`), and pinned ones it unpins (`pinsLifted`). They are `PolicyImpact` fields, defaulting to 0 so a confirmation sent by an older dashboard still parses (and is then refused until confirmed). A new or shorter maximum writes one `retention_notice` job in the save's global batch; the jobs Worker emails every admin once (`sendRetentionNotice`: claimed before sending, put back on a failed first send, suppressed addresses skipped, `checkNoticeCapacity`, `recordEmailsSent`, moot once the policy changed), in the admin's language among the 8, with counts, the number of days and the date, never a name, so the email is the same in every region. The Policies page shows every member a banner while it waits for its date, and the rule in effect after.

## Restores

The danger here is the opposite of decision 0015's: re-applying a tighter rule is what archives. So `apply-policies`:

- always applies a file's longer or removed maximum, alone if the rest of the item is held back for lifting a restriction (`liftedFields` never counts the maximum life as a lifted restriction);
- applies a file's new or shorter maximum with the effective date the file stores, never an earlier one (a file without one, edited by hand, gets the notice period);
- removes a maximum life the restore brought back from a workspace the file does not list (exported after the restore point, so it had no policy then), reported as `retentionCleared`; the rest of that workspace's policy is only listed, as before.

The job it writes gives back what the restored maximum capped. Between the restore and `apply-policies`, the scan may cap or archive with the restored rule: archiving is reversible until `purge_at` (months away), and operations.md says to run `apply-policies` right after the tombstones.

## Rollback

`storedPolicy` stores `artifactMaxDays` and its date only while set, so the previous release reads every other workspace's row. That release's strict schema refuses a row that sets them, like the network lists of decision 0020: rolling back breaks policy reads for workspaces with a maximum life only. Before rolling back, list them (`select id from workspaces where json_extract(policy, '$.artifactMaxDays') is not null`) and either accept that or remove the maximum with the operator (`apply-policies` with the field removed). `restored_at` is an added column the previous release ignores; restores made under it do not set it, so after rolling forward again such an artifact's life counts from its last publish (it may be archived sooner; it is restorable).

## Comment retention, designed

Not shipped here; recorded so the next change starts from it. A setting `commentRetentionDays` with a scope `resolved` (threads resolved more than N days ago) or `all` (threads whose last activity is older, open ones included, chosen explicitly). The scan deletes whole threads with their messages (a thread is the unit people read), never a single message, set-based per region with `maintenance_cursors`, conditioned on the thread still matching (a reply or a reopen since the selection keeps it). `annotation_usage` is kept by its triggers. Approval review notes are not comments and are untouched. The author's own message rule has nothing to apply to once the thread is gone. Exports simply no longer contain them. A D1 Time Travel restore would bring the rows back, and `applyTombstones` does not cover threads today, so each deleted thread needs a `comment_thread` tombstone (exported and re-applied like the other kinds) in the batch that deletes it. It shares the preview, the confirmation, the notice period, the email and the restore rule above.

## Alternatives rejected

- **Counting from creation.** It would archive a living document published yesterday because it was created a year ago. The last publish is what "life" means for a document that changes; creation would be the stricter option only for a compliance rule about first publication, which nobody asked for.
- **The pin wins.** Then any editor could exempt anything from the admins' rule.
- **A pinned artifact still reaches the maximum.** It breaks the invariant that a pinned artifact has no expiry (every reader of `expires_at` relies on it) for a pin that then means nothing.
- **Refusing to restore past the maximum.** An admin restoring an archived artifact is making the same deliberate choice as publishing it again; refusing it only sends them through a publish.
- **Archiving at the effective date without moving deadlines in the notice period.** Artifacts already past the maximum would be archived the minute it takes effect with no expiry notice to their owners.
- **A new deletion or archive path for the policy.** Archive is already one transition with its triggers, slots, search and audit; a second path would drift from it.
- **Capping in the delivery path.** It would add a read per delivery request for the policy; the cap lives in `expires_at`, which delivery already reads.
