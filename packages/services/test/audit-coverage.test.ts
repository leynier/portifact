// Every async use case the services export is either a read, a change that records its audit
// event (premium plan T10) or a change that deliberately does not, with the reason. A new
// exported use case fails this test until it is placed in one of the tables, which is what makes
// it hard to add a mutation without its event; `audit.test.ts` proves each recorded one.
import { AUDIT_KINDS, type AuditKind } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import * as services from "../src/index.ts";

/** Use cases that change what an owner has and the events they write in their batch. */
const RECORDED: Record<string, readonly AuditKind[]> = {
  commitPublish: ["artifact.published"],
  rollbackArtifact: ["artifact.rolled_back"],
  renewArtifact: ["artifact.renewed"],
  archiveArtifact: ["artifact.archived"],
  restoreArtifact: ["artifact.restored"],
  deleteArtifact: ["artifact.deleted"],
  pinArtifact: ["artifact.pinned"],
  unpinArtifact: ["artifact.unpinned"],
  // A target's maximum life unpins a pinned artifact, by the system (decision 0023).
  transferArtifact: ["artifact.transferred_in", "artifact.transferred_out", "artifact.unpinned"],
  updateAccess: ["access.changed"],
  createShareLink: ["share_link.created"],
  revokeShareLink: ["share_link.revoked"],
  requestApprovalReview: ["review.requested"],
  changeApprovalReview: ["review.changed"],
  cancelApprovalReview: ["review.cancelled"],
  submitApprovalVerdict: ["review.verdict"],
  verifyCustomDomain: ["domain.attached"],
  removeCustomDomain: ["domain.removed"],
  detachDomain: ["domain.removed"],
  createWebhook: ["webhook.created"],
  updateWebhook: ["webhook.changed"],
  removeWebhook: ["webhook.removed"],
  // Issue integrations (decision 0018): connections by an admin; a credential the service
  // refuses, by the admin who tested it or by the job, as the system; an issue once it exists.
  createIntegrationConnection: ["integration.connected"],
  updateIntegrationConnection: ["integration.changed"],
  removeIntegrationConnection: ["integration.removed"],
  testIntegrationConnection: ["integration.failing"],
  markAttention: ["integration.failing"],
  // Slack (decision 0025): an uninstall event marks the connection with integration.failing.
  applySlackEvent: ["integration.failing"],
  previewSlackLinks: ["integration.failing"],
  verifySlackRequest: ["integration.failing"],
  runThreadIssue: ["issue.created", "integration.failing"],
  updateBrand: ["brand.changed"],
  setBrandLogo: ["brand.changed"],
  deleteBrand: ["brand.removed"],
  removeBrandLogo: ["brand.removed"],
  inviteMember: ["member.invited"],
  revokeInvitation: ["member.invitation_revoked"],
  acceptInvitation: ["member.joined", "member.role_changed", "group.member_added"],
  createWorkspace: ["member.joined"],
  changeMemberRole: ["member.role_changed"],
  removeMember: ["member.removed", "member.left"],
  leaveWorkspace: ["member.left"],
  setOwnerPlan: [
    "plan.granted",
    "plan.grace_started",
    "plan.grace_ended",
    "policy.sso_suspended",
    "policy.sso_resumed",
  ],
  applyOwnerPlans: ["plan.granted"],
  removeOwnerPlan: ["plan.removed", "plan.grace_started", "plan.grace_ended"],
  // The grace scan (decision 0022): a natural expiry's start and every hold's end.
  maintainPlanGraces: ["plan.grace_started", "plan.grace_ended"],
  verifyWorkspaceDomain: ["email_domain.verified", "email_domain.removed"],
  removeWorkspaceDomain: ["email_domain.removed"],
  recheckEmailDomains: ["email_domain.removed", "policy.sso_suspended"],
  // "SSO required" entering or leaving suspension when a plan expires (decision 0021).
  syncSsoRequirementStates: ["policy.sso_suspended", "policy.sso_resumed"],
  createServiceToken: ["service_token.created"],
  revokeServiceToken: ["service_token.revoked"],
  createGitHubTrustRule: ["github_trust.created"],
  updateGitHubTrustRule: ["github_trust.changed"],
  removeGitHubTrustRule: ["github_trust.removed"],
  exchangeGitHubToken: ["github_trust.exchanged"],
  operatorRevokeServiceToken: ["service_token.revoked"],
  // The workspaces the account was in each record that the member is gone.
  requestAccountDeletion: ["member.left"],
  deleteAccountWithCode: ["member.left"],
  createWorkspaceGroup: ["group.created"],
  renameWorkspaceGroup: ["group.renamed"],
  deleteWorkspaceGroup: ["group.deleted"],
  addGroupMember: ["group.member_added"],
  removeGroupMember: ["group.member_removed"],
  saveSsoProvider: ["sso.created", "sso.changed"],
  removeSsoProvider: ["sso.removed"],
  joinWorkspaceThroughSso: ["member.joined", "group.member_added", "member.role_changed"],
  // SCIM (decision 0017): the directory's token and settings by an admin, and what a directory
  // changes, with the directory as the actor; a sign-in that claims a pending membership.
  createScimToken: ["scim_token.created"],
  revokeScimToken: ["scim_token.revoked"],
  operatorRevokeScimToken: ["scim_token.revoked"],
  updateScimSettings: ["scim.changed"],
  createScimUser: [
    "member.provisioned",
    "member.joined",
    "group.member_added",
    "member.role_changed",
  ],
  replaceScimUser: [
    "member.provisioned",
    "member.joined",
    "group.member_added",
    "member.role_changed",
    "member.removed",
    "member.invitation_revoked",
  ],
  patchScimUser: [
    "member.provisioned",
    "member.joined",
    "group.member_added",
    "member.role_changed",
    "member.removed",
    "member.invitation_revoked",
  ],
  deleteScimUser: ["member.removed", "member.invitation_revoked"],
  claimDirectoryMemberships: ["member.joined", "group.member_added", "member.role_changed"],
  // SCIM groups (decision 0017, "Groups and roles"), with the directory as the actor.
  createScimGroup: ["group.created", "group.member_added", "member.role_changed"],
  replaceScimGroup: [
    "group.renamed",
    "group.member_added",
    "group.member_removed",
    "member.role_changed",
  ],
  patchScimGroup: [
    "group.renamed",
    "group.member_added",
    "group.member_removed",
    "member.role_changed",
  ],
  deleteScimGroup: ["group.deleted", "member.role_changed"],
  // An admin stops syncing a directory group; the roles it gave are kept, nothing is recorded
  // for them (no role changes).
  stopDirectorySync: ["group.sync_stopped"],
  // After a restore, with the system as actor.
  recomputeDirectoryRoles: ["member.role_changed"],
  // Workspace policies (decision 0015): a change records which fields and values, and each step
  // that applies one to existing artifacts records its counts and each changed artifact's own
  // access change, as the system.
  setWorkspacePolicy: ["policy.changed"],
  // After a restore, with the operator as actor.
  applyWorkspacePolicies: ["policy.changed"],
  clearRequestPolicies: ["policy.changed"],
  // The maximum life (decision 0023) also unpins, by the system, naming the policy.
  enforceWorkspacePolicy: ["policy.enforced", "access.changed", "artifact.unpinned"],
  runWorkspacePolicyJob: ["policy.enforced", "access.changed", "artifact.unpinned"],
  enforceWorkspacePolicies: ["policy.enforced", "access.changed", "artifact.unpinned"],
  // An artifact that reached its workspace's maximum life is archived with the trail of a manual
  // archive, by the system (decision 0023); other expiries record nothing, as before.
  archiveExpired: ["artifact.archived"],
  // Comment retention (decision 0023): each batch records `policy.enforced` with the threads and
  // messages it deleted, by the system; a lapsed plan's suspension records `policy.changed`.
  deleteDueThreads: ["policy.enforced"],
  enforceCommentRetention: ["policy.enforced", "policy.changed"],
  // A read that records that it was asked for, before it streams (the one event outside a batch).
  exportAuditLog: ["audit.exported"],
  // Audit streams (decision 0019): an admin's changes; the delivery job records only the
  // platform's pause of a stream (failures, a lapsed plan, a URL or key that no longer works),
  // never a delivery.
  createAuditStream: ["audit_stream.created"],
  updateAuditStream: ["audit_stream.changed"],
  removeAuditStream: ["audit_stream.removed"],
  deliverAuditStream: ["audit_stream.paused"],
  // Edit suggestions (decision 0027): a decision, a withdrawal (also when the author deletes the
  // first message), an acceptance's completion with its publish, and a marked change item.
  rejectSuggestion: ["suggestion.rejected"],
  withdrawSuggestion: ["suggestion.withdrawn"],
  deleteOwnAnnotationMessage: ["suggestion.withdrawn"],
  runAcceptance: ["suggestion.accepted", "artifact.published"],
  publishFromPlan: ["suggestion.accepted", "artifact.published"],
  markChangeItem: ["change_item.marked"],
  // Artifact data (decision 0026, delivery 5): the owner side's changes are recorded by the audit
  // relay from the obligation the object wrote in the change's own transaction.
  runDataAudit: [
    "data.collection_set",
    "data.document_created",
    "data.document_replaced",
    "data.document_deleted",
    "data.documents_created",
    "data.documents_replaced",
    "data.documents_deleted",
  ],
  markChangeItemOnce: ["change_item.marked"],
};

