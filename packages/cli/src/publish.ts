// portifact publish: build the manifest (and the private sources, with their git origin), show
// it, prepare the publish with one idempotency key, upload only what the API asks for, then
// commit. Anything that fails after prepare cancels the upload so its reservation is released.
// Publishing never changes who can open the artifact.
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import {
  ArtifactSummary,
  type ArtifactType,
  CommittedPublish,
  LIMITS,
  PreparedPublish,
  type PublishRequest,
} from "@portifact/contracts";
import { callApi, withRetries } from "./api.ts";
import { parseArtifactId } from "./artifacts.ts";
import { type OutputOptions, openSession, writeJson } from "./commands.ts";
import { CliError } from "./errors.ts";
import { buildManifest, discardManifest, type LocalManifest } from "./manifest.ts";
import { messages } from "./messages.ts";
import type { Io, Runtime } from "./runtime.ts";
import type { Session } from "./session.ts";
import { buildSourceManifest, type SourceManifest } from "./sources.ts";
import { uploadAll } from "./upload.ts";

export interface PublishOptions extends OutputOptions {
  type?: ArtifactType | undefined;
  name?: string | undefined;
  entry?: string | undefined;
  artifact?: string | undefined;
  /** Private sources to attach: a folder (git-aware), a file or a ZIP file. */
  source?: string | undefined;
  /** With `source` in a git repository: attach exactly the tree of this commit. */
  ref?: string | undefined;
  /** Folder of assets of a Markdown document. */
  assets?: string | undefined;
  dryRun: boolean;
}

const NAME_MAX_LENGTH = 200;

export async function publish(
  io: Io,
  runtime: Runtime,
  path: string,
  options: PublishOptions,
): Promise<void> {
  const artifactId = options.artifact === undefined ? undefined : parseArtifactId(options.artifact);
  if (options.ref !== undefined && options.source === undefined) {
    throw new CliError("invalid_input", messages.errors.refNeedsSource);
  }

  // A dry run never contacts the server, so it works before signing in.
  let session: Session | undefined;
  let base: ArtifactSummary | undefined;
  if (!options.dryRun) {
    session = await openSession(io, runtime);
    if (artifactId) {
      base = await callApi(session, {
        method: "GET",
        path: `/artifacts/${artifactId}`,
        schema: ArtifactSummary,
      });
    }
  }
  if (base && options.type && options.type !== base.type) {
    throw new CliError("invalid_input", messages.errors.typeMismatch(base.type, options.type));
  }

  const manifest = await buildManifest(path, {
    type: options.type ?? base?.type,
    entry: options.entry,
    assets: options.assets,
  });
  let sources: SourceManifest | undefined;
  try {
    if (options.source !== undefined) {
      sources = await buildSourceManifest(options.source, { ref: options.ref, git: runtime.git });
    }
    await publishBuilt(io, { manifest, sources, path, options, session, base, artifactId });
  } finally {
    await discardManifest(manifest);
    if (sources) await discardManifest(sources);
  }
}

