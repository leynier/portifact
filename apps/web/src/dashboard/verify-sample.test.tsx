// The audit stream's verification sample, run as shown: a batch of several JSON Lines verifies
// and reads line by line, which the standardwebhooks library's verify() cannot do (it parses the
// whole body as one JSON value; decision 0019, "Production commissioning, 2026-11-16").
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VERIFY_SAMPLE } from "./screens/audit-streams.tsx";

interface Sample {
  verify(secret: string, headers: Record<string, string>, body: string): boolean;
  readLines(body: string): unknown[];
}

const KEY = Buffer.alloc(32, 7);
const SECRET = `whsec_${KEY.toString("base64")}`;
const BODY = `${[
  { id: "ae_1", kind: "artifact.published" },
  { id: "ae_2", kind: "access.changed" },
  { record: "gap", from: "2026-11-01T00:00:00.000Z" },
]
  .map((line) => JSON.stringify(line))
  .join("\n")}\n`;

function signed(body: string, secrets = [KEY]): Record<string, string> {
  const id = "asb_test";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = secrets
    .map(
      (key) =>
        `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`,
    )
    .join(" ");
  return { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": signature };
}

let dir = "";
let sample: Sample;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pf-verify-sample-"));
  const file = join(dir, "sample.mjs");
  writeFileSync(file, VERIFY_SAMPLE);
  sample = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as Sample;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the audit stream verification sample", () => {
  it("verifies a batch of several lines over the raw body, then reads each line", () => {
    expect(() => JSON.parse(BODY)).toThrow();
    expect(sample.verify(SECRET, signed(BODY), BODY)).toBe(true);
    expect(sample.readLines(BODY)).toEqual([
      { id: "ae_1", kind: "artifact.published" },
      { id: "ae_2", kind: "access.changed" },
      { record: "gap", from: "2026-11-01T00:00:00.000Z" },
    ]);
    // During a rotation either secret's signature passes.
    expect(sample.verify(SECRET, signed(BODY, [Buffer.alloc(32, 1), KEY]), BODY)).toBe(true);
  });

  it("refuses a changed byte, another secret and a stale timestamp", () => {
    const headers = signed(BODY);
    expect(sample.verify(SECRET, headers, BODY.replace("ae_2", "ae_3"))).toBe(false);
    expect(sample.verify(`whsec_${Buffer.alloc(32, 2).toString("base64")}`, headers, BODY)).toBe(
      false,
    );
    const stale = { ...headers, "webhook-timestamp": String(Math.floor(Date.now() / 1000) - 301) };
    expect(sample.verify(SECRET, stale, BODY)).toBe(false);
  });
});
