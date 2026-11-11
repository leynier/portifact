import { describe, expect, it } from "vitest";
import {
  EXPORT_MANIFEST_FILE,
  EXPORT_MANIFEST_FORMAT,
  ExportedLog,
  ExportManifest,
} from "./data-export.ts";

const sha = "a".repeat(64);
const manifest = {
  format: EXPORT_MANIFEST_FORMAT,
  space: "personal",
  exportedAt: "2026-11-11T00:00:00.000Z",
  artifacts: [
    {
      id: "abcdefghij",
      name: "Plan",
      versions: [
        {
          id: "v_1",
          number: 1,
          current: true,
          folder: "artifacts/abcdefghij/v1",
          files: [{ kind: "published", path: "index.md", size: 5, sha256: sha }],
        },
      ],
      accessLog: { file: "artifacts/abcdefghij/access-log.jsonl", lines: 2 },
    },
  ],
  audit: { skipped: "plan_required" },
  totals: { artifacts: 1, versions: 1, files: 1, bytes: 5 },
};

describe("the export manifest", () => {
  it("is manifest.json in format 1", () => {
    expect(EXPORT_MANIFEST_FILE).toBe("manifest.json");
    expect(ExportManifest.parse(manifest)).toEqual(manifest);
  });

  it("refuses another format, a bad hash, a bad artifact ID and unknown fields", () => {
    expect(ExportManifest.safeParse({ ...manifest, format: 2 }).success).toBe(false);
    const badHash = {
      ...manifest,
      artifacts: [
        {
          ...manifest.artifacts[0],
          versions: [
            {
              ...manifest.artifacts[0]?.versions[0],
              files: [{ kind: "published", path: "index.md", size: 5, sha256: "nope" }],
            },
          ],
        },
      ],
    };
    expect(ExportManifest.safeParse(badHash).success).toBe(false);
    expect(
      ExportManifest.safeParse({ ...manifest, artifacts: [{ ...manifest.artifacts[0], id: "X" }] })
        .success,
    ).toBe(false);
    expect(ExportManifest.safeParse({ ...manifest, extra: true }).success).toBe(false);
  });

  it("says a log is a file with its lines, or why it was skipped", () => {
    expect(ExportedLog.parse({ file: "audit.jsonl", lines: 0 })).toEqual({
      file: "audit.jsonl",
      lines: 0,
    });
    for (const skipped of ["forbidden", "plan_required", "not_found"]) {
      expect(ExportedLog.parse({ skipped })).toEqual({ skipped });
    }
    expect(ExportedLog.safeParse({ skipped: "broken" }).success).toBe(false);
  });
});
