// The restore drill of decision 0026 (delivery 2, experiment 2): a model of the rows D1 keeps
// about artifact data, the tombstones a restore must not lose, the R2 inventory and journal that
// a restore does not rewind, and the documents objects that it does not rewind either. A
// scenario runs transitions on both sides of a restore point; the drill restores D1 to that
// point, re-applies the exported tombstones, runs the record's reconciliation and probes who can
// read and write. The local test restores by snapshot (D1 Time Travel does not exist in
// workerd); `drill/runbook.ts` runs the same scenarios against a scratch deployment with a real
// Time Travel restore. Only the rows the record names are modeled, not Portifact's schema.
import type { ArtifactDocuments } from "./documents.ts";
import { type Control, type Envelope, reconcile } from "./envelope.ts";
import { claimVisitorId, RetiredIdentity, retireVisitorId } from "./journal.ts";
import type { Caller, DataLimits } from "./model.ts";

export const REGION = "default";
const COLLECTION = "notes";
const INVENTORY = "system/data-objects/";

/** Generous limits: the drill is about lifecycle, not budgets. */
export const DRILL_LIMITS: DataLimits = {
  bytesPerArtifact: 100_000_000,
  documentBytes: 16 * 1024,
  documentsPerCollection: 100_000,
  collections: 10,
  indexedFields: 3,
  writesPerAuthorPerMinute: 100_000,
  deletesPerAuthorPerMinute: 100_000,
  readsPerCallerPerMinute: 100_000,
  rowsReadPerDay: 1_000_000_000,
  rowsWrittenPerDay: 100_000_000,
  connectionsPerArtifact: 25,
  connectionsPerAuthor: 4,
  connectsPerAuthorPerMinute: 6,
  liveMessagesPerDay: 10_000_000,
  rightsRowsPerDay: 100_000_000,
  cleanupRowsPerDay: 100_000_000,
  exportRowsPerDay: 100_000_000,
};

/** The D1 side: the artifact's data row, grants, accounts, holds and tombstones. */
export const DRILL_SCHEMA = [
  `create table if not exists artifact_data (artifact_id text primary key, owner_id text not null,
     generation integer not null, epoch integer not null, held integer not null default 0,
     state text not null default 'active')`,
  "create table if not exists accounts (user_id text primary key)",
  `create table if not exists data_grants (id text primary key, artifact_id text not null,
     user_id text not null, visitor_id text not null, revoked_at integer)`,
  `create table if not exists legal_holds (artifact_id text primary key, transition text not null,
     released_at integer)`,
  "create table if not exists tombstones (kind text not null, ref text not null, primary key (kind, ref))",
];
const TABLES = ["artifact_data", "accounts", "data_grants", "legal_holds", "tombstones"] as const;

export type Snapshot = Record<(typeof TABLES)[number], Record<string, unknown>[]>;

/** What `export-tombstones` writes before a restore: markers and every hold, released ones too. */
export interface TombstoneExport {
  tombstones: { kind: string; ref: string }[];
  holds: { artifact_id: string; transition: string; released_at: number | null }[];
}

export type Access = "ok" | "forbidden" | "not_found" | "held" | "quarantined" | "stale";

export interface Probe {
  /** The owner D1 names, through the owner side. */
  ownerRead: Access;
  ownerWrite: Access;
  /** The scenario's visitor, through the page with their grant as D1 holds it. */
  visitorWrite: Access;
  /** The operator's export, allowed under a hold or a quarantine. */
  operatorExport: Access;
  /** Documents the operator's export finds. */
  documents: number;
  quarantined: boolean;
}

export interface DrillEnv {
  db: D1Database;
  bucket: R2Bucket;
  documents: DurableObjectNamespace<ArtifactDocuments>;
}

