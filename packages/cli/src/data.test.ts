import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseExportFile } from "@portifact/domain/artifact-data";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataQueryString } from "./data.ts";
import { EXIT } from "./errors.ts";
import { type FakeServer, startFakeServer } from "./testing/fake-server.ts";
import { createHarness, type Harness } from "./testing/harness.ts";

let server: FakeServer;
let h: Harness;

beforeEach(async () => {
  server = await startFakeServer();
  h = await createHarness({ server });
});

afterEach(async () => {
  await h.cleanup();
  await server.close();
});

const dataRequests = () => server.requests.filter((r) => r.path.includes("/data"));

async function declared() {
  h.signIn();
  const artifact = server.api.seed();
  const result = await h.invoke(
    "data",
    "declare",
    artifact.id,
    "votes",
    "--mode",
    "append",
    "--index",
    "choice",
    "--unique",
    "key",
  );
  expect(result.code, result.stderr).toBe(0);
  return artifact.id;
}

describe("portifact data", () => {
  it("declares, creates, reads, queries, counts and replaces", async () => {
    const id = await declared();
    const described = (await h.invoke("data", "describe", id)).stdout.split("\n");
    expect(described[0]).toMatch(/^COLLECTION\s+MODE\s+DOCUMENTS\s+BYTES\s+UNIQUE\s+INDEXED$/);
    expect(described[1]).toMatch(/^votes\s+append\s+0\s+0\s+key\s+choice$/);
    expect(described).toContain("Live: 2 of 10 connection(s) open, 40 of 2000 message(s) today.");

    const one = await h.invoke("data", "create", id, "votes", "--body", '{"choice":"a"}', "--json");
    expect(one.code, one.stderr).toBe(0);
    const doc = JSON.parse(one.stdout) as { _id: string; choice: string };
    expect(doc.choice).toBe("a");

    const folder = await h.files("input", {
      "many.json": JSON.stringify([{ choice: "b" }, { choice: "c" }]),
    });
    const file = join(folder, "many.json");
    const many = await h.invoke("data", "create", id, "votes", "--file", file);
    expect(many.stdout).toMatch(/^Created 2 document\(s\): /);

    const got = await h.invoke("data", "get", id, "votes", doc._id);
    expect(JSON.parse(got.stdout)).toMatchObject({ _id: doc._id, choice: "a" });
    expect(got.stderr).toContain("untrusted data");

    const page = await h.invoke("data", "query", id, "votes", "--where", "choice=b", "--json");
    expect((JSON.parse(page.stdout) as { documents: unknown[] }).documents).toHaveLength(1);
    expect((await h.invoke("data", "query", id, "votes")).stdout).toMatch(
      /^ID\s+BY\s+CREATED\s+BODY/,
    );

    expect((await h.invoke("data", "count", id, "votes")).stdout).toBe("3\n");
    expect((await h.invoke("data", "count", id, "votes", "--where", "choice=c")).stdout).toBe(
      "1\n",
    );

    const replaced = await h.invoke(
      "data",
      "replace",
      id,
      "votes",
      doc._id,
      "--body",
      '{"choice":"z"}',
    );
    expect(replaced.stdout).toBe(`Replaced ${doc._id} in votes.\n`);
    const bulk = await h.invoke(
      "data",
      "replace",
      id,
      "votes",
      "--body",
      JSON.stringify([{ id: doc._id, body: { choice: "y" } }]),
      "--json",
    );
    expect(JSON.parse(bulk.stdout)).toEqual({ replaced: 1 });
    expect((await h.invoke("data", "build-indexes", id)).stdout).toBe(
      "Every indexed field is built.\n",
    );

    // Every change carried an idempotency key.
    expect(server.api.data.keys.every((key) => typeof key === "string" && key.length > 8)).toBe(
      true,
    );
  });

  it("deletes one or many only after a confirmation", async () => {
    const id = await declared();
    const created = await h.invoke(
      "data",
      "create",
      id,
      "votes",
      "--body",
      '[{"n":1},{"n":2},{"n":3}]',
      "--json",
    );
    const ids = (JSON.parse(created.stdout) as { ids: string[] }).ids;
    const refused = await h.invoke("data", "delete", id, "votes", ids[0] as string);
    expect(refused.code).toBe(EXIT.usage);
    expect(refused.stderr).toContain("--yes");

    expect((await h.invoke("data", "delete", id, "votes", ids[0] as string, "--yes")).stdout).toBe(
      `Deleted ${ids[0]} from votes.\n`,
    );
    const both = await h.invoke(
      "data",
      "delete",
      id,
      "votes",
      ids[1] as string,
      ids[2] as string,
      "--yes",
      "--json",
    );
    expect(JSON.parse(both.stdout)).toEqual({ removed: 2, ids: [ids[1], ids[2]] });
    expect(dataRequests().some((r) => r.path.endsWith("/bulk-delete"))).toBe(true);
  });

  it("asks at the terminal and cancels on any answer but delete", async () => {
    await h.cleanup();
    h = await createHarness({ server, answers: ["no", "delete"] });
    const id = await declared();
    const created = await h.invoke("data", "create", id, "votes", "--body", "{}", "--json");
    const docId = (JSON.parse(created.stdout) as { _id: string })._id;
    const cancelled = await h.invoke("data", "delete", id, "votes", docId);
    expect(cancelled.code).not.toBe(0);
    expect(h.prompts[0]).toContain('Type "delete"');
    expect((await h.invoke("data", "delete", id, "votes", docId)).code).toBe(0);
  });

  it("writes an export file that loads into SQLite", async () => {
    const id = await declared();
    await h.invoke(
      "data",
      "create",
      id,
      "votes",
      "--body",
      JSON.stringify([
        { choice: "a", n: 1, nested: { deep: [1, 2] } },
        { choice: "b", n: 2 },
        { choice: "a", n: 3, text: "é  " },
      ]),
    );
    const out = join(await h.files("out", {}), "data.jsonl");
    const result = await h.invoke("data", "export", id, "--out", out);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(`Exported 3 document(s) of ${id} to ${out}.\n`);
    // Two pages of two: the cursor was followed.
    expect(dataRequests().filter((r) => r.path.includes("/export")).length).toBe(2);

    const text = await readFile(out, "utf8");
    const parsed = parseExportFile(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.header).toMatchObject({
      format: "portifact-data",
      version: 1,
      artifact: id,
      collections: [{ name: "votes", mode: "append", uniqueKey: "key", indexed: ["choice"] }],
    });
    expect(parsed.value.footer).toMatchObject({ consistent: true, documents: 3 });

    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE docs (collection TEXT, id TEXT, by TEXT, body TEXT)");
    const insert = db.prepare("INSERT INTO docs VALUES (?, ?, ?, ?)");
    for (const line of text.trimEnd().split("\n").slice(1, -1)) {
      const row = JSON.parse(line) as { collection: string; id: string; by: string; body: unknown };
      insert.run(row.collection, row.id, row.by, JSON.stringify(row.body));
    }
    const totals = db
      .prepare(
        "SELECT json_extract(body, '$.choice') AS choice, sum(json_extract(body, '$.n')) AS n FROM docs GROUP BY choice ORDER BY choice",
      )
      .all();
    expect(totals).toEqual([
      { choice: "a", n: 4 },
      { choice: "b", n: 2 },
    ]);
    expect(
      db
        .prepare("SELECT json_extract(body, '$.nested.deep[1]') AS v FROM docs WHERE v IS NOT NULL")
        .get(),
    ).toEqual({ v: 2 });
    db.close();

    // A second export never overwrites the file.
    const again = await h.invoke("data", "export", id, "--out", out);
    expect(again.code).toBe(EXIT.usage);
  });

  it("marks an export whose data changed between pages as inconsistent", async () => {
    const id = await declared();
    await h.invoke("data", "create", id, "votes", "--body", '[{"n":1},{"n":2},{"n":3}]');
    server.api.data.moveRevisionDuringExport = true;
    const result = await h.invoke("data", "export", id);
    expect(result.code).toBe(0);
    const footer = JSON.parse(result.stdout.trimEnd().split("\n").at(-1) as string);
    expect(footer).toMatchObject({ footer: true, consistent: false, documents: 3 });
  });

  it("refuses bad input before any request and answers the API's errors", async () => {
    h.signIn();
    const artifact = server.api.seed();
    for (const args of [
      ["declare", artifact.id, "Votes", "--mode", "own"],
      ["declare", artifact.id, "votes", "--mode", "everyone"],
      ["query", artifact.id, "votes", "--where", "nofield"],
      ["query", artifact.id, "votes", "--limit", "101"],
      ["query", artifact.id, "votes", "--created", "since:1"],
      ["get", artifact.id, "votes", "short"],
      ["create", artifact.id, "votes"],
      ["create", artifact.id, "votes", "--body", "not json"],
      ["create", artifact.id, "votes", "--body", "[1]"],
      ["replace", artifact.id, "votes", "--body", "{}"],
    ]) {
      const result = await h.invoke("data", ...args);
      expect(result.code, args.join(" ")).toBe(EXIT.usage);
    }
    expect(dataRequests()).toHaveLength(0);

    const missing = await h.invoke("data", "describe", "zzzzzzzzzz", "--json");
    expect(missing.code).toBe(EXIT.notFound);
    expect(JSON.parse(missing.stdout)).toEqual({
      error: { code: "not_found", message: "Artifact not found." },
    });
    const noCollection = await h.invoke("data", "create", artifact.id, "votes", "--body", "{}");
    expect(noCollection.code).toBe(EXIT.notFound);
    expect(noCollection.stderr).toContain("No such collection.");
  });
});

