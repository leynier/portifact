// portifact publish: build the manifest, show it, prepare the publish with one idempotency key,
// upload only what the API asks for, then commit. Anything that fails after prepare cancels the
// upload so its reservation is released. Publishing never changes who can open the artifact.
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import {
  ArtifactSummary,
  type ArtifactType,
  CommittedPublish,
  PreparedPublish,
  type PublishRequest,
} from "@portifact/contracts";
import { callApi, withRetries } from "./api.ts";
import { parseArtifactId } from "./artifacts.ts";
import { type OutputOptions, openSession, writeJson } from "./commands.ts";
import { CliError } from "./errors.ts";
import { buildManifest, type LocalManifest } from "./manifest.ts";
import { messages } from "./messages.ts";
import type { Io, Runtime } from "./runtime.ts";
import type { Session } from "./session.ts";
import { uploadAll } from "./upload.ts";

export interface PublishOptions extends OutputOptions {
  type?: ArtifactType | undefined;
  name?: string | undefined;
  entry?: string | undefined;
  artifact?: string | undefined;
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
  });
  const name = (options.name ?? base?.name ?? defaultName(path)).trim().slice(0, NAME_MAX_LENGTH);

  if (options.dryRun || !session) {
    writeDryRun(io, manifest, name, options.json);
    return;
  }
  showManifest(io.stderr, manifest);

  const request: PublishRequest = {
    ...(artifactId ? { artifactId } : {}),
    type: manifest.type,
    name,
    entrypoint: manifest.entrypoint,
    baseVersionId: base?.currentVersionId ?? null,
    files: manifest.files.map((file) => ({
      path: file.path,
      kind: "published",
      sha256: file.sha256,
      size: file.size,
      contentType: file.contentType,
    })),
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
    await uploadAll({
      session: active,
      uploadId: prepared.uploadId,
      targets: prepared.uploads,
      sources: new Map(manifest.files.map((file) => [file.sha256, file])),
      onUploaded: (target) => {
        done += 1;
        doneBytes += target.size;
        io.stderr(`${messages.uploaded(done, prepared.uploads.length, doneBytes, uploadBytes)}\n`);
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

function showManifest(write: (text: string) => void, manifest: LocalManifest): void {
  write(`${messages.manifestHeader(manifest.files.length, manifest.totalBytes, manifest.type)}\n`);
  for (const file of manifest.files) write(`${messages.manifestLine(file.path, file.size)}\n`);
  if (manifest.excluded.length > 0) {
    write(`${messages.excludedHeader(manifest.excluded.length)}\n`);
    for (const entry of manifest.excluded) {
      write(`${messages.excludedLine(entry.path, entry.reason)}\n`);
    }
  }
}

function writeDryRun(io: Io, manifest: LocalManifest, name: string, json: boolean): void {
  if (json) {
    writeJson(io, {
      dryRun: true,
      type: manifest.type,
      name,
      entrypoint: manifest.entrypoint,
      totalBytes: manifest.totalBytes,
      files: manifest.files.map((file) => ({
        path: file.path,
        size: file.size,
        sha256: file.sha256,
        contentType: file.contentType,
      })),
      excluded: manifest.excluded,
    });
  } else {
    showManifest(io.stdout, manifest);
  }
  io.stderr(`${messages.dryRun}\n`);
}
