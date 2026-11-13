// The real documents object behind the suites' driver (`DataObject`): every command runs inside
// the Durable Object through `runInDurableObject`, where the store answers synchronously over its
// SQLite storage, exactly as the object's own handlers call it. The store is rebuilt once with a
// test setup: deterministic IDs (the reference's), strict bounds, a recorded alarm instead of a
// real one (so no alarm fires on the wall clock), recorded socket output, and an instrument that
// keeps every charge. `evict` drops the store's memory and rebuilds it over the same storage, as
// the runtime does after an eviction; `hibernate` keeps the connections.

import { env, runInDurableObject } from "cloudflare:test";
import type { PendingReads } from "@portifact/domain/artifact-data";
import type {
  DataObject,
  Doc,
  DriverFaults,
  Durable,
  ObjectView,
  SeedRows,
  SocketView,
} from "@portifact/domain/testing/artifact-data";
import type { ArtifactDocuments } from "../src/documents.ts";
import { storeFor } from "../src/documents.ts";
import {
  type DocumentsStore,
  dayOfRow,
  docOf,
  fieldOf,
  Instrument,
  type SocketPort,
} from "../src/store.ts";

let objects = 0;

/** What the driver keeps outside the object: the recorded alarm and every socket's output. */
interface Recorder {
  alarm: number | null;
  sets: (number | null)[];
  received: Map<string, string[]>;
  /** Creation order of IDs, so a view lists documents as the reference does. */
  order: Map<string, number>;
  instrument: Instrument;
  /** Closes the object sends are lost (a crash between the commit and the close frame). */
  dropCloses: boolean;
  /** Fails the next alarm set (a failure to re-arm after a committed write). */
  failNextSet: boolean;
}

/** The reference's ID scheme (`MemoryObject#newId`), so both objects name things alike. */
/** What an eviction loses: the usage still held in memory. */
function lost(pending: PendingReads): number {
  return pending.rows + pending.deferred;
}

export function referenceIds(name: string, order?: Map<string, number>): () => string {
  let count = 0;
  return () => {
    count += 1;
    const id = `${name}${count}`.padStart(16, "x").slice(-16);
    order?.set(id, count);
    return id;
  };
}

type Row = Record<string, SqlStorageValue>;
const key2 = (...parts: (string | number)[]) => parts.join("\u0000");
const num = (value: SqlStorageValue | undefined) => Number(value ?? 0);
const str = (value: SqlStorageValue | undefined) => String(value ?? "");

