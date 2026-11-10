// User-facing text of the CLI, kept in one place so it can move to the i18n layer. Sentences
// end with a period; no em dashes. Never interpolate a token, cookie or code other than the
// device user code, which the user must see to approve the login.
import { VERSION_DIFF } from "@portifact/contracts";

const VERSION_DIFF_FILE_BYTES = VERSION_DIFF.fileBytes;

export const messages = {
  notice: [
    "Portifact is in early development.",
    "Sign in with `portifact login`, then publish a file or folder with `portifact publish <path>`.",
    "Run `portifact --help` for the available commands.",
    "",
  ].join("\n"),
  serverOverride: (origin: string) => `Using the Portifact server at ${origin}.`,
  deviceInstructions: (url: string, userCode: string) =>
    [
      "To sign in, open this page in a browser:",
      "",
      `  ${url}`,
      "",
      `and confirm that it shows this code: ${userCode}`,
      "",
    ].join("\n"),
  browserOpened: "Opened the page in your browser.",
  waiting: (minutes: number) =>
    `Waiting for approval. The code expires in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
  fileStoreWarning: (path: string) =>
    `Warning: no system credential store is available, so your credentials are saved in ${path}, readable only by your user account.`,
  signedIn: (origin: string, userId: string) => `Signed in to ${origin} as user ${userId}.`,
  whoami: (origin: string, userId: string, clientId: string, scopes: readonly string[]) =>
    [
      `Signed in to ${origin}`,
      `User: ${userId}`,
      `Client: ${clientId}`,
      `Scopes: ${scopes.length > 0 ? scopes.join(", ") : "none"}`,
    ].join("\n"),
  signedOut: (origin: string) =>
    `Signed out of ${origin}. The tokens were revoked and removed from this device.`,
  notSignedInLogout: (origin: string) => `Not signed in to ${origin}. Nothing to do.`,
  errorPrefix: "Error:",

  // Publishing.
  manifestHeader: (count: number, bytes: number, type: string) =>
    `${count} ${plural(count, "file", "files")} (${formatBytes(bytes)}) to publish as ${type}:`,
  manifestLine: (path: string, size: number) => `  ${path}  ${formatBytes(size)}`,
  excludedHeader: (count: number) =>
    `Left out ${count} ${plural(count, "entry", "entries")} by default:`,
  excludedLine: (path: string, reason: "default" | "secret" | "submodule") =>
    `  ${path}  (${reason === "secret" ? "may hold secrets" : reason === "submodule" ? "git submodule or nested repository" : "not published by default"})`,
  sourcesHeader: (count: number, bytes: number, chosenBy: "git" | "folder") =>
    `${count} private source ${plural(count, "file", "files")} (${formatBytes(bytes)}) to attach${chosenBy === "git" ? ", chosen by git" : ""}. Only you can see or download them:`,
  sourceOrigin: (origin: {
    commit: string | null;
    branch: string | null;
    remote: string | null;
    dirty: boolean;
  }) =>
    [
      `Source origin: ${origin.commit === null ? "no commit yet" : `commit ${origin.commit.slice(0, 12)}`}`,
      origin.branch === null ? "" : ` on ${origin.branch}`,
      origin.remote === null ? "" : ` from ${origin.remote}`,
      origin.dirty ? ", with uncommitted changes" : "",
      ".",
    ].join(""),
  lfsPointers: (paths: readonly string[]) =>
    `Warning: ${paths.length} source ${plural(paths.length, "file is a Git LFS pointer", "files are Git LFS pointers")}, not the content itself: ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ", ..." : ""}. Run \`git lfs pull\` first to attach the content.`,
  dryRun: "Dry run: nothing was uploaded.",
  prepared: (version: number, count: number, total: number, bytes: number) =>
    count === 0
      ? `Prepared version ${version}. Every file is already stored, so nothing needs uploading.`
      : `Prepared version ${version}. Uploading ${count} of ${total} ${plural(total, "file", "files")} (${formatBytes(bytes)}).`,
  uploaded: (done: number, total: number, bytes: number, totalBytes: number) =>
    `Uploaded ${done} of ${total} (${formatBytes(bytes)} of ${formatBytes(totalBytes)}).`,
  uploadedPart: (path: string, part: number, parts: number, bytes: number, totalBytes: number) =>
    `Uploaded part ${part} of ${parts} of ${path} (${formatBytes(bytes)} of ${formatBytes(totalBytes)}).`,
  committing: "Making the new version current.",
  aborted: "Cancelled the upload and released its reservation.",
  abortFailed: "Could not cancel the upload. Its reservation is released within 24 hours.",
  published: (url: string, artifactId: string, version: number, expiresAt: string | null) =>
    [
      `Published version ${version} of ${artifactId}.`,
      `URL: ${url}`,
      `Expires: ${formatExpiry(expiresAt)}`,
    ].join("\n"),
  starSuggestion: (command: string) =>
    `Enjoying Portifact? A GitHub star helps other people find it. If you want to, run: ${command}`,

  // Artifacts.
  listEmpty: "No artifacts yet. Publish one with `portifact publish <path>`.",
  listMore: (cursor: string, filterFlags = "") =>
    `More artifacts: run \`portifact list --cursor ${cursor}${filterFlags}\`.`,
  listNoMatch: "No artifacts match these filters.",
  renewed: (id: string, expiresAt: string | null) =>
    expiresAt === null
      ? `${id} is pinned, so it has no expiry to renew.`
      : `Renewed ${id}. It stays published until ${formatDate(expiresAt)}.`,
  pinned: (id: string) =>
    `Pinned ${id}. It stays published with no expiry until you run \`portifact unpin ${id}\`.`,
  unpinned: (id: string, expiresAt: string | null) =>
    `Unpinned ${id}. It stays published until ${formatDate(expiresAt)} unless you renew it.`,
  archived: (id: string, purgeAt: string | null) =>
    purgeAt === null
      ? `Archived ${id}. Restore it with \`portifact restore ${id}\`.`
      : `Archived ${id}. Restore it with \`portifact restore ${id}\` before ${formatDate(purgeAt)}, or it is deleted permanently.`,
  restored: (id: string, expiresAt: string | null) =>
    `Restored ${id}. It stays published until ${formatDate(expiresAt)}.`,
  deleted: (id: string) => `Deleted ${id} permanently.`,
  confirmDelete: (id: string, name: string) =>
    `This permanently deletes "${name}" (${id}) and every version of it. It cannot be undone.\nType the artifact ID to confirm: `,
  readersOnlyWhenRestricted: (mode: string) =>
    `Note: access is ${mode}, so the reader list applies only after \`portifact access set <id> restricted\`.`,
  accessChanged: (id: string) => `Updated access to ${id}.`,
  commentVisibility: {
    owner: "owner (each reader sees their own threads and yours)",
    everyone: "everyone (every reader sees every thread)",
  },
  readerSees: { all: "sees all comments", own: "sees own and yours" },

  // Versions.
  versionsEmpty: (id: string) => `${id} has no published versions.`,
  versionsRetention: (previous: number, days: number) =>
    `The owner's plan keeps ${previous} previous ${plural(previous, "version", "versions")} for ${days} ${plural(days, "day", "days")} after each is replaced.`,
  diffSummary: (
    id: string,
    from: number,
    to: number,
    counts: { added: number; removed: number; changed: number; unchanged: number },
  ) =>
    `Version ${from} to ${to} of ${id}: ${counts.added} added, ${counts.removed} removed, ${counts.changed} changed and ${counts.unchanged} unchanged ${plural(counts.unchanged, "file", "files")}.`,
  diffNoText: (
    path: string,
    change: string,
    status: string,
    before: number | null,
    after: number | null,
  ) => {
    const reason = {
      identical: "is identical in both versions",
      binary: "is not text, so there is no line diff",
      too_large: `is larger than ${formatBytes(VERSION_DIFF_FILE_BYTES)} in a version, so there is no line diff`,
      too_many_lines: "has too many lines for a line diff",
      too_many_changes: "changed too much for a line diff",
    }[status];
    const size = (bytes: number | null) => (bytes === null ? "none" : formatBytes(bytes));
    return `${path} (${change}) ${reason}. Size before: ${size(before)}, after: ${size(after)}.`;
  },

  // Access logs.
  logsEmpty: (id: string, days: number) =>
    `No signed-in visitor opened ${id} in the last ${days} days.`,
  logsNote: (minutes: number, days: number) =>
    `One entry per visitor every ${minutes} minutes, kept ${days} days. Only artifacts restricted to listed readers record openings, your own visits are not recorded, and some openings may be missing.`,
  rolledBack: (id: string, version: number, from: number, url: string, expiresAt: string | null) =>
    [
      `Rolled back ${id}: version ${version} has the files of version ${from}. Access did not change.`,
      `URL: ${url}`,
      `Expires: ${formatExpiry(expiresAt)}`,
    ].join("\n"),
  downloaded: (done: number, total: number) => `Downloaded ${done} of ${total}.`,
  usage: (lines: readonly [string, string][]) =>
    lines.map(([label, value]) => `${label.padEnd(30)} ${value}`).join("\n"),
  usageMeter: (used: string, limit: string) => `${used} of ${limit}`,
  usagePlan: (name: string, seats: number, validUntil: string | null) =>
    `${name.charAt(0).toUpperCase()}${name.slice(1)}${seats > 1 ? `, ${seats} seats` : ""}${validUntil === null ? "" : ` (until ${formatDate(validUntil)})`}`,
  usageFeatures: (features: readonly string[]) =>
    features.length === 0 ? "None" : features.join(", "),
  usageNoBlocks: "Nothing blocks your account.",
  usageBlocksHeader: "Blocked now:",
  usageBlock: (message: string, until: string | null) =>
    `  ${message}${until === null ? "" : ` Lifts ${formatDate(until)}.`}`,

  // Tokens.
  tokensEmpty: "No app holds tokens for your account.",
  tokensUnnamed: "Unnamed app",
  tokensNote:
    "Each ID is an app: revoking it ends every token it holds for your account, on every device. `portifact-cli` is this CLI on all your devices.",
  confirmRevoke: (name: string, id: string, current: boolean) =>
    `This revokes every token ${JSON.stringify(name)} (${id}) holds for your account, on every device, and its approval.${current ? " That includes this CLI, so you will be signed out here too." : ""}\nType "revoke" to confirm: `,
  revokedToken: (id: string) =>
    `Revoked the tokens of ${id}. It has to ask for your approval again to reconnect.`,
  revokedSelf: (origin: string) =>
    `Revoked the CLI's tokens on every device and signed out of ${origin} here. Run \`portifact login\` to sign in again.`,
  pulled: (count: number, bytes: number, version: number, id: string, out: string) =>
    `Downloaded ${count} ${plural(count, "file", "files")} (${formatBytes(bytes)}) of version ${version} of ${id} into ${out}.`,
  historyAdded: (count: number, first: number, last: number, id: string, out: string) =>
    `Added ${count} ${plural(count, "version", "versions")} of ${id} to the Git history in ${out}: ${first === last ? `v${first}` : `v${first} to v${last}`}, one commit and tag each.`,
  historyEmptyCommits: (versions: readonly number[], reason: "none" | "purged") =>
    `${reason === "none" ? "Without private sources" : "Sources no longer retained"}, so the commit is empty: ${versions.map((n) => `v${n}`).join(", ")}.`,
  historyUpToDate: (out: string, version: number, id: string) =>
    `The Git history in ${out} is already up to date with version ${version} of ${id}.`,
  historyNothing: (id: string) => `${id} has no published versions, so no Git history was created.`,

  errors: {
    notSignedIn: (origin: string) =>
      `Not signed in to ${origin}. Run \`portifact login\` to sign in.`,
    sessionEnded: (origin: string) =>
      `Your session on ${origin} has expired or was revoked. Run \`portifact login\` to sign in again.`,
    denied: "The login request was denied. Run `portifact login` to try again.",
    expired: "The login code expired before it was approved. Run `portifact login` to try again.",
    network: (origin: string) => `Could not reach ${origin}. Check your connection and try again.`,
    rateLimited: "Too many requests. Wait a minute and try again.",
    server: (origin: string) => `${origin} sent a response the CLI did not expect. Try again.`,
    revokeFailed: (origin: string) =>
      `Could not revoke your tokens on ${origin}, so they were kept on this device. Run \`portifact logout\` again.`,
    invalidOrigin:
      "PORTIFACT_APP_ORIGIN must be an https origin, or http on localhost, without a user name or password.",
    missingScope:
      "This device's session does not allow that action. Run `portifact login` to sign in again.",
    invalidTokenId: (value: string) =>
      `${JSON.stringify(value)} is not a token ID. Run \`portifact tokens list\` to see them.`,
    tokenNotFound: (id: string) =>
      `No app with the ID ${JSON.stringify(id)} holds tokens for your account. Run \`portifact tokens list\` to see them.`,
    revokeConfirmationRequired: (id: string) =>
      `Revoking disconnects the app on every device. Run \`portifact tokens revoke ${id} --yes\` to confirm without a prompt.`,
    revokeCancelled: 'Nothing was revoked: the confirmation was not "revoke".',
    invalidArtifactId: (value: string) =>
      `${JSON.stringify(value)} is not an artifact ID. IDs have 10 characters, like \`k7qzr2mv4a\`.`,
    invalidMode: (value: string) =>
      `${JSON.stringify(value)} is not an access mode. Use restricted, authenticated or public.`,
    invalidBarState: (value: string) =>
      `${JSON.stringify(value)} is not a Portifact bar state. Use on or off.`,
    invalidCommentVisibility: (value: string) =>
      `${JSON.stringify(value)} is not a comment visibility. Use owner or everyone.`,
    invalidReaderCommentVisibility: (value: string) =>
      `${JSON.stringify(value)} is not a reader's comment visibility. Use all, own or inherit.`,
    invalidEmail: (value: string) => `${JSON.stringify(value)} is not a valid email address.`,
    tooManyReaders: (max: number) => `Add or remove at most ${max} readers at a time.`,
    invalidLimit: (max: number) => `Use a whole number from 1 to ${max}.`,
    invalidSince: (value: string) =>
      `${JSON.stringify(value)} is not a time. Use a duration like 30m, 12h or 7d, or an ISO date like 2026-11-01T00:00:00Z.`,
    invalidSearch: (max: number) => `Search for 1 to ${max} characters.`,
    invalidRevision: "Use the message revision, a whole number from 1.",
    notFoundPath: (path: string) => `${path} does not exist or cannot be read.`,
    symlink: (path: string) =>
      `${path} is a symbolic link. Portifact does not follow links; publish the files themselves.`,
    specialFile: (path: string) =>
      `${path} is not a regular file or folder (for example a socket or device), so it cannot be published.`,
    unreadable: (path: string) => `Could not read ${path}.`,
    unknownType: (path: string) =>
      `Cannot tell the artifact type of ${path}. Pass --type site, markdown or text.`,
    folderNeedsSite: (type: string) =>
      `A folder can only be published as a site, not as ${type}. Publish the ${type} file itself.`,
    typeMismatch: (artifactType: string, type: string) =>
      `This artifact is a ${artifactType}, so a new version cannot be a ${type}. An artifact keeps its type.`,
    emptyFolder: (path: string) => `${path} has no files to publish after the default exclusions.`,
    excludedFile: (path: string, reason: "default" | "secret") =>
      reason === "secret"
        ? `${path} looks like a file that holds secrets, so Portifact does not publish it.`
        : `${path} is excluded by default (version control data, dependencies or caches).`,
    missingEntry: (path: string) =>
      `The entry page ${path} is not among the files to publish. Pass --entry with the page to open first.`,
    tooManyFiles: (max: number) => `A version can hold at most ${max} files.`,
    tooManyFilesWithSources: (max: number) =>
      `A version can hold at most ${max} files, published and sources together.`,
    zipNeedsSite: (type: string) =>
      `A ZIP file can only be published as a site, not as ${type}. Publish the ${type} file itself.`,
    zipRefused: (path: string, detail: string) =>
      `${path} cannot be expanded safely: ${detail}. Nothing was published.`,
    zipTooManyEntries: (path: string, max: number) =>
      `${path} has more than ${max} entries, more than Portifact expands.`,
    assetsNeedMarkdown: "--assets works only with Markdown documents.",
    assetsNotFolder: (path: string) => `${path} is not a folder. Pass the folder of assets.`,
    assetsOutside: (path: string) =>
      `${path} must be inside the folder of the Markdown file, so the document's relative links reach it.`,
    refNeedsSource: "--ref works only with --source.",
    refNeedsGit: (path: string) =>
      `--ref needs --source to be a folder inside a git repository, and ${path} is not.`,
    refNotCommit: (ref: string) =>
      `${JSON.stringify(ref)} does not name a commit in this repository.`,
    refMissingFolder: (path: string, ref: string) =>
      `${path} does not exist in ${ref}, so there are no sources to attach.`,
    emptySources: (path: string) => `${path} has no source files to attach after the exclusions.`,
    tooLarge: (max: number) => `An artifact can hold at most ${formatBytes(max)}.`,
    uploadFailed: (path: string) =>
      `Could not upload ${path}. If it changed while publishing, run the command again.`,
    confirmationRequired: (id: string) =>
      `Deleting is permanent. Run \`portifact delete ${id} --yes\` to confirm without a prompt.`,
    deleteCancelled: "Nothing was deleted: the confirmation did not match the artifact ID.",
    invalidVersionId: (value: string) =>
      `${JSON.stringify(value)} is not a version ID or number. Run \`portifact versions <id>\` to list them.`,
    noCurrentVersion: (id: string) => `${id} has no published version to roll back.`,
    versionNumberNotFound: (id: string, number: number) =>
      `${id} has no retained version ${number}. Run \`portifact versions ${id}\` to list them.`,
    outExists: (path: string) =>
      `${path} already exists. pull writes into a new folder; choose a path that does not exist.`,
    outInsideGit: (path: string) => `${path} is inside a .git folder. Choose another folder.`,
    unsafePath: (path: string, reason: string) =>
      `The server sent a file path that cannot be written safely (${JSON.stringify(path)}: ${reason}). Nothing was written.`,
    downloadFailed: (path: string) => `Could not download ${path}. Run the command again.`,
    downloadMismatch: (path: string) =>
      `${path} did not match its size or SHA-256 after downloading, so the pull stopped. Run the command again.`,
    pullCleanedUp: (out: string) => `Removed the partial download in ${out}.`,
    gitNeedsSource:
      "--git works only with --source: it builds a Git history of the private sources.",
    gitWithPublished: "--git downloads only the private sources. Leave out --published.",
    gitWithVersion: "--git adds every retained version. Leave out --version.",
    gitMissing:
      "pull --git needs Git, and the `git` command could not be run. Install Git and run the command again.",
    gitFailed: (step: string, out: string) =>
      `git ${step} failed in ${out}, so the history was not changed. Run the command again.`,
    historyNotOurs: (out: string) =>
      `${out} exists and is not a Git history made by \`portifact pull --source --git\`. Choose a folder that does not exist yet.`,
    historyOtherArtifact: (out: string, other: string) =>
      `${out} holds the Git history of ${other}. Choose another folder.`,
    historyDiverged: (out: string, reason: string) =>
      `${out} changed since the last pull (${reason}), so nothing was added. Choose a folder that does not exist yet to start a new history.`,
    historyBlocked: (out: string) =>
      `Could not update the files in ${out}: an untracked file or link is in the way of a file of the new versions. Move it, then run the command again.`,
    historyDirty: (out: string) =>
      `${out} has uncommitted changes to files Portifact wrote. Commit or discard them, then run the command again.`,
  },
} as const;

