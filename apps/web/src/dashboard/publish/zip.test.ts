import { strToU8, type Zippable, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { crc32, expandZipEntry, readZipEntries, ZipError } from "./zip.ts";

/** A ZIP built by a real archiver, as bytes we can then damage on purpose. */
export function zip(files: Zippable): Uint8Array {
  return zipSync(files, { mtime: new Date("2026-01-01T00:00:00Z") });
}

function blobOf(bytes: Uint8Array): Blob {
  return new Blob([bytes as BlobPart]);
}

/** Offset of the central directory entry of the `index`-th file. */
function centralEntry(bytes: Uint8Array, index = 0): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let found = -1;
  for (let i = 0; i < bytes.length - 4; i++) {
    if (view.getUint32(i, true) === 0x02014b50) {
      found += 1;
      if (found === index) return i;
    }
  }
  throw new Error("no central entry");
}

function patch(bytes: Uint8Array, at: number, value: number, width: 2 | 4): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  if (width === 2) view.setUint16(at, value, true);
  else view.setUint32(at, value, true);
  return copy;
}

async function expandAll(bytes: Uint8Array): Promise<Record<string, string>> {
  const blob = blobOf(bytes);
  const out: Record<string, string> = {};
  for (const entry of await readZipEntries(blob)) {
    const chunks: Uint8Array[] = [];
    await expandZipEntry(blob, entry, (chunk) => chunks.push(chunk.slice()));
    out[entry.name] = await new Blob(chunks as BlobPart[]).text();
  }
  return out;
}

async function failure(promise: Promise<unknown>): Promise<ZipError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ZipError);
  return error as ZipError;
}

