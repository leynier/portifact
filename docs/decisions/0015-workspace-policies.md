# 0015 Workspace policies

- Status: accepted
- Date: 2026-11-10
- Feature: premium plan E4 (`policies` in `PLANS`, Enterprise)

## Question

An organization wants rules that hold for every artifact of its workspace whoever acts on it: no artifact may be public, new artifacts start shared with the workspace, readers only at the company's own email domains, share links only with a password or not at all. Where do the rules live across the global and regional databases, how are they applied without a new read on every write (and none on delivery), what happens to existing artifacts that break a new rule, who sets them, what does a lapsed plan do, and what keeps a restore from lifting one?

## Decision in short

- A workspace's policies are one validated JSON value on its global row (`workspaces.policy`, null for the defaults) with a revision (`workspaces.policy_revision`). The shape is `WorkspacePolicy` in contracts, the rules are `packages/domain/src/workspace-policies.ts`, the use cases `packages/services/src/workspace-policies.ts`. A personal space has none.
- The policy is read in the same query as the membership (`actorOn`, `tokenActorOn`), so `Actor.policy` carries it and no write path gains a round trip. Measured with the recording proxy against develop: `preparePublish` 11, `updateAccess` 11, `createShareLink` 4 and `openShareLink` 3 D1 calls, before and after, with the defaults and with a restrictive policy (`packages/services/test/workspace-policies.test.ts`).
- The policies bind everyone acting on the workspace's artifacts: admins (the dashboard says so), editors and service tokens. A refusal is the new error code `policy_refused` (403, CLI exit 7) whose message names the policy, the same through the API, MCP, the CLI and the dashboard.
- Only admins set them (role action `policies`, never a token's), only through the dashboard session (`GET`/`PUT /api/v1/workspaces/:slug/policies`, `POST .../policies/preview`; a bearer token gets 403). Every member reads them there, and every client reads the policy in effect in the workspace list (`GET /api/v1/workspaces` with `artifacts:read`, MCP `list_workspaces`, `portifact workspaces`), so agents and the CLI can explain a refusal before trying.
- Setting or tightening any field needs `policies` in the workspace's plan; loosening (or changing nothing) never does. When the plan lapses the policies keep applying, because lifting a restriction silently would widen access; an admin can still loosen or remove them.
- A save that would change existing artifacts is refused with the counts (`policy_refused`), unless the admin confirms it (`confirm: true` after the preview). A confirmed save writes a `workspace_policy` outbox job in its global batch, which applies the policy in bounded steps.

## The policies

| Field              | Values                                                                                                          | Applied in                                                                       | Existing artifacts                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publicAccess`     | `allowed` (default), `forbidden`                                                                                | `updateAccess` (before the account-age rule), `transferArtifact`                 | Public artifacts become `workspace` (generation moves, sessions end), after confirmation                                                                                           |
| `defaultAccess`    | `restricted` (default), `workspace`, `domain` (needs a verified domain when set); never `public`                | `preparePublish`'s workspace path (`newArtifactDefaults`)                        | Never changed                                                                                                                                                                      |
| `readerDomains`    | null (default) or 1 to 20 plain ASCII domains, matched exactly against an address's domain like `emailDomainOf` | `updateAccess` when readers are added, `transferArtifact`                        | Readers outside are removed (generation moves), after confirmation. Members and groups are not readers and are not affected                                                        |
| `shareLinks`       | `allowed` (default), `password_required`, `disabled`                                                            | `createShareLink`, `openShareLink`, `transferArtifact` (`disabled` only)         | `disabled`: active links are revoked by the job. `password_required`: links without a password stop opening at once (checked at open time) and their sessions are ended by the job |
| `shareLinkMaxDays` | null (default) or 1 to 365                                                                                      | `createShareLink` (an expiry is required and must be within it), `openShareLink` | Links older than the lifetime stop opening at open time; their sessions are ended by the job                                                                                       |

Open-time enforcement for links costs no round trip: `openShareLink` already read the owner's plan from the global database, and now reads the plan and the workspace's policy in one `batch` (`ownerEntitlementsAndPolicy`). The content Worker's request path is unchanged: a link session that is already open lasts until the job ends it (it runs at the next outbox relay, within a minute or two) or its own expiry.

Transfers into a workspace are refused, never narrowed, when the artifact is public where public access is forbidden, lists a reader outside the allowlist, or has active share links where links are disabled: the admin narrows the artifact first. The batch of the move is conditioned on the same facts (`access_mode <> 'public'`, no reader outside, no live link), so a concurrent change makes the move a no-op (`version_conflict`). A link a stricter link rule refuses simply stops opening in the target.

## Races

Workspaces are global rows and artifacts regional ([decision 0005](0005-regions.md)): no batch spans both, so a regional write cannot be conditioned on the policy. Instead the tightened policy wins after the fact:

- Every save of a policy that restricts existing artifacts writes the `workspace_policy` job in its batch, even when nothing was counted, so a request that read the old policy and writes just after the save is narrowed when the job runs.
- A request that writes after the job ran is caught by the maintenance scan `enforceWorkspacePolicies` (every 15 minutes, 20 workspaces with a policy per run from a cursor in `maintenance_cursors`, one bounded step each). The bound for a race is one scan cycle, and the audit log records both the change and its correction.
- Share links need neither: a link created against the old policy is refused at open time.
- The policy write itself is conditioned on the caller still being an admin (`stillAdmin`) and on the revision it read, so an admin demoted before the write changes nothing and of two concurrent saves the later one is a `version_conflict`.

## The job

`enforceWorkspacePolicy` reads the workspace's current policy and, in one regional batch, changes at most 50 rows of each kind (`WORKSPACE_POLICIES.enforceBatch`): public artifacts narrowed to `workspace` (with the `artifact.access_changed` webhook event when the plan has webhooks), readers outside removed (the artifact's generation moves), active links revoked with their sessions while links are disabled (revoked links are covered by `share_link` tombstones like any revocation), and sessions of links the policy stops opening ended. Each statement is conditioned on the row still breaking the policy, so a retried or concurrent step changes nothing twice. It answers `pending` while a kind filled its limit and the queue delivers it again; `done` once nothing is left; `stale` for a workspace that is gone. Approval reviewers who no longer take part after a narrowing are dropped by the existing re-check scan.

## Audit

`policy.changed` (global, target `policy`, the workspace's ID) records the fields that changed, their new values (enums, numbers and domains, never addresses) and whether the admin confirmed changes to existing artifacts. `policy.enforced` (regional, actor `system`) records what one step changed, as counts read in the step's own statement; a step that changes nothing records nothing.

## Restore

A D1 Time Travel restore rewinds the workspace rows and with them the policies, which could lift a restriction an admin set after the restore point (for example re-allow public access). Policies are not tombstones, so they get the same treatment as plans: `export-policies --out <file>` before the restore and `apply-policies --file <file>` after it (`applyWorkspacePolicies`), which sets each exported policy again with the operator as actor, writes the job, and lists workspaces with a policy the file does not have for the operator to review; it never lifts one. See [operations.md](../operations.md).

## Next

Out of scope here, because each needs the content Worker or the auth layer:

- `sessionHours`: a maximum length of read, review and link sessions for the workspace's artifacts. Needs the content Worker to cap the session cookies and claims it issues by the owner's policy, which its delivery lookup would have to carry without a new read.
- `allowedClients`: the OAuth clients allowed to act on the workspace (for example the CLI and one MCP client). Needs the token's client in `Actor` and a check in `authorizeResourceRequest` or `actorOn`, and a way to list clients an admin can recognize.
- An IP allowlist for reading and acting on the workspace's artifacts. Needs the client IP in delivery and API authorization, a CIDR rule in the domain, and an answer for share links and the viewer's frame.
