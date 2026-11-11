// Portifact's emails: one branded layout (layout.ts) and a template per message, each with an
// HTML version and a plain-text alternative.
export { BUDGET_COMMAND, type BudgetAlertInput, budgetAlertEmail } from "./budget-alert.ts";
export {
  type CommentNoticeArtifact,
  type CommentNoticeInput,
  commentNoticeEmail,
} from "./comment-notice.ts";
export {
  DIRECTORY_NOTICE_TEXT,
  type DirectoryNoticeInput,
  type DirectoryNoticeText,
  directoryNoticeEmail,
} from "./directory-notice.ts";
export {
  DOMAIN_NOTICE_TEXT,
  type DomainNoticeInput,
  domainNoticeEmail,
} from "./domain-notice.ts";
export {
  type ExpiryNoticeArtifact,
  type ExpiryNoticeInput,
  expiryNoticeEmail,
  formatExpiry,
} from "./expiry-notice.ts";
export {
  GRACE_NOTICE_TEXT,
  type GraceNoticeInput,
  type GraceNoticeKind,
  type GraceNoticeText,
  graceNoticeEmail,
} from "./grace-notice.ts";
export {
  INVITATION_TEXT,
  type InvitationInput,
  invitationEmail,
} from "./invitation.ts";
export { type Block, type EmailLayout, escapeHtml, type Inline, renderEmail } from "./layout.ts";
export type { EmailContent } from "./message.ts";
export {
  RETENTION_NOTICE_TEXT,
  type RetentionNoticeInput,
  retentionNoticeEmail,
} from "./retention-notice.ts";
export {
  REVIEW_TEXT,
  type ReviewNoticeInput,
  type ReviewNoticeKind,
  reviewNoticeEmail,
} from "./review-notice.ts";
export { SIGN_IN_SUBJECT, type SignInCodeInput, signInCodeEmail } from "./sign-in-code.ts";
