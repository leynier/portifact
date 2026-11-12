import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type AnnotationThreadView, UNTRUSTED_ANNOTATIONS_NOTICE } from "@portifact/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatThread, plain } from "./annotations.ts";
import type { FakeArtifact } from "./testing/fake-api.ts";
import { type FakeServer, startFakeServer } from "./testing/fake-server.ts";
import { createHarness, type Harness } from "./testing/harness.ts";

let server: FakeServer;
let h: Harness;

beforeEach(async () => {
  server = await startFakeServer();
  h = await createHarness({ server });
  h.signIn();
});

afterEach(async () => {
  await h.cleanup();
  await server.close();
});

function json(output: { stdout: string }) {
  return JSON.parse(output.stdout);
}

function requests(method: string, path: RegExp) {
  return server.requests.filter((r) => r.method === method && path.test(r.path));
}

/** A site with one version whose main page is `pages/home.html`, annotations open. */
function reviewed(mode: "off" | "open" | "locked" = "open"): FakeArtifact {
  const artifact = server.api.seed({ currentVersionId: null, versions: 0 });
  server.api.seedVersion(
    artifact,
    { published: { "pages/home.html": "<h1>Hi</h1>", "about.html": "<p>About</p>" } },
    { entrypoint: "pages/home.html" },
  );
  server.annotations.modes.set(artifact.id, mode);
  return artifact;
}

async function bodyFile(content: string | Buffer, name = "comment.txt") {
  const folder = await h.files("input", { [name]: content });
  return join(folder, name);
}

async function startThread(artifact: FakeArtifact, body = "First") {
  const result = await h.invoke(
    "annotations",
    "create",
    artifact.id,
    "--body-file",
    await bodyFile(body, `${Math.random()}.txt`),
    "--json",
  );
  expect(result.code, result.stdout).toBe(0);
  return json(result) as AnnotationThreadView;
}

describe("portifact annotations set", () => {
  it("sets the mode and prints text or JSON", async () => {
    const artifact = reviewed("off");
    const text = await h.invoke("annotations", "set", artifact.id, "open");
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(`Annotations on ${artifact.id} are open.`);
    const locked = await h.invoke("annotations", "set", artifact.id, "locked", "--json");
    expect(json(locked)).toEqual({ artifactId: artifact.id, annotations: "locked" });
    expect(requests("PUT", /\/annotations\/mode$/).map((r) => JSON.parse(r.body))).toEqual([
      { mode: "open" },
      { mode: "locked" },
    ]);
    const off = await h.invoke("annotations", "set", artifact.id, "off");
    expect(off.stdout).toContain("are off");
  });

  it("refuses an unknown mode or artifact ID before any request", async () => {
    const artifact = reviewed();
    const bad = await h.invoke("annotations", "set", artifact.id, "closed", "--json");
    expect(bad.code).toBe(2);
    expect(json(bad)).toMatchObject({ error: { code: "invalid_input" } });
    expect((await h.invoke("annotations", "set", "nope", "open")).code).toBe(2);
    expect(requests("PUT", /annotations/)).toHaveLength(0);
  });

  it("reports a reader who cannot change the mode as not found", async () => {
    const artifact = reviewed();
    server.annotations.role = "participant";
    const result = await h.invoke("annotations", "set", artifact.id, "off");
    expect(result.code).toBe(5);
    expect(result.stderr).toContain("Error: Artifact not found.");
  });
});

