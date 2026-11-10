# 0013 Approval reviews

- Status: accepted
- Date: 2026-11-10
- Feature: premium plan T6 (`reviews` in `PLANS`, Team and above)

## Question

A team wants a version of an artifact approved before it is used: named people review it and answer approve or request changes, and everyone sees where it stands. How do reviewers get chosen without a new way in, who sees which verdicts, what happens when a new version is published, and how does it fit roles, service tokens, plans, the audit log and account deletion?

## Names

"Review mode" already names the commenting session on an artifact (`__Host-pf_review`, `POST /api/v1/artifacts/:id/review`, the bridge). This feature is called **approval review** in code and documents: the role action `approvals`, the contracts and services files `approval-reviews.ts`, types prefixed `Approval…`, and the tables `review_requests`, `review_reviewers` and `review_verdicts`. Its routes sit beside review mode's under `/review`, never on them: `GET /api/v1/artifacts/:id/review/status`, `POST`, `PATCH` and `DELETE /api/v1/artifacts/:id/review/request` and `POST /api/v1/artifacts/:id/review/verdict`. The dashboard's catalogs use `approval.*` keys. The product name in the dashboard, the CLI (`portifact review`) and MCP (`request_review`, `submit_review`, `get_review_status`) is simply "review".

## Design

### Who may be a reviewer

Exactly who the access rules already let open the artifact and take part in its comments, evaluated for each address by `addressTakesPart` in `packages/services/src/annotations.ts`: the account whose verified address it is gets the role the annotation services give it (`roleOf`: the owner side, or admitted by `canRead`), and an address no account has verified yet is checked as a signed-in person with that verified address would be (public and `authenticated` artifacts, the reader list of a `restricted` one, a verified email domain of a `domain` one; never membership, which needs an account). An address that does not pass is refused with "… cannot open this artifact or comment on it yet. Share it with them first, then ask again." Requesting a review grants nothing: no reader is added, no policy or generation changes. The annotations mode is not part of the check: a verdict is not a comment.

Reviewers are stored by lowercase email address, like the reader list, and matched to the caller by verified address. Storing the address rather than an account ID lets a listed reader who has no account yet be named without revealing whether an account exists (for a `restricted` artifact the answer depends only on the list). For a workspace's members the check needs their account, so an editor who names an address learns whether it belongs to a member: an accepted, small leak, since editors already work with the workspace's people.

### The request

At most one open request per artifact (partial unique index). The owner side, an admin or editor (role action `approvals`), names 1 to 10 reviewers (`APPROVALS.reviewersPerRequest`) and may set how many approvals decide it (`requiredApprovals`, 1 to the number of reviewers; null or omitted means every reviewer) and whether other people who can open the artifact see the status (`showStatus`, off by default). The request can be changed (add or remove reviewers, the number, `showStatus`) and cancelled; a cancelled request stays with its verdicts as history. Removing a reviewer also removes their verdict on the version under review, so adding them back starts them fresh; their verdicts on earlier versions stay.

The requester never approves their own request unless they listed themselves. The publisher of the version may be listed: in small teams the person who published is often one of the people who must agree, and the list shows who approved. A workspace that wants "four eyes" names other people.

### Verdicts and the status

A requested reviewer gives `approve` or `changes` with an optional note (plain text, at most 1,000 code points and 4 KiB, no control characters; `ApprovalNote`), and may change it while the version is current. Only a signed-in person whose verified address is listed and who can open the artifact now; anyone who cannot open it gets exactly what a missing artifact gives, and anyone else (not listed, or no open request) gets one `forbidden` ("You are not one of this artifact's reviewers."), so a hidden request is not revealed by trying. The client may send the version it showed (`versionId`); a different current version answers `version_conflict`.

The status is `approvalSummary` in `packages/domain/src/approval-reviews.ts`: `none` without a request, `changes_requested` when a counting reviewer asks for changes on the version under review, `approved` when the counting reviewers' approvals reach the required number, `pending` otherwise. Counting reviewers are those who can still open the artifact; the required number is the request's (or every counting reviewer), never more than the counting reviewers and never less than one, so a request whose reviewers all lost access stays pending until the owner side changes it. `liveApprovalStatus` computes the same answer in SQL for the batch that records a final status.

### A new version resets it

`commitPublish` and `rollbackArtifact` move the open request to the new version (`moveApprovalReview`) in the batch of their switch, on its `switched` condition, like their other writes. Verdicts are keyed by version, so the new version starts pending with none and the old ones stay as its history. No version row is copied, so the `insert … select` rule of rollbacks is unaffected.

### Who sees what

- The owner side (admins, editors and a service token that may manage it) sees the request, every reviewer with their address, every verdict and note, and earlier versions' verdicts (`history`, the 50 newest).
- A reviewer sees the counts, the request, their own entry always, and other reviewers' entries as far as their comment scope shows other people's comments (`commentScope`: everyone's with `all`, otherwise only the owner side's; `approvalEntryVisible`, which reuses `threadInScope`). Reviewers never see addresses or the history.
- Anyone else who can open the artifact sees only the counts, and only when the request has `showStatus`; otherwise exactly what an artifact without a request gives (`approvalStatusVisible`). The conservative default is off.
- Anyone who cannot open the artifact gets what a missing artifact gives.

