// The owner document API of artifact data (decision 0026, delivery 5): the plan's per-artifact
// limits, and the shapes the API, the MCP tools, the CLI and the dashboard share. The object's own
// shapes are `./artifact-data.ts`; these wrap them for an artifact named by its ID.
import { z } from "zod";
import {
  ARTIFACT_DATA,
  type ArtifactDataLimits,
  BulkCreate,
  BulkReplace,
  CollectionDeclaration,
  CollectionInfo,
  CollectionMode,
  CollectionName,
  DataCount,
  DataQuery,
  DayCounters,
  DocumentId,
  ExportCursor,
  FieldName,
  MAX_COLLECTIONS,
  StoredDocument,
} from "./artifact-data.ts";
import { ArtifactId } from "./core.ts";
import type { PlanName } from "./plans.ts";

/** One plan's artifact data: how many artifacts may hold data, and the limits each carries. */
export interface ArtifactDataPlan {
  /** Artifacts of one owner that may hold data (an `artifact_data` row each). */
  dataArtifacts: number;
  limits: ArtifactDataLimits;
}

const FREE_DATA: ArtifactDataLimits = {
  bytesPerArtifact: 5_000_000,
  documentBytes: 16 * 1024,
  documentsPerCollection: 1_000,
  collections: 10,
  indexedFields: 3,
  writesPerAuthorPerMinute: 30,
  deletesPerAuthorPerMinute: 60,
  readsPerCallerPerMinute: 300,
  rowsReadPerDay: 500_000,
  rowsWrittenPerDay: 5_000,
  cleanupRowsPerDay: 5_000,
  exportRowsPerDay: 200_000,
  rightsRowsPerDay: 500,
  liveMessagesPerDay: 2_000,
  connectionsPerArtifact: 10,
  connectionsPerAuthor: 4,
  connectsPerAuthorPerMinute: 6,
};

const TEAM_DATA: ArtifactDataLimits = {
  ...FREE_DATA,
  bytesPerArtifact: 50_000_000,
  documentBytes: 64 * 1024,
  documentsPerCollection: 100_000,
  collections: 32,
  indexedFields: 8,
  rowsReadPerDay: 1_000_000,
  rowsWrittenPerDay: 2_000,
  cleanupRowsPerDay: 2_000,
  exportRowsPerDay: 80_000,
  liveMessagesPerDay: 10_000,
  connectionsPerArtifact: 25,
};

/**
 * The per-plan numbers, option B of decision 0026 ("What the limits imply", the smallest
 * exposure), provisional: delivery 8 fixes them from staging's measurements ("The plan limits
 * (open)"). Every plan has artifact data; only the numbers differ. Team and Enterprise are per
 * workspace, not per seat. Every value stays within the platform's caps (`ArtifactDataLimits`).
 */
export const ARTIFACT_DATA_PLANS: Readonly<Record<PlanName, ArtifactDataPlan>> = {
  free: { dataArtifacts: 1, limits: FREE_DATA },
  pro: {
    dataArtifacts: 10,
    limits: {
      ...FREE_DATA,
      bytesPerArtifact: 25_000_000,
      documentBytes: 64 * 1024,
      documentsPerCollection: 25_000,
      collections: 20,
      indexedFields: 5,
      rowsWrittenPerDay: 2_000,
      cleanupRowsPerDay: 2_000,
      exportRowsPerDay: 80_000,
      liveMessagesPerDay: 5_000,
    },
  },
  team: { dataArtifacts: 50, limits: TEAM_DATA },
  enterprise: { dataArtifacts: 50, limits: TEAM_DATA },
};

/** `POST /api/v1/artifacts/:id/data/collections`: declares a collection or adds indexed fields. */
export const DataCollectionDeclare = CollectionDeclaration;
export type DataCollectionDeclare = z.infer<typeof DataCollectionDeclare>;

/** What a declaration answers: the collection as declared, and how many fields still build. */
export const DataCollectionView = z.object({
  collection: CollectionInfo,
  building: z.number().int().min(0),
});
export type DataCollectionView = z.infer<typeof DataCollectionView>;

