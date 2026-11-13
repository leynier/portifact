// `ArtifactDocuments`, the documents Durable Object of decision 0026: one per artifact, named by the
// artifact ID, on SQLite storage, in the jurisdiction of the owner's region. It holds the store
// (store.ts) and adapts the platform to it: the alarm, hibernatable WebSockets and the wake after
// hibernation or eviction. It has no fetch handler. Its only RPC methods are the lifecycle
// interface below (delivery 4), which the jobs Worker calls through its binding to this script;
// document commands get theirs with the owner API (delivery 5) and the page (delivery 6).

import { DurableObject } from "cloudflare:workers";
import {
  type DataControl,
  type DataEnvelope,
  DataFence,
  EraseStepName as EraseStep,
  ExportCursor,
  LifecycleEnvelope,
  DataTime as Now,
  OperationId,
  QuarantineReason,
  RequiredErase,
  QuarantineResolution as Resolution,
  type StorageReport,
  VisitorId,
} from "@portifact/contracts/artifact-data";
import { LIFECYCLE_LIMITS, type LiveAttachment } from "@portifact/domain/artifact-data";
import { DocumentsStore, type Instrument, type SocketPort, type WokenSocket } from "./store.ts";

/** What an invalid lifecycle command is answered. */
interface InvalidInput {
  ok: false;
  code: "invalid_input";
  message: string;
  cost: { rowsRead: number; rowsWritten: number };
  storage: StorageReport;
}

/** The most documents an export page of the operator's returns (the export cap). */
const EXPORT_TAKE = 500;
/** The most of the author's documents one lifecycle chunk deletes (the chunk cap). */
const CHUNK_TAKE = 500;

/** What a test may change when it rebuilds the store over the same storage. */
export interface StoreSetup {
  ids?: () => string;
  instrument?: Instrument;
  strictBounds?: boolean;
  scheduler?: { set(at: number | null): void };
  /** Wraps each socket the store uses, a woken one included (a test records what it sent). */
  wrap?: (port: SocketPort, socketId: string) => SocketPort;
}

/**
 * The store over a Durable Object's storage, rebuilding live connections from the hibernatable
 * WebSockets the runtime kept and their serialized attachments. The constructor runs it on every
 * wake, after hibernation or an eviction alike.
 */
export function storeFor(
  ctx: DurableObjectState,
  clients: Map<string, WebSocket>,
  setup: StoreSetup = {},
): DocumentsStore {
  const woken: WokenSocket[] = [];
  for (const socket of ctx.getWebSockets()) {
    // A socket the object already closed may still be listed while its close completes.
    if (socket.readyState !== WebSocket.READY_STATE_OPEN) continue;
    const attachment = socket.deserializeAttachment() as LiveAttachment | null;
    if (attachment !== null) {
      const port = setup.wrap?.(socket, attachment.socketId) ?? socket;
      woken.push({ port, attachment });
    }
  }
  return new DocumentsStore({
    storage: ctx.storage,
    scheduler: setup.scheduler ?? {
      set(at) {
        // The storage's output gate holds the answer until the alarm is durable.
        if (at === null) void ctx.storage.deleteAlarm();
        else void ctx.storage.setAlarm(at);
      },
    },
    accept(socketId): SocketPort {
      const pair = new WebSocketPair();
      ctx.acceptWebSocket(pair[1], [socketId]);
      // The client end is what a later delivery's upgrade answer carries; until then it is held
      // here, where only the object's own code can reach it.
      clients.set(socketId, pair[0]);
      return setup.wrap?.(pair[1], socketId) ?? pair[1];
    },
    woken,
    ...(setup.ids === undefined ? {} : { ids: setup.ids }),
    ...(setup.instrument === undefined ? {} : { instrument: setup.instrument }),
    ...(setup.strictBounds === undefined ? {} : { strictBounds: setup.strictBounds }),
  });
}