let sequence = 0;
function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}${Date.now().toString(36)}${sequence.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function context(caller: Caller): { caller: Caller; limits: DataLimits; now: number } {
  return { caller, limits: DRILL_LIMITS, now: Date.now() };
}

function access(outcome: { ok: boolean; error?: string }): Access {
  if (outcome.ok) return "ok";
  return (outcome.error ?? "forbidden") as Access;
}

interface Row {
  artifact_id: string;
  owner_id: string;
  generation: number;
  epoch: number;
  held: number;
  state: string;
}

/** The drill's two sides and the operations of the record, as the Workers and jobs would run them. */
export class Drill {
  constructor(readonly env: DrillEnv) {}

  async setup(): Promise<void> {
    await this.env.db.batch(DRILL_SCHEMA.map((sql) => this.env.db.prepare(sql)));
  }

  stub(artifactId: string): DurableObjectStub<ArtifactDocuments> {
    return this.env.documents.get(this.env.documents.idFromName(artifactId));
  }

  async row(artifactId: string): Promise<Row | null> {
    return this.env.db
      .prepare("select * from artifact_data where artifact_id = ?")
      .bind(artifactId)
      .first<Row>();
  }

  envelope(row: Row, opId = true): Envelope {
    const envelope: Envelope = {
      artifactId: row.artifact_id,
      region: REGION,
      ownerId: row.owner_id,
      generation: row.generation,
      epoch: row.epoch,
    };
    return opId ? { ...envelope, opId: `${Date.now()}.${unique("o")}` } : envelope;
  }

  async #require(artifactId: string): Promise<Row> {
    const row = await this.row(artifactId);
    if (row === null) throw new Error(`no data row for ${artifactId}`);
    return row;
  }

  async account(userId: string): Promise<void> {
    await this.env.db
      .prepare("insert or ignore into accounts (user_id) values (?)")
      .bind(userId)
      .run();
  }

  /** A new artifact with data: the D1 row, the R2 inventory entry and the first declaration. */
  async createArtifact(artifactId: string, ownerId: string): Promise<void> {
    await this.account(ownerId);
    await this.env.db
      .prepare(
        "insert into artifact_data (artifact_id, owner_id, generation, epoch) values (?, ?, 0, 0)",
      )
      .bind(artifactId, ownerId)
      .run();
    await this.env.bucket.put(`${INVENTORY}${artifactId}`, REGION);
    const row = await this.#require(artifactId);
    const declared = await this.stub(artifactId).declareCollection(
      this.envelope(row),
      context({ kind: "owner" }),
      { name: COLLECTION, mode: "own" },
    );
    if (!declared.ok) throw new Error(`declaring failed: ${declared.error}`);
  }

  /** A grant: the journal's claim first (R2, not rewound), then the D1 row. */
  async grant(artifactId: string, userId: string): Promise<string> {
    const visitorId = await claimVisitorId(
      this.env.bucket,
      userId,
      artifactId,
      unique("v_"),
      Date.now(),
    );
    const id = unique("g_");
    await this.env.db
      .prepare("insert into data_grants (id, artifact_id, user_id, visitor_id) values (?, ?, ?, ?)")
      .bind(id, artifactId, userId, visitorId)
      .run();
    return id;
  }

  async #grantOf(
    artifactId: string,
    userId: string,
  ): Promise<{ id: string; visitor_id: string } | null> {
    return this.env.db
      .prepare(
        `select g.id, g.visitor_id from data_grants g join accounts a on a.user_id = g.user_id
         where g.artifact_id = ? and g.user_id = ? and g.revoked_at is null`,
      )
      .bind(artifactId, userId)
      .first<{ id: string; visitor_id: string }>();
  }

  /** A page write as a visitor: the content Worker needs a live grant in D1, then the object decides. */
  async visitorWrite(artifactId: string, userId: string, body: unknown): Promise<Access> {
    const row = await this.row(artifactId);
    if (row === null || row.state !== "active") return "not_found";
    const grant = await this.#grantOf(artifactId, userId);
    if (grant === null) return "forbidden";
    const caller: Caller = { kind: "visitor", author: grant.visitor_id, canWrite: true };
    return access(
      await this.stub(artifactId).create(this.envelope(row), context(caller), COLLECTION, body),
    );
  }

  /** The owner side: D1 authorizes the owner it names, then the object decides. */
  async ownerRead(artifactId: string, ownerId: string): Promise<Access> {
    const row = await this.row(artifactId);
    if (row === null || row.state !== "active") return "not_found";
    if (row.owner_id !== ownerId) return "forbidden";
    return access(
      await this.stub(artifactId).query(this.envelope(row, false), context({ kind: "owner" }), {
        collection: COLLECTION,
      }),
    );
  }

  async ownerWrite(artifactId: string, ownerId: string): Promise<Access> {
    const row = await this.row(artifactId);
    if (row === null || row.state !== "active") return "not_found";
    if (row.owner_id !== ownerId) return "forbidden";
    return access(
      await this.stub(artifactId).create(
        this.envelope(row),
        context({ kind: "owner" }),
        COLLECTION,
        { by: "owner" },
      ),
    );
  }

  /** A command sent straight to the object with a forged envelope: what the object alone refuses. */
  async direct(artifactId: string, envelope: Envelope, caller: Caller): Promise<Access> {
    return access(
      await this.stub(artifactId).create(
        { ...envelope, opId: `${Date.now()}.${unique("f")}` },
        context(caller),
        COLLECTION,
        { forged: true },
      ),
    );
  }

  /** The operator's export: the object's own control record names the owner. */
  async operatorExport(artifactId: string): Promise<{ access: Access; documents: number }> {
    const stub = this.stub(artifactId);
    const control = await stub.controlRecord();
    if (control === null) return { access: "not_found", documents: 0 };
    const page = await stub.exportPage(
      controlEnvelope(control),
      context({ kind: "owner", actor: "operator" }),
      null,
      500,
      true,
    );
    if (!page.ok) return { access: access(page), documents: 0 };
    return { access: "ok", documents: "value" in page ? page.value.rows.length : 0 };
  }

  async #fence(artifactId: string, change: { state: "open" | "held"; toOwner?: string }) {
    const before = await this.#require(artifactId);
    const transition = unique("t_");
    const epoch = before.epoch + 1;
    const owner = change.toOwner ?? before.owner_id;
    const statements = [
      this.env.db
        .prepare("update artifact_data set epoch = ?, held = ?, owner_id = ? where artifact_id = ?")
        .bind(epoch, change.state === "held" ? 1 : 0, owner, artifactId),
    ];
    if (change.state === "held")
      statements.push(
        this.env.db
          .prepare(
            "insert into legal_holds (artifact_id, transition) values (?, ?) on conflict (artifact_id) do update set transition = excluded.transition, released_at = null",
          )
          .bind(artifactId, transition),
      );
    else if (change.toOwner === undefined)
      statements.push(
        this.env.db
          .prepare("update legal_holds set released_at = ? where artifact_id = ?")
          .bind(Date.now(), artifactId),
      );
    await this.env.db.batch(statements);
    // The data_fence job: the object is told under the old owner and the new epoch.
    const fenced = await this.stub(artifactId).fence(
      { ...this.envelope(before, false), epoch },
      { ...change, transition },
    );
    if (!fenced.ok) throw new Error(`fence refused: ${fenced.error}`);
  }

  hold(artifactId: string): Promise<void> {
    return this.#fence(artifactId, { state: "held" });
  }

  release(artifactId: string): Promise<void> {
    return this.#fence(artifactId, { state: "open" });
  }

  async transfer(artifactId: string, toOwner: string): Promise<void> {
    await this.account(toOwner);
    await this.#fence(artifactId, { state: "open", toOwner });
  }

  /** The owner's "erase all", step one: prepared under an erase ID; nothing in D1 says so yet. */
  async prepareErase(artifactId: string): Promise<string> {
    const row = await this.#require(artifactId);
    const eraseId = unique("e_");
    const prepared = await this.stub(artifactId).prepareErase(this.envelope(row, false), eraseId);
    if (!prepared.ok) throw new Error(`prepare refused: ${prepared.error}`);
    return eraseId;
  }

  /** Step two: the object commits, then D1 records the next generation. */
  async commitErase(artifactId: string, eraseId: string): Promise<void> {
    const row = await this.#require(artifactId);
    const committed = await this.stub(artifactId).commitErase(this.envelope(row, false), eraseId);
    if (!committed.ok) throw new Error(`commit refused: ${committed.error}`);
    await this.env.db
      .prepare("update artifact_data set generation = generation + 1 where artifact_id = ?")
      .bind(artifactId)
      .run();
  }

  /** Account deletion: the tombstone and the deletion, the journal retired, then the chunks. */
  async deleteAccount(userId: string, artifactId: string): Promise<void> {
    const grant = await this.#grantOf(artifactId, userId);
    await this.env.db.batch([
      this.env.db
        .prepare("insert or ignore into tombstones (kind, ref) values ('account', ?)")
        .bind(userId),
      this.env.db.prepare("delete from data_grants where user_id = ?").bind(userId),
      this.env.db.prepare("delete from accounts where user_id = ?").bind(userId),
    ]);
    await retireVisitorId(this.env.bucket, userId, artifactId, Date.now());
    if (grant === null) return;
    const row = await this.#require(artifactId);
    for (;;) {
      const chunk = await this.stub(artifactId).eraseAuthorChunk(
        this.envelope(row),
        grant.visitor_id,
        500,
      );
      if (!chunk.ok) throw new Error(`erasure refused: ${chunk.error}`);
      if (!("value" in chunk) || !chunk.value.more) return;
    }
  }

  async revoke(grantId: string): Promise<void> {
    await this.env.db.batch([
      this.env.db
        .prepare("update data_grants set revoked_at = ? where id = ?")
        .bind(Date.now(), grantId),
      this.env.db
        .prepare("insert or ignore into tombstones (kind, ref) values ('data_grant', ?)")
        .bind(grantId),
    ]);
  }

  // The restore, and what the operator runs around it.

  async snapshot(): Promise<Snapshot> {
    const entries = await Promise.all(
      TABLES.map(
        async (table) =>
          [table, (await this.env.db.prepare(`select * from ${table}`).all()).results] as const,
      ),
    );
    return Object.fromEntries(entries) as Snapshot;
  }

  /** The local stand-in for D1 Time Travel: every modeled table back to the snapshot. */
  async restore(snapshot: Snapshot): Promise<void> {
    const statements = TABLES.flatMap((table) => [
      this.env.db.prepare(`delete from ${table}`),
      ...snapshot[table].map((row) => {
        const columns = Object.keys(row);
        return this.env.db
          .prepare(
            `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`,
          )
          .bind(...columns.map((column) => row[column]));
      }),
    ]);
    await this.env.db.batch(statements);
  }

  async exportTombstones(): Promise<TombstoneExport> {
    const tombstones = await this.env.db
      .prepare("select kind, ref from tombstones")
      .all<{ kind: string; ref: string }>();
    const holds = await this.env.db
      .prepare("select artifact_id, transition, released_at from legal_holds")
      .all<TombstoneExport["holds"][number]>();
    return { tombstones: tombstones.results, holds: holds.results };
  }

  /** `apply-tombstones`: holds first (put back or released again), then the markers. */
  async applyTombstones(file: TombstoneExport): Promise<void> {
    const db = this.env.db;
    const statements = file.holds.flatMap((hold) => [
      db
        .prepare(
          "insert into legal_holds (artifact_id, transition, released_at) values (?, ?, ?) on conflict (artifact_id) do update set transition = excluded.transition, released_at = excluded.released_at",
        )
        .bind(hold.artifact_id, hold.transition, hold.released_at),
      db
        .prepare("update artifact_data set held = ? where artifact_id = ?")
        .bind(hold.released_at === null ? 1 : 0, hold.artifact_id),
    ]);
    for (const marker of file.tombstones) {
      statements.push(
        db
          .prepare("insert or ignore into tombstones (kind, ref) values (?, ?)")
          .bind(marker.kind, marker.ref),
      );
      if (marker.kind === "account")
        statements.push(
          db.prepare("delete from data_grants where user_id = ?").bind(marker.ref),
          db.prepare("delete from accounts where user_id = ?").bind(marker.ref),
        );
      else
        statements.push(
          db
            .prepare("update data_grants set revoked_at = coalesce(revoked_at, ?) where id = ?")
            .bind(Date.now(), marker.ref),
        );
    }
    if (statements.length > 0) await db.batch(statements);
  }

  /**
   * `data_reconcile`: every object the R2 inventory lists, against its D1 row, by the record's
   * field authority table. Returns the action taken per artifact.
   */
  async reconcileAll(): Promise<Record<string, string>> {
    const actions: Record<string, string> = {};
    const listed = await this.env.bucket.list({ prefix: INVENTORY });
    for (const object of listed.objects) {
      const artifactId = object.key.slice(INVENTORY.length);
      const stub = this.stub(artifactId);
      const control = await stub.controlRecord();
      const row = await this.row(artifactId);
      if (control === null) {
        actions[artifactId] = "none";
        continue;
      }
      if (row === null) {
        // Created after the restore point: no D1 row can vouch for it.
        await stub.quarantine(controlEnvelope(control), "owner");
        actions[artifactId] = "quarantine:no_row";
        continue;
      }
      const decision = reconcile(
        {
          ownerId: row.owner_id,
          generation: row.generation,
          epoch: row.epoch,
          held: row.held === 1,
        },
        control,
      );
      actions[artifactId] =
        decision.action === "quarantine" ? `quarantine:${decision.reason}` : decision.action;
      if (decision.action === "quarantine") {
        await stub.quarantine(controlEnvelope(control), decision.reason);
      } else if (decision.action === "raise") {
        await this.#setNumbers(artifactId, decision.generation, decision.epoch);
      } else if (decision.action === "resume_erase" && control.erasing !== null) {
        const envelope = { ...controlEnvelope(control), generation: control.erasing.generation };
        const committed = await stub.commitErase(envelope, control.erasing.id);
        if (!committed.ok) throw new Error(`resumed erase refused: ${committed.error}`);
        await this.#setNumbers(artifactId, control.erasing.generation + 1, decision.epoch);
      }
    }
    return actions;
  }

  async #setNumbers(artifactId: string, generation: number, epoch: number): Promise<void> {
    await this.env.db
      .prepare("update artifact_data set generation = ?, epoch = ? where artifact_id = ?")
      .bind(generation, epoch, artifactId)
      .run();
  }

  /**
   * The operator ends a quarantine: `adopt` after making D1 agree with the object's owner and
   * numbers (inserting the row an artifact created after the restore point lost), or `erase`.
   */
  async resolve(artifactId: string, decision: "adopt" | "erase"): Promise<{ ok: boolean }> {
    const stub = this.stub(artifactId);
    const control = await stub.controlRecord();
    if (control === null) return { ok: false };
    if (decision === "adopt") {
      await this.account(control.ownerId);
      await this.env.db
        .prepare(
          `insert into artifact_data (artifact_id, owner_id, generation, epoch, held) values (?, ?, ?, ?, ?)
           on conflict (artifact_id) do update set owner_id = excluded.owner_id,
             generation = excluded.generation, epoch = excluded.epoch, held = excluded.held`,
        )
        .bind(
          artifactId,
          control.ownerId,
          control.generation,
          control.epoch,
          control.hold === null ? 0 : 1,
        )
        .run();
    }
    const resolved = await stub.resolveQuarantine(controlEnvelope(control), decision);
    if (resolved.ok && decision === "erase")
      await this.#setNumbers(artifactId, control.generation + 1, control.epoch);
    return { ok: resolved.ok };
  }

  /** A fresh grant after the restore: the journal returns the person's ID, or refuses if retired. */
  async regrant(artifactId: string, userId: string): Promise<"granted" | "retired"> {
    try {
      await this.grant(artifactId, userId);
      return "granted";
    } catch (error) {
      if (error instanceof RetiredIdentity) return "retired";
      throw error;
    }
  }

  async visitorIdOf(artifactId: string, userId: string): Promise<string | null> {
    return (await this.#grantOf(artifactId, userId))?.visitor_id ?? null;
  }

  async probe(artifactId: string, ownerId: string, visitor: string): Promise<Probe> {
    const exported = await this.operatorExport(artifactId);
    const control = await this.stub(artifactId).controlRecord();
    return {
      ownerRead: await this.ownerRead(artifactId, ownerId),
      ownerWrite: await this.ownerWrite(artifactId, ownerId),
      visitorWrite: await this.visitorWrite(artifactId, visitor, { probe: true }),
      operatorExport: exported.access,
      documents: exported.documents,
      quarantined: (control?.quarantine ?? null) !== null,
    };
  }

  /** Deletes the drill's inventory and journal entries from the bucket. */
  async clearBucket(): Promise<number> {
    let removed = 0;
    for (const prefix of [INVENTORY, "system/data-authors/"]) {
      for (;;) {
        const listed = await this.env.bucket.list({ prefix });
        if (listed.objects.length === 0) break;
        await this.env.bucket.delete(listed.objects.map((object) => object.key));
        removed += listed.objects.length;
      }
    }
    return removed;
  }
}

