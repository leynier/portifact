// Live updates (decision 0026, "Live updates"): a connection's admission, its re-admission against
// the control record on every message in and out, renewal by the same principal, the per-minute
// bounds, message reservations against the artifact's day and who receives a change.
import {
  ARTIFACT_DATA,
  type ArtifactDataLimits,
  type CollectionMode,
  type DataControl,
  LIVE_CLOSE,
  type LiveCloseCode,
} from "@portifact/contracts/artifact-data";
import { dayOf, minuteOf } from "./charging.ts";
import { accept, type Decision, refuse } from "./decision.ts";

/** What a connection holds in its attachment, so it survives hibernation. */
export interface LiveAttachment {
  socketId: string;
  /** The grant's visitor, or null for a reader. */
  author: string | null;
  /** The credential that opened it; only the same principal renews it. */
  principal: string;
  generation: number;
  subscriptions: string[];
  deadline: number;
  window: number;
  messagesIn: number;
  bytesOut: number;
  /** Messages reserved against the artifact's day and not yet sent. */
  reserved: number;
  /** The UTC day they were reserved in: they expire when it ends. */
  reservedDay: number;
  liveMessagesPerDay: number;
}

/**
 * A new connection, after admission and the connect rate: only on an object with data, with a
 * deadline in the future and at most `live.deadlineMs` away, under the plan's connection counts.
 */
export function connectDecision(input: {
  hasData: boolean;
  barred: boolean;
  deadline: number;
  now: number;
  open: number;
  openForAuthor: number;
  limits: ArtifactDataLimits;
}): Decision<null> {
  if (!input.hasData) return refuse("not_found", "no data");
  if (input.barred) return refuse("forbidden", "this author's data was erased");
  if (input.deadline <= input.now || input.deadline > input.now + ARTIFACT_DATA.live.deadlineMs) {
    return refuse("forbidden", "the connection's deadline is not valid");
  }
  if (input.open >= input.limits.connectionsPerArtifact) {
    return refuse("rate_limited", "too many connections");
  }
  if (input.openForAuthor >= input.limits.connectionsPerAuthor) {
    return refuse("rate_limited", "too many connections");
  }
  return accept(null);
}

export function newAttachment(input: {
  socketId: string;
  author: string | null;
  principal: string;
  generation: number;
  deadline: number;
  now: number;
  limits: ArtifactDataLimits;
}): LiveAttachment {
  return {
    socketId: input.socketId,
    author: input.author,
    principal: input.principal,
    generation: input.generation,
    subscriptions: [],
    deadline: input.deadline,
    window: minuteOf(input.now),
    messagesIn: 0,
    bytesOut: 0,
    reserved: 0,
    reservedDay: dayOf(input.now),
    liveMessagesPerDay: input.limits.liveMessagesPerDay,
  };
}

/**
 * Re-admission, before any message in or out: a passed deadline closes `renew`; a hold, a
 * quarantine, a prepared erase or a new generation closes `reconnect`; an erased author closes
 * `erased`. Otherwise the attachment with its minute's counters reset when the minute changed.
 */
export function liveCheck(
  control: DataControl | null,
  attachment: LiveAttachment,
  barred: boolean,
  now: number,
): { close: LiveCloseCode } | { attachment: LiveAttachment } {
  if (attachment.deadline <= now) return { close: LIVE_CLOSE.renew };
  if (barred) return { close: LIVE_CLOSE.erased };
  if (
    control === null ||
    control.hold !== null ||
    control.quarantine !== null ||
    control.erasing !== null ||
    control.generation !== attachment.generation
  ) {
    return { close: LIVE_CLOSE.reconnect };
  }
  const window = minuteOf(now);
  if (window === attachment.window) return { attachment };
  return { attachment: { ...attachment, window, messagesIn: 0, bytesOut: 0 } };
}

/**
 * Renewal: only the principal that opened the connection; the deadline may move to any time up to
 * `live.deadlineMs` ahead, shorter included; it carries the current plan's daily message limit,
 * and a lowered limit drops the messages already reserved, so the next message reserves against
 * it. A deadline already passed closes the connection.
 */
export function renewDecision(
  attachment: LiveAttachment,
  principal: string,
  deadline: number,
  now: number,
  limits: ArtifactDataLimits,
): { close: LiveCloseCode } | { refused: true } | { attachment: LiveAttachment } {
  if (attachment.principal !== principal) return { refused: true };
  if (deadline <= now) return { close: LIVE_CLOSE.renew };
  if (deadline > now + ARTIFACT_DATA.live.deadlineMs) return { refused: true };
  const lowered = limits.liveMessagesPerDay < attachment.liveMessagesPerDay;
  return {
    attachment: {
      ...attachment,
      deadline,
      liveMessagesPerDay: limits.liveMessagesPerDay,
      reserved: lowered ? 0 : attachment.reserved,
    },
  };
}

/** A message in: at most `messageBytes` and `messagesInPerMinute`, else closed `tooManyIn`. */
export function inbound(
  attachment: LiveAttachment,
  bytes: number,
): { close: LiveCloseCode } | { attachment: LiveAttachment } {
  const next = { ...attachment, messagesIn: attachment.messagesIn + 1 };
  if (
    bytes > ARTIFACT_DATA.live.messageBytes ||
    next.messagesIn > ARTIFACT_DATA.live.messagesInPerMinute
  ) {
    return { close: LIVE_CLOSE.tooManyIn };
  }
  return { attachment: next };
}

/**
 * A message out, acknowledgements and errors included: past the minute's bytes closes
 * `slowDown`; with nothing reserved today the connection must reserve first (`liveReservation`)
 * against today's limit (credits of an earlier day expire), and a refused reservation closes
 * `daySpent`. Each message sent spends one reserved message.
 */
export function outbound(
  attachment: LiveAttachment,
  bytes: number,
  granted: number | null,
  now: number,
): { close: LiveCloseCode } | { reserve: true } | { attachment: LiveAttachment } {
  if (attachment.bytesOut + bytes > ARTIFACT_DATA.live.bytesOutPerMinute) {
    return { close: LIVE_CLOSE.slowDown };
  }
  const today = dayOf(now);
  let reserved = attachment.reservedDay === today ? attachment.reserved : 0;
  if (reserved === 0) {
    if (granted === null) return { reserve: true };
    if (granted === 0) return { close: LIVE_CLOSE.daySpent };
    reserved = granted;
  }
  return {
    attachment: {
      ...attachment,
      bytesOut: attachment.bytesOut + bytes,
      reserved: reserved - 1,
      reservedDay: today,
    },
  };
}

/** A subscription, kept to `live.subscriptions` collections. */
export function subscribed(attachment: LiveAttachment, collection: string): LiveAttachment {
  const subscriptions = [...new Set([...attachment.subscriptions, collection])].slice(
    0,
    ARTIFACT_DATA.live.subscriptions,
  );
  return { ...attachment, subscriptions };
}

/**
 * Whether a change to a document of `creator` in a collection of `mode` goes to this connection:
 * it subscribed to the collection, and in `own` mode only the creator's own connections hear it.
 * A reader of an `own` collection hears nothing.
 */
export function receives(
  attachment: LiveAttachment,
  collection: string,
  mode: CollectionMode,
  creator: string,
): boolean {
  if (!attachment.subscriptions.includes(collection)) return false;
  return mode !== "own" || attachment.author === creator;
}