/** The object's tables in the reference's shapes. */
export function durableOf(store: DocumentsStore, recorder: Recorder): Durable {
  const rows = (table: string) => store.inspect(table);
  const collections = new Map(
    rows("pf_collections")
      .sort((a, b) => num(a.position) - num(b.position))
      .map((row) => [
        str(row.name),
        {
          mode: str(row.mode) as "own",
          uniqueKey: row.unique_key === null ? null : str(row.unique_key),
          documents: num(row.documents),
          bytes: num(row.bytes),
        },
      ]),
  );
  const documents = rows("pf_documents")
    .map(docOf)
    .sort(
      (a, b) =>
        (recorder.order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
          (recorder.order.get(b.id) ?? Number.MAX_SAFE_INTEGER) || (a.id < b.id ? -1 : 1),
    );
  return {
    control: store.controlRecord(),
    collections,
    fields: rows("pf_fields")
      .sort((a, b) => num(a.position) - num(b.position))
      .map(fieldOf),
    documents: new Map(documents.map((doc): [string, Doc] => [key2(doc.collection, doc.id), doc])),
    authorCounts: new Map(
      rows("pf_author_counts").map((row) => [
        key2(str(row.collection), str(row.author)),
        num(row.count),
      ]),
    ),
    valueCounts: new Map(
      rows("pf_value_counts").map((row) => [
        key2(str(row.collection), str(row.field), str(row.value)),
        num(row.count),
      ]),
    ),
    seq: new Map(rows("pf_seq").map((row) => [str(row.scope), num(row.value)])),
    ops: new Map(
      rows("pf_ops").map((row) => [
        str(row.key),
        {
          actor: str(row.actor),
          requestHash: str(row.request_hash),
          state: str(row.state) as "committed",
          kind: str(row.kind),
          target: str(row.target),
          result:
            row.result === null ? null : (JSON.parse(str(row.result)) as Record<string, number>),
          at: num(row.at),
        },
      ]),
    ),
    audit: new Map(
      rows("pf_audit").map((row) => [
        str(row.key),
        {
          kind: str(row.kind),
          detail: JSON.parse(str(row.detail)) as Record<string, number | boolean>,
          owner: str(row.owner),
          state: str(row.state) as "pending",
          at: num(row.at),
        },
      ]),
    ),
    barriers: new Map(
      rows("pf_barriers").map((row) => [
        str(row.author),
        { at: num(row.at), complete: num(row.complete) === 1 },
      ]),
    ),
    rates: new Map(
      rows("pf_rates").map((row) => [
        key2(str(row.subject), str(row.kind), num(row.window)),
        num(row.count),
      ]),
    ),
    days: new Map(
      rows("pf_days")
        .map(dayOfRow)
        .sort((a, b) => a.day - b.day)
        .map((day) => [day.day, day]),
    ),
    rights: new Map(
      rows("pf_rights").map((row) => [key2(str(row.author), num(row.day)), num(row.used)]),
    ),
    ended: new Map(
      rows("pf_ended").map((row) => [
        str(row.id),
        { outcome: str(row.outcome) as "committed", at: num(row.at) },
      ]),
    ),
    alarm: recorder.alarm,
  };
}

/** A real documents object, fresh and empty, driven like the reference. */
export class RealObject implements DataObject {
  readonly kind = "real" as const;
  readonly stub: DurableObjectStub<ArtifactDocuments>;
  readonly recorder: Recorder;
  readonly #ids: () => string;
  #ready = false;
  /**
   * The last view, until anything else runs in the object: a suite reads the state several times
   * between two commands, and each read would otherwise snapshot every table again.
   */
  #view: Promise<ObjectView> | null = null;
  /** Whether the state was read since the last command. */
  #viewed = false;
  /** Commands sent so far: a snapshot is kept only from the last one sent. */
  #calls = 0;

  constructor(readonly name = "obj") {
    objects += 1;
    this.stub = env.DOCUMENTS.get(env.DOCUMENTS.idFromName(`real-${objects}-${name}`));
    const order = new Map<string, number>();
    this.recorder = {
      alarm: null,
      sets: [],
      received: new Map(),
      order,
      instrument: new Instrument(true),
      dropCloses: false,
      failNextSet: false,
    };
    this.#ids = referenceIds(name, order);
  }

  /** Rebuilds the store over the object's storage with the test setup, as a wake does. */
  #rebuild(instance: ArtifactDocuments, ctx: DurableObjectState): void {
    const recorder = this.recorder;
    instance.store = storeFor(ctx, instance.clients, {
      ids: this.#ids,
      instrument: recorder.instrument,
      strictBounds: true,
      scheduler: {
        set(at) {
          if (recorder.failNextSet) {
            recorder.failNextSet = false;
            throw new Error("injected alarm failure");
          }
          recorder.alarm = at;
          recorder.sets.push(at);
        },
      },
      wrap(port, socketId): SocketPort {
        return {
          send(text) {
            const list = recorder.received.get(socketId) ?? [];
            list.push(text);
            recorder.received.set(socketId, list);
            port.send(text);
          },
          close(code) {
            if (!recorder.dropCloses) port.close(code);
          },
          serializeAttachment(value) {
            port.serializeAttachment(value);
          },
        };
      },
    });
  }

  /** Runs `work` inside the object, with the test store in place. */
  run<T>(
    work: (store: DocumentsStore, instance: ArtifactDocuments, ctx: DurableObjectState) => T,
  ): Promise<T> {
    // A suite that read the state since the last command will read it again after this one: the
    // snapshot is taken in this command's own call, right after it, saving a request.
    const eager = this.#viewed;
    this.#viewed = false;
    this.#view = null;
    this.#calls += 1;
    const call = this.#calls;
    return this.#enter((store, instance, ctx) => {
      const value = work(store, instance, ctx);
      // The instance's store, which an eviction or a wake has just replaced. Only the last call
      // sent may leave its snapshot: with several in flight, an earlier one's is already stale.
      if (eager && call === this.#calls) {
        this.#view = Promise.resolve(this.#build(instance.store));
      }
      return value;
    });
  }

  /** Runs `work` inside the object, with the test store in place. */
  async #enter<T>(
    work: (store: DocumentsStore, instance: ArtifactDocuments, ctx: DurableObjectState) => T,
  ): Promise<T> {
    return runInDurableObject(this.stub, (instance, ctx) => {
      if (!this.#ready) {
        this.#rebuild(instance, ctx);
        this.#ready = true;
      }
      return work(instance.store, instance, ctx);
    });
  }

  declare: DataObject["declare"] = (...args) => this.run((s) => s.declare(...args));
  indexStep: DataObject["indexStep"] = (...args) => this.run((s) => s.indexStep(...args));
  create: DataObject["create"] = (...args) => this.run((s) => s.create(...args));
  replace: DataObject["replace"] = (...args) => this.run((s) => s.replace(...args));
  remove: DataObject["remove"] = (...args) => this.run((s) => s.remove(...args));
  bulkCreate: DataObject["bulkCreate"] = (...args) => this.run((s) => s.bulkCreate(...args));
  bulkReplace: DataObject["bulkReplace"] = (...args) => this.run((s) => s.bulkReplace(...args));
  bulkRemove: DataObject["bulkRemove"] = (...args) => this.run((s) => s.bulkRemove(...args));
  eraseAuthorChunk: DataObject["eraseAuthorChunk"] = (...args) =>
    this.run((s) => s.eraseAuthorChunk(...args));
  get: DataObject["get"] = (...args) => this.run((s) => s.get(...args));
  query: DataObject["query"] = (...args) => this.run((s) => s.query(...args));
  count: DataObject["count"] = (...args) => this.run((s) => s.count(...args));
  describe: DataObject["describe"] = (...args) => this.run((s) => s.describe(...args));
  exportPage: DataObject["exportPage"] = (...args) => this.run((s) => s.exportPage(...args));
  exportMine: DataObject["exportMine"] = (...args) => this.run((s) => s.exportMine(...args));
  fence: DataObject["fence"] = (...args) => this.run((s) => s.fence(...args));
  quarantine: DataObject["quarantine"] = (...args) => this.run((s) => s.quarantine(...args));
  resolveQuarantine: DataObject["resolveQuarantine"] = (...args) =>
    this.run((s) => s.resolveQuarantine(...args));
  prepareErase: DataObject["prepareErase"] = (...args) => this.run((s) => s.prepareErase(...args));
  commitErase: DataObject["commitErase"] = (...args) => this.run((s) => s.commitErase(...args));
  cancelErase: DataObject["cancelErase"] = (...args) => this.run((s) => s.cancelErase(...args));
  settle: DataObject["settle"] = (...args) => this.run((s) => s.settle(...args));
  acknowledge: DataObject["acknowledge"] = (...args) => this.run((s) => s.acknowledge(...args));
  alarm: DataObject["alarm"] = (now) => this.run((s) => s.alarm(now));
  flushReads: DataObject["flushReads"] = (now) => this.run((s) => s.flushReads(now));
  connect: DataObject["connect"] = (...args) => this.run((s) => s.connect(...args));
  renew: DataObject["renew"] = (...args) => this.run((s) => s.renew(...args));
  message: DataObject["message"] = (...args) => this.run((s) => s.message(...args));

  /** An eviction: memory (pending usage, attempts, connections) goes; storage stays. */
  evict(): Promise<void> {
    return this.run((store, instance, ctx) => {
      this.recorder.instrument.retired += lost(store.pending);
      store.closeAll(1001);
      this.#rebuild(instance, ctx);
    });
  }

  /** A wake after hibernation: memory goes, connections stay with their attachments. */
  hibernate(): Promise<void> {
    return this.run((store, instance, ctx) => {
      this.recorder.instrument.retired += lost(store.pending);
      this.#rebuild(instance, ctx);
    });
  }

  view(): Promise<ObjectView> {
    this.#viewed = true;
    this.#view ??= this.#enter((store) => this.#build(store));
    return this.#view;
  }

  /** The state and meters right now, in the reference's shapes. */
  #build(store: DocumentsStore): ObjectView {
    const durable = durableOf(store, this.recorder);
    const sockets = new Map<string, SocketView>();
    for (const [id, socket] of store.sockets) {
      sockets.set(id, {
        attachment: socket.attachment,
        received: [...(this.recorder.received.get(id) ?? [])],
        closed: socket.closed,
      });
    }
    const meters = this.recorder.instrument;
    const accounted = store.accounted();
    const bytes = store.fileBytes();
    return {
      durable,
      pending: { ...store.pending },
      sockets,
      charges: [...meters.charges],
      checked: [...meters.checked],
      accesses: meters.accesses,
      counterWrites: meters.counterWrites,
      retired: meters.retired,
      accounted: () => accounted,
      fileBytes: () => bytes,
    };
  }

  setFaults(faults: DriverFaults): Promise<void> {
    return this.run((store) => {
      store.faults = { ...faults };
    });
  }

  setRowBounds(bounds: Parameters<DataObject["setRowBounds"]>[0]): Promise<void> {
    return this.run((store) => {
      Object.assign(store.rowBounds, bounds);
    });
  }

  /** Puts retained control rows in place with plain statements, outside any command. */
  seed(rows: SeedRows): Promise<void> {
    return this.run((_store, _instance, ctx) => {
      const sql = ctx.storage.sql;
      const run = (query: string, ...binds: SqlStorageValue[]) =>
        sql.exec(query, ...binds).toArray();
      ctx.storage.transactionSync(() => {
        for (const table of rows.clear ?? []) run(`DELETE FROM pf_${table}`);
        for (const [key, row] of rows.ops ?? []) {
          run(
            "INSERT INTO pf_ops VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            key,
            row.actor,
            row.requestHash,
            row.state,
            row.kind,
            row.target,
            row.result === null ? null : JSON.stringify(row.result),
            row.at,
          );
        }
        for (const [id, row] of rows.ended ?? []) {
          run("INSERT INTO pf_ended VALUES (?, ?, ?)", id, row.outcome, row.at);
        }
        for (const [key, row] of rows.audit ?? []) {
          run(
            "INSERT INTO pf_audit VALUES (?, ?, ?, ?, ?, ?)",
            key,
            row.kind,
            JSON.stringify(row.detail),
            row.owner,
            row.state,
            row.at,
          );
        }
        for (const [key, count] of rows.rates ?? []) {
          const [subject, kind, window] = key.split("\u0000");
          run(
            "INSERT INTO pf_rates VALUES (?, ?, ?, ?)",
            str(subject),
            str(kind),
            num(Number(window)),
            count,
          );
        }
        for (const day of rows.days ?? []) {
          run(
            "INSERT OR REPLACE INTO pf_days VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            day.day,
            day.growth,
            day.read,
            day.cleanup,
            day.export,
            day.rights,
            day.protected,
            day.live,
            day.refused,
            day.intents,
          );
        }
        for (const [key, used] of rows.rights ?? []) {
          const [author, day] = key.split("\u0000");
          run("INSERT INTO pf_rights VALUES (?, ?, ?)", str(author), Number(day), used);
        }
      });
    });
  }
}

/** A fresh real object, as the suites make one. */
export const realObject = async (name?: string) => new RealObject(name);

export type { Row };
