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
  transferArtifact: ["artifact.transferred_in", "artifact.transferred_out"],
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
  updateBrand: ["brand.changed"],
  setBrandLogo: ["brand.changed"],
  deleteBrand: ["brand.removed"],
  removeBrandLogo: ["brand.removed"],
  inviteMember: ["member.invited"],
  revokeInvitation: ["member.invitation_revoked"],
  acceptInvitation: ["member.joined"],
  createWorkspace: ["member.joined"],
  changeMemberRole: ["member.role_changed"],
  removeMember: ["member.removed", "member.left"],
  leaveWorkspace: ["member.left"],
  setOwnerPlan: ["plan.granted"],
  applyOwnerPlans: ["plan.granted"],
  removeOwnerPlan: ["plan.removed"],
  verifyWorkspaceDomain: ["email_domain.verified", "email_domain.removed"],
  removeWorkspaceDomain: ["email_domain.removed"],
  recheckEmailDomains: ["email_domain.removed"],
  createServiceToken: ["service_token.created"],
  revokeServiceToken: ["service_token.revoked"],
  operatorRevokeServiceToken: ["service_token.revoked"],
  // The workspaces the account was in each record that the member is gone.
  requestAccountDeletion: ["member.left"],
  // A read that records that it was asked for, before it streams (the one event outside a batch).
  exportAuditLog: ["audit.exported"],
};

/** Changes that record no event, and why. */
const NOT_RECORDED: Record<string, string> = {};
const reason = (why: string, names: string[]) => {
  for (const name of names) NOT_RECORDED[name] = why;
};
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
]);
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
]);
reason("comments are not in the audit log's scope (T10); their text never is", [
  "createAnnotationThread",
  "replyToAnnotationThread",
  "editAnnotationMessage",
  "deleteOwnAnnotationMessage",
  "deleteAnnotationThread",
  "moderateAnnotationMessage",
  "setAnnotationThreadState",
  "eraseAuthorFromThread",
]);
reason("whether an artifact takes comments is outside the T10 catalog for now", [
  "setAnnotationMode",
]);
reason("the account's own preferences and sign-ins, not an owner's shared state", [
  "updateAccountSettings",
  "setCommentNoticeMute",
  "unsubscribeCommentNotices",
  "disconnectApp",
]);
reason("the owner is erased with its events", [
  "advanceAccountDeletion",
  "processAccountDeletions",
  "deleteWorkspace",
  "advanceWorkspaceDeletion",
  "processWorkspaceDeletions",
  "deleteArtifactData",
  "eraseOwnerBrand",
]);
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
reason("scheduled jobs and their consequences of changes already recorded", [
  "archiveExpired",
  "expireUploads",
  "pruneVersions",
  "purgeArchived",
  "sweepOrphanObjects",
  "rerenderDocuments",
  "runMaintenance",
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
  "scheduleDomainNotices",
  "sendDomainNotice",
  "alignPlanLimits",
  "unpinLapsedPlans",
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
  "accessAudience",
  "approvalSummaries",
  "participation",
  "withActivity",
  "authorizeUploadOn",
  "policyDomains",
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
  // Content search is a read (decision 0012): it records nothing.
  "searchContent",
  "signUnsubscribeToken",
  "signWebhook",
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