describe("portifact annotations create", () => {
  it("starts a general comment on the main page of the current version", async () => {
    const artifact = reviewed();
    const result = await h.invoke(
      "annotations",
      "create",
      artifact.id,
      "--body-file",
      await bodyFile("  Fix the title\r\nplease \n"),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^Started thread [\w-]+\.\n/);
    expect(result.stdout).toContain("on pages/home.html");
    expect(result.stdout).toContain("    Fix the title\n    please\n");
    expect(result.stderr).toContain(UNTRUSTED_ANNOTATIONS_NOTICE);
    const [create] = requests("POST", /\/annotations\/threads$/);
    expect(JSON.parse(create?.body ?? "")).toEqual({
      versionId: artifact.currentVersionId,
      target: { schema: 1, path: "pages/home.html", anchor: { kind: "document" } },
      body: "Fix the title\nplease",
    });
    expect(create?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("comments on --path or on a target file checked with the contract", async () => {
    const artifact = reviewed();
    const withPath = await h.invoke(
      "annotations",
      "create",
      artifact.id,
      "--body-file",
      await bodyFile("About page"),
      "--path",
      "about.html",
      "--json",
    );
    expect(json(withPath)).toMatchObject({
      path: "about.html",
      messages: [{ body: "About page" }],
    });

    const target = {
      schema: 1,
      path: "about.html",
      anchor: {
        kind: "text",
        quote: { exact: "About", prefix: "", suffix: "" },
        position: { start: 0, end: 5 },
      },
    };
    const targetFile = await bodyFile(JSON.stringify(target), "target.json");
    const withTarget = await h.invoke(
      "annotations",
      "create",
      artifact.id,
      "--body-file",
      await bodyFile("Quote it"),
      "--target",
      targetFile,
    );
    expect(withTarget.code).toBe(0);
    expect(withTarget.stdout).toContain('Quote: "About"');
    // The entrypoint is only looked up when nothing says where the comment goes.
    expect(requests("GET", /\/versions\//)).toHaveLength(0);
  });

  it("refuses invalid targets, bodies and flags before posting", async () => {
    const artifact = reviewed();
    const comment = await bodyFile("ok");
    const cases: [string[], string][] = [
      [["--target", await bodyFile("{", "broken.json")], "is not valid JSON"],
      [
        [
          "--target",
          await bodyFile(
            JSON.stringify({ schema: 1, path: "../x", anchor: { kind: "document" } }),
            "bad.json",
          ),
        ],
        "The target is not valid: path: Invalid path",
      ],
      [["--target", comment, "--path", "x.html"], "either --target or --path"],
      [["--path", "../secret"], "is not a file path inside the artifact"],
      [["--version", "bad id!"], "is not a version ID"],
    ];
    for (const [flags, message] of cases) {
      const result = await h.invoke(
        "annotations",
        "create",
        artifact.id,
        "--body-file",
        comment,
        ...flags,
      );
      expect(result.code, message).toBe(2);
      expect(result.stderr, message).toContain(message);
    }
    const bodies: [string | Buffer, string][] = [
      ["   \n", "The comment cannot be sent: Write a comment."],
      ["x".repeat(4_001), "at most 4000 characters"],
      [Buffer.from([0xff, 0xfe, 0x00]), "is not UTF-8 text"],
      ["bell\u0007", "characters that are not allowed"],
      ["x".repeat(40_000), "more than a comment or target can hold"],
    ];
    for (const [content, message] of bodies) {
      const file = await bodyFile(content, `${Math.random()}.txt`);
      const result = await h.invoke("annotations", "create", artifact.id, "--body-file", file);
      expect(result.code, message).toBe(2);
      expect(result.stderr, message).toContain(message);
    }
    const missing = await h.invoke(
      "annotations",
      "create",
      artifact.id,
      "--body-file",
      join(h.workspace, "missing.txt"),
    );
    expect(missing.stderr).toContain("Could not read the file");
    const folder = await h.invoke("annotations", "create", artifact.id, "--body-file", h.workspace);
    expect(folder.code).toBe(2);
    expect(requests("POST", /annotations/)).toHaveLength(0);
  });

  it("posts once when the answer is lost and the CLI retries with the same key", async () => {
    const artifact = reviewed();
    server.faults.push({ method: "POST", path: /\/annotations\/threads$/, drop: "after" });
    const result = await h.invoke(
      "annotations",
      "create",
      artifact.id,
      "--body-file",
      await bodyFile("Once"),
      "--json",
    );
    expect(result.code, result.stdout).toBe(0);
    const posts = requests("POST", /\/annotations\/threads$/);
    expect(posts).toHaveLength(2);
    expect(posts[0]?.headers["idempotency-key"]).toBe(posts[1]?.headers["idempotency-key"]);
    expect(server.annotations.threads.size).toBe(1);
  });

  it("finds the page from the download for readers, and asks for --path otherwise", async () => {
    const artifact = reviewed();
    const notFound = { status: 404, body: { error: { code: "not_found", message: "No." } } };
    server.faults.push({ method: "GET", path: /\/versions\/ver_[^/]+$/, reply: notFound });
    const reader = await h.invoke(
      "annotations",
      "create",
      artifact.id,
      "--body-file",
      await bodyFile("Hi"),
      "--json",
    );
    expect(json(reader)).toMatchObject({ path: "pages/home.html" });
    expect(requests("GET", /\/versions\/current\/download$/)).toHaveLength(1);

    server.faults.push(
      { method: "GET", path: /\/versions\/ver_[^/]+$/, reply: notFound },
      { method: "GET", path: /\/download$/, reply: notFound },
    );
    const stuck = await h.invoke(
      "annotations",
      "create",
      artifact.id,
      "--body-file",
      await bodyFile("Hi"),
    );
    expect(stuck.code).toBe(2);
    expect(stuck.stderr).toContain("Pass --path with the file");

    // Any other failure is reported as it is.
    server.faults.push({
      method: "GET",
      path: /\/versions\/ver_[^/]+$/,
      reply: { status: 409, body: { error: { code: "artifact_archived", message: "Archived." } } },
    });
    const archived = await h.invoke(
      "annotations",
      "create",
      artifact.id,
      "--body-file",
      await bodyFile("Hi"),
    );
    expect(archived.code).toBe(6);
  });

  it("uses a pinned --version and reports a conflict when it is no longer current", async () => {
    const artifact = reviewed();
    const stale = await h.invoke(
      "annotations",
      "create",
      artifact.id,
      "--body-file",
      await bodyFile("Late"),
      "--path",
      "about.html",
      "--version",
      "ver_old",
      "--json",
    );
    expect(stale.code).toBe(6);
    expect(json(stale)).toMatchObject({ error: { code: "version_conflict" } });
    expect(requests("GET", /\/annotations$/)).toHaveLength(0);
  });

  it("refuses when annotations are off or the artifact has no version", async () => {
    const off = reviewed("off");
    const result = await h.invoke(
      "annotations",
      "create",
      off.id,
      "--body-file",
      await bodyFile("Hi"),
    );
    expect(result.code).toBe(5);
    expect(result.stderr).toContain("Annotations are off.");
    const empty = server.api.seed({ currentVersionId: null, versions: 0 });
    const none = await h.invoke(
      "annotations",
      "create",
      empty.id,
      "--body-file",
      await bodyFile("Hi"),
    );
    expect(none.code).toBe(5);
    expect(none.stderr).toContain("has no published version to comment on");
  });
});

describe("portifact annotations list and show", () => {
  it("follows every page and prints stable JSON with the cursor", async () => {
    const artifact = reviewed();
    for (let i = 0; i < 52; i++) await startThread(artifact, `Comment ${i}`);
    const before = server.requests.length;
    const result = await h.invoke("annotations", "list", artifact.id, "--json");
    expect(result.code).toBe(0);
    const page = json(result);
    expect(Object.keys(page)).toEqual([
      "artifactId",
      "annotations",
      "currentVersionId",
      "role",
      "commentScope",
      "humanCheck",
      "threads",
      "removed",
      "cursor",
    ]);
    expect(page.threads).toHaveLength(52);
    expect(page.role).toBe("owner");
    expect(page.commentScope).toBe("all");
    expect(result.stderr).not.toContain("You see only the threads you started");
    expect(page.humanCheck).toBe(false);
    expect(
      server.requests.slice(before).filter((r) => r.path.endsWith("/annotations")),
    ).toHaveLength(2);
    expect(result.stderr).toContain(UNTRUSTED_ANNOTATIONS_NOTICE);

    // With the cursor only what changed since comes back, and deleted threads are listed.
    const [first] = page.threads as AnnotationThreadView[];
    await h.invoke("annotations", "delete-thread", artifact.id, first?.id ?? "", "--yes");
    const later = json(
      await h.invoke("annotations", "list", artifact.id, "--cursor", page.cursor, "--json"),
    );
    expect(later.threads).toEqual([]);
    expect(later.removed).toEqual([first?.id]);
    const text = await h.invoke("annotations", "list", artifact.id, "--cursor", page.cursor);
    expect(text.stdout).toContain(`Removed since the cursor: ${first?.id}`);
  });

  it("filters by status and version, and refuses unknown filters", async () => {
    const artifact = reviewed();
    const thread = await startThread(artifact);
    await startThread(artifact, "Other");
    await h.invoke("annotations", "resolve", artifact.id, thread.id);
    const resolved = json(
      await h.invoke(
        "annotations",
        "list",
        artifact.id,
        "--status",
        "resolved",
        "--version",
        "all",
        "--json",
      ),
    );
    expect(resolved.threads.map((t: AnnotationThreadView) => t.id)).toEqual([thread.id]);
    for (const [flag, value] of [
      ["--status", "closed"],
      ["--version", "bad id!"],
    ] as const) {
      const bad = await h.invoke("annotations", "list", artifact.id, flag, value);
      expect(bad.code).toBe(2);
    }
  });

  it("prints threads as text with reviewer text stripped of control characters", async () => {
    const artifact = reviewed();
    const thread = await startThread(artifact, "Line one\n\tLine two");
    const stored = server.annotations.threads.get(thread.id);
    if (stored?.messages[0]?.author) stored.messages[0].author.name = "Eve\u001b[31m\u202e";
    const result = await h.invoke("annotations", "list", artifact.id);
    expect(result.stdout).toContain(`Thread ${thread.id} (open) on pages/home.html`);
    expect(result.stdout).toContain("Eve[31m");
    expect(result.stdout).not.toContain("\u001b");
    expect(result.stdout).not.toContain("\u202e");
    expect(result.stdout).toContain("    Line one\n    \tLine two\n");
    expect(result.stderr).toContain(`portifact annotations list ${artifact.id} --cursor`);

    const shown = await h.invoke("annotations", "show", artifact.id, thread.id);
    expect(shown.stdout).toContain("rev 1  (you)");
    const shownJson = json(await h.invoke("annotations", "show", artifact.id, thread.id, "--json"));
    expect(shownJson.id).toBe(thread.id);
    expect((await h.invoke("annotations", "show", artifact.id, "bad id!")).code).toBe(2);
    expect((await h.invoke("annotations", "show", artifact.id, "missing")).code).toBe(5);
  });

  it("explains an empty list", async () => {
    const off = reviewed("off");
    const result = await h.invoke("annotations", "list", off.id);
    expect(result.stdout).toContain("Annotations are off; turn them on with");
    const open = reviewed();
    expect((await h.invoke("annotations", "list", open.id)).stdout).toContain(
      "has no threads yet.",
    );
  });

  it("tells a reader who sees only their own threads and the owner's", async () => {
    const artifact = reviewed();
    server.annotations.role = "participant";
    server.annotations.commentScope = "own";
    const text = await h.invoke("annotations", "list", artifact.id);
    expect(text.stderr).toContain(
      "You see only the threads you started and the threads the owner started; the owner chooses who sees the rest.",
    );
    const output = await h.invoke("annotations", "list", artifact.id, "--json");
    expect(json(output)).toMatchObject({ role: "participant", commentScope: "own" });
  });
});

describe("portifact annotations on a thread the reader no longer sees", () => {
  it("edits and deletes the reader's own message and says the thread is not visible", async () => {
    const artifact = reviewed();
    const thread = await startThread(artifact);
    server.annotations.outOfScope.add(thread.id);
    const messageId = thread.messages[0]?.id ?? "";
    const edited = await h.invoke(
      "annotations",
      "edit",
      artifact.id,
      messageId,
      "--body-file",
      await bodyFile("Redacted"),
      "--revision",
      "1",
    );
    expect(edited.code).toBe(0);
    expect(edited.stdout).toBe(
      `Edited message ${messageId}.\nYou no longer see thread ${thread.id}: the owner limited who sees comments, or it is gone.\n`,
    );
    const json_ = await h.invoke(
      "annotations",
      "edit",
      artifact.id,
      messageId,
      "--body-file",
      await bodyFile("Again"),
      "--revision",
      "2",
      "--json",
    );
    expect(json(json_)).toEqual({ threadId: thread.id, thread: null });
    const deleted = await h.invoke("annotations", "delete", artifact.id, messageId, "--yes");
    expect(deleted.stdout).toContain(`You no longer see thread ${thread.id}`);
  });
});

describe("portifact annotations reply, edit, resolve and reopen", () => {
  it("replies, edits by revision and changes the thread state", async () => {
    const artifact = reviewed();
    const thread = await startThread(artifact);
    const replied = await h.invoke(
      "annotations",
      "reply",
      artifact.id,
      thread.id,
      "--body-file",
      await bodyFile("Second"),
    );
    expect(replied.stdout).toContain(`Replied in thread ${thread.id}.`);
    const [reply] = requests("POST", /\/messages$/);
    expect(reply?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);

    const messageId = thread.messages[0]?.id ?? "";
    const edited = await h.invoke(
      "annotations",
      "edit",
      artifact.id,
      messageId,
      "--body-file",
      await bodyFile("First, edited"),
      "--revision",
      "1",
      "--json",
    );
    expect(json(edited).messages[0]).toMatchObject({ body: "First, edited", revision: 2 });
    const stale = await h.invoke(
      "annotations",
      "edit",
      artifact.id,
      messageId,
      "--body-file",
      await bodyFile("Again"),
      "--revision",
      "1",
    );
    expect(stale.code).toBe(6);
    expect(requests("PATCH", /\/messages\//)).toHaveLength(2);
    const badRevision = await h.invoke(
      "annotations",
      "edit",
      artifact.id,
      messageId,
      "--body-file",
      await bodyFile("x"),
      "--revision",
      "0",
    );
    expect(badRevision.code).toBe(2);
    expect(badRevision.stderr).toContain("Use the message revision");

    const resolved = await h.invoke("annotations", "resolve", artifact.id, thread.id);
    expect(resolved.stdout).toContain(`Thread ${thread.id} is resolved.`);
    const again = json(await h.invoke("annotations", "resolve", artifact.id, thread.id, "--json"));
    expect(again.state).toBe("resolved");
    const reopened = await h.invoke("annotations", "reopen", artifact.id, thread.id);
    expect(reopened.stdout).toContain(`Thread ${thread.id} is open.`);
  });
});

describe("portifact annotations delete, moderate and delete-thread", () => {
  it("asks before deleting a message and needs --yes without a terminal", async () => {
    const artifact = reviewed();
    const thread = await startThread(artifact);
    const messageId = thread.messages[0]?.id ?? "";
    const refused = await h.invoke("annotations", "delete", artifact.id, messageId, "--json");
    expect(refused.code).toBe(2);
    expect(json(refused).error.message).toContain(
      `portifact annotations delete ${artifact.id} ${messageId} --yes`,
    );
    expect(requests("DELETE", /\/messages\//)).toHaveLength(0);

    const deleted = await h.invoke("annotations", "delete", artifact.id, messageId, "--yes");
    expect(deleted.code).toBe(0);
    expect(deleted.stdout).toContain(`Deleted message ${messageId}.`);
    expect(deleted.stdout).toContain(
      `You no longer see thread ${thread.id}: the owner limited who sees comments, or it is gone.`,
    );
  });

  it("deletes after typing delete at the prompt and cancels otherwise", async () => {
    const artifact = reviewed();
    const thread = await startThread(artifact);
    await h.invoke(
      "annotations",
      "reply",
      artifact.id,
      thread.id,
      "--body-file",
      await bodyFile("Two"),
    );
    const messageId = thread.messages[0]?.id ?? "";
    const prompted = await createHarness({ server, answers: ["no", " DELETE "] });
    prompted.signIn();
    try {
      const cancelled = await prompted.invoke("annotations", "delete", artifact.id, messageId);
      expect(cancelled.code).toBe(1);
      expect(cancelled.stderr).toContain('the confirmation was not "delete"');
      const confirmed = await prompted.invoke(
        "annotations",
        "delete",
        artifact.id,
        messageId,
        "--json",
      );
      expect(json(confirmed)).toMatchObject({ artifactId: artifact.id, threadId: thread.id });
      expect(json(confirmed).thread.messages[0]).toMatchObject({ state: "deleted", body: null });
      expect(prompted.prompts[0]).toContain(`This deletes your message ${messageId} for everyone.`);
    } finally {
      await prompted.cleanup();
    }
  });

  it("hides and unhides without asking and confirms a moderation delete", async () => {
    const artifact = reviewed();
    const thread = await startThread(artifact);
    await h.invoke(
      "annotations",
      "reply",
      artifact.id,
      thread.id,
      "--body-file",
      await bodyFile("Two"),
    );
    const messageId = thread.messages[0]?.id ?? "";

    const hidden = await h.invoke("annotations", "moderate", artifact.id, messageId, "hide");
    expect(hidden.stdout).toContain(`Hid message ${messageId}.`);
    expect(server.annotations.threads.get(thread.id)?.messages[0]?.state).toBe("hidden");
    const shown = await h.invoke(
      "annotations",
      "moderate",
      artifact.id,
      messageId,
      "unhide",
      "--json",
    );
    expect(json(shown).thread.messages[0].state).toBe("visible");
    const text = await h.invoke("annotations", "moderate", artifact.id, messageId, "unhide");
    expect(text.stdout).toContain("is visible again");

    const unconfirmed = await h.invoke("annotations", "moderate", artifact.id, messageId, "delete");
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.stderr).toContain(`moderate ${artifact.id} ${messageId} delete --yes`);
    const removed = await h.invoke(
      "annotations",
      "moderate",
      artifact.id,
      messageId,
      "delete",
      "--yes",
    );
    expect(removed.stdout).toContain(`Deleted message ${messageId}.`);
    expect(requests("POST", /\/moderation$/).map((r) => JSON.parse(r.body).action)).toEqual([
      "hide",
      "unhide",
      "unhide",
      "delete",
    ]);

    const bad = await h.invoke("annotations", "moderate", artifact.id, messageId, "edit");
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("is not a moderation action");
    expect((await h.invoke("annotations", "moderate", artifact.id, "bad id!", "hide")).code).toBe(
      2,
    );

    server.annotations.role = "participant";
    const forbidden = await h.invoke(
      "annotations",
      "moderate",
      artifact.id,
      messageId,
      "hide",
      "--json",
    );
    expect(forbidden.code).toBe(5);
    expect(json(forbidden)).toMatchObject({ error: { code: "forbidden" } });
  });

  it("deletes a whole thread after a confirmation", async () => {
    const artifact = reviewed();
    const thread = await startThread(artifact);
    const unconfirmed = await h.invoke("annotations", "delete-thread", artifact.id, thread.id);
    expect(unconfirmed.code).toBe(2);
    const prompted = await createHarness({ server, answers: ["delete"] });
    prompted.signIn();
    try {
      const deleted = await prompted.invoke("annotations", "delete-thread", artifact.id, thread.id);
      expect(deleted.stdout).toContain(`Deleted thread ${thread.id} and all its messages.`);
      expect(prompted.prompts[0]).toContain(`This deletes thread ${thread.id}`);
    } finally {
      await prompted.cleanup();
    }
    const again = await h.invoke(
      "annotations",
      "delete-thread",
      artifact.id,
      thread.id,
      "--yes",
      "--json",
    );
    expect(again.code).toBe(5);
    const other = await startThread(artifact);
    const result = await h.invoke(
      "annotations",
      "delete-thread",
      artifact.id,
      other.id,
      "--yes",
      "--json",
    );
    expect(json(result)).toEqual({ artifactId: artifact.id, threadId: other.id, deleted: true });
  });
});

describe("portifact annotations export", () => {
  it("writes JSON or Markdown to stdout with the notice on stderr", async () => {
    const artifact = reviewed();
    await startThread(artifact, "Ship it");
    const exported = await h.invoke("annotations", "export", artifact.id);
    expect(exported.code).toBe(0);
    const data = json(exported);
    expect(data.notice).toBe(UNTRUSTED_ANNOTATIONS_NOTICE);
    expect(data.threads).toHaveLength(1);
    expect(exported.stderr).toContain(UNTRUSTED_ANNOTATIONS_NOTICE);

    const markdown = await h.invoke(
      "annotations",
      "export",
      artifact.id,
      "--format",
      "markdown",
      "--status",
      "open",
    );
    expect(markdown.stdout).toContain("Ship it");
    expect(markdown.stdout).toContain(`> ${UNTRUSTED_ANNOTATIONS_NOTICE}`);
    expect((await h.invoke("annotations", "export", artifact.id, "--format", "pdf")).code).toBe(2);
  });

  it("writes a new file with --out and never overwrites one", async () => {
    const artifact = reviewed();
    await startThread(artifact, "Ship it");
    const out = join(h.workspace, "feedback.md");
    const written = await h.invoke(
      "annotations",
      "export",
      artifact.id,
      "--format",
      "markdown",
      "--out",
      out,
    );
    expect(written.code).toBe(0);
    expect(written.stdout).toContain(`as Markdown to ${out}`);
    expect(await readFile(out, "utf8")).toContain("Ship it");

    const again = await h.invoke("annotations", "export", artifact.id, "--out", out, "--json");
    expect(again.code).toBe(2);
    expect(json(again).error.message).toContain("already exists");

    const jsonOut = join(h.workspace, "feedback.json");
    const summary = json(
      await h.invoke("annotations", "export", artifact.id, "--out", jsonOut, "--json"),
    );
    expect(summary).toMatchObject({
      artifactId: artifact.id,
      format: "json",
      out: jsonOut,
      threads: 1,
    });
    expect(JSON.parse(await readFile(jsonOut, "utf8")).threads).toHaveLength(1);
    expect(summary.bytes).toBe((await readFile(jsonOut)).length);

    const markdownOut = join(h.workspace, "plain.md");
    const md = json(
      await h.invoke(
        "annotations",
        "export",
        artifact.id,
        "--format",
        "markdown",
        "--out",
        markdownOut,
        "--json",
      ),
    );
    expect(md).not.toHaveProperty("threads");
    const unwritable = await h.invoke(
      "annotations",
      "export",
      artifact.id,
      "--out",
      join(h.workspace, "no", "dir.json"),
    );
    expect(unwritable.code).toBe(2);
    expect(unwritable.stderr).toContain("Could not write");
  });

  it("needs the annotations scope like every annotation command", async () => {
    const artifact = reviewed();
    h.signIn(["artifacts:read", "offline_access"]);
    const result = await h.invoke("annotations", "export", artifact.id, "--json");
    expect(result.code).toBe(5);
    expect(json(result)).toMatchObject({ error: { code: "forbidden" } });
  });
});

describe("text formatting", () => {
  const base = {
    id: "t1",
    versionId: "ver_old",
    current: false,
    path: "index.html",
    state: "open" as const,
    author: null,
    own: false,
    byOwner: false,
    revision: 1,
    createdAt: "2026-11-08T12:00:00.000Z",
    updatedAt: "2026-11-08T12:00:00.000Z",
    resolvedAt: null,
  };

  it("shows elements, older versions, hidden, deleted and nameless messages", () => {
    const output = formatThread({
      ...base,
      target: {
        schema: 1,
        path: "index.html",
        anchor: { kind: "element", selectors: ["h1"], tagName: "h1", fingerprint: "Title" },
      },
      messages: [
        {
          id: "m1",
          author: null,
          own: false,
          state: "hidden",
          body: null,
          revision: 1,
          createdAt: base.createdAt,
          editedAt: null,
        },
        {
          id: "m2",
          author: { id: "u", name: "", image: null },
          own: false,
          state: "deleted",
          body: null,
          revision: 2,
          createdAt: base.createdAt,
          editedAt: base.createdAt,
        },
      ],
    });
    expect(output).toContain("version ver_old (not the current one)");
    expect(output).toContain('Element: <h1> "Title"');
    expect(output).toContain("(deleted account)");
    expect(output).toContain("(hidden by the owner)");
    expect(output).toContain("(no name)");
    expect(output).toContain("(deleted, edited)");
  });

  it("keeps line feeds and tabs and drops other control and direction characters", () => {
    expect(plain("a\u0000b\nc\td\u2028e\u2066f\u0085")).toBe("ab\nc\tdef");
  });
});

describe("annotations history", () => {
  const entry = (seq: number, kind: "thread_created" | "message_edited", name: string | null) => ({
    seq,
    threadId: "th_1",
    messageId: kind === "message_edited" ? "msg_1" : null,
    kind,
    actor: name === null ? null : { id: `u_${seq}`, name, image: null },
    at: "2026-11-01T09:30:00.000Z",
  });

  it("prints every page of who did what and when, without text, and as JSON", async () => {
    const artifact = reviewed();
    const entries = [
      ...Array.from({ length: 600 }, (_, i) => entry(i + 1, "thread_created", "Ada")),
      entry(601, "message_edited", "Bob\u001b[31m"),
      entry(602, "message_edited", null),
    ];
    server.annotations.history.set(artifact.id, entries);
    const text = await h.invoke("annotations", "history", artifact.id);
    expect(text.code).toBe(0);
    const lines = text.stdout.trim().split("\n");
    expect(lines).toHaveLength(602);
    expect(lines[0]).toBe("2026-11-01 09:30 UTC  thread created  thread th_1  by Ada");
    expect(lines[600]).toBe(
      "2026-11-01 09:30 UTC  message edited  thread th_1, message msg_1  by Bob[31m",
    );
    expect(lines[601]).toContain("by (deleted account)");
    expect(text.stderr).toContain(UNTRUSTED_ANNOTATIONS_NOTICE);
    expect(requests("GET", /\/history/)).toHaveLength(2);

    const asJson = json(await h.invoke("annotations", "history", artifact.id, "--json"));
    expect(asJson).toEqual({ artifactId: artifact.id, entries });
  });

  it("says when there is no history, and refuses a reader like the server does", async () => {
    const artifact = reviewed();
    const empty = await h.invoke("annotations", "history", artifact.id);
    expect(empty.stdout).toBe(`${artifact.id} has no comment history yet.\n`);
    server.annotations.role = "participant";
    const refused = await h.invoke("annotations", "history", artifact.id, "--json");
    expect(refused.code).toBe(5);
    expect(json(refused).error.code).toBe("forbidden");
    expect((await h.invoke("annotations", "history", "nope")).code).toBe(2);
  });

  it("refuses IDs outside their format instead of printing them", async () => {
    const artifact = reviewed();
    server.annotations.history.set(artifact.id, [
      { ...entry(1, "thread_created", "Ada"), threadId: "th\u001b[2J" },
    ]);
    const result = await h.invoke("annotations", "history", artifact.id);
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("\u001b");
    expect(result.stderr).not.toContain("\u001b[2J");
  });
});