/** `GET /api/v1/artifacts/:id/data`: the artifact's collections and today's counters. */
export const DataDescriptionView = z.object({
  artifactId: ArtifactId,
  /** False when no durable write ever bound the artifact's data: nothing has been stored. */
  exists: z.boolean(),
  generation: z.number().int().min(0),
  revision: z.number().int().min(0),
  collections: z.array(CollectionInfo).max(MAX_COLLECTIONS),
  today: DayCounters,
  /** The plan's per-artifact limits the counters are measured against. */
  limits: z.object({
    bytesPerArtifact: z.number().int(),
    documentBytes: z.number().int(),
    documentsPerCollection: z.number().int(),
    collections: z.number().int(),
    indexedFields: z.number().int(),
    rowsReadPerDay: z.number().int(),
    rowsWrittenPerDay: z.number().int(),
    cleanupRowsPerDay: z.number().int(),
    exportRowsPerDay: z.number().int(),
  }),
  /** The bytes the object last reported (documents and control records). */
  storedBytes: z.number().int().min(0),
});
export type DataDescriptionView = z.infer<typeof DataDescriptionView>;

/** A document as the owner side reads it: its body's fields and the server fields. */
export const DataDocumentView = StoredDocument;
export type DataDocumentView = z.infer<typeof DataDocumentView>;

/** A document body: a JSON object. */
export const DataDocumentBody = z.record(z.string(), z.unknown());
export type DataDocumentBody = z.infer<typeof DataDocumentBody>;

/** A page of a query: up to `caps.pageDocuments` documents and the cursor of the next page. */
export const DataQueryPage = z.object({
  documents: z.array(DataDocumentView).max(ARTIFACT_DATA.caps.pageDocuments),
  next: z.string().nullable(),
});
export type DataQueryPage = z.infer<typeof DataQueryPage>;

/** `GET /api/v1/artifacts/:id/data/collections/:collection/documents` as query parameters. */
export const DataQueryParams = z.strictObject({
  equalsField: z.union([z.literal("_by"), FieldName]).optional(),
  equalsValue: z.string().max(1024).optional(),
  createdOp: z.enum(["gt", "gte", "lt", "lte"]).optional(),
  createdValue: z.coerce.number().int().min(0).optional(),
  order: z.enum(["created", "-created"]).optional(),
  limit: z.coerce.number().int().min(1).max(ARTIFACT_DATA.caps.pageDocuments).optional(),
  after: z.string().min(1).max(512).optional(),
});
export type DataQueryParams = z.infer<typeof DataQueryParams>;

/** A query value from a query string: a number or a boolean when it reads as one. */
export function queryValue(text: string): string | number | boolean {
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?(0|[1-9][0-9]{0,14})(\.[0-9]{1,6})?$/.test(text)) return Number(text);
  return text;
}

/** Builds the object's query from a collection and the query string's parameters. */
export function dataQueryOf(collection: string, params: DataQueryParams): DataQuery {
  return DataQuery.parse({
    collection,
    ...(params.equalsField !== undefined
      ? { equals: { field: params.equalsField, value: queryValue(params.equalsValue ?? "") } }
      : {}),
    ...(params.createdOp !== undefined
      ? { created: { op: params.createdOp, value: params.createdValue ?? 0 } }
      : {}),
    ...(params.order !== undefined ? { order: params.order } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.after !== undefined ? { after: params.after } : {}),
  });
}

/** `POST .../documents/bulk-delete`: up to `caps.bulkDocuments` distinct IDs, all or nothing. */
export const DataBulkRemove = z.strictObject({
  ids: z
    .array(DocumentId)
    .min(1)
    .max(ARTIFACT_DATA.caps.bulkDocuments)
    .refine((ids) => new Set(ids).size === ids.length, "Repeated document ID"),
});
export type DataBulkRemove = z.infer<typeof DataBulkRemove>;

/** `POST .../documents/bulk`: up to `caps.bulkDocuments` bodies, all or nothing. */
export const DataBulkCreate = BulkCreate.omit({ collection: true });
export type DataBulkCreate = z.infer<typeof DataBulkCreate>;

/** `PUT .../documents/bulk`: up to `caps.bulkDocuments` distinct IDs with their new bodies. */
export const DataBulkReplace = BulkReplace.omit({ collection: true }).refine(
  (input) => new Set(input.documents.map((item) => item.id)).size === input.documents.length,
  "Repeated document ID",
);
export type DataBulkReplace = z.infer<typeof DataBulkReplace>;

export const DataBulkCreated = z.object({ ids: z.array(DocumentId) });
export const DataBulkReplaced = z.object({ replaced: z.number().int().min(0) });
export const DataBulkRemoved = z.object({ removed: z.number().int().min(0) });
export const DataDocumentRemoved = z.object({ id: DocumentId });