/** Text of the `annotations` commands. Reviewer-written values are passed in already cleaned. */
export const annotationMessages = {
  modeSet: (id: string, mode: string) =>
    ({
      off: `Annotations on ${id} are off. Threads are kept but hidden, and nobody can comment.`,
      open: `Annotations on ${id} are open. You and readers with access can comment on the current version.`,
      locked: `Annotations on ${id} are locked. Threads stay readable, and nobody can add comments.`,
    })[mode] ?? `Annotations on ${id} are ${mode}.`,
  listEmpty: (id: string, mode: string) =>
    mode === "off"
      ? `${id} has no threads to show. Annotations are off; turn them on with \`portifact annotations set ${id} open\`.`
      : `${id} has no threads yet.`,
  removed: (ids: readonly string[]) => `Removed since the cursor: ${ids.join(", ")}`,
  ownScope:
    "You see only the threads you started and the threads the owner started; the owner chooses who sees the rest.",
  listCursor: (id: string, cursor: string) =>
    `Only changes later: run \`portifact annotations list ${id} --cursor ${cursor}\`.`,
  threadHeader: (id: string, state: string, path: string, version: string | null) =>
    `Thread ${id} (${state}) on ${path}${version === null ? "" : `, version ${version} (not the current one)`}`,
  quote: (exact: string) => `Quote: ${JSON.stringify(exact)}`,
  element: (tagName: string, fingerprint: string) =>
    `Element: <${tagName}> ${JSON.stringify(fingerprint)}`,
  goneAuthor: "(deleted account)",
  unnamed: "(no name)",
  noBody: (state: string) => (state === "hidden" ? "(hidden by the owner)" : "(deleted)"),
  created: (threadId: string) => `Started thread ${threadId}.`,
  replied: (threadId: string) => `Replied in thread ${threadId}.`,
  edited: (messageId: string) => `Edited message ${messageId}.`,
  threadState: (threadId: string, state: string) => `Thread ${threadId} is ${state}.`,
  deletedMessage: (messageId: string) => `Deleted message ${messageId}.`,
  moderated: (messageId: string, action: string) =>
    ({
      hide: `Hid message ${messageId}. Only its author and you still see it.`,
      unhide: `Message ${messageId} is visible again.`,
      delete: `Deleted message ${messageId}.`,
    })[action] ?? `Message ${messageId}: ${action}.`,
  threadGone: (threadId: string) =>
    `You no longer see thread ${threadId}: the owner limited who sees comments, or it is gone.`,
  deletedThread: (threadId: string) => `Deleted thread ${threadId} and all its messages.`,
  exported: (id: string, format: string, out: string) =>
    `Exported the annotations of ${id} as ${format === "json" ? "JSON" : "Markdown"} to ${out}.`,
  confirmDeleteMessage: (messageId: string) =>
    `This deletes your message ${messageId} for everyone. It cannot be undone.\nType "delete" to confirm: `,
  confirmModerateDelete: (messageId: string) =>
    `This deletes message ${messageId} for everyone, including its author. It cannot be undone.\nType "delete" to confirm: `,
  confirmDeleteThread: (threadId: string) =>
    `This deletes thread ${threadId} and every message in it, for everyone. It cannot be undone.\nType "delete" to confirm: `,

  errors: {
    invalidId: (kind: string, value: string) =>
      `${JSON.stringify(value)} is not a ${kind} ID. Run \`portifact annotations list <id> --json\` to see them.`,
    invalidMode: (value: string) =>
      `${JSON.stringify(value)} is not an annotations mode. Use off, open or locked.`,
    invalidAction: (value: string) =>
      `${JSON.stringify(value)} is not a moderation action. Use hide, unhide or delete.`,
    invalidStatus: (value: string) =>
      `${JSON.stringify(value)} is not a thread status. Use open or resolved.`,
    invalidVersion: (value: string) =>
      `${JSON.stringify(value)} is not a version filter. Use current, all or a version ID.`,
    invalidPath: (value: string) =>
      `${JSON.stringify(value)} is not a file path inside the artifact, like \`index.html\` or \`docs/plan.md\`.`,
    targetAndPath: "Pass either --target or --path, not both.",
    unreadable: (path: string) => `Could not read the file ${path}.`,
    fileTooLarge: (path: string, max: number) =>
      `${path} is larger than ${formatBytes(max)}, more than a comment or target can hold.`,
    notUtf8: (path: string) => `${path} is not UTF-8 text.`,
    invalidBody: (issue: string) => `The comment cannot be sent: ${issue}`,
    targetNotJson: (path: string) => `${path} is not valid JSON.`,
    invalidTarget: (issue: string) => `The target is not valid: ${issue}`,
    noCurrentVersion: (id: string) => `${id} has no published version to comment on.`,
    pathNeeded: (id: string) =>
      `Could not find the page of ${id} to comment on. Pass --path with the file, like --path index.html.`,
    confirmationRequired: (command: string) =>
      `Deleting is permanent. Run \`portifact annotations ${command} --yes\` to confirm without a prompt.`,
    deleteCancelled: 'Nothing was deleted: the confirmation was not "delete".',
    outExists: (path: string) =>
      `${path} already exists. Export writes a new file; choose a path that does not exist.`,
    cannotWrite: (path: string) => `Could not write ${path}.`,
  },
} as const;

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** Decimal units, as the product limits use: 1 MB is 1,000,000 bytes. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1000) break;
    value /= 1000;
    unit = next;
  }
  return `${value.toFixed(1)} ${unit}`;
}

/** An instant as a readable UTC date and time; "never" when there is none. */
/** An artifact's expiry: a date, or "never (pinned)" for a pinned artifact, which has none. */
export function formatExpiry(value: string | null): string {
  return value === null ? "never (pinned)" : formatDate(value);
}

export function formatDate(value: string | null): string {
  if (value === null) return "never";
  return `${value.slice(0, 10)} ${value.slice(11, 16)} UTC`;
}
