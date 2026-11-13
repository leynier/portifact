// The text of a page for "Suggest a text change" (decision 0027, "Suggesting", "Keyboard, screen
// readers and touch"): for people who cannot select text in the frame, the viewer searches the
// page's text instead and builds the same text target a selection gives. Whoever may suggest on
// the artifact gets it (the authorization of submitting a suggestion, `participate`), a person
// only; anyone else gets what a missing artifact gives, and a held or suspended artifact is
// refused like any comment write. It is the text the served page shows, as the anchors read it
// (`servedPageText`): never the file, its markup, attributes, comments or hidden text, which a
// reader of a site never gets. The page is read within the planning limits (its stored size
// checked before any byte is read) and every request counts in the planning windows.
import type { PageText } from "@portifact/contracts";
import type { RegionalDb } from "@portifact/db";
import { fail, ok, type Result } from "@portifact/domain";
import { newWork, servedPageText } from "@portifact/domain/suggestions";
import { type AnnotationActor, annotationParts } from "./annotations.ts";
import { admitPlanning, readStoredPage, storedFiles } from "./suggestion-plans.ts";
import { checkEditablePage } from "./suggestions.ts";

/** The text of the page at `path` of the artifact's current version, for one who may suggest. */
export async function suggestionPageText(
  db: RegionalDb,
  bucket: R2Bucket,
  input: AnnotationActor & { path: string; contentDomain: string },
): Promise<Result<PageText>> {
  const loaded = await annotationParts.authorize(db, input, "participate");
  if (!loaded.ok) return loaded;
  const { artifact } = loaded.value;
  const versionId = artifact.currentVersionId;
  if (versionId === null) return fail("not_found", "Artifact not found.");
  const admitted = await admitPlanning(db, input.userId, artifact.id, input.now);
  if (!admitted.ok) return admitted;
  // Only a page a suggestion can be made on: a document's original or an HTML page.
  const page = await checkEditablePage(db, artifact.type, versionId, input.path);
  if (!page.ok) return page;
  const files = await storedFiles(db, {
    artifact,
    versionId,
    path: input.path,
    contentDomain: input.contentDomain,
  });
  if (!files.ok) return files;
  const read = await readStoredPage(bucket, files.value, { artifact });
  if (!read.ok) return read;
  const stored = read.value;
  if (stored.oversized) return ok({ state: "unavailable", reason: "too_large" });
  if (!stored.decoded) return ok({ state: "unavailable", reason: "not_eligible" });
  // The page as served: an HTML file itself, a document's stored rendering. A document whose
  // rendering could not be read as a baseline has no served page to read here.
  const html = stored.kind === "html" ? stored.source : stored.stored?.html;
  if (html === undefined) return ok({ state: "unavailable", reason: "renderer_changed" });
  return ok({
    state: "ready",
    versionId,
    path: input.path,
    text: servedPageText(html, newWork()),
  });
}