/** Changes that record no event, and why. */
const NOT_RECORDED: Record<string, string> = {};
const reason = (why: string, names: string[]) => {
  for (const name of names) NOT_RECORDED[name] = why;
};
reason(
  "single sign-on protocol steps and lookups: they change nothing an owner has (decision 0016)",
  [
    "fetchSsoJson",
    "discoverSso",
    "testSsoIssuer",
    "ssoProviderForEmail",
    "ssoProviderForCallback",
    "checkSsoIdentity",
    "unlinkSsoIdentity",
    "ssoKeys",
    "openSsoSecret",
  ],
);
reason(
  "audit streams: a test record, the log's pruning, re-arming lost jobs and re-sealing with the current key change nothing an owner has (decision 0019)",
  ["sendAuditStreamTest", "maintainAuditStreams", "rewrapAuditStreamKeys"],
);
reason(
  "expired GitHub run credentials, an hour after they stopped working: their exchange was recorded (decision 0024)",
  ["pruneFederatedCredentials", "pruneUsedGitHubTokens"],
);
reason("reads at most a few bytes of a response and cancels the rest", ["drain"]);
reason("approval reviews: who can still open the artifact counts again; nobody's choice changed", [
  "recheckApprovalReviewers",
]);
reason("statements for an access change's own batch, which records access.changed", [
  "approvalAccessStatements",
]);
reason("upload steps: the publish is recorded when it commits", [
  "preparePublish",
  "abortPublish",
  "closeUploadSession",
  "reportUploadedPart",
  "abortSessionMultipart",
  "uploadProgress",
  "claimArtifactId",
  "claimNewArtifactId",
]);
reason("a claim before any DNS proof attaches nothing; verifying records it", [
  "addCustomDomain",
  "addWorkspaceDomain",
]);
reason("a token's use: what it changes is recorded as its own events, last use is a timestamp", [
  "authenticateServiceToken",
  "authenticateScimToken",
  "hitScimRateLimit",
  "hitScimAuthFailure",
]);
reason("statements for a settings change's own batch, which records scim.changed (decision 0017)", [
  "roleMappingStatements",
]);
reason(
  "a visitor's own grant of artifact data (decision 0026): the person's consent in one browser, not something an owner has; the person lists and revokes it themselves",
  [
    "claimVisitorId",
    "issueDataGrantCode",
    "redeemDataGrantCode",
    "revokeDataGrants",
    "pruneDataGrants",
  ],
);
reason(
  "what a directory said about people who never got an account, once it lapsed (decision 0017)",
  ["pruneDirectoryUsers"],
);
reason("readers, visitors and reviewers, not the owner side: the access log covers reads", [
  "openShareLink",
  "redeemShareHandoff",
  "refreshShareSession",
  "redeemReadHandoff",
  "refreshReadSession",
  "redeemReviewHandoff",
  "refreshReviewSession",
  "endReviewSession",
  "recordOpenings",
  "recordViews",
  "recordTraffic",
  "submitAbuseReport",
  "declineInvitation",
  "issueReadHandoff",
  "issueReviewHandoff",
  // Built previews of suggestions (decision 0027): a one-use code to read a thread's plan.
  "issuePreviewCode",
  "redeemPreviewCode",
]);
reason("comments are not in the audit log's scope (T10); their text never is", [
  "createAnnotationThread",
  "replyToAnnotationThread",
  "editAnnotationMessage",
  "deleteAnnotationThread",
  "moderateAnnotationMessage",
  "setAnnotationThreadState",
  "eraseAuthorFromThread",
]);
reason(
  "edit suggestions (decision 0027): the owner's draft is private to its author until published, and publishing it records suggestion.accepted",
  ["saveDraft", "discardDraft"],
);
reason("a suggestion is a comment: its creation is outside the T10 catalog like any comment", [
  "submitSuggestion",
]);
reason(
  "edit suggestions (decision 0027): starting an acceptance or a draft publish records nothing until the job completes it (suggestion.accepted); a dry run only caches a plan and the suggestion's proofs",
  ["acceptSuggestion", "publishDraft", "planSuggestion", "planDraft"],
);
reason(
  "edit suggestions (decision 0027): an attempt that ends, carries, closures by a new version and the scans change nothing an owner decided; the suggestion is pending again or the record expired",
  [
    "endAttempt",
    "expireAcceptAttempts",
    "runSuggestionCarry",
    "runChangeListCheck",
    "pruneSuggestionRecords",
    "pruneDraftsWithoutRole",
  ],
);
reason("whether an artifact takes comments is outside the T10 catalog for now", [
  "setAnnotationMode",
]);
reason("the account's own preferences and sign-ins, not an owner's shared state", [
  "updateAccountSettings",
  "issueAccountDeletionCode",
  "setCommentNoticeMute",
  "unsubscribeCommentNotices",
  "disconnectApp",
]);
reason("the owner is erased with its events", [
  "finalDeletionStep",
  "retried",
  "advanceAccountDeletion",
  "processAccountDeletions",
  "deleteWorkspace",
  "advanceWorkspaceDeletion",
  "processWorkspaceDeletions",
  "deleteArtifactData",
  "eraseOwnerBrand",
]);
reason("a keyed hash for rate limit keys: it computes and changes nothing", ["keyedHash"]);
reason(
  "legal holds: operator-only, kept in legal_holds and never shown to the owner side, whose audit log must not reveal a hold",
  [
    "placeLegalHold",
    "releaseLegalHold",
    "releaseDueHolds",
    "applyLegalHolds",
    "isHeld",
    "updateHoldRelease",
    "openHold",
    "heldArtifactIds",
    "holdIdentities",
    "runHoldRelease",
  ],
);
reason(
  "artifact data lifecycle (decision 0026): fences and whole erases follow a change that records its own event or is operator-only (a hold, a transfer, a purge); author erasure chunks keep their audit obligation in the object, which the audit relay of delivery 5 writes to D1; reconciliation, its resolutions and the export are operator-only after a restore",
  [
    "runDataFence",
    "convergeHold",
    "runDataErase",
    "runDataAuthorErasure",
    "runDataReconcile",
    "runDataResolve",
    "runDataExport",
    "reconcileObject",
    "registerDataObject",
    "recordStorageReport",
    "eraseReason",
    "permanentlyDeleted",
    "pruneJournalCursors",
    "retireJournalEntry",
    "scheduleAuthorErasures",
    "wakeDataJobs",
    "queueDataReconcile",
    "queueDataResolve",
    "queueDataExport",
  ],
);
reason(
  "artifact data's owner side (decision 0026, delivery 5): each change writes its audit obligation in the object's own transaction and a data_audit job before it reaches the object; runDataAudit records the event once the object says the change committed (the record's durable audit states), never the adapter",
  [
    "declareDataCollection",
    "buildDataIndexes",
    "createDataDocument",
    "replaceDataDocument",
    "deleteDataDocument",
    "createDataDocuments",
    "replaceDataDocuments",
    "deleteDataDocuments",
  ],
);
reason(
  "statements of reasons and report outcomes: emails about operator decisions, recorded in moderation_decisions, moderation_notice_sends and abuse_reports",
  [
    "sendModerationNotice",
    "sendReportOutcome",
    "suspensionStatement",
    "sendSuspensionStatement",
    "accountSuspensionView",
    "brandSuspensionStatement",
  ],
);
reason("operator moderation and platform controls, kept by the operator tool's own records", [
  "suspendArtifact",
  "reinstateArtifact",
  "suspendAccount",
  "reinstateAccount",
  "suspendBrand",
  "reinstateBrand",
  "setBudgetOverride",
  "clearBudgetOverride",
  "suppressEmail",
  "liftEmailSuppression",
  "applyTombstones",
  "rebuildArtifactDirectory",
  // Detaching the domains a block covers records `domain.removed` (reason `blocked`).
  "blockHostname",
  "unblockHostname",
  "resolveAbuseReport",
]);
reason("reads that find a custom host or the operator's block list", [
  "activeCustomHost",
  "blockedNames",
  "customHostHint",
]);
reason(
  "issue integrations: calls to GitHub, Linear or Jira and key handling change nothing an owner has",
  [
    "checkCredential",
    "createIssue",
    "findIssue",
    "integrationKeys",
    "sealCredential",
    "openCredential",
  ],
);
reason("the email of a policy change already recorded as policy.changed (decision 0023)", [
  "sendRetentionNotice",
  "sendCommentRetentionNotice",
]);
reason(
  "the restore guard's record in R2, beside a policy change or lapse recorded as policy.changed, or a read (decision 0023)",
  [
    "writeGuardRecord",
    "deleteGuardRecord",
    "releaseGuardForPlan",
    "guardAgreement",
    "confirmGuardRecord",
  ],
);
reason(
  "the sweep only deletes guard records no stored rule vouches for: R2 objects, not an owner's data (decision 0023)",
  ["sweepGuardRecords"],
);
reason(
  "tombstones of threads whose deletion its batch already recorded as policy.enforced (decision 0023)",
  ["writeCommentTombstones"],
);
reason(
  "Slack: calls that change nothing an owner has, and the pending scan, which deletes rows that never held anything (decision 0025)",
  ["slackCall", "slackAuthTest", "slackRevoke", "slackUnfurl", "prunePendingConnections"],
);
reason("an issue request is recorded once the job creates the issue (issue.created)", [
  "requestThreadIssue",
]);
reason("restores re-apply removals already recorded (operator only)", [
  "applyIntegrationTombstones",
]);
reason(
  'retention of history about what is already gone (docs/operations.md, "History retention")',
  ["pruneGoneHistory", "pruneUploadHistory", "pruneStaleFindings", "eraseAccountTraces"],
);
reason("expired sign-in records and unused app registrations: identity, not an owner's data", [
  "pruneAuthRecords",
]);
reason(
  "restore markers and idempotency records: the change they belong to is recorded (or is a person's own preference)",
  ["idempotentThreadWrite"],
);
reason("scheduled jobs and their consequences of changes already recorded", [
  "requeueThreadIssues",
  "rewrapIntegrationKeys",
  "releaseMovedArtifactDomains",
  "expireUploads",
  "pruneVersions",
  "purgeArchived",
  "sweepOrphanObjects",
  "rerenderDocuments",
  "runMaintenance",
  "runRegionalMaintenance",
  "pruneArtifactGroups",
  "pruneGroupTombstones",
  "relayOutbox",
  "runJob",
  "maintainWebhooks",
  "stopWebhooksWhileOff",
  "rewrapWebhookKeys",
  "deliverWebhook",
  "sendTestEvent",
  "scheduleExpiryNotices",
  "scheduleCommentNotices",
  "sendExpiryNotice",
  "sendCommentNotice",
  // Review emails (decision 0013): sending a notice changes nothing an owner has.
  "runReviewNotice",
  "scheduleDomainNotices",
  "sendDomainNotice",
  // The notice of being added by a directory (decision 0017): sending changes nothing.
  "sendDirectoryNotice",
  "alignPlanLimits",
  "unpinLapsedPlans",
  // The one-time re-dating pass (decision 0022): writes retention jobs, changes nothing an owner has.
  "redateDatedPlans",
  // Grace emails (decision 0022, third delivery): the hold's start and end are already events, and
  // scheduling or sending an email changes nothing an owner has.
  "scheduleGraceNotices",
  "sendGraceNotice",
  // The regional half of a plan change (decision 0005): the change's `plan.granted` or
  // `plan.removed` was recorded with its global half.
  "applyOwnerPlanRegion",
  // Content search (decision 0012): the index is derived data, kept by a job and two scans.
  "runSearchIndex",
  "scheduleSearchIndexing",
  "dropLapsedSearchIndexes",
  "applyOwnerRetention",
  "moveAccessHistory",
  "eraseAccessEvents",
  "eraseArtifactViews",
  "releaseOrphans",
  "provision",
  "runDeleteHostname",
  "enforceDomainLimits",
  "reconcileCustomDomains",
  // Detaching a domain that stopped pointing records `domain.removed` through `detachDomain`.
  "checkCustomDomains",
  "releaseArtifactDomains",
  "releaseOwnerDomains",
  "reconcileStorage",
  "recordBudgetMeasurement",
  "markBudgetAlertsNotified",
  "measurePlatformUsage",
  "recordEmailEvent",
  "recordEmailsSent",
  "pruneAccessEvents",
  "pruneArtifactViews",
  "pruneAuditEvents",
  "pruneEmailCounters",
  "pruneEmailSuppressions",
  "pruneExpiredInvitations",
  "pruneOperations",
  "prunePreviewCodes",
  "pruneReadSessions",
  "pruneReviewSessions",
  "pruneShareLinks",
  "pruneTrafficCounters",
  "runIdempotent",
]);

