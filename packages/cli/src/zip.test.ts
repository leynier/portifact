import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "./errors.ts";
import { excludedPrefix } from "./manifest.ts";
import { buildZip, type ZipFixtureEntry, type ZipFixtureOptions } from "./testing/zip-writer.ts";
import { crc32, extractZip, isZipPath, readZip, removeExtracted, ZIP_LIMITS } from "./zip.ts";

let folder: string;
let previousTmp: string | undefined;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "portifact-zip-test-"));
  // Expansions land here, so a test can check that nothing is left behind.
  previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = await mkdtemp(join(folder, "tmp-"));
});

afterEach(async () => {
  if (previousTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmp;
  await rm(folder, { recursive: true, force: true });
});

async function zipFile(entries: ZipFixtureEntry[], options?: ZipFixtureOptions): Promise<string> {
  const path = join(folder, `${Math.random().toString(36).slice(2)}.zip`);
  await writeFile(path, buildZip(entries, options));
  return path;
}

const keepAll = { maxBytes: 250_000_000, exclude: () => undefined };

async function refusal(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

function sha(data: string | Buffer) {
  return createHash("sha256").update(data).digest("hex");
}

async function leftovers(): Promise<string[]> {
  return readdir(process.env.TMPDIR as string);
}

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.from("6789"), crc32(Buffer.from("12345")))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe("isZipPath", () => {
  it("goes by the extension in any case", () => {
    expect(isZipPath("site.ZIP")).toBe(true);
    expect(isZipPath("site.zip.html")).toBe(false);
  });
});

describe("extractZip", () => {
  it("expands stored and deflated files into private numbered files, hashed", async () => {
    const big = "<p>repeat</p>".repeat(1_000);
    const path = await zipFile([
      { name: "site/", data: "" },
      { name: "site/index.html", data: big },
      { name: "site/img/logo.png", data: Buffer.from([0x89, 0x50, 0, 255]), method: 0 },
      { name: "site/empty.txt", data: "" },
    ]);
    const zip = await extractZip(path, "site.zip", keepAll);
    expect(zip.files.map((file) => [file.path, file.size, file.sha256])).toEqual([
      ["site/index.html", big.length, sha(big)],
      ["site/img/logo.png", 4, sha(Buffer.from([0x89, 0x50, 0, 255]))],
      ["site/empty.txt", 0, sha("")],
    ]);
    // Names from the archive never become paths on disk.
    expect(zip.files.map((file) => file.source)).toEqual(
      ["0", "1", "2"].map((name) => join(zip.directory, name)),
    );
    expect(await readFile(zip.files[0]?.source as string, "utf8")).toBe(big);
    await removeExtracted(zip.directory);
    expect(await leftovers()).toEqual([]);
  });

  it("leaves excluded entries unwritten and reports each excluded folder once", async () => {
    const path = await zipFile([
      { name: "index.html", data: "<p>hi</p>" },
      { name: "node_modules/a/index.js", data: "1" },
      { name: "node_modules/b/index.js", data: "2" },
      { name: "config/.env", data: "TOKEN=x" },
      { name: "__MACOSX/._index.html", data: "junk" },
    ]);
    const zip = await extractZip(path, "site.zip", {
      maxBytes: 1_000,
      exclude: (entry) => excludedPrefix(entry, "all"),
    });
    expect(zip.files.map((file) => file.path)).toEqual(["index.html"]);
    expect(zip.excluded).toEqual([
      { path: "node_modules", reason: "default" },
      { path: "config/.env", reason: "secret" },
      { path: "__MACOSX", reason: "default" },
    ]);
    expect(await readdir(zip.directory)).toEqual(["0"]);
    await removeExtracted(zip.directory);
  });

  it("reads ZIP64 records and sizes", async () => {
    const path = await zipFile(
      [
        { name: "a.txt", data: "alpha" },
        { name: "b/", data: "" },
        { name: "b/c.txt", data: "charlie", method: 0 },
      ],
      { zip64: true },
    );
    const zip = await extractZip(path, "big.zip", keepAll);
    expect(zip.files.map((file) => [file.path, file.size])).toEqual([
      ["a.txt", 5],
      ["b/c.txt", 7],
    ]);
    await removeExtracted(zip.directory);
  });

  it("expands what git archive writes", async () => {
    // A folder entry from MS-DOS hosts is marked by its attribute, not its mode.
    const path = await zipFile([
      { name: "docs", data: "", host: 0, external: 0x10, method: 0 },
      { name: "docs/readme.md", data: "# Readme", host: 0, external: 0 },
    ]);
    const entries = await readZip(path, "x.zip");
    expect(entries.map((entry) => [entry.path, entry.directory])).toEqual([
      ["docs", true],
      ["docs/readme.md", false],
    ]);
  });

  describe("refuses hostile archives before writing anything", () => {
    const cases: [string, ZipFixtureEntry[], RegExp, ZipFixtureOptions?][] = [
      ["a path that climbs out (zip slip)", [{ name: "../evil.sh", data: "x" }], /unsafe path/],
      ["a nested climbing path", [{ name: "a/../../evil", data: "x" }], /unsafe path/],
      ["an absolute path", [{ name: "/etc/passwd", data: "x" }], /unsafe path/],
      ["a drive letter", [{ name: "C:/Windows/evil.dll", data: "x" }], /unsafe path/],
      ["backslashes", [{ name: "..\\evil", data: "x" }], /unsafe path/],
      ["control characters", [{ name: "a\u0001b", data: "x" }], /unsafe path/],
      ["the reserved segment", [{ name: "__portifact/x", data: "x" }], /unsafe path/],
      ["a symbolic link", [{ name: "link", data: "/etc/passwd", mode: 0o120777 }], /symbolic link/],
      [
        "a Windows reparse point",
        [{ name: "link", data: "x", host: 0, external: 0x400 }],
        /symbolic link/,
      ],
      ["a FIFO", [{ name: "pipe", data: "", mode: 0o010644 }], /special file/],
      ["a device", [{ name: "dev", data: "", mode: 0o020644 }], /special file/],
      ["an encrypted entry", [{ name: "secret.txt", data: "x", flags: 0x801 }], /encrypted/],
      ["an unknown method", [{ name: "a.txt", data: "x", method: 12 }], /compression method/],
      ["a folder with content", [{ name: "dir/", data: "x", method: 0 }], /folder with content/],
      [
        "stored sizes that disagree",
        [{ name: "a.txt", data: "abc", method: 0, declaredSize: 2 }],
        /inconsistent sizes/,
      ],
      [
        "a duplicate name",
        [
          { name: "index.html", data: "1" },
          { name: "index.html", data: "2" },
        ],
        /more than once/,
      ],
      [
        "names that differ only by case",
        [
          { name: "Index.html", data: "1" },
          { name: "index.HTML", data: "2" },
        ],
        /more than once/,
      ],
      [
        "a name that is a file and a folder",
        [
          { name: "a", data: "1" },
          { name: "a/b", data: "2" },
        ],
        /both a file and a folder/,
      ],
      [
        "a folder entry with a file's name",
        [
          { name: "a/", data: "" },
          { name: "A", data: "2" },
        ],
        /both a file and a folder/,
      ],
      [
        "entries that share bytes (overlap bomb)",
        [
          { name: "a.txt", data: "aaaa" },
          { name: "b.txt", data: "bbbb", offsetOf: 0 },
        ],
        /overlaps/,
      ],
      [
        "a local header that names another file",
        [{ name: "safe.txt", data: "x", localName: "../evil" }],
        /does not match/,
      ],
      [
        "a name that is not UTF-8",
        [{ name: "x", rawName: Buffer.from([0x66, 0xff, 0xfe]), data: "x", flags: 0 }],
        /not UTF-8/,
      ],
      ["several disks", [{ name: "a.txt", data: "x" }], /several disks/, { disk: 1 }],
    ];
    for (const [label, entries, message, options] of cases) {
      it(`refuses ${label}`, async () => {
        const path = await zipFile(entries, options);
        const error = await refusal(extractZip(path, "hostile.zip", keepAll));
        expect(error.code).toBe("invalid_input");
        expect(error.message).toMatch(message);
        expect(error.message).toContain("hostile.zip");
        expect(await leftovers()).toEqual([]);
      });
    }
  });

  it("refuses more entries than it expands, before reading the directory", async () => {
    const path = await zipFile([{ name: "a.txt", data: "x" }], {
      declaredEntries: ZIP_LIMITS.entries + 1,
    });
    const error = await refusal(extractZip(path, "many.zip", keepAll));
    expect(error.code).toBe("quota_exceeded");
  });

  it("refuses a highly compressed entry (zip bomb)", async () => {
    const zeros = Buffer.alloc(5_000_000);
    const path = await zipFile([{ name: "zeros.bin", data: zeros }]);
    const error = await refusal(extractZip(path, "bomb.zip", keepAll));
    expect(error.message).toMatch(/expands more than 200 times/);
    expect(await leftovers()).toEqual([]);
  });

  it("stops inflating an entry that expands past the size it declares", async () => {
    const path = await zipFile([
      { name: "a.txt", data: "small" },
      { name: "liar.txt", data: "x".repeat(200_000), declaredSize: 10 },
    ]);
    const error = await refusal(extractZip(path, "liar.zip", keepAll));
    expect(error.message).toMatch(/liar\.txt expands past its declared size/);
    expect(await leftovers()).toEqual([]);
  });

  it("refuses an entry shorter than declared, a wrong CRC and corrupt deflate data", async () => {
    const short = await zipFile([{ name: "a.txt", data: "abc", declaredSize: 5 }]);
    expect((await refusal(extractZip(short, "s.zip", keepAll))).message).toMatch(/damaged/);
    const crc = await zipFile([{ name: "a.txt", data: "abc", crc: 1 }]);
    expect((await refusal(extractZip(crc, "c.zip", keepAll))).message).toMatch(/damaged/);
    const corrupt = buildZip([{ name: "a.txt", data: "hello world, hello world" }]);
    corrupt.fill(0xff, 30 + 5, 30 + 5 + 6);
    const corruptPath = join(folder, "corrupt.zip");
    await writeFile(corruptPath, corrupt);
    expect((await refusal(extractZip(corruptPath, "d.zip", keepAll))).message).toMatch(/damaged/);
    expect(await leftovers()).toEqual([]);
  });

  it("refuses expanded files over the size limit by their declared sizes", async () => {
    const path = await zipFile([
      { name: "a.txt", data: "x".repeat(600) },
      { name: "b.txt", data: "y".repeat(600) },
    ]);
    const error = await refusal(extractZip(path, "big.zip", { ...keepAll, maxBytes: 1_000 }));
    expect(error.code).toBe("quota_exceeded");
    expect(await leftovers()).toEqual([]);
  });

  it("refuses files that are not ZIP archives, truncated or missing", async () => {
    const text = join(folder, "fake.zip");
    await writeFile(text, "this is not a zip file at all, just text");
    expect((await refusal(readZip(text, "fake.zip"))).message).toMatch(/not a ZIP file/);
    const tiny = join(folder, "tiny.zip");
    await writeFile(tiny, "PK");
    expect((await refusal(readZip(tiny, "tiny.zip"))).message).toMatch(/not a ZIP file/);

    const whole = buildZip([{ name: "a.txt", data: "abc" }]);
    // Keep the end record but drop the first bytes, so the directory points before the file.
    const truncated = join(folder, "truncated.zip");
    await writeFile(truncated, whole.subarray(10));
    expect((await refusal(readZip(truncated, "truncated.zip"))).code).toBe("invalid_input");

    const missing = await refusal(readZip(join(folder, "missing.zip"), "missing.zip"));
    expect(missing.message).toMatch(/does not exist/);
  });

  it("refuses ZIP64 markers without their records", async () => {
    const whole = buildZip([{ name: "a.txt", data: "abc" }], { zip64: true });
    // Drop the ZIP64 end record and locator, keep the saturated classic end record.
    const end = whole.subarray(whole.length - 22);
    const broken = Buffer.concat([whole.subarray(0, whole.length - 22 - 76), end]);
    const path = join(folder, "broken64.zip");
    await writeFile(path, broken);
    expect((await refusal(readZip(path, "broken64.zip"))).message).toMatch(/ZIP64/);
  });
});