async function publishBuilt(
  io: Io,
  built: {
    manifest: LocalManifest;
    sources: SourceManifest | undefined;
    path: string;
    options: PublishOptions;
    session: Session | undefined;
    base: ArtifactSummary | undefined;
    artifactId: string | undefined;
  },
): Promise<void> {
  const { manifest, sources, path, options, session, base, artifactId } = built;
  const fileCount = manifest.files.length + (sources?.files.length ?? 0);
  if (fileCount > LIMITS.filesPerVersion) {
    throw new CliError(
      "quota_exceeded",
      messages.errors.tooManyFilesWithSources(LIMITS.filesPerVersion),
    );
  }
  const name = (options.name ?? base?.name ?? defaultName(path)).trim().slice(0, NAME_MAX_LENGTH);
  if (sources && sources.lfsPointers.length > 0) {
    io.stderr(`${messages.lfsPointers(sources.lfsPointers)}\n`);
  }

  if (options.dryRun || !session) {
    writeDryRun(io, manifest, sources, name, options.json);
    return;
  }
  showManifest(io.stderr, manifest, sources);

  const request: PublishRequest = {
    ...(artifactId ? { artifactId } : {}),
    type: manifest.type,
    name,
    entrypoint: manifest.entrypoint,
    baseVersionId: base?.currentVersionId ?? null,
    files: [
      ...manifest.files.map((file) => ({
        path: file.path,
        kind: "published" as const,
        sha256: file.sha256,
        size: file.size,
        contentType: file.contentType,
      })),
      ...(sources?.files ?? []).map((file) => ({
        path: file.path,
        kind: "source" as const,
        sha256: file.sha256,
        size: file.size,
        contentType: file.contentType,
      })),
    ],
    ...(sources?.origin ? { sourceOrigin: sources.origin } : {}),
    // Files over the multipart threshold are uploaded in parts that resume after a failure.
    multipart: true,
  };
  // One key for every attempt: a retry after a lost answer gets the same upload back.
  const idempotencyKey = randomUUID();
  const active = session;
  const prepared = await withRetries(active, () =>
    callApi(active, {
      method: "POST",
      path: "/publishes",
      headers: { "idempotency-key": idempotencyKey },
      body: request,
      schema: PreparedPublish,
    }),
  );

  const uploadBytes = prepared.uploads.reduce((sum, target) => sum + target.size, 0);
  io.stderr(
    `${messages.prepared(prepared.versionNumber, prepared.uploads.length, manifest.files.length, uploadBytes)}\n`,
  );

  let committed: CommittedPublish;
  try {
    let done = 0;
    let doneBytes = 0;
    const files = new Map(
      [...(sources?.files ?? []), ...manifest.files].map((file) => [file.sha256, file]),
    );
    await uploadAll({
      session: active,
      uploadId: prepared.uploadId,
      targets: prepared.uploads,
      sources: files,
      onUploaded: (target) => {
        done += 1;
        // A multipart object counted its bytes part by part.
        if (target.method === "PUT") doneBytes += target.size;
        io.stderr(`${messages.uploaded(done, prepared.uploads.length, doneBytes, uploadBytes)}\n`);
      },
      onPart: (target, partNumber, bytes) => {
        doneBytes += bytes;
        const path = files.get(target.sha256)?.path ?? target.sha256;
        io.stderr(
          `${messages.uploadedPart(path, partNumber, target.partCount, doneBytes, uploadBytes)}\n`,
        );
      },
    });
    io.stderr(`${messages.committing}\n`);
    committed = await withRetries(active, () =>
      callApi(active, {
        method: "POST",
        path: `/publishes/${encodeURIComponent(prepared.uploadId)}/commit`,
        schema: CommittedPublish,
      }),
    );
  } catch (error) {
    await abort(io, active, prepared.uploadId);
    throw error;
  }

  if (options.json) {
    writeJson(io, {
      artifactId: committed.artifactId,
      versionId: committed.versionId,
      versionNumber: committed.versionNumber,
      url: committed.url,
      expiresAt: committed.expiresAt,
      uploadId: prepared.uploadId,
      files: manifest.files.length,
      totalBytes: manifest.totalBytes,
      sourceFiles: sources?.files.length ?? 0,
      sourceBytes: sources?.totalBytes ?? 0,
      sourceOrigin: sources?.origin ?? null,
      uploadedFiles: prepared.uploads.length,
      uploadedBytes: uploadBytes,
    });
  } else {
    io.stdout(
      `${messages.published(committed.url, committed.artifactId, committed.versionNumber, committed.expiresAt)}\n`,
    );
  }
}

async function abort(io: Io, session: Session, uploadId: string): Promise<void> {
  try {
    await withRetries(session, () =>
      callApi(session, { method: "DELETE", path: `/publishes/${encodeURIComponent(uploadId)}` }),
    );
    io.stderr(`${messages.aborted}\n`);
  } catch {
    io.stderr(`${messages.abortFailed}\n`);
  }
}

function defaultName(path: string): string {
  return basename(resolve(path)) || "artifact";
}

function showManifest(
  write: (text: string) => void,
  manifest: LocalManifest,
  sources: SourceManifest | undefined,
): void {
  write(`${messages.manifestHeader(manifest.files.length, manifest.totalBytes, manifest.type)}\n`);
  for (const file of manifest.files) write(`${messages.manifestLine(file.path, file.size)}\n`);
  showExcluded(write, manifest.excluded);
  if (!sources) return;
  write(`${messages.sourcesHeader(sources.files.length, sources.totalBytes, sources.chosenBy)}\n`);
  for (const file of sources.files) write(`${messages.manifestLine(file.path, file.size)}\n`);
  showExcluded(write, sources.excluded);
  if (sources.origin) write(`${messages.sourceOrigin(sources.origin)}\n`);
}

function showExcluded(write: (text: string) => void, excluded: LocalManifest["excluded"]): void {
  if (excluded.length === 0) return;
  write(`${messages.excludedHeader(excluded.length)}\n`);
  for (const entry of excluded) write(`${messages.excludedLine(entry.path, entry.reason)}\n`);
}

const fileView = (file: LocalManifest["files"][number]) => ({
  path: file.path,
  size: file.size,
  sha256: file.sha256,
  contentType: file.contentType,
});

function writeDryRun(
  io: Io,
  manifest: LocalManifest,
  sources: SourceManifest | undefined,
  name: string,
  json: boolean,
): void {
  if (json) {
    writeJson(io, {
      dryRun: true,
      type: manifest.type,
      name,
      entrypoint: manifest.entrypoint,
      totalBytes: manifest.totalBytes,
      files: manifest.files.map(fileView),
      excluded: manifest.excluded,
      ...(sources
        ? {
            sources: {
              chosenBy: sources.chosenBy,
              totalBytes: sources.totalBytes,
              files: sources.files.map(fileView),
              excluded: sources.excluded,
              origin: sources.origin ?? null,
              lfsPointers: sources.lfsPointers,
            },
          }
        : {}),
    });
  } else {
    showManifest(io.stdout, manifest, sources);
  }
  io.stderr(`${messages.dryRun}\n`);
}
