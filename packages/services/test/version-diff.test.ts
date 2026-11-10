// Comparing two versions (premium plan P3, feature `versionDiff`): the file summary from the
// manifests and the text diff of one file, for an admin or editor of the owner whose plan
// includes the feature.
import { env } from "cloudflare:test";
import { planRequiredMessage, VERSION_DIFF } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { pruneVersions } from "../src/maintenance.ts";
import {
  compareVersions,
  decodeDiffCursor,
  diffVersionFile,
  encodeDiffCursor,
} from "../src/version-diff.ts";
import { db, grantPlan, NOW, user, value } from "./fixtures.ts";
import { type Published, publishVersion, versions, workspace } from "./version-support.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const LATER = NOW + 2 * HOUR;

const compare = (userId: string, from: Published, to: Published, extra: object = {}) =>
  compareVersions(db(), {
    userId,
    artifactId: from.artifactId,
    fromVersionId: from.versionId,
    toVersionId: to.versionId,
    limit: 100,
    now: LATER,
    ...extra,
  });

const diffFile = (
  userId: string,
  from: Published,
  to: Published,
  path: string,
  extra: object = {},
) =>
  diffVersionFile(db(), env.ARTIFACTS, {
    userId,
    artifactId: from.artifactId,
    fromVersionId: from.versionId,
    toVersionId: to.versionId,
    kind: "published",
    path,
    cursor: 0,
    now: LATER,
    ...extra,
  });

/** A Pro owner with two versions of a site: one file changed, one kept, one moved, one source. */
async function twoVersions() {
  const owner = await user();
  await grantPlan(owner.id, "pro");
  const v1 = await publishVersion(owner.id, {
    "index.html": "<h1>One</h1>\n<p>a</p>\n",
    "style.css": { body: "body {}\n", contentType: "text/css" },
    "old.txt": { body: "moved\n", contentType: "text/plain" },
    "notes.md": { body: "draft\n", contentType: "text/markdown", kind: "source" },
  });
  const v2 = await publishVersion(
    owner.id,
    {
      "index.html": "<h1>Two</h1>\n<p>a</p>\n",
      "style.css": { body: "body {}\n", contentType: "text/css" },
      "new.txt": { body: "moved\n", contentType: "text/plain" },
      "notes.md": { body: "final\n", contentType: "text/markdown", kind: "source" },
    },
    { now: NOW + HOUR, base: v1 },
  );
  return { owner, v1, v2 };
}

