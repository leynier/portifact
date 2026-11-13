import { describe, expect, it } from "vitest";
import {
  AdmitMode,
  ARTIFACT_DATA,
  ArtifactDataLimits,
  AuditObligation,
  BulkCreate,
  BulkReplace,
  CHARGE_CLASSES,
  CollectionDeclaration,
  CollectionInfo,
  CollectionName,
  DATA_EXPORT_FORMAT,
  DATA_EXPORT_VERSION,
  DATA_REFUSAL_CODES,
  DataControl,
  DataCount,
  DataDescription,
  DataEnvelope,
  DataExportFooter,
  DataExportHeader,
  DataExportRow,
  DataFence,
  DataQuery,
  DataRefusalWire,
  DataRegion,
  DayCounters,
  DocumentId,
  ERASED_EDITOR,
  ERASURE_ACTOR,
  EraseChunkAnswer,
  EraseStepAnswer,
  ExportCursor,
  FieldName,
  JournalEntry,
  LIVE_CLOSE,
  MAX_ARTIFACT_BYTES,
  MAX_COLLECTIONS,
  MAX_DOCUMENT_BYTES,
  MAX_INDEXED_FIELDS,
  OperationId,
  OperationRecord,
  OWNER_AUTHOR,
  ReplayAnswer,
  SettleAnswer,
  StorageReport,
  StoredDocument,
  TransitionId,
  VisitorId,
} from "./artifact-data.ts";

const NOW = 1_794_830_400_000;
const envelope = {
  artifactId: "abcdefgh23",
  region: "default",
  ownerId: "u_1",
  generation: 0,
  epoch: 0,
};
const control = {
  artifactId: "abcdefgh23",
  region: "eu",
  ownerId: "ws_1",
  ownerEpoch: 0,
  generation: 1,
  epoch: 3,
  boundEpoch: 0,
  fencedEpoch: 3,
  hold: null,
  quarantine: null,
  erasing: null,
  lastErase: null,
  last: { id: "created", kind: "created", epoch: 0, fromOwner: null, toOwner: "ws_1", at: NOW },
  storageSeq: 4,
  payloadRevision: 2,
  liveEpoch: 1,
};

