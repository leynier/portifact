// `ArtifactDocuments`, the documents Durable Object of decision 0026: one per artifact, named by the
// artifact ID, on SQLite storage, in the jurisdiction of the owner's region. It holds the store
// (store.ts) and adapts the platform to it: the alarm, hibernatable WebSockets and the wake after
// hibernation or eviction. It exposes no fetch handler and no RPC method: nothing reaches it until
// a later delivery adds its callers (the jobs Worker's lifecycle and erasure paths, then the owner
// API and the page), and no deployed Worker binds it yet.

import { DurableObject } from "cloudflare:workers";
import type { LiveAttachment } from "@portifact/domain/artifact-data";
import { DocumentsStore, type Instrument, type SocketPort, type WokenSocket } from "./store.ts";

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
