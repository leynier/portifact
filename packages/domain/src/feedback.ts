// A space's open feedback (premium plan T9): which threads of an owner's artifacts a caller sees
// in one listing. It adds no rule of its own: every decision comes from the per-artifact rules
// (`canRead` for access, `checkAnnotationAction` for the artifact's state and comment mode,
// `commentScope` for the comment visibility), evaluated once per possible value so the services
// can apply them to every artifact of the owner in one query. A thread the per-artifact list
// would not show the caller is never listed, counted or used for a cursor.
import {
  AccessMode,
  type AnnotationsState,
  ArtifactState,
  type CommentScope,
  CommentVisibility,
} from "@portifact/contracts";
import { type AccessPolicy, canRead, type Viewer } from "./access.ts";
import { type Actor, actsForOwner } from "./actor.ts";
import { type AnnotationRole, checkAnnotationAction, commentScope } from "./annotations.ts";

const ANNOTATION_MODES: readonly AnnotationsState[] = ["open", "locked", "off"];

/** What the caller reads on every artifact of the owner their actor acts on. */
export interface FeedbackReach {
  role: AnnotationRole;
  /** The (effective state, comment mode) pairs in which the role reads an artifact's threads. */
  readable: readonly { state: ArtifactState; mode: AnnotationsState }[];
  /**
   * Access modes that admit the caller without the reader list; `null` when every mode does
   * (the caller acts for the owner).
   */
  openModes: readonly AccessMode[] | null;
  /** Whether a `restricted` artifact admits the caller when their verified address is listed. */
  readerList: boolean;
  /**
   * Whether a `restricted` artifact admits the caller when it lists one of `groups` (decision
   * 0014): a member of the owning workspace while its plan includes `workspaces`.
   */
  groupList: boolean;
  /** The caller's groups in the owning workspace that grant, by ID; empty when none can. */
  groups: readonly string[];
  /**
   * The scope that follows from an artifact's comment visibility when the caller has no
   * exception on its reader list.
   */
  scopeOf: Readonly<Record<CommentVisibility, CommentScope>>;
}

/**
 * The reach of `viewer` acting as `actor` on its owner. `domains` is what `policyDomains` gives
 * for the owner and the viewer in the `domain` mode; `groups` the viewer's groups in the owning
 * workspace (`viewerGroupIds`).
 */
export function feedbackReach(
  actor: Actor,
  viewer: Viewer,
  domains: AccessPolicy["domains"],
  groups: { featureAvailable: boolean; ids: readonly string[] } = {
    featureAvailable: false,
    ids: [],
  },
): FeedbackReach {
  const role: AnnotationRole = actsForOwner(actor, actor.ownerId) ? "owner" : "participant";
  const admits = (mode: AccessMode, readers: readonly string[]) =>
    canRead({ mode, ownerId: actor.ownerId, readers, domains }, viewer, actor).ok;
  const openModes = AccessMode.options.filter((mode) => admits(mode, []));
  return {
    role,
    readable: ArtifactState.options.flatMap((state) =>
      ANNOTATION_MODES.filter(
        (mode) => checkAnnotationAction({ role, state, mode }, "read").ok,
      ).map((mode) => ({ state, mode })),
    ),
    openModes: openModes.length === AccessMode.options.length ? null : openModes,
    readerList: viewer.verifiedEmails.length > 0 && admits("restricted", viewer.verifiedEmails),
    ...groupReach(actor, viewer, groups),
    scopeOf: Object.fromEntries(
      CommentVisibility.options.map((visibility) => [
        visibility,
        commentScope(role, visibility, null),
      ]),
    ) as Record<CommentVisibility, CommentScope>,
  };
}

/** Whether a listed group admits the caller on a `restricted` artifact, decided by `canRead`. */
function groupReach(
  actor: Actor,
  viewer: Viewer,
  groups: { featureAvailable: boolean; ids: readonly string[] },
): Pick<FeedbackReach, "groupList" | "groups"> {
  // The owner side reads every artifact already; groups add nothing for it.
  if (groups.ids.length === 0 || actsForOwner(actor, actor.ownerId)) {
    return { groupList: false, groups: [] };
  }
  const admitted = canRead(
    {
      mode: "restricted",
      ownerId: actor.ownerId,
      readers: [],
      groups: {
        featureAvailable: groups.featureAvailable,
        matched: groups.ids.map((id) => ({ id, commentVisibility: null })),
      },
    },
    viewer,
    actor,
  ).ok;
  return admitted ? { groupList: true, groups: [...groups.ids] } : { groupList: false, groups: [] };
}

/** The sort key of a listed thread: its last activity, then its ID. */
export interface FeedbackPosition {
  updatedAt: number;
  threadId: string;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CURSOR = new RegExp(`^f(\\d{1,15})\\.(${UUID})$`);

/** Opaque cursor: the position of the last item of a page, in base64url. */
export function encodeFeedbackCursor(position: FeedbackPosition): string {
  return btoa(`f${position.updatedAt}.${position.threadId}`)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** The position a cursor names, or `undefined` for anything this listing did not make. */
export function decodeFeedbackCursor(cursor: string): FeedbackPosition | undefined {
  try {
    const match = CURSOR.exec(atob(cursor.replaceAll("-", "+").replaceAll("_", "/")));
    if (!match) return undefined;
    return { updatedAt: Number(match[1]), threadId: match[2] as string };
  } catch {
    return undefined;
  }
}
