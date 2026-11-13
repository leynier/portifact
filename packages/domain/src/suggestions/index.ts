// Edit suggestions (decision 0027): the pure planners and everything they need. Imported through
// `@portifact/domain/suggestions` so the dashboard's bundle, which imports `@portifact/domain`,
// never pulls parse5 or the renderer in for them.
export { type Closure, type ClosureProof, closure } from "./closure.ts";
export { canonicalJson, sha256Hex } from "./digest.ts";
export {
  type DisplayToken,
  destination,
  inspect,
  isSpecialCharacter,
  omitted,
  shortenDestination,
  tokens,
  visible,
} from "./display.ts";
export { changedRegion, type TextEdit, textEditOf, validAfter } from "./edit.ts";
export {
  contextOf,
  envelopeBytes,
  envelopeOperation,
  locationOf,
  presentEnvelope,
  renderEnvelope,
} from "./envelope.ts";
export { escapeHtml, planHtml } from "./html-planner.ts";
export {
  decodeHtml,
  htmlEligibility,
  type SubsetRefusal,
  subsetRefusal,
} from "./html-subset.ts";
export {
  IdentityCache,
  type LinkContext,
  linkContext,
  linksAroundAll,
  sameIdentity,
} from "./identity.ts";
export { planMarkdown } from "./markdown-planner.ts";
export {
  admitItems,
  type BuiltPlan,
  buildPlan,
  type Confirmation,
  confirmPlan,
  type PlanInput,
  PlanTooLargeError,
  planDigest,
  previewOfPlan,
  type StoredRendering,
} from "./plan.ts";
export { onlyApprovedBytes, type PlannedFile } from "./planned.ts";
export {
  buildPreview,
  PREVIEW_CSS_LIMITS,
  PREVIEW_POLICY,
  type PreviewResult,
  previewable,
  previewHeaders,
  withoutMotion,
} from "./preview.ts";
export {
  type Carriable,
  type Carry,
  type CarryOptions,
  carryAll,
  MARKER_BATCH_MAX,
} from "./relocate.ts";
export { type RenderedPage, renderedPage } from "./rendered.ts";
export { planText, TEXT_IDENTITY } from "./text-planner.ts";
export { newWork, type Work } from "./work.ts";
