// Messages between the review viewer on app.portifact.com and the bridge running inside the
// artifact on <id>.portifact.dev (plan section 8, "Revisión segura de HTML arbitrario"). Both
// sides treat every message as untrusted data: the artifact's own code runs in the same window
// as the bridge and can send anything the bridge can. The viewer therefore never acts on a
// message by itself (a selection only offers a comment that the user writes and confirms), and
// it never sends tokens, email addresses or thread bodies to the frame: only the targets needed
// to draw markers and short labels for them.
import { AnchorPath, AnchorRoute, AnnotationTarget } from "@portifact/contracts";
import { z } from "zod";

/** Identifies Portifact review messages among whatever else a page posts. */
export const REVIEW_CHANNEL = "portifact-review";
export const REVIEW_PROTOCOL = 1;

export const BRIDGE_LIMITS = {
  /** A bridge message holds at most one target (8 KiB) plus its envelope. */
  bridgeMessageMaxBytes: 16 * 1024,
  /** Viewer messages carry up to `markersMax` targets. */
  viewerMessageMaxBytes: 2 * 1024 * 1024,
  markersMax: 200,
  idMaxLength: 64,
  labelMaxLength: 128,
} as const;

/** A random per-instance value the viewer hands to one bridge instance (one page load). */
export const InstanceNonce = z.string().regex(/^[A-Za-z0-9_-]{22,64}$/, "Invalid nonce");

/** Thread IDs used as marker IDs. */
export const MarkerId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid marker id");

const Label = z.string().min(1).max(BRIDGE_LIMITS.labelMaxLength);

/** The page the bridge runs on: its file path in the version and its SPA route. */
export const BridgePage = z.strictObject({
  path: AnchorPath,
  route: AnchorRoute.optional(),
});
export type BridgePage = z.infer<typeof BridgePage>;

/** Why the bridge could not turn a selection or element into a target. */
export const RefusalReason = z.enum([
  "invalid_range",
  "outside_root",
  "empty_selection",
  "quote_too_long",
  "no_selector",
  "too_large",
]);
export type RefusalReason = z.infer<typeof RefusalReason>;

export const MarkerResolution = z.strictObject({
  id: MarkerId,
  confidence: z.enum(["exact", "fuzzy", "orphaned"]),
  reason: z.enum(["not_found", "ambiguous", "route_mismatch"]).optional(),
});
export type MarkerResolution = z.infer<typeof MarkerResolution>;

const envelope = { channel: z.literal(REVIEW_CHANNEL), v: z.literal(REVIEW_PROTOCOL) };
const bound = { ...envelope, nonce: InstanceNonce };

/** Bridge to viewer. Everything here is untrusted. */
export const BridgeMessage = z.discriminatedUnion("type", [
  /** A bridge instance started on a page; the viewer answers with `init` and a nonce. */
  z.strictObject({ ...envelope, type: z.literal("ready"), page: BridgePage }),
  /**
   * Sent by the artifact origin's own pages, not the bridge: review mode could not start in
   * this browser (`unavailable`, the review cookie was not stored), the review session ended
   * (`ended`), or the review link failed (`failed`). Like `ready`, it has no nonce.
   */
  z.strictObject({
    ...envelope,
    type: z.literal("status"),
    status: z.enum(["unavailable", "ended", "failed"]),
  }),
  /** The SPA route changed. */
  z.strictObject({ ...bound, type: z.literal("location"), page: BridgePage }),
  /** The reader's text selection as a target, or `null` once it is gone. */
  z.strictObject({ ...bound, type: z.literal("selection"), target: AnnotationTarget.nullable() }),
  /** The element the reader picked in element mode. */
  z.strictObject({ ...bound, type: z.literal("element"), target: AnnotationTarget }),
  z.strictObject({ ...bound, type: z.literal("refused"), reason: RefusalReason }),
  /** Element mode ended in the page (Escape or a pick). */
  z.strictObject({ ...bound, type: z.literal("pick-ended") }),
  /** Where each marker of this page was found. */
  z.strictObject({
    ...bound,
    type: z.literal("resolved"),
    results: z.array(MarkerResolution).max(BRIDGE_LIMITS.markersMax),
  }),
  /** The reader activated a marker in the page. */
  z.strictObject({ ...bound, type: z.literal("activate"), id: MarkerId }),
]);
export type BridgeMessage = z.infer<typeof BridgeMessage>;

export const Marker = z.strictObject({
  id: MarkerId,
  /** Short visible label, such as the thread's number. */
  label: Label,
  /** Accessible name of the marker's button, such as "Open thread 3". */
  name: Label,
  target: AnnotationTarget,
});
export type Marker = z.infer<typeof Marker>;

/** Viewer to bridge. */
export const ViewerMessage = z.discriminatedUnion("type", [
  /** Binds this bridge instance to a nonce; every later message carries it. */
  z.strictObject({ ...bound, type: z.literal("init") }),
  z.strictObject({
    ...bound,
    type: z.literal("markers"),
    markers: z.array(Marker).max(BRIDGE_LIMITS.markersMax),
    /** The marker to show as active, if any. */
    active: MarkerId.nullable(),
  }),
  /** Starts or stops element mode; `hint` is the instruction shown in the page. */
  z.strictObject({ ...bound, type: z.literal("pick"), active: z.boolean(), hint: Label }),
  z.strictObject({ ...bound, type: z.literal("focus"), id: MarkerId }),
  z.strictObject({ ...bound, type: z.literal("clear-selection") }),
]);
export type ViewerMessage = z.infer<typeof ViewerMessage>;

type Bound<T> = T extends { nonce: string } ? Omit<T, "channel" | "v" | "nonce"> : never;
/** A message body before the envelope and nonce are added. */
export type BridgeBody = Bound<BridgeMessage>;
export type ViewerBody = Bound<ViewerMessage>;