export function controlEnvelope(control: Control): Envelope {
  return {
    artifactId: control.artifactId,
    region: control.region,
    ownerId: control.ownerId,
    generation: control.generation,
    epoch: control.epoch,
  };
}

/**
 * One scenario: what happens before the restore point (kept by D1), what happens after it (lost
 * by D1, kept by the object and R2), whether the transition's markers reach the export, and what
 * the record's recovery table says each party gets after reconciliation.
 */
export interface Scenario {
  name: string;
  /** The transition the record lists that this scenario puts after the restore point. */
  transition: string;
  before(drill: Drill, ids: ScenarioIds, state: ScenarioState): Promise<void>;
  after(drill: Drill, ids: ScenarioIds, state: ScenarioState): Promise<void>;
  /** Changes made after the export was taken (the restore window's own risk). */
  afterExport?(drill: Drill, ids: ScenarioIds, state: ScenarioState): Promise<void>;
  /** The reconciliation action the record's table predicts. */
  action: string;
  /** Whom the probe asks as owner (D1's owner after recovery). */
  probeOwner(ids: ScenarioIds): string;
  expected: Omit<Probe, "documents"> & { documents: number | "any" };
}

export interface ScenarioIds {
  artifact: string;
  owner: string;
  newOwner: string;
  visitor: string;
}