describe("compareVersions", () => {
  it("is refused on free with plan_required, after authorization", async () => {
    const owner = await user();
    const [v1, v2] = (await versions(owner.id, 2)) as [Published, Published];
    expect(await compare(owner.id, v1, v2)).toEqual({
      ok: false,
      code: "plan_required",
      message: planRequiredMessage("versionDiff"),
    });
    // Someone with no role learns nothing, not even that a plan would help.
    const stranger = await user();
    await grantPlan(stranger.id, "pro");
    expect(await compare(stranger.id, v1, v2)).toEqual({
      ok: false,
      code: "not_found",
      message: "Artifact not found.",
    });
  });

  it("lists added, removed and changed files with counts; a move is a remove and an add", async () => {
    const { owner, v1, v2 } = await twoVersions();
    const result = value(await compare(owner.id, v1, v2));
    expect(result.from).toEqual({ id: v1.versionId, number: 1 });
    expect(result.to).toEqual({ id: v2.versionId, number: 2 });
    expect(result.counts).toEqual({ added: 1, removed: 1, changed: 2, unchanged: 1 });
    expect(result.files.map((file) => [file.kind, file.path, file.change])).toEqual([
      ["published", "index.html", "changed"],
      ["published", "new.txt", "added"],
      ["published", "old.txt", "removed"],
      ["source", "notes.md", "changed"],
    ]);
    const index = result.files[0];
    expect(index?.before).toMatchObject({ size: 22, contentType: "text/html" });
    expect(index?.after).toMatchObject({ size: 22, contentType: "text/html" });
    expect(result.files[1]?.before).toBeNull();
    expect(result.files[2]?.after).toBeNull();
    expect(result.nextCursor).toBeNull();
  });

  it("pages the files with a cursor and refuses a forged one", async () => {
    const { owner, v1, v2 } = await twoVersions();
    const first = value(await compare(owner.id, v1, v2, { limit: 3 }));
    expect(first.files).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    const second = value(await compare(owner.id, v1, v2, { limit: 3, cursor: first.nextCursor }));
    expect(second.files.map((file) => file.path)).toEqual(["notes.md"]);
    expect(second.nextCursor).toBeNull();
    expect(second.counts).toEqual(first.counts);
    for (const cursor of ["!!", "e30", encodeDiffCursor("published", "x").slice(0, 5)]) {
      expect(await compare(owner.id, v1, v2, { cursor })).toEqual({
        ok: false,
        code: "invalid_input",
        message: "Invalid cursor.",
      });
    }
    expect(decodeDiffCursor(encodeDiffCursor("source", "dir/ñ.md"))).toEqual([
      "source",
      "dir/ñ.md",
    ]);
  });

  it("finds nothing to list between a version and itself", async () => {
    const { owner, v2 } = await twoVersions();
    const result = value(await compare(owner.id, v2, v2));
    expect(result.counts).toEqual({ added: 0, removed: 0, changed: 0, unchanged: 4 });
    expect(result.files).toEqual([]);
  });

  it("accepts current for either side", async () => {
    const { owner, v1, v2 } = await twoVersions();
    const result = value(
      await compare(owner.id, v1, { artifactId: v1.artifactId, versionId: "current" }),
    );
    expect(result.to).toEqual({ id: v2.versionId, number: 2 });
  });

  it("refuses versions of another artifact and versions no longer retained", async () => {
    const { owner, v1, v2 } = await twoVersions();
    const other = await publishVersion(owner.id, { "index.html": "<p>other</p>" });
    const missing = {
      ok: false,
      code: "not_found",
      message:
        "This version does not exist, is no longer retained or your account cannot download it.",
    };
    expect(
      await compare(owner.id, v1, { artifactId: v1.artifactId, versionId: other.versionId }),
    ).toEqual(missing);
    // On free again, a third version leaves v1 among the three; a fourth prunes it.
    const v3 = await publishVersion(
      owner.id,
      { "index.html": "<p>3</p>" },
      { now: NOW + 2 * HOUR, base: v2 },
    );
    await publishVersion(owner.id, { "index.html": "<p>4</p>" }, { now: NOW + 3 * HOUR, base: v3 });
    await grantPlan(owner.id, "pro", { overrides: { limits: { retainedPreviousVersions: 2 } } });
    await pruneVersions(db(), env.ARTIFACTS, NOW + 3 * HOUR);
    expect(await compare(owner.id, v1, v3, { now: NOW + 3 * HOUR })).toEqual(missing);
  });

  it("is open to an admin or editor of a workspace on a plan with it, never to a member", async () => {
    const team = await workspace(() => user());
    const v1 = await publishVersion(
      team.editor.id,
      { "index.html": "<p>1</p>" },
      { ownerId: team.id },
    );
    const v2 = await publishVersion(
      team.editor.id,
      { "index.html": "<p>2</p>" },
      { ownerId: team.id, now: NOW + HOUR, base: v1 },
    );
    // The editor's own plan does not count: the workspace's does.
    await grantPlan(team.editor.id, "enterprise");
    expect(await compare(team.editor.id, v1, v2)).toMatchObject({ code: "plan_required" });
    await grantPlan(team.id, "team");
    expect(await compare(team.editor.id, v1, v2)).toMatchObject({ ok: true });
    expect(await compare(team.admin.id, v1, v2)).toMatchObject({ ok: true });
    expect(await compare(team.member.id, v1, v2)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await compare(team.outsider.id, v1, v2)).toEqual({
      ok: false,
      code: "not_found",
      message: "Artifact not found.",
    });
  });
});

