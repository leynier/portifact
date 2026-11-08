import { chmod, mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "@portifact/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "./errors.ts";
import { buildManifest, hashFile } from "./manifest.ts";
import { sha256Of } from "./testing/fake-api.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "portifact-manifest-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function failure(promise: Promise<unknown>): Promise<CliError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(CliError);
  return error as CliError;
}

describe("hashFile", () => {
  it("hashes the bytes on disk and counts them", async () => {
    const path = join(dir, "a.bin");
    await writeFile(path, "hello");
    expect(await hashFile(path)).toEqual({ sha256: sha256Of("hello"), size: 5 });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports a file it cannot read",
    async () => {
      const path = join(dir, "locked.html");
      await writeFile(path, "x");
      await chmod(path, 0o000);
      const error = await failure(hashFile(path));
      expect(error.code).toBe("invalid_input");
      expect(error.message).toBe(`Could not read ${path}.`);
    },
  );
});

describe("buildManifest", () => {
  it("lists nested files in a stable order with forward slashes", async () => {
    await mkdir(join(dir, "b", "c"), { recursive: true });
    await writeFile(join(dir, "index.html"), "i");
    await writeFile(join(dir, "b", "c", "z.js"), "z");
    await writeFile(join(dir, "b", "a.css"), "a");
    await writeFile(join(dir, "B.txt"), "B");

    const manifest = await buildManifest(dir, {});

    expect(manifest.files.map((file) => file.path)).toEqual([
      "B.txt",
      "b/a.css",
      "b/c/z.js",
      "index.html",
    ]);
    expect(manifest.totalBytes).toBe(4);
    expect(manifest.entrypoint).toBe("index.html");
  });

  it("refuses more files than a version can hold", async () => {
    await writeFile(join(dir, "index.html"), "i");
    await Promise.all(
      Array.from({ length: LIMITS.filesPerVersion }, (_, i) =>
        writeFile(join(dir, `f${i}.txt`), ""),
      ),
    );
    const error = await failure(buildManifest(dir, {}));
    expect(error.code).toBe("quota_exceeded");
    expect(error.message).toBe(`A version can hold at most ${LIMITS.filesPerVersion} files.`);
  });

  it("refuses an artifact over the size limit before hashing it", async () => {
    await writeFile(join(dir, "index.html"), "i");
    // A sparse file: its size is over the limit without using the disk space.
    await writeFile(join(dir, "big.bin"), "");
    await truncate(join(dir, "big.bin"), LIMITS.artifactBytes);
    const error = await failure(buildManifest(dir, {}));
    expect(error.code).toBe("quota_exceeded");
    expect(error.message).toBe("An artifact can hold at most 250.0 MB.");
  });

  it("refuses an entry path outside the artifact", async () => {
    await writeFile(join(dir, "index.html"), "i");
    const error = await failure(buildManifest(dir, { entry: "../index.html" }));
    expect(error.code).toBe("invalid_input");
    expect(error.message).toContain("`..`");
  });
});