export interface ScenarioState {
  eraseId?: string;
  grantId?: string;
}

async function seeded(drill: Drill, ids: ScenarioIds): Promise<void> {
  await drill.createArtifact(ids.artifact, ids.owner);
  await drill.account(ids.visitor);
  await drill.grant(ids.artifact, ids.visitor);
  const wrote = await drill.visitorWrite(ids.artifact, ids.visitor, { text: "before" });
  if (wrote !== "ok") throw new Error(`seeding write refused: ${wrote}`);
}

const open = {
  ownerRead: "ok",
  ownerWrite: "ok",
  visitorWrite: "ok",
  operatorExport: "ok",
  quarantined: false,
} as const;

export const SCENARIOS: Scenario[] = [
  {
    name: "nothing after the restore point",
    transition: "none (control)",
    before: seeded,
    after: async () => {},
    action: "none",
    probeOwner: (ids) => ids.owner,
    expected: { ...open, documents: 1 },
  },
  {
    name: "hold after the restore point",
    transition: "hold",
    before: seeded,
    after: (drill, ids) => drill.hold(ids.artifact),
    action: "raise",
    probeOwner: (ids) => ids.owner,
    expected: {
      ownerRead: "held",
      ownerWrite: "held",
      visitorWrite: "held",
      operatorExport: "ok",
      quarantined: false,
      documents: 1,
    },
  },
  {
    name: "hold after the export (missing from it)",
    transition: "hold",
    before: seeded,
    after: async () => {},
    afterExport: (drill, ids) => drill.hold(ids.artifact),
    action: "quarantine:hold",
    probeOwner: (ids) => ids.owner,
    expected: {
      ownerRead: "quarantined",
      ownerWrite: "quarantined",
      visitorWrite: "quarantined",
      operatorExport: "ok",
      quarantined: true,
      documents: 1,
    },
  },
  {
    name: "release after the restore point",
    transition: "release",
    before: async (drill, ids) => {
      await seeded(drill, ids);
      await drill.hold(ids.artifact);
    },
    after: (drill, ids) => drill.release(ids.artifact),
    action: "raise",
    probeOwner: (ids) => ids.owner,
    expected: { ...open, documents: 1 },
  },
  {
    name: "hold and release both after the restore point",
    transition: "hold, release",
    before: seeded,
    after: async (drill, ids) => {
      await drill.hold(ids.artifact);
      await drill.release(ids.artifact);
    },
    action: "raise",
    probeOwner: (ids) => ids.owner,
    expected: { ...open, documents: 1 },
  },
  {
    name: "transfer after the restore point",
    transition: "transfer",
    before: seeded,
    after: (drill, ids) => drill.transfer(ids.artifact, ids.newOwner),
    action: "quarantine:owner",
    probeOwner: (ids) => ids.owner,
    expected: {
      ownerRead: "quarantined",
      ownerWrite: "quarantined",
      visitorWrite: "quarantined",
      operatorExport: "ok",
      quarantined: true,
      documents: 1,
    },
  },
  {
    name: "whole erase prepared after the restore point",
    transition: "erase prepared",
    before: seeded,
    after: async (drill, ids, state) => {
      state.eraseId = await drill.prepareErase(ids.artifact);
    },
    action: "resume_erase",
    probeOwner: (ids) => ids.owner,
    // The erase deletes the declarations with the documents: the collection is gone too.
    expected: {
      ownerRead: "not_found",
      ownerWrite: "not_found",
      visitorWrite: "not_found",
      operatorExport: "ok",
      quarantined: false,
      documents: 0,
    },
  },
  {
    name: "whole erase prepared and committed after the restore point",
    transition: "erase committed",
    before: seeded,
    after: async (drill, ids) => {
      await drill.commitErase(ids.artifact, await drill.prepareErase(ids.artifact));
    },
    action: "raise",
    probeOwner: (ids) => ids.owner,
    expected: {
      ownerRead: "not_found",
      ownerWrite: "not_found",
      visitorWrite: "not_found",
      operatorExport: "ok",
      quarantined: false,
      documents: 0,
    },
  },
  {
    name: "whole erase prepared before and committed after the restore point",
    transition: "erase committed",
    before: async (drill, ids, state) => {
      await seeded(drill, ids);
      state.eraseId = await drill.prepareErase(ids.artifact);
    },
    after: async (drill, ids, state) => {
      await drill.commitErase(ids.artifact, state.eraseId ?? "");
    },
    action: "raise",
    probeOwner: (ids) => ids.owner,
    expected: {
      ownerRead: "not_found",
      ownerWrite: "not_found",
      visitorWrite: "not_found",
      operatorExport: "ok",
      quarantined: false,
      documents: 0,
    },
  },
  {
    name: "author erasure after the restore point",
    transition: "author erasure",
    before: seeded,
    after: (drill, ids) => drill.deleteAccount(ids.visitor, ids.artifact),
    action: "none",
    probeOwner: (ids) => ids.owner,
    expected: { ...open, visitorWrite: "forbidden", documents: 0 },
  },
  {
    name: "grant after the restore point",
    transition: "grant",
    before: async (drill, ids) => {
      await drill.createArtifact(ids.artifact, ids.owner);
      await drill.account(ids.visitor);
    },
    after: async (drill, ids) => {
      await drill.grant(ids.artifact, ids.visitor);
      const wrote = await drill.visitorWrite(ids.artifact, ids.visitor, { text: "after" });
      if (wrote !== "ok") throw new Error(`write refused: ${wrote}`);
    },
    action: "none",
    probeOwner: (ids) => ids.owner,
    expected: { ...open, visitorWrite: "forbidden", documents: 1 },
  },
  {
    name: "revocation after the restore point",
    transition: "revocation",
    before: async (drill, ids, state) => {
      await drill.createArtifact(ids.artifact, ids.owner);
      await drill.account(ids.visitor);
      state.grantId = await drill.grant(ids.artifact, ids.visitor);
    },
    after: (drill, _ids, state) => drill.revoke(state.grantId ?? ""),
    action: "none",
    probeOwner: (ids) => ids.owner,
    expected: { ...open, visitorWrite: "forbidden", documents: "any" },
  },
  {
    name: "new artifact after the restore point",
    transition: "new artifact",
    before: async (drill, ids) => {
      await drill.account(ids.owner);
      await drill.account(ids.visitor);
    },
    after: async (drill, ids) => {
      await drill.createArtifact(ids.artifact, ids.owner);
      await drill.grant(ids.artifact, ids.visitor);
      await drill.visitorWrite(ids.artifact, ids.visitor, { text: "lost row" });
    },
    action: "quarantine:no_row",
    probeOwner: (ids) => ids.owner,
    expected: {
      ownerRead: "not_found",
      ownerWrite: "not_found",
      visitorWrite: "not_found",
      operatorExport: "ok",
      quarantined: true,
      documents: 1,
    },
  },
];

export interface ScenarioResult {
  name: string;
  transition: string;
  action: string;
  expectedAction: string;
  probe: Probe;
  expected: Scenario["expected"];
  pass: boolean;
}

/** Compares a probe with the record's prediction. */
export function matches(probe: Probe, expected: Scenario["expected"]): boolean {
  return (
    probe.ownerRead === expected.ownerRead &&
    probe.ownerWrite === expected.ownerWrite &&
    probe.visitorWrite === expected.visitorWrite &&
    probe.operatorExport === expected.operatorExport &&
    probe.quarantined === expected.quarantined &&
    (expected.documents === "any" || probe.documents === expected.documents)
  );
}

export function idsFor(index: number, run: string): ScenarioIds {
  return {
    artifact: `pfx${run}${index.toString().padStart(2, "0")}`,
    owner: `u_owner_${run}_${index}`,
    newOwner: `u_new_${run}_${index}`,
    visitor: `u_visitor_${run}_${index}`,
  };
}
