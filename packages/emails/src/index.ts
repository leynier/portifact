// Portifact's emails: one branded layout (layout.ts) and a template per message, each with an
// HTML version and a plain-text alternative.
export { BUDGET_COMMAND, type BudgetAlertInput, budgetAlertEmail } from "./budget-alert.ts";
export {
  type CommentNoticeArtifact,
  type CommentNoticeInput,
  commentNoticeEmail,
} from "./comment-notice.ts";
export {
  type ExpiryNoticeArtifact,
  type ExpiryNoticeInput,
  expiryNoticeEmail,
  formatExpiry,
} from "./expiry-notice.ts";
export { type Block, type EmailLayout, escapeHtml, type Inline, renderEmail } from "./layout.ts";
export type { EmailContent } from "./message.ts";
export { SIGN_IN_SUBJECT, type SignInCodeInput, signInCodeEmail } from "./sign-in-code.ts";
