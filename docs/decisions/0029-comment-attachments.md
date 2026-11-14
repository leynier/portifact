# 0029 Comment attachments and screenshots

- Status: accepted; built switched off (`ATTACHMENTS_ENABLED`), in stacked pull requests: this record, storage and the API, the viewer, then the legal pages, the skill and `TERMS_VERSION` for the maintainer's review.
- Date: 2026-11-14
- Feature: comments (plan section 8). The plan lists attachments as outside the first version ("sin adjuntos") and gives them no design; the maintainer authorized defining and building them.

## Question

A reviewer often needs to show, not only say: a screenshot of what they see, a mockup, a PDF with a marked-up page, a log. Comments are plain text today. Adding files to comments brings the risks the rest of Portifact keeps apart: untrusted bytes next to accounts, storage that someone other than the owner fills, files that must go when their comment goes and must not come back with a backup, and abuse that is not the owner's.

## Decision in short

1. **A message holds up to 4 files**, each judged by its bytes, never its name or declared type: PNG, JPEG, GIF, WebP, PDF or plain UTF-8 text. Nothing else, SVG and HTML included.
2. **Bytes go straight to R2** through a presigned `PUT` that signs the exact size and SHA-256, like publishing. The file belongs to nobody until a comment or reply names it; the write that names it checks the bytes and attaches it in the comment's own claimed batch.
3. **They count in the artifact owner's comment storage** (`annotation_usage.bytes`, the plan's `annotationBytes`), kept by triggers and refused by the existing CHECK constraint. No new plan limit or feature.
4. **Who may read a file is exactly who may read its message's body** (thread in the caller's comment scope, current version for readers, hidden bodies only for the owner side and the author). Files are read through a 5-minute presigned `GET` from R2's endpoint, as a download (`Content-Disposition: attachment`, the type the bytes showed), never from `portifact.com` or an artifact origin.
5. **Images are shown only as `blob:` images** the viewer builds after checking size and SHA-256; PDF and text are downloads only.
6. **Screenshots are the browser's screen capture** (`getDisplayMedia`) in the trusted viewer page, one frame, shown to the person before posting, or a file the person chooses. No script ever reads the artifact's frame.
7. **A file goes when its row goes, and its row goes with its message**, by triggers: deleting a message (marker or row), a thread, an artifact or an account removes the row, and the row's delete trigger writes the `delete_objects` job for its key. No deletion path needs its own code.
8. **Adding is the dashboard's** (session only); reading and downloading are the API's, MCP's and the CLI's too.
9. **Switched off** by `ATTACHMENTS_ENABLED="true"` on the app Worker, never in a deployed `wrangler.jsonc`.

## Files

### Allowed types

The type is what the first bytes say (`sniffAttachment`, `packages/domain/src/attachments.ts`); the name and the client's declared type are never consulted:

| Type              | Bytes                                                              | Shown as                |
| ----------------- | ------------------------------------------------------------------ | ----------------------- |
| `image/png`       | `89 50 4E 47 0D 0A 1A 0A`                                          | image in the viewer     |
| `image/jpeg`      | `FF D8 FF`                                                         | image in the viewer     |
| `image/gif`       | `GIF87a` or `GIF89a`                                               | image in the viewer     |
| `image/webp`      | `RIFF`, four bytes, `WEBP`                                         | image in the viewer     |
| `application/pdf` | `%PDF-`                                                            | download                |
| `text/plain`      | the whole file is strict UTF-8 without NUL, at most 1 MiB          | download                |

Anything else, an empty file, or a text file over 1 MiB is refused with `invalid_input`. SVG is refused because it is a document that runs scripts when opened, and HTML, archives and office files because their only use is to be opened by something else. A file that is two things at once (a polyglot) can only ever be an `<img>` or a download, so its second meaning never runs.

### Sizes and counts

`ATTACHMENT_LIMITS` in contracts:

- 10 MiB per file (a full-screen PNG of a 4K display fits), 1 MiB for text.
- 4 files per message.
- 8 unattached uploads per person at a time, each usable for an hour.
- 60 uploads started per person and 300 per artifact in 24 hours, counted in `rate_limits` before the row is written.

### Names

