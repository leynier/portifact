// What an email Portifact sends on its own initiative may say about an owner's data (decision
// 0005, "What leaves the region"). The email provider is outside every region, so for an owner
// whose data is stored outside the default region a notice carries only counts, dates and links
// into the app: never an artifact's name, never comment text (no notice ever carries it), never a
// reader's or reviewer's address besides the recipient's own. Every notice builder asks this one
// rule with the region its job runs in; nothing else decides it.
import { DEFAULT_REGION, type Region } from "@portifact/contracts";

/**
 * `named`: a notice may name the owner's artifacts (escaped, never in the subject).
 * `counts`: only counts, dates and links into the app.
 */
export type NoticeDetail = "named" | "counts";

/** What a notice about an owner's data may carry, from the owner's region. */
export function noticeDetail(region: Region): NoticeDetail {
  return region === DEFAULT_REGION ? "named" : "counts";
}

/** Whether a notice about an owner in this region may name its artifacts. */
export function noticeNames(region: Region): boolean {
  return noticeDetail(region) === "named";
}