describe("dataQueryString", () => {
  it("builds the API's query parameters", () => {
    expect(
      String(
        dataQueryString({
          json: false,
          where: "choice=a=b",
          created: "gte:5",
          order: "-created",
          limit: "10",
          after: "c",
        }),
      ),
    ).toBe(
      "equalsField=choice&equalsValue=a%3Db&createdOp=gte&createdValue=5&order=-created&limit=10&after=c",
    );
    expect(String(dataQueryString({ json: false, by: "owner" }))).toBe(
      "equalsField=_by&equalsValue=owner",
    );
    expect(() => dataQueryString({ json: false, by: "a", where: "x=1" })).toThrow();
    expect(() => dataQueryString({ json: false, order: "name" })).toThrow();
  });

  it("escapes C1 terminal controls in document output and the export file", async () => {
    const id = await declared();
    const text = "\u009b2J\u009d52;c;SGVsbG8=\u009c";
    const one = await h.invoke(
      "data",
      "create",
      id,
      "votes",
      "--body",
      JSON.stringify({ text, choice: "c1", key: "c1" }),
      "--json",
    );
    expect(one.code, one.stderr).toBe(0);
    expect(one.stdout).not.toMatch(/[\u0080-\u009f]/u);
    const { _id } = JSON.parse(one.stdout) as { _id: string; text: string };
    expect((JSON.parse(one.stdout) as { text: string }).text).toBe(text);
    const got = await h.invoke("data", "get", id, "votes", _id);
    expect(got.stdout).not.toMatch(/[\u0080-\u009f]/u);
    const listed = await h.invoke("data", "query", id, "votes");
    expect(listed.stdout).not.toMatch(/[\u0080-\u009f]/u);
    const out = join(await h.files("out-c1", {}), "c1-export.jsonl");
    const exported = await h.invoke("data", "export", id, "--out", out);
    expect(exported.code, exported.stderr).toBe(0);
    const file = await readFile(out, "utf8");
    expect(file).not.toMatch(/[\u0080-\u009f]/u);
    // Escaped, not dropped: the file still loads with the stored value.
    const parsed = parseExportFile(file);
    expect(parsed.ok && parsed.value.rows.find((row) => row.id === _id)?.body.text).toBe(text);
  });
});
