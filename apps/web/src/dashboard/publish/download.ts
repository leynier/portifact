// Downloads the published files or the sources of a version through the short-lived links the
// API returns (plan sections 6 and 9: the export is packaged in the browser). Every file is
// checked against the size and SHA-256 of the manifest before it is handed to the user; several
// files are packaged into one ZIP, stored without compression so packaging stays cheap.
import type { DownloadKind } from "@portifact/contracts";
import { Zip, ZipPassThrough } from "fflate";
import type { DashboardApi } from "../api.ts";
import { sha256OfBlob } from "./hash.ts";
import type { StorageTransport } from "./upload.ts";

export class DownloadFailure extends Error {
  constructor(
    readonly reason: "integrity" | "network",
    readonly path: string,
  ) {
    super(`${reason}: ${path}`);
    this.name = "DownloadFailure";
  }
}

export interface DownloadJob {
  api: Pick<DashboardApi, "versionDownload">;
  transport: StorageTransport;
  artifactId: string;
  versionId: string;
  kind: DownloadKind;
  /** Base of the ZIP's name, such as the artifact name. */
  name: string;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface SavedFile {
  fileName: string;
  blob: Blob;
}

/** A file name safe on every system, from an artifact name. */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize("NFC")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 80);
  return cleaned || "artifact";
}

export async function downloadVersion(job: DownloadJob): Promise<SavedFile> {
  const plan = await job.api.versionDownload(job.artifactId, job.versionId, job.kind);
  const files: { path: string; blob: Blob }[] = [];
  job.onProgress?.(0, plan.files.length);
  for (const file of plan.files) {
    let blob: Blob;
    try {
      blob = await job.transport.get(file.url, job.signal);
    } catch {
      throw new DownloadFailure("network", file.path);
    }
    if (blob.size !== file.size || (await sha256OfBlob(blob)) !== file.sha256) {
      throw new DownloadFailure("integrity", file.path);
    }
    files.push({ path: file.path, blob });
    job.onProgress?.(files.length, plan.files.length);
  }
  const only = files.length === 1 ? files[0] : undefined;
  if (only) return { fileName: only.path.split("/").pop() || only.path, blob: only.blob };
  const suffix = job.kind === "source" ? "-sources" : "";
  return {
    fileName: `${safeFileName(job.name)}-v${plan.versionNumber}${suffix}.zip`,
    blob: await zipFiles(files),
  };
}

/** Packages files into a ZIP without compression, one file at a time. */
export async function zipFiles(files: readonly { path: string; blob: Blob }[]): Promise<Blob> {
  const parts: Uint8Array[] = [];
  let failed: Error | null = null;
  const finished = new Promise<void>((resolve) => {
    const zip = new Zip((error, chunk, final) => {
      if (error) failed = error;
      else parts.push(chunk);
      if (final || error) resolve();
    });
    void (async () => {
      for (const file of files) {
        const entry = new ZipPassThrough(file.path);
        zip.add(entry);
        const reader = file.blob.stream().getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          entry.push(value);
        }
        entry.push(new Uint8Array(0), true);
      }
      zip.end();
    })();
  });
  await finished;
  if (failed) throw failed;
  return new Blob(parts as BlobPart[], { type: "application/zip" });
}