/**
 * Names that only read or compute: by their verb, which must be followed by a capital letter so
 * `is` never swallows `issue…`, or listed here when the verb also names changes (`check`,
 * `resolve`, `open`, `sign`).
 */
const READ_NAMES = new Set([
  // The grant's control and renewal read access and the account (decision 0026); the digest computes.
  "dataGrantControl",
  "renewDataGrant",
  "nonceDigest",
  // Edit suggestions (decision 0027): rebuilds a replayed acceptance's answer, writes nothing.
  "replayAcceptance",
  // Budget protection's data step (decision 0026): reads the platform's protection only.
  "checkDataWriteCapacity",
  // D1's hold level for the data convergence rule (decision 0026): one read of `legal_holds`.
  "holdLevel",
  // The grace forecast's counts (decision 0022), shared by its route and the grace emails.
  "graceForecastKinds",
  // The thread a caller may read now (decision 0018): a read like every annotation read.
  "readableThread",
  "appSessionLive",
  "appSessionSignIn",
  // Who requiring single sign-on would bind, counted for the preview and the save (0021).
  "ssoReach",
  // What a maximum life would archive, counted for the preview and the save (0023).
  "maxLifeImpact",
  // What comment retention would delete, counted for the preview, the save and the notice.
  "commentRetentionImpact",
  "directoryGroupChoices",
  "directoryRoleHolders",
  "seatLimit",
  "accessAudience",
  "approvalSummaries",
  "participation",
  "withActivity",
  "authorizeUploadOn",
  "policyDomains",
  "viewerGroups",
  "viewerGroupIds",
  "groupMembershipsOf",
  "groupSummaries",
  // What saving a policy would change (decision 0015): counts only.
  "policyImpact",
  "scoped",
  "checkReadAccess",
  "checkSignInEmail",
  "emailsSentInCycle",
  "exportedBrand",
  "isEmailSuppressed",
  "open",
  "openUnsubscribeToken",
  "resolveActor",
  "resolveOwnerScope",
  // A stream's next events (decision 0019): a read.
  "streamEventsAfter",
  // Content search is a read (decision 0012): it records nothing.
  "searchContent",
  "signUnsubscribeToken",
  "signWebhook",
  // Edit suggestions (decision 0027): building a plan and reading stored files and drafts.
  "suggestionPlanOf",
  "draftPlanOf",
  "storedPage",
  "ownDraft",
  // Artifact data (decision 0026): describing and querying an artifact's documents.
  "describeArtifactData",
  "queryArtifactData",
]);
const READS =
  /^(get|list|read|find|load|export|show|count|view|preview|lookup|stats|current|personal|require|owner|actor|artifact|workspace|usage|account|managed|compare|diff|hash|sha|seal|verify(Share)?Password|email|invitation|annotation|noticeView|newArtifactDefaults|platformProtection|pendingBudgetAlerts|multipartStates|openMultipartUploads|revokedShareLinks|shareLinkLabels|soleAdminOf|windowSum|webhookKeys|authorizeOn|reviewSessionTag)(?=[A-Z]|$)/;

const asyncUseCases = Object.entries(services)
  .filter(([, value]) => typeof value === "function" && value.constructor.name === "AsyncFunction")
  .map(([name]) => name)
  .sort();

describe("every exported use case is classified for the audit log", () => {
  it("places each async export as a read, a recorded change or a change with a reason", () => {
    const unclassified = asyncUseCases.filter(
      (name) =>
        !(name in RECORDED) &&
        !(name in NOT_RECORDED) &&
        !READ_NAMES.has(name) &&
        !READS.test(name),
    );
    expect(unclassified).toEqual([]);
  });

  it("names only use cases that exist, and records every kind of the catalog somewhere", () => {
    for (const name of [...Object.keys(RECORDED), ...Object.keys(NOT_RECORDED), ...READ_NAMES]) {
      expect(asyncUseCases, name).toContain(name);
    }
    const written = new Set(Object.values(RECORDED).flat());
    expect(AUDIT_KINDS.filter((kind) => !written.has(kind))).toEqual([]);
  });
});