describe("artifact data contracts", () => {
  it("accepts envelopes with an issue-timed operation ID and refuses anything else", () => {
    expect(DataEnvelope.parse({ ...envelope, opId: `${NOW}.abcdefgh` })).toMatchObject({
      opId: `${NOW}.abcdefgh`,
    });
    for (const bad of [
      { ...envelope, artifactId: "ABC" },
      { ...envelope, region: "EU" },
      { ...envelope, ownerId: "" },
      { ...envelope, generation: -1 },
      { ...envelope, epoch: 1.5 },
      { ...envelope, opId: "123.abcdefgh" },
      { ...envelope, opId: `${NOW}.short` },
      { ...envelope, extra: true },
    ]) {
      expect(DataEnvelope.safeParse(bad).success).toBe(false);
    }
    expect(OperationId.safeParse(`${NOW}.${"a".repeat(64)}`).success).toBe(true);
    expect(OperationId.safeParse(`${NOW}.${"a".repeat(65)}`).success).toBe(false);
    expect(TransitionId.safeParse("t:1.a-b_c").success).toBe(true);
    expect(TransitionId.safeParse("t 1").success).toBe(false);
  });

  it("keeps fields a later version adds to stored records, and fails closed on fields it decides on", () => {
    const parsed = DataControl.parse({
      ...control,
      future: { kept: true },
      last: { ...control.last, note: 1 },
    });
    expect(parsed).toMatchObject({ future: { kept: true }, last: { note: 1 } });
    expect(
      DataControl.safeParse({ ...control, last: { ...control.last, kind: "teleport" } }).success,
    ).toBe(false);
    expect(
      DataControl.safeParse({ ...control, quarantine: { reason: "cosmic", at: NOW } }).success,
    ).toBe(false);
    expect(
      DataControl.safeParse({
        ...control,
        hold: { transition: "t", epoch: 1 },
        quarantine: { reason: "orphan", at: NOW },
        erasing: { id: `${NOW}.abcdefgh`, generation: 1, epoch: 3 },
        lastErase: { id: `${NOW}.abcdefgh`, outcome: "cancelled" },
      }).success,
    ).toBe(true);
    expect(DataControl.safeParse({ ...control, storageSeq: -1 }).success).toBe(false);
    expect(
      DayCounters.parse({
        day: 1,
        growth: 0,
        read: 0,
        cleanup: 0,
        export: 0,
        rights: 0,
        protected: 0,
        live: 0,
        refused: 0,
        intents: 0,
        later: 1,
      }),
    ).toMatchObject({ later: 1 });
    expect(StorageReport.safeParse({ generation: 0, seq: 0, bytes: -1 }).success).toBe(false);
  });

  it("parses each fence kind and nothing else", () => {
    expect(DataFence.parse({ kind: "transfer", transition: "t", toOwner: "ws_2" })).toEqual({
      kind: "transfer",
      transition: "t",
      toOwner: "ws_2",
    });
    for (const kind of ["hold", "release", "epoch"])
      expect(DataFence.safeParse({ kind, transition: "t" }).success).toBe(true);
    expect(DataFence.safeParse({ kind: "transfer", transition: "t" }).success).toBe(false);
    expect(DataFence.safeParse({ kind: "hold", transition: "t", toOwner: "x" }).success).toBe(
      false,
    );
    expect(DataFence.safeParse({ kind: "erase", transition: "t" }).success).toBe(false);
  });

  it("lets clients read refusal codes a later server adds", () => {
    expect(DataRefusalWire.parse({ code: "a_new_code", message: "m" }).code).toBe("a_new_code");
    expect(DataRefusalWire.safeParse({ code: "Bad", message: "m" }).success).toBe(false);
    expect(DATA_REFUSAL_CODES).toContain("held");
    expect(SettleAnswer.parse({ state: "refused", code: "later_code" })).toEqual({
      state: "refused",
      code: "later_code",
    });
    expect(
      SettleAnswer.parse({ state: "committed", kind: "data.x", detail: null, delivered: true }),
    ).toMatchObject({ delivered: true });
    expect(EraseStepAnswer.safeParse({ outcome: "superseded" }).success).toBe(true);
    expect(EraseStepAnswer.safeParse({ outcome: "done" }).success).toBe(false);
    expect(EraseChunkAnswer.parse({ documents: 1, edits: 0, more: false })).toEqual({
      documents: 1,
      edits: 0,
      more: false,
    });
    expect(
      ReplayAnswer.safeParse({ replayed: true, kind: "document", target: "items/x", result: null })
        .success,
    ).toBe(true);
    expect(
      ReplayAnswer.safeParse({ replayed: false, kind: "document", target: "", result: null })
        .success,
    ).toBe(false);
  });

  it("validates limits, declarations and queries at their bounds", () => {
    const limits = {
      bytesPerArtifact: 1,
      documentBytes: 1,
      documentsPerCollection: 1,
      collections: 1,
      indexedFields: 0,
      writesPerAuthorPerMinute: 1,
      deletesPerAuthorPerMinute: 1,
      readsPerCallerPerMinute: 1,
      rowsReadPerDay: 1,
      rowsWrittenPerDay: 1,
      cleanupRowsPerDay: 1,
      exportRowsPerDay: 1,
      rightsRowsPerDay: 1,
      liveMessagesPerDay: 0,
      connectionsPerArtifact: 0,
      connectionsPerAuthor: 0,
      connectsPerAuthorPerMinute: 0,
    };
    expect(ArtifactDataLimits.safeParse(limits).success).toBe(true);
    expect(ArtifactDataLimits.safeParse({ ...limits, rowsWrittenPerDay: 0 }).success).toBe(false);
    // Limits the platform cannot hold are refused whatever plan sends them.
    const largest = {
      ...limits,
      documentBytes: MAX_DOCUMENT_BYTES,
      bytesPerArtifact: MAX_ARTIFACT_BYTES,
    };
    expect(ArtifactDataLimits.safeParse(largest).success).toBe(true);
    expect(
      ArtifactDataLimits.safeParse({ ...largest, documentBytes: MAX_DOCUMENT_BYTES + 1 }).success,
    ).toBe(false);
    expect(
      ArtifactDataLimits.safeParse({ ...largest, bytesPerArtifact: MAX_ARTIFACT_BYTES + 1 })
        .success,
    ).toBe(false);
    expect(MAX_ARTIFACT_BYTES + ARTIFACT_DATA.controlReserveBytes).toBeLessThan(10_000_000_000);
    expect(
      CollectionDeclaration.safeParse({
        name: "votes_1",
        mode: "own",
        uniqueKey: "slot",
        indexed: ["a"],
      }).success,
    ).toBe(true);
    for (const bad of [
      { name: "Votes", mode: "own" },
      { name: "v", mode: "private" },
      { name: "v", mode: "own", uniqueKey: "_id" },
      { name: "v".repeat(33), mode: "own" },
    ]) {
      expect(CollectionDeclaration.safeParse(bad).success).toBe(false);
    }
    expect(
      DataQuery.safeParse({
        collection: "c",
        equals: { field: "_by", value: "v" },
        created: { op: "gte", value: 0 },
        order: "-created",
        limit: 100,
      }).success,
    ).toBe(true);
    expect(DataQuery.safeParse({ collection: "c", limit: 101 }).success).toBe(false);
    expect(
      DataQuery.safeParse({ collection: "c", equals: { field: "_seq", value: 1 } }).success,
    ).toBe(false);
    expect(
      DataQuery.safeParse({ collection: "c", equals: { field: "n", value: Number.NaN } }).success,
    ).toBe(false);
    expect(DataQuery.safeParse({ collection: "c", order: "updated" }).success).toBe(false);
    expect(
      CollectionInfo.safeParse({
        name: "c",
        mode: "append",
        uniqueKey: null,
        indexed: [{ field: "n", state: "building" }],
        documents: 0,
        bytes: 0,
      }).success,
    ).toBe(true);
  });

  it("shapes documents, records and obligations without bodies", () => {
    expect(DocumentId.safeParse("AAAAAAAAAAAAAAA_").success).toBe(true);
    expect(DocumentId.safeParse("A+AAAAAAAAAAAAAA").success).toBe(false);
    expect(
      StoredDocument.parse({
        _id: "AAAAAAAAAAAAAAAA",
        _by: "owner",
        _editedBy: null,
        _created: 1,
        _updated: 1,
        _seq: 0,
        n: 1,
      }),
    ).toMatchObject({ n: 1 });
    expect(
      OperationRecord.safeParse({
        key: "a|0|b",
        actor: "a",
        requestHash: "",
        state: "aborted",
        kind: "aborted",
        target: "",
        result: null,
        at: 1,
      }).success,
    ).toBe(true);
    expect(
      OperationRecord.safeParse({
        key: "a|0|b",
        actor: "a",
        requestHash: "f".repeat(63),
        state: "committed",
        kind: "k",
        target: "",
        result: null,
        at: 1,
      }).success,
    ).toBe(false);
    expect(
      OperationRecord.safeParse({
        key: "a|0|b",
        actor: "a",
        requestHash: "f".repeat(64),
        state: "committed",
        kind: "k",
        target: "",
        result: { removed: 2 },
        at: 1,
      }).success,
    ).toBe(true);
    expect(
      OperationRecord.safeParse({
        key: "a|0|b",
        actor: "a",
        requestHash: "",
        state: "committed",
        kind: "k",
        target: "",
        result: { body: "text" },
        at: 1,
      }).success,
    ).toBe(false);
    expect(
      AuditObligation.safeParse({
        key: "k",
        kind: "data.document_created",
        detail: { bytes: 3 },
        owner: "u",
        state: "pending",
        at: 1,
      }).success,
    ).toBe(true);
    expect(
      AuditObligation.safeParse({
        key: "k",
        kind: "data.document_created",
        detail: { text: "secret" },
        owner: "u",
        state: "pending",
        at: 1,
      }).success,
    ).toBe(false);
    expect(
      AuditObligation.safeParse({
        key: "k",
        kind: "document_created",
        detail: {},
        owner: "u",
        state: "pending",
        at: 1,
      }).success,
    ).toBe(false);
  });

  it("names visitors apart from the owner side and the erased marker, and journals retirements", () => {
    expect(VisitorId.safeParse("v_AAAAAAAAAAAAAAAA").success).toBe(true);
    for (const bad of ["owner", "erased", "v_short", "x_AAAAAAAAAAAAAAAA"])
      expect(VisitorId.safeParse(bad).success).toBe(false);
    expect(JournalEntry.safeParse({ visitorId: null, firstGrantAt: 1, retiredAt: 1 }).success).toBe(
      true,
    );
    expect(
      JournalEntry.safeParse({ visitorId: "v_AAAAAAAAAAAAAAAA", firstGrantAt: 1 }).success,
    ).toBe(true);
  });

  it("describes the export file's lines, version 1", () => {
    expect([DATA_EXPORT_FORMAT, DATA_EXPORT_VERSION]).toEqual(["portifact-data", 1]);
    const header = {
      format: "portifact-data",
      version: 1,
      artifact: "abcdefgh23",
      generation: 0,
      revision: 0,
      collections: [{ name: "c", mode: "own", uniqueKey: null, indexed: [] }],
    };
    expect(DataExportHeader.safeParse(header).success).toBe(true);
    expect(DataExportHeader.safeParse({ ...header, format: "other" }).success).toBe(false);
    expect(
      DataExportRow.safeParse({
        collection: "c",
        id: "AAAAAAAAAAAAAAAA",
        by: "v",
        editedBy: null,
        created: 1,
        updated: 1,
        body: { n: 1 },
      }).success,
    ).toBe(true);
    expect(
      DataExportRow.safeParse({
        collection: "c",
        id: "AAAAAAAAAAAAAAAA",
        by: "v",
        editedBy: null,
        created: 1,
        updated: 1,
        body: [1],
      }).success,
    ).toBe(false);
    expect(
      DataExportFooter.safeParse({ footer: true, revision: 0, consistent: true, documents: 0 })
        .success,
    ).toBe(true);
    expect(ExportCursor.safeParse({ collection: "c", id: "AAAAAAAAAAAAAAAA" }).success).toBe(true);
  });

  it("keeps the protocol's constants consistent with each other", () => {
    expect(ARTIFACT_DATA.horizonMs + ARTIFACT_DATA.clockSkewMs).toBeLessThan(
      ARTIFACT_DATA.replayMs,
    );
    expect(ARTIFACT_DATA.journalRetiredMs).toBeGreaterThan(30 * 86_400_000 + 60_000);
    expect(ARTIFACT_DATA.caps).toEqual({
      pageDocuments: 100,
      bulkDocuments: 100,
      indexStepDocuments: 500,
      eraseChunkDocuments: 500,
      exportRows: 500,
      exportBytes: 1_048_576,
      pruneRows: 500,
    });
    expect(new Set(Object.values(LIVE_CLOSE)).size).toBe(Object.keys(LIVE_CLOSE).length);
  });

  it("anchors every pattern at both ends and names what failed", () => {
    const cases: [
      {
        safeParse: (value: unknown) => {
          success: boolean;
          error?: { issues: { message: string }[] };
        };
      },
      string,
      string[],
      string,
    ][] = [
      [DataRegion, "eu", ["Xeu", "eu!", "-eu"], "Invalid region"],
      [
        OperationId,
        `${NOW}.abcdefgh`,
        [`x${NOW}.abcdefgh`, `${NOW}.abcdefgh!`],
        "Invalid operation id",
      ],
      [TransitionId, "t1", ["", "t 1"], "Invalid transition id"],
      [
        VisitorId,
        "v_AAAAAAAAAAAAAAAA",
        ["xv_AAAAAAAAAAAAAAAA", "v_AAAAAAAAAAAAAAAA!"],
        "Invalid visitor id",
      ],
      [CollectionName, "c", ["C", "c!"], "Invalid collection"],
      [FieldName, "f", ["1f", "f!"], "Invalid field"],
      [
        DocumentId,
        "AAAAAAAAAAAAAAAA",
        ["!AAAAAAAAAAAAAAAA", "AAAAAAAAAAAAAAAA!"],
        "Invalid document id",
      ],
    ];
    for (const [schema, good, bad, message] of cases) {
      expect(schema.safeParse(good).success, good).toBe(true);
      for (const value of bad) {
        const result = schema.safeParse(value);
        expect(result.success, value).toBe(false);
        expect(result.error?.issues[0]?.message).toBe(message);
      }
    }
    expect(DataRefusalWire.safeParse({ code: "a!", message: "m" }).success).toBe(false);
    expect(
      AuditObligation.safeParse({
        key: "k",
        kind: "xdata.a",
        detail: {},
        owner: "u",
        state: "pending",
        at: 1,
      }).success,
    ).toBe(false);
    expect(
      AuditObligation.safeParse({
        key: "k",
        kind: "data.a!",
        detail: {},
        owner: "u",
        state: "pending",
        at: 1,
      }).success,
    ).toBe(false);
  });

  it("names the special authors and actors", () => {
    expect([OWNER_AUTHOR, ERASED_EDITOR, ERASURE_ACTOR]).toEqual([
      "owner",
      "erased",
      "system:erasure",
    ]);
  });

  it("requires every field of every stored and answered shape", () => {
    const required: [
      { safeParse: (value: unknown) => { success: boolean } },
      Record<string, unknown>,
    ][] = [
      [DataControl, control],
      [
        DayCounters,
        {
          day: 1,
          growth: 0,
          read: 0,
          cleanup: 0,
          export: 0,
          rights: 0,
          protected: 0,
          live: 0,
          refused: 0,
          intents: 0,
        },
      ],
      [
        CollectionInfo,
        { name: "c", mode: "append", uniqueKey: null, indexed: [], documents: 0, bytes: 0 },
      ],
      [
        StoredDocument,
        { _id: "AAAAAAAAAAAAAAAA", _by: "v", _editedBy: null, _created: 1, _updated: 1, _seq: 0 },
      ],
      [EraseChunkAnswer, { documents: 1, edits: 0, more: false }],
      [JournalEntry, { visitorId: null, firstGrantAt: 1 }],
      [DataExportFooter, { footer: true, revision: 0, consistent: true, documents: 0 }],
      [
        DataExportHeader,
        {
          format: "portifact-data",
          version: 1,
          artifact: "abcdefgh23",
          generation: 0,
          revision: 0,
          collections: [{ name: "c", mode: "own", uniqueKey: null, indexed: [] }],
        },
      ],
    ];
    for (const [schema, whole] of required) {
      expect(schema.safeParse(whole).success).toBe(true);
      for (const key of Object.keys(whole)) {
        const { [key]: _dropped, ...rest } = whole;
        expect(schema.safeParse(rest).success, key).toBe(false);
      }
    }
    for (const [field, value] of [
      ["hold", { transition: "t" }],
      ["erasing", { id: `${NOW}.abcdefgh`, generation: 1 }],
      ["lastErase", { id: `${NOW}.abcdefgh` }],
    ] as const) {
      expect(DataControl.safeParse({ ...control, [field]: value }).success, field).toBe(false);
    }
    expect(
      CollectionInfo.safeParse({
        name: "c",
        mode: "append",
        uniqueKey: null,
        indexed: [{ field: "n" }],
        documents: 0,
        bytes: 0,
      }).success,
    ).toBe(false);
    const header = {
      format: "portifact-data",
      version: 1,
      artifact: "abcdefgh23",
      generation: 0,
      revision: 0,
      collections: [{ name: "c", mode: "own", uniqueKey: null }],
    };
    expect(DataExportHeader.safeParse(header).success).toBe(false);
  });

  it("accepts every value of every enum and refuses empty strings where a name is required", () => {
    for (const kind of ["request", "operator", "erase", "maintenance"]) {
      expect(
        AdmitMode.safeParse(kind === "request" ? { kind, create: true } : { kind }).success,
        kind,
      ).toBe(true);
    }
    for (const state of ["building", "ready"])
      expect(
        CollectionInfo.safeParse({
          name: "c",
          mode: "own",
          uniqueKey: null,
          indexed: [{ field: "n", state }],
          documents: 0,
          bytes: 0,
        }).success,
      ).toBe(true);
    for (const op of ["gt", "gte", "lt", "lte"])
      expect(DataQuery.safeParse({ collection: "c", created: { op, value: 1 } }).success, op).toBe(
        true,
      );
    for (const order of ["created", "-created"])
      expect(DataQuery.safeParse({ collection: "c", order }).success).toBe(true);
    expect(DataQuery.safeParse({ collection: "c", after: "" }).success).toBe(false);
    expect(DataQuery.safeParse({ collection: "c", after: "x".repeat(512) }).success).toBe(true);
    expect(DataQuery.safeParse({ collection: "c", after: "x".repeat(513) }).success).toBe(false);
    for (const outcome of ["prepared", "committed", "cancelled", "superseded"])
      expect(EraseStepAnswer.safeParse({ outcome }).success).toBe(true);
    for (const state of ["pending", "delivered"])
      expect(
        AuditObligation.safeParse({
          key: "k",
          kind: "data.a",
          detail: { flag: true },
          owner: "u",
          state,
          at: 1,
        }).success,
      ).toBe(true);
    expect(
      AuditObligation.safeParse({
        key: "",
        kind: "data.a",
        detail: {},
        owner: "u",
        state: "pending",
        at: 1,
      }).success,
    ).toBe(false);
    expect(SettleAnswer.safeParse({ state: "aborted" }).success).toBe(true);
    expect(
      SettleAnswer.safeParse({
        state: "committed",
        kind: "data.x",
        detail: { n: 1, flag: false },
        delivered: false,
      }).success,
    ).toBe(true);
    const doc = {
      _id: "AAAAAAAAAAAAAAAA",
      _by: "v",
      _editedBy: "w",
      _created: 1,
      _updated: 1,
      _seq: 0,
    };
    expect(StoredDocument.safeParse(doc).success).toBe(true);
    expect(StoredDocument.safeParse({ ...doc, _editedBy: "" }).success).toBe(false);
    const record = {
      key: "a|0|b",
      actor: "",
      requestHash: "",
      state: "aborted",
      kind: "aborted",
      target: "",
      result: null,
      at: 1,
    };
    expect(OperationRecord.safeParse(record).success).toBe(false);
    expect(OperationRecord.safeParse({ ...record, actor: "ab", key: "" }).success).toBe(false);
    expect(OperationRecord.safeParse({ ...record, actor: "ab", key: "ab" }).success).toBe(true);
    const row = {
      collection: "c",
      id: "AAAAAAAAAAAAAAAA",
      by: "vv",
      editedBy: "ww",
      created: 1,
      updated: 1,
      body: {},
    };
    expect(DataExportRow.safeParse(row).success).toBe(true);
    expect(DataExportRow.safeParse({ ...row, by: "" }).success).toBe(false);
    expect(DataExportRow.safeParse({ ...row, editedBy: "" }).success).toBe(false);
  });

  it("pins the absolute caps every per-operation bound derives from, and the new owner shapes", () => {
    expect([MAX_INDEXED_FIELDS, MAX_COLLECTIONS]).toEqual([8, 32]);
    expect(DataControl.safeParse({ ...control, fencedEpoch: null }).success).toBe(true);
    expect(DataControl.safeParse({ ...control, fencedEpoch: -1 }).success).toBe(false);
    const limits = ArtifactDataLimits.shape;
    expect(limits.indexedFields.safeParse(MAX_INDEXED_FIELDS).success).toBe(true);
    expect(limits.indexedFields.safeParse(MAX_INDEXED_FIELDS + 1).success).toBe(false);
    expect(limits.collections.safeParse(MAX_COLLECTIONS + 1).success).toBe(false);
    const indexed = Array.from({ length: MAX_INDEXED_FIELDS + 1 }, (_, i) => `f${i}`);
    expect(
      CollectionDeclaration.safeParse({ name: "c", mode: "own", indexed: indexed.slice(1) })
        .success,
    ).toBe(true);
    expect(CollectionDeclaration.safeParse({ name: "c", mode: "own", indexed }).success).toBe(
      false,
    );
    expect(CHARGE_CLASSES).toContain("protected");
    expect(ARTIFACT_DATA.readFlush).toEqual({ rows: 10_000, refusals: 1_000, ms: 30_000 });
    expect([ARTIFACT_DATA.alarmBatchMs, ARTIFACT_DATA.erase.intentsPerDay]).toEqual([
      3_600_000, 20,
    ]);
    const many = Array.from({ length: 101 }, () => ({ n: 1 }));
    expect(BulkCreate.safeParse({ collection: "c", documents: many.slice(1) }).success).toBe(true);
    expect(BulkCreate.safeParse({ collection: "c", documents: many }).success).toBe(false);
    expect(BulkCreate.safeParse({ collection: "c", documents: [] }).success).toBe(false);
    expect(
      BulkReplace.safeParse({ collection: "c", documents: [{ id: "AAAAAAAAAAAAAAAA", body: {} }] })
        .success,
    ).toBe(true);
    expect(
      BulkReplace.safeParse({ collection: "c", documents: [{ id: "bad", body: {} }] }).success,
    ).toBe(false);
    expect(
      DataCount.safeParse({ collection: "c", equals: { field: "f", value: true } }).success,
    ).toBe(true);
    expect(DataCount.safeParse({ collection: "c", by: "" }).success).toBe(false);
    const today = {
      day: 1,
      growth: 0,
      read: 0,
      cleanup: 0,
      export: 0,
      rights: 0,
      protected: 0,
      live: 0,
      refused: 0,
      intents: 0,
    };
    expect(
      DataDescription.safeParse({ generation: 0, revision: 0, collections: [], today }).success,
    ).toBe(true);
    expect(
      DataDescription.safeParse({ generation: 0, revision: 0, collections: [], today: {} }).success,
    ).toBe(false);
  });
});