describe("readZipEntries and expandZipEntry", () => {
  it("lists files, skips folders and expands stored and deflated entries", async () => {
    const big = "<p>repeated</p>".repeat(5_000);
    const bytes = zip({
      "site/": {},
      "site/index.html": [strToU8(big), { level: 9 }],
      "site/app.js": [strToU8("console.log(1)"), { level: 0 }],
      "site/ünï.txt": strToU8("unicode"),
    });
    const entries = await readZipEntries(blobOf(bytes));
    expect(entries.map((e) => e.name)).toEqual(["site/index.html", "site/app.js", "site/ünï.txt"]);
    expect(entries.map((e) => e.method)).toEqual([8, 0, 8]);
    expect(await expandAll(bytes)).toEqual({
      "site/index.html": big,
      "site/app.js": "console.log(1)",
      "site/ünï.txt": "unicode",
    });
  });

  it("reads an archive with a trailing comment", async () => {
    const bytes = zipSync({ "a.txt": strToU8("a") }, {
      comment: "made by a tool".repeat(100),
    } as never);
    expect((await readZipEntries(blobOf(bytes))).map((e) => e.name)).toEqual(["a.txt"]);
  });

  it("refuses links and special files declared by Unix archivers", async () => {
    const link = zip({
      "site/current": [strToU8("../../etc/passwd"), { os: 3, attrs: 0o120777 << 16 }],
    });
    const linkError = await failure(readZipEntries(blobOf(link)));
    expect(linkError.reason).toBe("symlink");
    expect(linkError.entry).toBe("site/current");

    const fifo = zip({ pipe: [strToU8(""), { os: 3, attrs: 0o010644 << 16 }] });
    expect((await failure(readZipEntries(blobOf(fifo)))).reason).toBe("special_file");

    const regular = zip({
      "ok.txt": [strToU8("x"), { os: 3, attrs: 0o100644 << 16 }],
      "dir/": [new Uint8Array(0), { os: 3, attrs: 0o040755 << 16 }],
    });
    expect((await readZipEntries(blobOf(regular))).map((e) => e.name)).toEqual(["ok.txt"]);
  });

  it("refuses encrypted entries, unknown compression, ZIP64 and split archives", async () => {
    const bytes = zip({ "a.txt": strToU8("hello") });
    const at = centralEntry(bytes);
    expect((await failure(readZipEntries(blobOf(patch(bytes, at + 8, 0x1, 2))))).reason).toBe(
      "encrypted",
    );
    expect((await failure(readZipEntries(blobOf(patch(bytes, at + 10, 12, 2))))).reason).toBe(
      "unsupported",
    );
    expect(
      (await failure(readZipEntries(blobOf(patch(bytes, at + 24, 0xffffffff, 4))))).reason,
    ).toBe("unsupported");

    const eocd = bytes.length - 22;
    expect((await failure(readZipEntries(blobOf(patch(bytes, eocd + 4, 1, 2))))).reason).toBe(
      "unsupported",
    );
    expect((await failure(readZipEntries(blobOf(patch(bytes, eocd + 10, 0xffff, 2))))).reason).toBe(
      "unsupported",
    );
    const locator = new Uint8Array(20);
    new DataView(locator.buffer).setUint32(0, 0x07064b50, true);
    const withLocator = new Uint8Array([...bytes.slice(0, eocd), ...locator, ...bytes.slice(eocd)]);
    expect((await failure(readZipEntries(blobOf(withLocator)))).reason).toBe("unsupported");
  });

  it("refuses data that is not a ZIP", async () => {
    expect((await failure(readZipEntries(new Blob(["short"])))).reason).toBe("not_zip");
    expect((await failure(readZipEntries(new Blob(["x".repeat(500)])))).reason).toBe("not_zip");
  });

  it("refuses a damaged central directory", async () => {
    const bytes = zip({ "a.txt": strToU8("hello"), "b.txt": strToU8("bye") });
    const eocd = bytes.length - 22;
    // More entries than the directory holds.
    expect((await failure(readZipEntries(blobOf(patch(bytes, eocd + 10, 3, 2))))).reason).toBe(
      "corrupt",
    );
    // A directory that would end past the end record.
    expect(
      (await failure(readZipEntries(blobOf(patch(bytes, eocd + 12, 0xfffff, 4))))).reason,
    ).toBe("corrupt");
    // A name longer than the directory.
    const at = centralEntry(bytes, 1);
    expect((await failure(readZipEntries(blobOf(patch(bytes, at + 28, 4000, 2))))).reason).toBe(
      "corrupt",
    );
    // A stored entry whose sizes disagree.
    const stored = zip({ "a.txt": [strToU8("hello"), { level: 0 }] });
    const storedAt = centralEntry(stored);
    expect((await failure(readZipEntries(blobOf(patch(stored, storedAt + 20, 3, 4))))).reason).toBe(
      "corrupt",
    );
  });

  it("stops an entry that expands past its declared size", async () => {
    const bytes = zip({ "bomb.txt": [strToU8("a".repeat(100_000)), { level: 9 }] });
    const at = centralEntry(bytes);
    const lying = patch(bytes, at + 24, 1_000, 4);
    const blob = blobOf(lying);
    const [entry] = await readZipEntries(blob);
    let produced = 0;
    const error = await failure(
      expandZipEntry(blob, entry as never, (chunk) => {
        produced += chunk.byteLength;
      }),
    );
    expect(error.reason).toBe("corrupt");
    expect(error.entry).toBe("bomb.txt");
    expect(produced).toBeLessThanOrEqual(1_000);
  });

  it("refuses entries whose bytes, size or CRC do not match what was declared", async () => {
    const bytes = zip({ "a.txt": [strToU8("hello world"), { level: 0 }] });
    const blob = blobOf(bytes);
    const [entry] = await readZipEntries(blob);
    if (!entry) throw new Error("no entry");
    const sink = () => {};
    expect((await failure(expandZipEntry(blob, { ...entry, crc32: 1 }, sink))).reason).toBe(
      "corrupt",
    );
    expect(
      (
        await failure(
          expandZipEntry(
            blob,
            { ...entry, size: entry.size + 5, compressedSize: entry.size },
            sink,
          ),
        )
      ).reason,
    ).toBe("corrupt");
    expect((await failure(expandZipEntry(blob, { ...entry, offset: 3 }, sink))).reason).toBe(
      "corrupt",
    );
    expect(
      (await failure(expandZipEntry(blob, { ...entry, compressedSize: 10_000 }, sink))).reason,
    ).toBe("corrupt");
    const deflated = zip({ "b.txt": [strToU8("abc".repeat(50)), { level: 6 }] });
    const deflatedBlob = blobOf(deflated);
    const [compressed] = await readZipEntries(deflatedBlob);
    if (!compressed) throw new Error("no entry");
    const garbage = deflated.slice();
    garbage.fill(0xff, 40, 40 + compressed.compressedSize);
    expect((await failure(expandZipEntry(blobOf(garbage), compressed, sink))).reason).toBe(
      "corrupt",
    );
  });

  it("computes the CRC-32 ZIP declares, across chunks", () => {
    const data = strToU8("The quick brown fox jumps over the lazy dog");
    expect(crc32(0, data)).toBe(0x414fa339);
    expect(crc32(crc32(0, data.subarray(0, 10)), data.subarray(10))).toBe(0x414fa339);
    expect(crc32(0, new Uint8Array(0))).toBe(0);
  });
});