A name is 1 to 200 code points without control characters, `/` or `\`. It is untrusted text shown escaped. The download's file name is the name with the bytes' extension appended unless it already ends with one of the type's extensions (`report.html` that is a PNG downloads as `report.html.png`), sent as RFC 6266 `filename*`.

## Uploading

1. `POST /api/v1/artifacts/:id/annotations/attachments` with `{ name, size, sha256 }`. The caller must be able to start a thread on the artifact (the annotations `participate` action, the same checks as a new comment); budget protection's pause of new comments refuses it (`checkAnnotationCapacity`); the size must fit. One insert writes a `pending` row (`comment_attachments`, regional) only while the person has fewer than 8 live pending rows; the answer is the row and a presigned `PUT` to `attachments/<artifact>/<attachment>` signing `content-length` and `x-amz-checksum-sha256`, 15 minutes. R2 refuses other bytes. No idempotency key: a retry leaves one more pending row, bounded by the cap and gone within the hour.
2. The client sends the bytes.
3. A new thread or reply names the files (`attachments`: up to 4 IDs, no repeats). Before its batch the service reads each object's head and first bytes (the whole file for text, at most 1 MiB): the size and SHA-256 must be the row's and the bytes an allowed type, or the write is `invalid_input` and nothing is written. Its claim's guard adds that every named row is still `pending`, uploaded by the caller, for this artifact and unexpired; the batch then turns them `attached` with the message, the thread and the type the bytes showed. The attach trigger adds the size to the owner's `annotation_usage.bytes`; past the plan's limit the CHECK fails the whole batch and the write answers `quota_exceeded`, like a comment that does not fit.

An attachment never changes after that: editing a message changes its text only. Removing a file means deleting its message (the author) or deleting or hiding it (the people who manage the artifact).

Pending rows do not count in anyone's storage: at most 8 per person, 10 MiB each, for an hour. The maintenance scan deletes expired ones (`pruneAttachmentUploads`), so their bytes go by the same trigger as every other row.

## Storage and the owner's quota

`comment_attachments` has one row per file: ID, artifact (foreign key, cascade), owner, thread and message (foreign keys, cascade, null while pending), uploader, name, size, SHA-256, type (null while pending), state (`pending`, `attached`), creation, expiry (pending only) and attach time. Its R2 key is derived (`attachments/<artifact>/<id>`), never stored or taken from input, in the owner's region's bucket.

Triggers (migration `comment_attachments`):

- `comment_attachments_usage_attach`, `_usage_delete`, `_usage_owner`: an attached row's size counts in its owner's `annotation_usage.bytes`, moves with a transfer and goes with the row, like change-list items (0078).
- `comment_attachments_release`: every deleted row, pending or attached, writes one `delete_objects` outbox job for its key, in the statement that deleted it.
- `annotation_messages_attachments_deleted`: a message turning `deleted` (the marker kept when others replied) deletes its rows.

Foreign keys do the rest: a thread deleted, an artifact purged, a message row deleted remove the rows, and SQLite fires the delete triggers for rows a cascade deletes. `deleteUnreferencedKeys` keeps an `attachments/` key while a row still names it, as it keeps a logo a brand names again.

Counting in the comment bytes, not in `account_usage.stored_bytes`, is deliberate: readers add attachments, and they must never be able to stop the owner publishing. The cost is that files compete with comment text for the same 50 MB on Free and 100 MB on paid plans (per seat on Team); raising `annotationBytes` is a pricing change outside this record. The owner controls it as they control comments: the annotations mode, comment deletion and moderation.

## Reading

- **In thread views.** A message view carries `attachments` (`{ id, name, contentType, size, sha256 }`) only when it has any, only while the switch is on, and only when the caller sees its body (`messageBodyVisible`). Released clients validate with `z.object`, which drops the field. Every read path (list, one thread, the export, a space's open feedback) gets it from `threadViews`, so none decides it separately.
- **Downloading.** `GET /api/v1/artifacts/:id/annotations/attachments/:attachmentId` (`annotations:read`; MCP `get_annotation_attachment`; `portifact annotations attachment`) authorizes `read` on the artifact, finds the row attached to this artifact, then its thread through `findThread` (scope and version) and its message through `messageBodyVisible`; anything else answers `not_found` with the message of a missing attachment, so a hidden thread's file is indistinguishable from none. It answers the metadata and a presigned `GET` valid 5 minutes with `response-content-disposition=attachment; filename*=...` and `response-content-type` set to the stored type. The legal hold's refusal comes from the annotations `authorize`, which already refuses the owner side of a held artifact and gives everyone else what a suspended one gives.
- **Where the bytes come from.** R2's S3 endpoint, as for version downloads: it holds no Portifact credential, the session never goes there (`credentials: "omit"`), and the response is a download. The artifact origin is not used: it cannot decide comment scope (that needs the person, which only the app knows), and a new reserved path on `portifact.dev` would be a second way to read comments outside the services.
- **In the viewer.** The viewer fetches an image's link, checks the bytes' size and SHA-256, and shows it as a `blob:` URL in an `<img>`; the dashboard's and viewer's policies add `blob:` to `img-src` only while the switch is on. An image cannot run scripts or load anything. PDF and text are saved with the name as a download, never framed or rendered.
- **Tokens.** A service token takes no part in comments (decision 0011), so it gets what a missing artifact gives. A person's OAuth token with `annotations:read` reads what the person reads.

## Screenshots

The viewer's composer offers "Attach a screenshot" where `navigator.mediaDevices.getDisplayMedia` exists. It asks for one capture (`preferCurrentTab`, a hint Chromium honors; Firefox and Safari show their chooser), draws one frame on a canvas in the viewer page, stops every track at once, encodes a PNG and shows it in the composer with a Remove button. Nothing is uploaded until the person posts, and then it is an ordinary attachment.

Rejected ways:

- **Reading the frame by script** (`html2canvas`, the bridge serializing its DOM, `drawImage` of the iframe): the frame is another origin on purpose and the browser forbids it; making the bridge send page content to the viewer would turn untrusted script into a data source the viewer trusts.
- **Capturing on the server** (a headless browser opening the artifact): it would render as someone else, with other cookies and state, and is a large new attack surface for a picture the person can take themselves.

The browser shows its own permission prompt and recording indicator; the person chooses what to share. Where screen capture does not exist (most phones), the file picker is the way, and an operating system screenshot is a file like any other.

## Adding is the dashboard's

The upload route refuses a request with an `Authorization` header before its token is checked, as suggestions do, and a new thread or reply that names files from a bearer credential is refused `forbidden`. Reading and downloading take a person's token on the API, MCP and the CLI, with the same rules and errors.

Why: attachments are evidence a person adds while looking at the artifact; an agent that can post files into other people's artifacts is a cheap way to spread content the owner pays to store; and MCP never carries bytes, so adding through it would need an upload path for agents that the first version does not need. Adding through MCP and the CLI can come later with the same services.

## Lifecycle, deletion and restore

| Event                                                     | What happens to attachments                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| The author deletes their message                          | Marker or row: the trigger or the cascade deletes the rows; each writes its `delete_objects` job                               |
| A moderator hides a message                               | Hidden with the body; unhiding shows them again                                                                                |
| A moderator deletes a message or a thread                 | As above                                                                                                                       |
| Comment retention deletes threads                         | Cascade                                                                                                                        |
| The artifact is purged (also account or workspace deletion) | Cascade from the artifact                                                                                                    |
| An account is deleted                                     | Its messages elsewhere are erased (`eraseAuthorFromThread`), taking their files; its pending uploads are deleted in `advanceAccountDeletion` |
| A transfer                                                | The rows' owner moves; the trigger moves the bytes in the usage, and the target's CHECK refuses a move without room              |
| A legal hold                                              | Nothing is deleted: comments on a held artifact are kept, and the release's erasure takes their files with them; the pending prune and the operator's removal leave held artifacts out |
| The operator removes a file                               | Its row is deleted with a `comment_attachment` window tombstone                                                                 |
| A pending upload expires                                  | The maintenance scan deletes the row                                                                                           |

A D1 Time Travel restore rewinds rows, not R2:

- Rows deleted after the restore point come back. Their messages' and threads' deletions are kept by the existing `comment_message` and `comment_thread` markers, artifacts and accounts by theirs, and the operator's removals by `comment_attachment` markers (`WINDOW_TOMBSTONE_KINDS`, re-applied by `restoreEntries`); re-applying them deletes the rows again, so files whose bytes are gone stop being listed. Pending rows that come back are expired and pruned again.
- Files uploaded after the restore point have bytes and no row. The storage reconciliation lists `attachments/` too and reports them as `orphan` findings, which the operator deletes after checking, as for other orphans.

## Abuse and the operator

Reports name the artifact (the report form is unchanged); the reporter explains which comment. The people who manage the artifact can hide or delete the message. For a file that is not the owner's to judge (illegal content on someone else's artifact), the operator tool lists an artifact's files (`attachments --artifact <id> --region <name>`, metadata only) and removes one (`remove-attachment <id> --region <name>`), which deletes the row with its tombstone and records `attachment_removed` in the artifact's `lifecycle_events`. A held artifact's files are refused: the hold keeps evidence, and the artifact is already suspended, so nobody reads them.

## Export

- The account export lists the account's own messages with their attachments' metadata; the comments export (JSON) and the data records carry them through the message views. The Markdown export says how many files a message has, never their names.
- The bytes are not in the export files: they are downloaded through the attachment link by whoever may read them, as an export's artifact files are fetched through the download links. The Terms' export register says so.

## What never carries attachments

Comment notices, review notices, webhooks' payloads, issue integrations (the text and quote they may send never include files), content search, the access log and analytics. Logs never hold a name, a key or a link.

## Plans, budget and traffic

- No new plan feature or limit: the files count in the owner's `annotationBytes` (Free 50 MB, Pro 100 MB, Team 100 MB per seat), so released clients that parse plans strictly are unaffected.
- Budget protection's pause of new comments also refuses starting an upload; reading is never refused.
- Downloads go from R2 straight to the reader and are not the owner's traffic, like version downloads.

## Regions

The table is regional (`TABLE_HOMES`), the bytes are in the owner's region's bucket, presigned against that bucket's endpoint, and every scan runs per region. A notice never names a file.

## Switched off

Without `ATTACHMENTS_ENABLED="true"` on the app Worker: the upload and download routes and the MCP tool answer `not_found`, a thread or reply naming files is `invalid_input`, views carry no `attachments`, the viewer's lookup says `attachments: false` so it shows no control, and the policies stay as they are. The jobs Worker deletes files whatever the switch, so cleanup never depends on it. The legal pages describe the feature only in the last pull request of the stack, which also decides about `TERMS_VERSION`.

## Threat model

| Threat                                                   | Answer                                                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A file runs script on a Portifact origin                 | It is never served from `portifact.com` or `portifact.dev`; R2 sends it as a download; the viewer shows only allowed images as `blob:` images |
| A renamed or mislabeled file                             | Types come from the bytes; the download name gets the bytes' extension                                                         |
| Other bytes than the ones checked                        | The upload URL signs size and SHA-256; the attach rechecks both against R2 before its batch                                     |
| A reader reads a file of a thread they cannot see        | The download runs the thread's scope and the body's visibility; a hidden file answers like a missing one                        |
| Someone fills the owner's storage                        | Files count in comment bytes only, never publishing storage; per-person and per-artifact upload limits; the owner's moderation |
| A file outlives its comment                              | Triggers on every row deletion write its R2 deletion; restore markers delete restored rows again; reconciliation finds orphans |
| A screenshot captures more than intended                 | The browser's own prompt and indicator; one frame; shown before posting; nothing sent until the person posts                   |
| An agent spams files                                     | Adding is session only                                                                                                         |
| A link leaks                                             | It names one object, expires in 5 minutes and is never logged                                                                  |

## Rejected

- **A content Worker path for attachments**: see "Reading".
- **Counting files in publishing storage**: readers could stop the owner publishing.
- **A paid feature or a new limit**: released CLIs parse plan shapes strictly, and the comment byte limit already bounds the cost.
- **Inline PDF or text viewing**: a PDF viewer is a large parser of untrusted input; a download leaves it to the person's own reader.
- **Editing attachments**: deleting the message is enough for a first version.

## Questions for the maintainer

1. Are 50 MB of comment storage on Free, shared by text and files, the right default, or should paid plans' `annotationBytes` grow when attachments are switched on?
2. Should the account export carry the person's own attachment bytes in `portifact export`, instead of links?
3. Should adding through MCP and the CLI come next?