export class ArtifactDocuments extends DurableObject<Env> {
  /** The store: reachable by the object's own code (and tests in its isolate), never over RPC. */
  store: DocumentsStore;
  /** Client ends of connections this instance opened, until the upgrade route exists. */
  readonly clients = new Map<string, WebSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = storeFor(ctx, this.clients);
    // The alarm as the platform holds it, so re-arming skips a set that would change nothing.
    void ctx.blockConcurrencyWhile(async () => {
      this.store.knownAlarm(await ctx.storage.getAlarm());
    });
  }

  // The lifecycle interface (decision 0026, delivery 4). The binding is the credential: only a
  // Worker whose deployed configuration binds this class by `script_name` reaches these methods
  // (today the jobs Worker; there is no route and no fetch handler). Every argument is parsed at
  // this boundary, and every command is then admitted by the store through the domain's envelope
  // rules (`admit`, `applyFence`, the erase steps), which decide; nothing here does.

  /** The control record, or null when no durable write ever bound the object. Writes nothing. */
  lifecycleControl(): DataControl | null {
    return this.store.controlRecord();
  }

  /** A hold, a release, a transfer or an epoch raise. */
  lifecycleFence(envelope: unknown, fence: unknown, now: unknown) {
    const input = this.#parsed(() => ({
      envelope: LifecycleEnvelope.parse(envelope),
      fence: DataFence.parse(fence),
      now: Now.parse(now),
    }));
    if ("refused" in input) return input.refused;
    return this.store.fence(input.envelope, input.fence, input.now);
  }

  /**
   * A step of a whole erase the lifecycle requires (`reason`: a purge, an account's or a
   * workspace's deletion): only these paths set `requiredErase`, never a document command.
   */
  lifecycleErase(
    step: unknown,
    envelope: unknown,
    eraseId: unknown,
    reason: unknown,
    now: unknown,
  ) {
    const input = this.#parsed(() => ({
      step: EraseStep.parse(step),
      envelope: {
        ...LifecycleEnvelope.parse(envelope),
        requiredErase: RequiredErase.parse(reason),
      } satisfies DataEnvelope,
      eraseId: OperationId.parse(eraseId),
      now: Now.parse(now),
    }));
    if ("refused" in input) return input.refused;
    const { envelope: parsed, eraseId: id, now: at } = input;
    if (input.step === "prepare") return this.store.prepareErase(parsed, id, at);
    if (input.step === "commit") return this.store.commitErase(parsed, id, at);
    return this.store.cancelErase(parsed, id, at);
  }

  /** One bounded chunk of a deleted account's erasure, under its own operation ID. */
  lifecycleEraseAuthor(envelope: unknown, visitorId: unknown, opId: unknown, now: unknown) {
    const input = this.#parsed(() => ({
      envelope: {
        ...LifecycleEnvelope.parse(envelope),
        opId: OperationId.parse(opId),
      } satisfies DataEnvelope,
      visitorId: VisitorId.parse(visitorId),
      now: Now.parse(now),
    }));
    if ("refused" in input) return input.refused;
    return this.store.eraseAuthorChunk(input.envelope, input.visitorId, CHUNK_TAKE, {
      now: input.now,
      limits: LIFECYCLE_LIMITS,
    });
  }

  /** Reconciliation's quarantine. */
  lifecycleQuarantine(envelope: unknown, reason: unknown, now: unknown) {
    const input = this.#parsed(() => ({
      envelope: LifecycleEnvelope.parse(envelope),
      reason: QuarantineReason.parse(reason),
      now: Now.parse(now),
    }));
    if ("refused" in input) return input.refused;
    return this.store.quarantine(input.envelope, input.reason, input.now);
  }

  /** The operator's resolution of a quarantine. */
  lifecycleResolve(envelope: unknown, decision: unknown, now: unknown) {
    const input = this.#parsed(() => ({
      envelope: LifecycleEnvelope.parse(envelope),
      decision: Resolution.parse(decision),
      now: Now.parse(now),
    }));
    if ("refused" in input) return input.refused;
    return this.store.resolveQuarantine(input.envelope, input.decision, input.now);
  }

  /** One page of the operator's export, allowed under a hold or a quarantine. */
  lifecycleExport(envelope: unknown, after: unknown, now: unknown) {
    const input = this.#parsed(() => ({
      envelope: LifecycleEnvelope.parse(envelope),
      after: ExportCursor.nullable().parse(after),
      now: Now.parse(now),
    }));
    if ("refused" in input) return input.refused;
    return this.store.exportPage(
      input.envelope,
      { kind: "owner", actor: "operator" },
      input.after,
      EXPORT_TAKE,
      { now: input.now, limits: LIFECYCLE_LIMITS },
      true,
    );
  }

  /**
   * The arguments as parsed, or the refusal an invalid one gets: answered as a value, never
   * thrown across the RPC boundary, and before anything reads or writes storage.
   */
  #parsed<T extends object>(parse: () => T): T | { refused: InvalidInput } {
    try {
      return parse();
    } catch {
      return {
        refused: {
          ok: false,
          code: "invalid_input",
          message: "invalid lifecycle command",
          cost: { rowsRead: 0, rowsWritten: 0 },
          storage: this.store.currentReport(),
        },
      };
    }
  }

  override async alarm(): Promise<void> {
    this.store.alarm(Date.now());
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const [socketId] = this.ctx.getTags(socket);
    if (socketId === undefined) return;
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    this.store.message(socketId, text, Date.now());
  }

  override async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    const [socketId] = this.ctx.getTags(socket);
    if (socketId !== undefined) this.store.closed(socketId, code);
  }
}
