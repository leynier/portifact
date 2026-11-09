// Reads one file of a version as text, a page at a time (plan section 6, read_artifact): inline
// content up to 256 KiB per operation, larger files in pages by byte offset. Who may read what
// is exactly what `getVersionDownload` allows; this only fetches the bytes the plan names.
import { type DownloadKind, LIMITS } from "@portifact/contracts";
import type { Db } from "@portifact/db";
import { fail, isTextContentType, ok, type Result, utf8BoundaryEnd } from "@portifact/domain";
import { getVersionDownload } from "./versions.ts";

export interface ReadFileInput {
  userId: string;
  artifactId: string;
  versionId: string;
  kind: DownloadKind;
  /** The file to read; the version's entrypoint when omitted. */
  path?: string | undefined;
  /** Byte offset to start at: 0, or the `nextOffset` of the previous page. */
  offset: number;
  now: number;
}

export interface FilePage {
  artifactId: string;
  versionId: string;
  versionNumber: number;
  kind: DownloadKind;
  path: string;
  contentType: string;
  size: number;
  sha256: string;
  offset: number;
  /** Bytes of the file this page holds. */
  length: number;
  /** Where the next page starts; null after the last one. */
  nextOffset: number | null;
  content: string;
}

/** Bytes of one page; the plan's inline limit for MCP. */
export const READ_PAGE_BYTES = LIMITS.inlineMcpBytes;

export async function readVersionFile(
  db: Db,
  bucket: R2Bucket,
  input: ReadFileInput,
): Promise<Result<FilePage>> {
  const plan = await getVersionDownload(db, {
    userId: input.userId,
    artifactId: input.artifactId,
    versionId: input.versionId,
    kind: input.kind,
    path: input.path,
    now: input.now,
  });
  if (!plan.ok) return plan;
  // With a path the plan holds just that file; without one, read the entrypoint.
  const file =
    input.path === undefined
      ? plan.value.files.find((entry) => entry.path === plan.value.entrypoint)
      : plan.value.files[0];
  if (!file) {
    return fail(
      "not_found",
      `This version has no ${input.kind} file at its entrypoint; pass path.`,
    );
  }
  if (!isTextContentType(file.contentType)) {
    return fail(
      "invalid_input",
      `${file.path} is ${file.contentType}, not text. Download it with get_download instead.`,
    );
  }
  if (input.offset > file.size) {
    return fail("invalid_input", `The offset is past the end of the file (${file.size} bytes).`);
  }
  const want = Math.min(READ_PAGE_BYTES, file.size - input.offset);
  let bytes = new Uint8Array();
  if (want > 0) {
    const object = await bucket.get(file.r2Key, { range: { offset: input.offset, length: want } });
    if (!object) return fail("not_found", "This file's content is no longer stored.");
    bytes = new Uint8Array(await object.arrayBuffer());
  }
  const last = input.offset + bytes.length >= file.size;
  const length = last ? bytes.length : utf8BoundaryEnd(bytes);
  let content: string;
  try {
    // ignoreBOM keeps every byte, so offsets stay exact across pages.
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, length),
    );
  } catch {
    return fail(
      "invalid_input",
      `${file.path} is not valid UTF-8 text from this offset. Start at 0 or a nextOffset, or download it with get_download.`,
    );
  }
  return ok({
    artifactId: plan.value.artifactId,
    versionId: plan.value.versionId,
    versionNumber: plan.value.versionNumber,
    kind: plan.value.kind,
    path: file.path,
    contentType: file.contentType,
    size: file.size,
    sha256: file.sha256,
    offset: input.offset,
    length,
    nextOffset: last ? null : input.offset + length,
    content,
  });
}
