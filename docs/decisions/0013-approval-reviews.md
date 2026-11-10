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

Exactly who the access rules already let open the artifact and take part in its comments, decided for all the listed addresses at once by `participation` in `packages/services/src/annotations.ts`: `canRead` for a signed-in person with that verified address, plus the owner side. It makes the same reads whatever the addresses are: one read of the owner's own people among them (the owner of a personal space, or the workspace's members, matched by verified address), one of the reader list for a `restricted` artifact and one of the verified email domains for a `domain` artifact. Whether an address belongs to an account outside the owner's people never changes a read or the answer: for a public or `authenticated` artifact every address passes, for a `restricted` one only listed addresses do, for `domain` only addresses at a verified domain. An address that does not pass is refused with "… cannot open this artifact or comment on it yet. Share it with them first, then ask again."; a service token gets one message for every address ("At least one of these addresses …"), so it learns nothing about membership. Requesting a review grants nothing: no reader is added, no policy or generation changes. The annotations mode is not part of the check: a verdict is not a comment.

Reviewers are stored by lowercase email address, like the reader list, and matched to the caller by verified address. A reviewer is shown by name only once they gave a verdict on this artifact (the name of the verdict's author), or when the address is the owner side or a member of the owning workspace. Anyone else stays an address to the owner side and anonymous to reviewers, so a request never tells whether an address has an account or whose it is.

**What an editor can still learn, and why it is not new.** That an address is a member of the workspace, and that member's name: on `workspace` and `domain` artifacts a member passes where a stranger would not, and members are named. Editors already work with the workspace's members (they see them as the owner side's comment authors, in the viewer and in every comment thread), so this tells them nothing an editor does not already see. A service token, which is not a person and may be leaked, gets neither: one refusal for every address, and names only after a verdict or for members, never addresses unless it holds `artifacts:share`.

### The request

At most one open request per artifact (partial unique index). The owner side, an admin or editor (role action `approvals`), names 1 to 10 reviewers (`APPROVALS.reviewersPerRequest`) and may set how many approvals decide it (`requiredApprovals`, 1 to the number of reviewers; null or omitted means every reviewer) and whether other people who can open the artifact see the status (`showStatus`, off by default). The request can be changed (add or remove reviewers, the number, `showStatus`) and cancelled; a cancelled request stays with its verdicts as history. Removing a reviewer also removes their verdict on the version under review, so adding them back starts them fresh; their verdicts on earlier versions stay.

The requester never approves their own request unless they listed themselves. The publisher of the version may be listed: in small teams the person who published is often one of the people who must agree, and the list shows who approved. A workspace that wants "four eyes" names other people.

### Verdicts and the status

A requested reviewer gives `approve` or `changes` with an optional note (plain text, at most 1,000 code points and 4 KiB, no control characters; `ApprovalNote`), and may change it while the version is current. Only a signed-in person whose verified address is listed and who can open the artifact now; anyone who cannot open it gets exactly what a missing artifact gives, and anyone else (not listed, or no open request) gets one `forbidden` ("You are not one of this artifact's reviewers."), so a hidden request is not revealed by trying. The client may send the version it showed (`versionId`); a different current version answers `version_conflict`.

The status is `approvalSummary` in `packages/domain/src/approval-reviews.ts`: `none` without a request, `changes_requested` when a counting reviewer asks for changes on the version under review, `approved` when the counting reviewers' approvals reach the required number, `pending` otherwise. Counting reviewers are those who can still open the artifact; the required number is the request's (or every counting reviewer), never more than the counting reviewers and never less than one, so a request whose reviewers all lost access stays pending until the owner side changes it. `liveApprovalStatus` computes the same answer in SQL for the batch that records a final status.

### A new version resets it

`commitPublish` and `rollbackArtifact` move the open request to the new version (`moveApprovalReview`) in the batch of their switch, on its `switched` condition, like their other writes. Verdicts are keyed by version, so the new version starts pending with none and the old ones stay as its history. No version row is copied, so the `insert … select` rule of rollbacks is unaffected.

### Who sees what

- The owner side (admins and editors) sees the request, every reviewer with their address, every verdict and note, and earlier versions' verdicts (`history`, the 50 newest). A service token that may manage it sees the same without notes (people's words, like comments) and without addresses unless it holds `artifacts:share` (`seesReaders`).
- A reviewer sees the counts, the request, their own entry always, and other reviewers' entries as far as their comment scope shows other people's comments (`commentScope`: everyone's with `all`, otherwise only the owner side's; `approvalEntryVisible`, which reuses `threadInScope`). Reviewers never see addresses or the history.
- Anyone else who can open the artifact sees only the counts, and only when the request has `showStatus`; otherwise exactly what an artifact without a request gives (`approvalStatusVisible`). The conservative default is off.
- Anyone who cannot open the artifact gets what a missing artifact gives, and so does anyone who is not the owner side while the artifact is archived, past its expiry or suspended, as for comments.

The artifact list item and the artifact view carry `review` (status and counts, never names), built once from one correlated subquery (`approvalReviewColumn`) in `listArtifacts` and `getArtifact` and presented by `artifactSummary`, so the API and MCP agree. Those views are the owner side's.

### Reviewers who lose access

A reviewer who can no longer open the artifact stops counting (`review_reviewers.dropped_at`):

- **Reader list and mode.** `updateAccess` re-runs `participation` over the request's counting reviewers (at most 10) against the policy it is about to write (its mode and whole reader list) whenever it removes readers or changes the mode, and drops those who no longer take part in its own regional batch, on the same generation condition as the reader writes (`approvalAccessStatements`). A removed reader's approval stops counting with the removal.
- **Verdicts.** A verdict that would make the status final (approved or changes requested) first re-checks the other counting reviewers and drops those who no longer take part in its batch, so a reviewer who lost access some other way never decides it; a removal that commits between the verdict's reads and its write drops the reviewer in its own batch, and the status is computed on the live rows.
- **Membership and email domains.** Members are global and reviews regional, and a domain can lapse with no write at all, so those losses are left to the maintenance scan. The real bound: a lost member or domain address keeps an earlier verdict counting until the scan reaches its request, which with a backlog is one pass over the open requests (30 requests a run, a run every 15 minutes: `ceil(open requests / 30) × 15` minutes), unless a final verdict re-checks it first. They cannot give a new verdict meanwhile: they cannot open the artifact.

The scan (`recheckApprovalReviewers`) runs last in `runMaintenance` with its own budget: at most 8 D1 calls a request (its reviewers, the owner's plan once per owner, two participation reads, its verdicts and their authors, one write batch) plus 3 a run, at most 30 requests (243 calls) and 5 seconds a run, resuming from a cursor in `maintenance_cursors`. A test counts the calls with a recording proxy over a backlog of the costliest shape. A backlog therefore never pushes the run past D1's query limit or keeps the deletions before it from running.

### A verdict follows its author

A verdict counts, and is shown, only while the address it was given for is still its author's verified address (`verdictHolds`). An author who changes address, or an account that later verifies the address, never inherits it: the list and view ignore it, the verdict path deletes it before writing the caller's own, a different account's verdict is never updated in place (`setWhere` on the author), and the scan deletes the ones left.

### Interfaces and scopes

Requesting, changing and cancelling take `artifacts:write`: managing the artifact's workflow, which grants nobody access, so it is not `artifacts:share`. With the account lookup closed (no names before a verdict, one answer whether or not an address has an account, one refusal for tokens), a token or app with `artifacts:write` learns nothing from a request that its scope did not already let it see, so `artifacts:share`, the scope that manages who reads, is not needed. A verdict is a reader's act like a comment: `annotations:write`. Reading takes `artifacts:read`, which both the owner side's tokens and readers' apps hold. Request, change and verdict take an idempotency key (`Idempotency-Key`, MCP `idempotencyKey`); cancelling a cancelled request answers `not_found` and changes nothing. MCP `request_review` takes `action` (`request`, `change`, `cancel`); its text says reviewers must already have access, and `submit_review` says the agent asks the user which verdict to give before submitting one in their name, and that notes are untrusted. The CLI is `portifact review request|change|status|approve|request-changes|cancel`.

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

### Events and emails

The seam is `review_requests.announced`: the batch that makes a version's status final (`announce`, in a verdict, a change, an access change or the scan) sets it once per version. `packages/services/src/review-activity.ts` builds the statements the writes add to their own batches, from the owner's entitlements they already loaded, so no read or round trip is added (a test counts the D1 calls of request, change and verdict with and without the features):

- `reviewCompletedStatements` runs just before `announce`, on `aboutToAnnounce`: the same predicate `announce` uses (the request open, its live status final and not the one announced), so it sees the same rows and holds exactly when `announce` writes. `reviewRequestedStatements` runs on the request's own `created` condition, or on a change's `updated` condition for the reviewers it added.
- **Webhooks** (decision 0009): `review.requested` for a new request and `review.completed`, through `markWebhookEvent`, only with `webhooks`. They carry the version and the review's status and counts, computed in SQL in the batch (`liveSummary`); never a reviewer's name, address or note, and `review.completed` names nobody.
- **Emails**: one `review_notice` event job, only with both `reviews` and `commentNotices` in the artifact owner's plan (Team has both; without `commentNotices` nothing is written or sent). The jobs Worker turns it into one send job per recipient account, claimed by deleting its row before sending and put back on a failed send, like `comment_notice` and `expiry_notice`. Grouping, the reason for a scan in comment notices, is not needed: a request names at most 10 reviewers and a status is told once per version, so a fan-out job is enough and the write path stays one statement.
  - **Asked**: the reviewers added at that time who have an account holding that verified address. An address that never signed in to Portifact gets nothing: Portifact does not email addresses that never signed in, and a review request must not become a way to send Portifact email to strangers; the requester tells such a reviewer themselves. The email says their review was asked, names the artifact and the version and links the viewer; never the note (requests have none), never other reviewers' names.
  - **Decided**: the owner side (`ownerSide`: the user of a personal space, or a workspace's admins and editors, the requester among them while they still are), minus the person whose verdict made it final, told the version was approved or changes were requested. These are the people who get comment notices on the owner side.
  - At send time the job checks again the account, the opt-out, that the request is open on that version and the version current and active, the plan, that a reviewer is still listed and counting and passes `participation` (the same access rules), or that an owner-side recipient still is one and has not muted the artifact, the suppression list and the cycle's capacity, then claims the email in `review_notices` (one per person, artifact, version and kind, with foreign keys to the version and the artifact; both account deletion batches delete the account's rows and its waiting jobs). Every email is counted with `recordEmailsSent`.
  - **Opt-out**: one setting for comment and review notices, `account_settings.comment_notices`, with the same signed one-click unsubscribe link (`POST /api/v1/notices/unsubscribe`, unchanged). Both kinds come from the same artifacts and people and a reviewer can always see the request in the viewer, so a second switch would only add a choice to explain; the settings page, the unsubscribe page and every email say that the setting covers both.
  - **Capacity**: `checkReviewNoticeCapacity`, at the top of the ladder: review notices stop 5,000 emails before comment notices (4,900 in the cycle), which stop 5,000 before expiry notices, which stop 5,000 before sign-in codes.
  - **Bounds**: request emails come only from requests and changes that add reviewers, which `limitRequests` already caps at 100 a day per owner and 30 an hour per person, each naming at most 10 reviewers: at most 1,000 request emails a day (and so an hour) per owner, 300 an hour per person. Status emails are at most one per owner-side person per artifact version, whatever the status does meanwhile.

## Consequences

- One more correlated subquery per row of the artifact list.
- A reviewer who loses access counts for at most one maintenance run.
- The `approvals` role action is the one place that decides who manages reviews; a new action for tokens must still be added to `TOKEN_ACTIONS` deliberately.
