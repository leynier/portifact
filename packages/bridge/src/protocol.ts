// Messages between the review viewer on app.portifact.com and the bridge running inside the
// artifact on <id>.portifact.dev (plan section 8, "Revisión segura de HTML arbitrario"). Both
// sides treat every message as untrusted data: the artifact's own code runs in the same window
// as the bridge and can send anything the bridge can. The viewer therefore never acts on a
// message by itself (a selection only offers a comment that the user writes and confirms), and
// it never sends tokens, email addresses or thread bodies to the frame: only the targets needed
// to highlight each thread's text, and short labels.
import { AnchorPath, AnchorRoute, AnnotationTarget } from "@portifact/contracts";
import { z } from "zod";

/** Identifies Portifact review messages among whatever else a page posts. */
export const REVIEW_CHANNEL = "portifact-review";
/** 2: threads are highlights without numbered markers, and a click reports every thread under it. */
export const REVIEW_PROTOCOL = 2;

export const BRIDGE_LIMITS = {
  /** A bridge message holds at most one target (8 KiB) plus its envelope. */
  bridgeMessageMaxBytes: 16 * 1024,
  /** Viewer messages carry up to `highlightsMax` targets. */
  viewerMessageMaxBytes: 2 * 1024 * 1024,
  highlightsMax: 200,
  idMaxLength: 64,
  labelMaxLength: 128,
  /** Largest coordinate or size a frame rectangle may hold, in CSS pixels. */
  rectMaxPixels: 1_000_000,
} as const;

/** A random per-instance value the viewer hands to one bridge instance (one page load). */
export const InstanceNonce = z.string().regex(/^[A-Za-z0-9_-]{22,64}$/, "Invalid nonce");

/**
 * Identifies the review session the page runs in, without revealing it: the review API gives it
 * to the viewer and the content Worker gives it to the bridge, which echoes it in `ready`. A
 * mismatch means the frame runs a review session this viewer did not start (fixation).
 */
export const SessionTag = z.string().regex(/^[A-Za-z0-9_-]{22}$/, "Invalid session tag");

/** Thread IDs, which name each thread's highlight. */
export const HighlightId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid highlight id");

const Label = z.string().min(1).max(BRIDGE_LIMITS.labelMaxLength);

const coordinate = z.number().min(-BRIDGE_LIMITS.rectMaxPixels).max(BRIDGE_LIMITS.rectMaxPixels);
const extent = z.number().min(0).max(BRIDGE_LIMITS.rectMaxPixels);

/**
 * Where the reader's selection or picked element is drawn, in the frame's viewport (CSS pixels
 * from the frame's top left corner, as `getBoundingClientRect` reports it). The viewer places
 * its "Comment" control and composer by it, but treats it as an untrusted hint: it clamps it to
 * the frame's visible box and never draws outside the frame (see `visibleRect`).
 */
export const FrameRect = z.strictObject({
  x: coordinate,
  y: coordinate,
  width: extent,
  height: extent,
});
export type FrameRect = z.infer<typeof FrameRect>;

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

export const HighlightResolution = z.strictObject({
  id: HighlightId,
  confidence: z.enum(["exact", "fuzzy", "orphaned"]),
  reason: z.enum(["not_found", "ambiguous", "route_mismatch"]).optional(),
});
export type HighlightResolution = z.infer<typeof HighlightResolution>;

const envelope = { channel: z.literal(REVIEW_CHANNEL), v: z.literal(REVIEW_PROTOCOL) };
const bound = { ...envelope, nonce: InstanceNonce };