describe("diffVersionFile", () => {
  it("diffs a changed text file into hunks", async () => {
    const { owner, v1, v2 } = await twoVersions();
    const result = value(await diffFile(owner.id, v1, v2, "index.html"));
    expect(result).toMatchObject({ kind: "published", path: "index.html", change: "changed" });
    expect(result.diff).toEqual({
      status: "text",
      added: 1,
      removed: 1,
      nextCursor: null,
      hunks: [
        {
          beforeStart: 1,
          beforeLines: 2,
          afterStart: 1,
          afterLines: 2,
          lines: [
            { type: "removed", text: "<h1>One</h1>", before: 1, after: null, noNewline: false },
            { type: "added", text: "<h1>Two</h1>", before: null, after: 1, noNewline: false },
            { type: "context", text: "<p>a</p>", before: 2, after: 2, noNewline: false },
          ],
        },
      ],
    });
  });

  it("diffs sources, added and removed files, and answers identical for an unchanged one", async () => {
    const { owner, v1, v2 } = await twoVersions();
    expect(
      value(await diffFile(owner.id, v1, v2, "notes.md", { kind: "source" })).diff,
    ).toMatchObject({
      status: "text",
      added: 1,
      removed: 1,
    });
    const added = value(await diffFile(owner.id, v1, v2, "new.txt"));
    expect(added).toMatchObject({
      change: "added",
      before: null,
      diff: { status: "text", added: 1, removed: 0 },
    });
    const removed = value(await diffFile(owner.id, v1, v2, "old.txt"));
    expect(removed).toMatchObject({
      change: "removed",
      after: null,
      diff: { status: "text", added: 0, removed: 1 },
    });
    expect(value(await diffFile(owner.id, v1, v2, "style.css")).diff).toEqual({
      status: "identical",
    });
    expect(await diffFile(owner.id, v1, v2, "missing.txt")).toEqual({
      ok: false,
      code: "not_found",
      message: "Neither version has this file.",
    });
    expect(await diffFile(owner.id, v1, v2, "../index.html")).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });

  it("answers with sizes only for binary, oversized and invalid UTF-8 files", async () => {
    const owner = await user();
    await grantPlan(owner.id, "pro");
    const big = "x".repeat(VERSION_DIFF.fileBytes);
    const v1 = await publishVersion(owner.id, {
      "index.html": "<p>1</p>",
      "logo.png": { body: Uint8Array.of(1, 2, 3), contentType: "image/png" },
      "big.txt": { body: big, contentType: "text/plain" },
      "bad.txt": { body: Uint8Array.of(0x61, 0x0a), contentType: "text/plain" },
    });
    const v2 = await publishVersion(
      owner.id,
      {
        "index.html": "<p>1</p>",
        "logo.png": { body: Uint8Array.of(1, 2, 4), contentType: "image/png" },
        "big.txt": { body: `${big}y`, contentType: "text/plain" },
        "bad.txt": { body: Uint8Array.of(0x61, 0xff, 0x0a), contentType: "text/plain" },
      },
      { now: NOW + HOUR, base: v1 },
    );
    expect(value(await diffFile(owner.id, v1, v2, "logo.png")).diff).toEqual({ status: "binary" });
    const large = value(await diffFile(owner.id, v1, v2, "big.txt"));
    expect(large.diff).toEqual({ status: "too_large" });
    expect([large.before?.size, large.after?.size]).toEqual([
      VERSION_DIFF.fileBytes,
      VERSION_DIFF.fileBytes + 1,
    ]);
    expect(value(await diffFile(owner.id, v1, v2, "bad.txt")).diff).toEqual({ status: "binary" });
  });

  it("compares a Markdown document's source, never its rendered page", async () => {
    const owner = await user();
    await grantPlan(owner.id, "pro");
    const doc = (body: string) => ({
      "index.md": { body, contentType: "text/markdown; charset=utf-8" },
    });
    const v1 = await publishVersion(owner.id, doc("# Title\n\nOne\n"), {
      type: "markdown",
      entrypoint: "index.md",
    });
    const v2 = await publishVersion(owner.id, doc("# Title\n\nTwo\n"), {
      type: "markdown",
      entrypoint: "index.md",
      now: NOW + HOUR,
      base: v1,
    });
    const summary = value(await compare(owner.id, v1, v2));
    expect(summary.files.map((file) => file.path)).toEqual(["index.md"]);
    expect(summary.counts).toEqual({ added: 0, removed: 0, changed: 1, unchanged: 0 });
    const diff = value(await diffFile(owner.id, v1, v2, "index.md")).diff;
    expect(diff).toMatchObject({ status: "text", added: 1, removed: 1 });
  });

  it("pages long diffs by hunk", async () => {
    const owner = await user();
    await grantPlan(owner.id, "pro");
    const lines = Array.from({ length: 4_000 }, (_, i) => `line ${i}`);
    const changed = lines.map((line, i) => (i % 10 === 0 ? `${line} changed` : line));
    const text = (body: string[]) => ({
      "a.txt": { body: `${body.join("\n")}\n`, contentType: "text/plain" },
    });
    const v1 = await publishVersion(owner.id, { "index.html": "<p></p>", ...text(lines) });
    const v2 = await publishVersion(
      owner.id,
      { "index.html": "<p></p>", ...text(changed) },
      { now: NOW + HOUR, base: v1 },
    );
    const first = value(await diffFile(owner.id, v1, v2, "a.txt")).diff;
    if (first.status !== "text") throw new Error("expected a text diff");
    expect(first.nextCursor).not.toBeNull();
    const total = first.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
    expect(total).toBeLessThanOrEqual(VERSION_DIFF.pageLines);
    const next = value(
      await diffFile(owner.id, v1, v2, "a.txt", { cursor: first.nextCursor }),
    ).diff;
    if (next.status !== "text") throw new Error("expected a text diff");
    expect(next.hunks[0]?.beforeStart).toBeGreaterThan(first.hunks.at(-1)?.beforeStart ?? 0);
  });

  it("makes the same checks as the summary", async () => {
    const owner = await user();
    const [v1, v2] = (await versions(owner.id, 2)) as [Published, Published];
    expect(await diffFile(owner.id, v1, v2, "index.html")).toEqual({
      ok: false,
      code: "plan_required",
      message: planRequiredMessage("versionDiff"),
    });
    const stranger = await user();
    expect(await diffFile(stranger.id, v1, v2, "index.html")).toMatchObject({ code: "not_found" });
    expect(await diffFile(owner.id, v1, v2, "index.html", { now: NOW + 30 * DAY })).toMatchObject({
      code: "plan_required",
    });
  });
});