/** `GET .../data/count`: a collection's count, one author's, or one built indexed value's. */
export const DataCountParams = z.strictObject({
  collection: CollectionName,
  by: z.string().min(1).max(80).optional(),
  equalsField: FieldName.optional(),
  equalsValue: z.string().max(1024).optional(),
});
export type DataCountParams = z.infer<typeof DataCountParams>;

export function dataCountOf(params: DataCountParams): DataCount {
  return DataCount.parse({
    collection: params.collection,
    ...(params.by !== undefined ? { by: params.by } : {}),
    ...(params.equalsField !== undefined
      ? { equals: { field: params.equalsField, value: queryValue(params.equalsValue ?? "") } }
      : {}),
  });
}

export const DataCountView = z.object({ documents: z.number().int().min(0) });
export type DataCountView = z.infer<typeof DataCountView>;

/** One exported document: the server fields and the body's stored JSON text, unparsed. */
export const DataExportDocument = z.object({
  collection: CollectionName,
  id: DocumentId,
  by: z.string().min(1),
  editedBy: z.string().min(1).nullable(),
  created: z.number().int().min(0),
  updated: z.number().int().min(0),
  /** The body exactly as stored, as JSON text: the file splices it in unchanged. */
  body: z.string(),
});
export type DataExportDocument = z.infer<typeof DataExportDocument>;

/**
 * `GET /api/v1/artifacts/:id/data/export`: one page in primary key order. The first page (no
 * cursor) also carries what the file's header needs: the generation and every collection.
 */
export const DataExportPageView = z.object({
  artifactId: ArtifactId,
  revision: z.number().int().min(0),
  rows: z.array(DataExportDocument).max(ARTIFACT_DATA.caps.exportRows),
  /** The cursor of the next page, as `collection/id`, or null on the last page. */
  next: z.string().nullable(),
  header: z
    .object({
      generation: z.number().int().min(0),
      /** The revision the description of the collections saw: the file's header revision. */
      revision: z.number().int().min(0),
      collections: z.array(
        z.object({
          name: CollectionName,
          mode: CollectionMode,
          uniqueKey: FieldName.nullable(),
          indexed: z.array(FieldName),
        }),
      ),
    })
    .nullable(),
});
export type DataExportPageView = z.infer<typeof DataExportPageView>;

/** An export cursor as a query parameter: `collection/id`. */
export function exportCursorText(cursor: ExportCursor | null): string | null {
  return cursor === null ? null : `${cursor.collection}/${cursor.id}`;
}

export function parseExportCursor(text: string | undefined): ExportCursor | null | undefined {
  if (text === undefined || text === "") return null;
  const [collection, id, ...rest] = text.split("/");
  const parsed = ExportCursor.safeParse({ collection, id });
  return rest.length === 0 && parsed.success ? parsed.data : undefined;
}

// MCP tool inputs: the API's inputs with the artifact named.

const OnArtifact = { artifactId: ArtifactId };
const OnCollection = { ...OnArtifact, collection: CollectionName };

export const DescribeDataInput = z.object(OnArtifact);
export const DeclareDataCollectionInput = z.object({ ...OnArtifact, ...CollectionDeclaration.shape });
export const GetDataDocumentInput = z.object({ ...OnCollection, id: DocumentId });
export const QueryDataInput = z.object({ ...OnCollection, ...DataQueryParams.shape });
export const CountDataInput = z.object({ ...OnArtifact, ...DataCountParams.shape });
export const CreateDataDocumentInput = z.object({ ...OnCollection, body: DataDocumentBody });
export const ReplaceDataDocumentInput = z.object({
  ...OnCollection,
  id: DocumentId,
  body: DataDocumentBody,
});
export const DeleteDataDocumentInput = z.object({
  ...OnCollection,
  id: DocumentId,
  confirm: z.literal(true),
});
export const CreateDataDocumentsInput = z.object({ ...OnCollection, ...DataBulkCreate.shape });
export const ReplaceDataDocumentsInput = z.object({
  ...OnCollection,
  documents: BulkReplace.shape.documents,
});
export const DeleteDataDocumentsInput = z.object({
  ...OnCollection,
  ids: DataBulkRemove.shape.ids,
  confirm: z.literal(true),
});
export const ExportDataInput = z.object({
  ...OnArtifact,
  after: z.string().min(1).max(80).optional(),
});