/** Bridge to viewer. Everything here is untrusted. */
export const BridgeMessage = z.discriminatedUnion("type", [
  /**
   * A bridge instance started on a page; the viewer answers with `init` and a nonce, but only
   * when `sessionTag` is the one of the review session it started.
   */
  z.strictObject({
    ...envelope,
    type: z.literal("ready"),
    page: BridgePage,
    sessionTag: SessionTag,
  }),
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
  /**
   * The reader's text selection as a target, or `null` once it is gone. `rect` is where it is
   * drawn in the frame, a hint for placing the viewer's "Comment" control.
   */
  z.strictObject({
    ...bound,
    type: z.literal("selection"),
    target: AnnotationTarget.nullable(),
    rect: FrameRect.optional(),
  }),
  /** The element the reader picked in element mode, and where it is drawn in the frame. */
  z.strictObject({
    ...bound,
    type: z.literal("element"),
    target: AnnotationTarget,
    rect: FrameRect.optional(),
  }),
  /**
   * The reported selection or picked element moved in the frame (the page scrolled or was
   * resized): its new rectangle, or `null` when it is no longer drawn. It never changes the
   * target, and the viewer ignores it while it offers nothing or a comment is open.
   */
  z.strictObject({ ...bound, type: z.literal("selection-rect"), rect: FrameRect.nullable() }),
  z.strictObject({ ...bound, type: z.literal("refused"), reason: RefusalReason }),
  /** Element mode ended in the page (Escape or a pick). */
  z.strictObject({ ...bound, type: z.literal("pick-ended") }),
  /** Where each highlight of this page was found. */
  z.strictObject({
    ...bound,
    type: z.literal("resolved"),
    results: z.array(HighlightResolution).max(BRIDGE_LIMITS.highlightsMax),
  }),
  /**
   * The reader clicked the page: the threads whose highlight covers the point, innermost (the
   * smallest highlighted area) first, or none when the click was outside every highlight. The
   * viewer selects only threads it sent to this page and ignores every other ID.
   */
  z.strictObject({
    ...bound,
    type: z.literal("select"),
    ids: z.array(HighlightId).max(BRIDGE_LIMITS.highlightsMax),
  }),
  /** The answer to `ping`: this bridge instance still runs in the frame. */
  z.strictObject({ ...bound, type: z.literal("pong") }),
]);
export type BridgeMessage = z.infer<typeof BridgeMessage>;

/** One thread to highlight in the page: its ID and where it points. */
export const Highlight = z.strictObject({
  id: HighlightId,
  target: AnnotationTarget,
});
export type Highlight = z.infer<typeof Highlight>;

/** Viewer to bridge. */
export const ViewerMessage = z.discriminatedUnion("type", [
  /** Binds this bridge instance to a nonce; every later message carries it. */
  z.strictObject({ ...bound, type: z.literal("init") }),
  /**
   * The threads to highlight on the page. Their highlights are layered, so text several threads
   * cover is drawn darker. `selected` are drawn emphasized, the first one most.
   */
  z.strictObject({
    ...bound,
    type: z.literal("highlights"),
    highlights: z.array(Highlight).max(BRIDGE_LIMITS.highlightsMax),
    selected: z.array(HighlightId).max(BRIDGE_LIMITS.highlightsMax),
  }),
  /** The thread the reader points at in the sidebar, outlined in the page; null for none. */
  z.strictObject({ ...bound, type: z.literal("hover"), id: HighlightId.nullable() }),
  /** Starts or stops element mode; `hint` is the instruction shown in the page. */
  z.strictObject({ ...bound, type: z.literal("pick"), active: z.boolean(), hint: Label }),
  /** Scrolls the page to a thread's highlight ("Show in the artifact"). */
  z.strictObject({ ...bound, type: z.literal("focus"), id: HighlightId }),
  z.strictObject({ ...bound, type: z.literal("clear-selection") }),
  /** Sent after each load of the frame: a page of the artifact answers with `pong`. */
  z.strictObject({ ...bound, type: z.literal("ping") }),
]);
export type ViewerMessage = z.infer<typeof ViewerMessage>;

type Bound<T> = T extends { nonce: string } ? Omit<T, "channel" | "v" | "nonce"> : never;
/** A message body before the envelope and nonce are added. */
export type BridgeBody = Bound<BridgeMessage>;
export type ViewerBody = Bound<ViewerMessage>;
