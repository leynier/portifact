// Index builds in bounded steps (decision 0026, "Index builds are incremental"). Declaring an
// indexed field records it as building; each step adds the values of the next
// `indexStepDocuments` documents of its collection in primary key order; writes keep values for
// every declared field meanwhile, built or not; queries on a field are refused until it is ready.
// No step touches more than one step's documents, however many the collection holds.
import { ARTIFACT_DATA } from "@portifact/contracts/artifact-data";

export interface IndexField {
  collection: string;
  field: string;
  state: "building" | "ready";
  /** The last document ID a step covered, or null before the first step. */
  cursor: string | null;
}

/** The field the next step builds: the first building one by collection, then field. */
export function nextBuild(fields: readonly IndexField[]): IndexField | null {
  let next: IndexField | null = null;
  for (const field of fields) {
    if (field.state !== "building") continue;
    if (
      next === null ||
      field.collection < next.collection ||
      (field.collection === next.collection && field.field < next.field)
    ) {
      next = field;
    }
  }
  return next;
}

/**
 * The field after one step over `covered`, the IDs (in primary key order, after the cursor) whose
 * values this step added. A step that covered fewer than the cap reached the end: the field is
 * ready. Otherwise the cursor moves to the last ID covered.
 */
export function afterStep(field: IndexField, covered: readonly string[]): IndexField {
  const last = covered.at(-1);
  if (covered.length < ARTIFACT_DATA.caps.indexStepDocuments || last === undefined) {
    return { ...field, state: "ready" };
  }
  return { ...field, cursor: last };
}

/** The fields of a collection a query may filter on. */
export function readyFields(fields: readonly IndexField[], collection: string): string[] {
  return fields
    .filter((field) => field.collection === collection && field.state === "ready")
    .map((field) => field.field);
}

/** Every declared field of a collection, built or building: what a write keeps values for. */
export function declaredFields(fields: readonly IndexField[], collection: string): string[] {
  return fields.filter((field) => field.collection === collection).map((field) => field.field);
}