The artifact list item and the artifact view carry `review` (status and counts, never names), built once from one correlated subquery (`approvalReviewColumn`) in `listArtifacts` and `getArtifact` and presented by `artifactSummary`, so the API and MCP agree. Those views are the owner side's.

### Reviewers who lose access

A reviewer who can no longer open the artifact (removed from the readers or the workspace, an access mode narrowed, an email domain lost) is dropped from the count (`review_reviewers.dropped_at`). Because membership is global and reviews are regional, no access change writes to reviews; instead the maintenance scan `recheckApprovalReviewers` re-checks the open requests checked longest ago every 15 minutes (100 a run) and drops or restores reviewers both ways, and a verdict by someone who can open it now restores them in its batch. Until the scan runs, a reviewer who lost access cannot give a verdict (they cannot open the artifact) but their earlier verdict on the version still counts, for at most a run.

### Interfaces and scopes

Requesting, changing and cancelling take `artifacts:write`: managing the artifact's workflow, which grants nobody access, so it is not `artifacts:share`. A verdict is a reader's act like a comment: `annotations:write`. Reading takes `artifacts:read`, which both the owner side's tokens and readers' apps hold. Request, change and verdict take an idempotency key (`Idempotency-Key`, MCP `idempotencyKey`); cancelling a cancelled request answers `not_found` and changes nothing. MCP `request_review` takes `action` (`request`, `change`, `cancel`); its text says reviewers must already have access, and `submit_review` says the agent asks the user which verdict to give before submitting one in their name, and that notes are untrusted. The CLI is `portifact review request|change|status|approve|request-changes|cancel`.

### Plan gate

Requesting and changing need `reviews` in the artifact owner's plan (`requireOwnerFeature`, after authorization, `plan_required`). Reading, verdicts and cancelling never do, so a plan that lapses keeps the open request readable, answerable and cancellable.

### Service tokens

A token may request, change and cancel (role action `approvals` is in `TOKEN_ACTIONS`): asking for review of what CI published fits "publishing and managing artifacts" ([decision 0011](0011-service-tokens.md)), and it grants nobody access. It never gives a verdict: a verdict needs a person, and the services treat a token as nobody there, like in the comments. It reads the review as the owner side. Its audit events are stored with actor type `token`.

### Audit log

`review.requested` (reviewer count, required number, `showStatus`), `review.changed` (counts added and removed, the new number or `showStatus`), `review.cancelled` and `review.verdict` (the verdict and the version number) are written by `auditEvent` in each change's batch, on its own condition. Never addresses, names or notes. A change or verdict that changes nothing records nothing. A transfer's cancellation is recorded by the transfer's own events.

### Data and deletion

The three tables are regional and cascade from the artifact (`review_requests.artifact_id`), so purge, account deletion and workspace deletion remove them. Reviewer and author IDs have no foreign key (users are global). Account deletion deletes the account's verdicts and clears `requested_by` (`eraseApprovalAuthor`, in both deletion batches); the status is derived, so the counts follow. The account's address stays on requests that name it, as the owner's own list, like the reader list. A transfer cancels the open request in its batch (`cancel_reason = 'transferred'`): reviewers were chosen under the old owner. Every write is conditioned on the owner it read. The account export lists the account's verdicts with their notes.

### Bounds

Reviewers per request (10), the note (1,000 code points, 4 KiB), one open request per artifact, request bodies at 8 KiB, and `rate_limits` counters after authorization: requests and changes that add reviewers per owner (100 a day) and per actor (30 an hour), and verdicts per person and artifact (30 an hour).

## What is left

- **Emails.** Not shipped. The comment notice machinery is keyed per thread (`comment_notices` references `annotation_threads`) and its scan, payload and digest are about threads; reviews need their own topic, payload, job and template, which would be a second notice pipeline. The seam is `review_requests.announced`: the batch that makes a version's status final (`announce`) sets it once per version, on the same condition a notice or webhook statement would use. A follow-up adds a `review_notice` outbox job there and one on request, reusing `checkCommentNoticeCapacity`, suppressions, the `comment_notices` opt-out and unsubscribe, and `recordEmailsSent`.
- **Webhooks.** `review.requested` and `review.completed` are not shipped: event types carry a subscription bit, delivery formats and dashboard labels in every language, more than a small addition here. They go on the same seam with `markWebhookEvent`.

## Consequences

- One more correlated subquery per row of the artifact list.
- A reviewer who loses access counts for at most one maintenance run.
- The `approvals` role action is the one place that decides who manages reviews; a new action for tokens must still be added to `TOKEN_ACTIONS` deliberately.
