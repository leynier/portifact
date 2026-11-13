import { env } from "cloudflare:test";
import { regionsFromEnv, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { OPERATOR_USAGE, operatorTarget, parseArgs, runOperator } from "../src/operator.ts";

const NOW = Date.UTC(2026, 10, 8, 12);
const db = () => regionsFromEnv(env).get("default").db;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
/** The statement of reasons every restriction needs, and the facts of a reinstatement. */
const WHY = [
  "--facts",
  "It asks for bank passwords.",
  "--ground",
  "Acceptable Use Policy: phishing.",
];
const LIFT = ["--facts", "The owner removed the page."];
const RECORDED =
  "The statement of reasons is recorded; the people affected are emailed shortly (see: decisions).";

function artifactId(): string {
  let id = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(10))) id += ALPHABET[byte % 32];
  return id;
}

async function owner(): Promise<{ id: string; email: string }> {
  const id = `u_${crypto.randomUUID()}`;
  const email = `${id}@example.test`;
  await db()
    .insert(schema.users)
    .values({
      id,
      name: "Owner",
      email,
      emailVerified: true,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    });
  await db()
    .insert(schema.accountUsage)
    .values({ ownerId: id, activeArtifacts: 1, monthStartedAt: NOW });
  return { id, email };
}

async function artifact(ownerId: string, accessMode: "public" | "restricted" = "public") {
  const id = artifactId();
  await db()
    .insert(schema.artifacts)
    .values({
      id,
      ownerId,
      type: "site",
      name: "Plan",
      state: "active",
      accessMode,
      expiresAt: NOW + 86_400_000,
    });
  return id;
}

const run = (...argv: string[]) => runOperator(db(), argv, NOW);

describe("operator arguments", () => {
  it("splits options from positional arguments", () => {
    const parsed = parseArgs([
      "suspend-artifact",
      "abc",
      "--reason",
      "spam",
      "--flag",
      "--note",
      "x y",
    ]);
    expect(parsed.positional).toEqual(["suspend-artifact", "abc"]);
    expect([...parsed.options]).toEqual([
      ["reason", "spam"],
      ["flag", ""],
      ["note", "x y"],
    ]);
  });

  it("targets production unless --local or --config says otherwise", () => {
    expect(operatorTarget(["budget"])).toEqual({
      ok: true,
      target: "production",
      config: null,
      args: ["budget"],
    });
    expect(operatorTarget(["--local", "reports", "--limit", "5"])).toEqual({
      ok: true,
      target: "local",
      config: null,
      args: ["reports", "--limit", "5"],
    });
    expect(
      operatorTarget([
        "export-tombstones",
        "--config",
        "/tmp/drill.jsonc",
        "--out",
        "/tmp/t.jsonl",
      ]),
    ).toEqual({
      ok: true,
      target: "config",
      config: "/tmp/drill.jsonc",
      args: ["export-tombstones", "--out", "/tmp/t.jsonl"],
    });
  });

  it("refuses a --config without a file and --config with --local", () => {
    for (const argv of [
      ["budget", "--config"],
      ["--config", "--local", "budget"],
      ["--local", "--config", "drill.jsonc", "budget"],
      ["--config", "drill.jsonc", "--local", "budget"],
    ]) {
      expect(operatorTarget(argv), argv.join(" ")).toMatchObject({ ok: false });
    }
    expect(operatorTarget(["--config"])).toEqual({
      ok: false,
      message: "--config needs a Wrangler configuration file.",
    });
    expect(operatorTarget(["--local", "--config", "x.jsonc"])).toEqual({
      ok: false,
      message: "Use --local or --config, not both.",
    });
  });

  it("explains usage for missing or unknown commands and bad options", async () => {
    for (const argv of [
      [],
      ["launch"],
      ["reports", "--status", "weird"],
      ["reports", "--limit", "0"],
      ["resolve-report", "rep_1", "maybe"],
      ["show-artifact"],
      ["suspend-artifact", "abc"],
      ["suspend-artifact", "abc", "--reason", "boredom"],
      ["suspend-artifact", "abc", "--reason", "spam"],
      ["suspend-artifact", "abc", "--reason", "spam", "--facts", "x"],
      ["suspend-artifact", "abc", "--reason", "spam", ...WHY, "--source", "maybe"],
      ["suspend-artifact", "abc", "--reason", "spam", "--facts", "x".repeat(2001), "--ground", "g"],
      ["reinstate-artifact"],
      ["reinstate-artifact", "abc"],
      ["suspend-account", "someone"],
      ["suspend-account", "someone", "--reason", "spam"],
      ["reinstate-account"],
      ["reinstate-account", "someone"],
      ["suspend-brand", "someone", "--reason", "spam"],
      ["reinstate-brand", "someone"],
      ["report"],
      ["decisions", "artifact"],
      ["decisions", "thing", "x"],
      ["hold-artifact", "abc"],
      ["hold-artifact", "abc", "--ground", "g", "--until", "never"],
      ["hold-artifact", "abc", "--ground", "g", "--until", "12/11/2027"],
      ["hold-artifact", "abc", "--ground", "g", "--until", "2027-11-12T10:00:00"],
      ["hold-artifact", "abc", "--ground", "g", "--until", "2027-02-30"],
      ["send-statement", "artifact"],
      ["send-statement", "thing", "x"],
      ["release-hold"],
      ["hold"],
      ["holds", "--limit", "0"],
    ]) {
      const result = await run(...argv);
      expect(result.exitCode, argv.join(" ")).toBe(2);
      expect(result.output).toContain(OPERATOR_USAGE);
    }
  });
});

describe("operator commands", () => {
  it("lists reports as plain lines and resolves them", async () => {
    const user = await owner();
    const id = await artifact(user.id);
    await db().insert(schema.abuseReports).values({
      id: "rep_operator",
      artifactId: id,
      reporterEmail: "reporter@example.test",
      reason: "phishing",
      details: "line one\nline two\u001b[31m",
      createdAt: NOW,
    });
    const listed = await run("reports");
    expect(listed.exitCode).toBe(0);
    const line = listed.output.split("\n").find((l) => l.startsWith("rep_operator"));
    expect(line).toContain(`open  ${id}  phishing  report  has-email  line one line two`);
    // The reporter's address is not printed.
    expect(listed.output).not.toContain("reporter@example.test");

    expect(await run("resolve-report", "rep_operator", "actioned")).toEqual({
      exitCode: 0,
      output: "Report rep_operator marked actioned. The reporter is emailed the outcome shortly.",
    });
    expect((await run("reports", "--status", "actioned", "--limit", "500")).output).toContain(
      "rep_operator",
    );
    expect(await run("resolve-report", "rep_missing", "dismissed")).toMatchObject({
      exitCode: 1,
    });
    expect((await run("reports", "--status", "dismissed")).output).toBe("No reports.");
  });

  it("suspends and reinstates an artifact, and shows it", async () => {
    const user = await owner();
    const id = await artifact(user.id);
    expect(
      await run("suspend-artifact", id, "--reason", "malware", "--note", "seen it", ...WHY),
    ).toMatchObject({
      exitCode: 0,
      output: expect.stringMatching(
        new RegExp(`^Suspended ${id} \\(sus_\\w+\\)\\. ${RECORDED.replace(/[().]/g, "\\$&")}$`),
      ),
    });
    expect((await run("suspend-artifact", id, "--reason", "malware", ...WHY)).output).toContain(
      "was already suspended",
    );
    expect((await run("show-artifact", id)).output).toContain("state     suspended (malware)");
    expect(await run("reinstate-artifact", id, ...LIFT)).toEqual({
      exitCode: 0,
      output: `Reinstated ${id} as active. ${RECORDED}`,
    });
    expect((await run("reinstate-artifact", id, ...LIFT)).output).toBe(
      `${id} was not suspended; it is active.`,
    );
    expect(await run("show-artifact", "zzzzzzzzzz")).toEqual({
      exitCode: 1,
      output: "Artifact not found.",
    });
    expect((await run("suspend-artifact", "zzzzzzzzzz", "--reason", "spam", ...WHY)).exitCode).toBe(
      1,
    );
    expect((await run("reinstate-artifact", "zzzzzzzzzz", ...LIFT)).exitCode).toBe(1);
  });

  it("suspends and reinstates an account by email or ID", async () => {
    const user = await owner();
    const id = await artifact(user.id);
    expect(
      await run("suspend-account", user.email.toUpperCase(), "--reason", "spam", ...WHY),
    ).toEqual({
      exitCode: 0,
      output: `Suspended account ${user.id} and 1 artifact(s). ${RECORDED}`,
    });
    expect((await run("suspend-account", user.id, "--reason", "spam", ...WHY)).output).toBe(
      `Account ${user.id} was already suspended; nothing was recorded or sent.`,
    );
    expect((await run("show-artifact", id)).output).toContain("(account suspended: spam)");
    expect(await run("reinstate-account", user.email, ...LIFT)).toEqual({
      exitCode: 0,
      output: `Reinstated account ${user.id} and 1 artifact(s). ${RECORDED}`,
    });
    expect((await run("reinstate-account", user.id, ...LIFT)).output).toBe(
      `Account ${user.id} was not suspended.`,
    );
    const [row] = await db().select().from(schema.artifacts).where(eq(schema.artifacts.id, id));
    expect(row?.state).toBe("active");
    for (const command of ["suspend-account", "reinstate-account"]) {
      expect((await run(command, "nobody@example.test", "--reason", "spam", ...WHY)).output).toBe(
        "Account not found.",
      );
    }
    expect((await run("suspend-account", "u_missing", "--reason", "spam", ...WHY)).exitCode).toBe(
      1,
    );
  });
});

/** An in-memory file system for the backup commands. */
function memoryFiles(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    read: async (path: string) => {
      const text = store.get(path);
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    write: async (path: string, text: string) => {
      store.set(path, text);
    },
  };
}

describe("operator backup commands", () => {
  it("lists storage findings, or says there are none", async () => {
    await db().delete(schema.storageFindings);
    expect(await run("storage-report")).toEqual({ exitCode: 0, output: "No storage findings." });
    await db()
      .insert(schema.storageFindings)
      .values([
        { kind: "missing", r2Key: "objects/u_a/1", firstSeenAt: NOW, lastSeenAt: NOW },
        {
          kind: "size_mismatch",
          r2Key: "objects/u_a/2",
          detail: "row 3 bytes, object 7 bytes",
          firstSeenAt: NOW,
          lastSeenAt: NOW,
        },
      ]);
    const report = await run("storage-report", "--limit", "10");
    expect(report.exitCode).toBe(0);
    expect(report.output.split("\n")).toEqual([
      `missing  objects/u_a/1  first ${new Date(NOW).toISOString()}  last ${new Date(NOW).toISOString()}`,
      `size_mismatch  objects/u_a/2  first ${new Date(NOW).toISOString()}  last ${new Date(NOW).toISOString()}  row 3 bytes, object 7 bytes`,
    ]);
    expect((await run("storage-report", "--limit", "0")).exitCode).toBe(2);
  });

  it("exports tombstones to a file and applies them after a restore, once", async () => {
    const user = await owner();
    const id = await artifact(user.id);
    await db()
      .insert(schema.tombstones)
      .values([
        { kind: "artifact", id, deletedAt: NOW },
        { kind: "account", id: user.id, deletedAt: NOW },
      ]);
    const files = memoryFiles();
    const exported = await runOperator(db(), ["export-tombstones", "--out", "t.jsonl"], NOW, files);
    expect(exported.exitCode).toBe(0);
    const lines = (files.store.get("t.jsonl") ?? "").trim().split("\n");
    expect(lines).toContain(JSON.stringify({ kind: "artifact", id, deletedAt: NOW }));
    const holdLines = lines.filter((l) => l.startsWith('{"legalHold"')).length;
    const markerLines = lines.length - holdLines;
    expect(exported.output).toBe(
      `Wrote ${markerLines} tombstone marker(s) and ${holdLines} legal hold(s) to t.jsonl.`,
    );

    // The restore lost the tombstones; the resurrected rows are still there.
    await db().delete(schema.tombstones);
    const applied = await runOperator(db(), ["apply-tombstones", "--file", "t.jsonl"], NOW, files);
    expect(applied).toEqual({
      exitCode: 0,
      // Other tests in this file write artifacts without directory rows, so the count varies.
      output: expect.stringMatching(
        new RegExp(
          `^Applied tombstones: ${markerLines} restored, 1 artifact\\(s\\) claimed for purging, 1 account\\(s\\) and 0 workspace\\(s\\) deleted again, 0 share link\\(s\\) revoked again, 0 service token\\(s\\) deleted again, 0 group\\(s\\) and 0 group membership\\(s\\) removed again, 0 single sign-on provider\\(s\\) removed again, 0 membership\\(s\\) ended again, 0 invitation\\(s\\) withdrawn again, 0 comment thread\\(s\\) and 0 message\\(s\\) deleted again, 0 suggestion\\(s\\) withdrawn and 0 rejected again, 0 draft\\(s\\) removed again, 0 email preference\\(s\\) turned off again, 0 notice mute\\(s\\) set again, 0 data grant\\(s\\) revoked again, \\d+ session\\(s\\) ended again, \\d+ app token\\(s\\) revoked again, \\d+ app consent\\(s\\) withdrawn again, 0 issue connection\\(s\\) removed again, [1-9]\\d* artifact directory row\\(s\\) rebuilt, 0 legal hold\\(s\\) put back \\(0 artifact\\(s\\) suspended again\\)\\. The jobs Worker purges them on its next runs\\.$`,
        ),
      ),
    });
    const [row] = await db().select().from(schema.artifacts).where(eq(schema.artifacts.id, id));
    expect(row?.state).toBe("purging");
    expect(await db().select().from(schema.users).where(eq(schema.users.id, user.id))).toEqual([]);

    expect(
      (await runOperator(db(), ["apply-tombstones", "--file", "t.jsonl"], NOW, files)).output,
    ).toBe(
      "Applied tombstones: 0 restored, 0 artifact(s) claimed for purging, 0 account(s) and 0 workspace(s) deleted again, 0 share link(s) revoked again, 0 service token(s) deleted again, 0 group(s) and 0 group membership(s) removed again, 0 single sign-on provider(s) removed again, 0 membership(s) ended again, 0 invitation(s) withdrawn again, 0 comment thread(s) and 0 message(s) deleted again, 0 suggestion(s) withdrawn and 0 rejected again, 0 draft(s) removed again, 0 email preference(s) turned off again, 0 notice mute(s) set again, 0 data grant(s) revoked again, 0 session(s) ended again, 0 app token(s) revoked again, 0 app consent(s) withdrawn again, 0 issue connection(s) removed again, 0 artifact directory row(s) rebuilt, 0 legal hold(s) put back (0 artifact(s) suspended again). The jobs Worker purges them on its next runs.",
    );
    expect((await run("apply-tombstones")).exitCode).toBe(0);
  });

  it("refuses a tombstone file with a bad line and applies nothing", async () => {
    const user = await owner();
    const id = await artifact(user.id);
    const files = memoryFiles({
      "bad.jsonl": `${JSON.stringify({ kind: "artifact", id, deletedAt: NOW })}\n{"kind":"version","id":"x","deletedAt":1}\n`,
      "broken.jsonl": "not json\n",
    });
    expect(
      await runOperator(db(), ["apply-tombstones", "--file", "bad.jsonl"], NOW, files),
    ).toEqual({
      exitCode: 1,
      output: "Line 2 of bad.jsonl is not a tombstone marker; nothing was applied.",
    });
    expect(
      (await runOperator(db(), ["apply-tombstones", "--file", "broken.jsonl"], NOW, files)).output,
    ).toBe("Line 1 of broken.jsonl is not a tombstone marker; nothing was applied.");
    const [row] = await db().select().from(schema.artifacts).where(eq(schema.artifacts.id, id));
    expect(row?.state).toBe("active");
  });

  it("needs a path for the tombstone files", async () => {
    expect((await run("export-tombstones")).exitCode).toBe(2);
    expect((await run("apply-tombstones", "--file")).exitCode).toBe(2);
    await expect(run("export-tombstones", "--out", "x.jsonl")).rejects.toThrow("No file access.");
    await expect(run("apply-tombstones", "--file", "x.jsonl")).rejects.toThrow("No file access.");
  });
});

describe("operator share link lookup", () => {
  it("finds a reported link's artifact from standard input, never printing the token", async () => {
    const { id: ownerId } = await owner();
    const artifactId = await artifact(ownerId, "restricted");
    const token = "Tk_".padEnd(43, "x");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const tokenHash = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const linkId = `sl_${"a".repeat(32)}`;
    await db().insert(schema.shareLinks).values({
      id: linkId,
      artifactId,
      tokenHash,
      label: "Board",
      createdBy: ownerId,
      createdAt: NOW,
    });
    const stdin = (text: string) => memoryFiles({ "/dev/stdin": text });
    const found = await runOperator(
      db(),
      ["find-share-link"],
      NOW,
      stdin(`https://app.portifact.com/s#${token}\n`),
    );
    expect(found.exitCode).toBe(0);
    expect(found.output).toContain(`artifact  ${artifactId}`);
    expect(found.output).toContain(`link      ${linkId}  active`);
    expect(found.output).not.toContain(token);
    expect((await runOperator(db(), ["find-share-link"], NOW, stdin(token))).exitCode).toBe(0);
    expect(await runOperator(db(), ["find-share-link"], NOW, stdin("B".repeat(43)))).toEqual({
      exitCode: 1,
      output: "No share link has this token.",
    });
    expect((await runOperator(db(), ["find-share-link"], NOW, stdin("not a token"))).exitCode).toBe(
      2,
    );
  });
});

describe("operator service token commands", () => {
  it("finds a leaked token from standard input and revokes it, never printing the secret", async () => {
    const { id: adminId } = await owner();
    const workspaceId = `ws_${"c".repeat(32)}`;
    await db().insert(schema.workspaces).values({
      id: workspaceId,
      slug: "leaky",
      name: "Leaky",
      createdBy: adminId,
      updatedAt: NOW,
    });
    // Built at run time so nothing committed matches the secret scanner's rule for the prefix.
    const secret = ["pf", "st_", "L".repeat(43)].join("");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    const tokenHash = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const tokenId = `st_${"d".repeat(32)}`;
    await db()
      .insert(schema.serviceTokens)
      .values({
        id: tokenId,
        workspaceId,
        label: "CI",
        role: "editor",
        scopes: "artifacts:read",
        tokenHash,
        createdBy: adminId,
        createdAt: NOW,
        expiresAt: NOW + 86_400_000,
      });
    const stdin = (text: string) => memoryFiles({ "/dev/stdin": text });
    const found = await runOperator(db(), ["find-service-token"], NOW, stdin(`${secret}\n`));
    expect(found.exitCode).toBe(0);
    expect(found.output).toContain(`token      ${tokenId}  CI`);
    expect(found.output).toContain("workspace  leaky");
    expect(found.output).not.toContain(secret);
    expect(await runOperator(db(), ["revoke-service-token", "st_bad"], NOW)).toMatchObject({
      exitCode: 2,
    });
    expect((await runOperator(db(), ["revoke-service-token", tokenId], NOW)).exitCode).toBe(0);
    expect((await runOperator(db(), ["revoke-service-token", tokenId], NOW)).exitCode).toBe(1);
    expect(await runOperator(db(), ["find-service-token"], NOW, stdin(secret))).toEqual({
      exitCode: 1,
      output: "No service token has this secret.",
    });
    const [tombstone] = await db()
      .select()
      .from(schema.tombstones)
      .where(eq(schema.tombstones.id, tokenId));
    expect(tombstone?.kind).toBe("service_token");
  });
});

describe("operator SCIM token commands", () => {
  it("finds a leaked SCIM token from standard input and revokes it, never printing the secret", async () => {
    const { id: adminId } = await owner();
    const workspaceId = `ws_${"e".repeat(32)}`;
    await db().insert(schema.workspaces).values({
      id: workspaceId,
      slug: "directory",
      name: "Directory",
      createdBy: adminId,
      updatedAt: NOW,
    });
    // Built at run time so nothing committed matches the secret scanner's rule for the prefix.
    const secret = ["pf", "sc_", "M".repeat(43)].join("");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    const tokenHash = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const tokenId = `sc_${"f".repeat(32)}`;
    await db()
      .insert(schema.scimTokens)
      .values({
        id: tokenId,
        workspaceId,
        label: "Okta",
        tokenHash,
        createdBy: adminId,
        createdAt: NOW,
        expiresAt: NOW + 86_400_000,
      });
    const stdin = (text: string) => memoryFiles({ "/dev/stdin": text });
    const found = await runOperator(db(), ["find-scim-token"], NOW, stdin(`${secret}\n`));
    expect(found.exitCode).toBe(0);
    expect(found.output).toContain(`token      ${tokenId}  Okta`);
    expect(found.output).toContain("workspace  directory");
    expect(found.output).toContain(`revoke-scim-token ${tokenId}`);
    expect(found.output).not.toContain(secret);
    expect(await runOperator(db(), ["revoke-scim-token", "sc_bad"], NOW)).toMatchObject({
      exitCode: 2,
    });
    expect((await runOperator(db(), ["revoke-scim-token", tokenId], NOW)).exitCode).toBe(0);
    expect((await runOperator(db(), ["revoke-scim-token", tokenId], NOW)).exitCode).toBe(1);
    expect(await runOperator(db(), ["find-scim-token"], NOW, stdin(secret))).toEqual({
      exitCode: 1,
      output: "No SCIM token has this secret.",
    });
    const [tombstone] = await db()
      .select()
      .from(schema.tombstones)
      .where(eq(schema.tombstones.id, tokenId));
    expect(tombstone?.kind).toBe("scim_token");
  });
});

describe("brand commands", () => {
  async function branded() {
    const account = await owner();
    await db()
      .insert(schema.ownerPlans)
      .values({ ownerId: account.id, plan: "pro", seats: 1, grantedBy: "test", updatedAt: NOW });
    await db()
      .insert(schema.ownerBrands)
      .values({
        ownerId: account.id,
        name: 'Acme "Labs"\nnext line',
        accentColor: "#1a2b3c",
        link: "https://acme.example.com/",
        logoSha256: "a".repeat(64),
        logoType: "image/png",
        logoWidth: 64,
        logoHeight: 32,
        logoBytes: 900,
        updatedAt: NOW,
      });
    return account;
  }

  it("shows a brand with its text on one quoted line each, and whether it is shown", async () => {
    const account = await branded();
    const shown = await run("brand", account.email);
    expect(shown.exitCode).toBe(0);
    expect(shown.output).toBe(
      [
        `owner       ${account.id}`,
        'name        "Acme \\"Labs\\" next line"',
        'link        "https://acme.example.com/"',
        "accent      #1a2b3c",
        `logo        image/png 64x32 900 bytes ${"a".repeat(64)}`,
        "suspended   no",
        "shown       yes",
      ].join("\n"),
    );
    const none = await owner();
    expect(await run("brand", none.id)).toEqual({
      exitCode: 0,
      output: `${none.id} has no brand.`,
    });
    expect((await run("brand")).exitCode).toBe(2);
    expect(await run("brand", "nobody@example.test")).toEqual({
      exitCode: 1,
      output: "Account not found.",
    });
  });

  it("suspends a brand back to the default bar and reinstates it, once each", async () => {
    const account = await branded();
    expect(await run("suspend-brand", account.id, "--reason", "impersonation", ...WHY)).toEqual({
      exitCode: 0,
      output: `Suspended the brand of ${account.id}; its viewer shows the default bar. ${RECORDED}`,
    });
    expect((await run("suspend-brand", account.id, "--reason", "phishing", ...WHY)).output).toBe(
      `The brand of ${account.id} was already suspended; nothing was recorded or sent.`,
    );
    const [row] = await db()
      .select()
      .from(schema.ownerBrands)
      .where(eq(schema.ownerBrands.ownerId, account.id));
    expect(row).toMatchObject({ suspendedAt: NOW, suspensionReason: "impersonation" });
    expect((await run("brand", account.id)).output).toContain(
      `suspended   ${new Date(NOW).toISOString()} (impersonation)\nshown       no (default bar)`,
    );
    expect(await run("reinstate-brand", account.email, ...LIFT)).toEqual({
      exitCode: 0,
      output: `Reinstated the brand of ${account.id}. ${RECORDED}`,
    });
    expect((await run("reinstate-brand", account.id, ...LIFT)).output).toBe(
      `The brand of ${account.id} was not suspended.`,
    );
    expect((await run("suspend-brand", account.id)).exitCode).toBe(2);
    expect((await run("suspend-brand", account.id, "--reason", "nope")).exitCode).toBe(2);
    expect((await run("reinstate-brand")).exitCode).toBe(2);
    const none = await owner();
    expect(await run("suspend-brand", none.id, "--reason", "spam", ...WHY)).toEqual({
      exitCode: 1,
      output: "This owner has no brand.",
    });
    expect(await run("reinstate-brand", none.id, ...LIFT)).toEqual({
      exitCode: 1,
      output: "This owner has no brand.",
    });
    expect((await run("suspend-brand", "x@example.test", "--reason", "spam", ...WHY)).output).toBe(
      "Account not found.",
    );
    expect((await run("reinstate-brand", "x@example.test", ...LIFT)).output).toBe(
      "Account not found.",
    );
  });
});

describe("notices, statements of reasons and legal holds", () => {
  it("shows one report in full, without the reporter's email", async () => {
    const user = await owner();
    const id = await artifact(user.id);
    await db()
      .insert(schema.abuseReports)
      .values({
        id: "rep_full",
        artifactId: id,
        reporterEmail: "reporter@example.test",
        reporterName: "Ada\nLovelace",
        address: `https://${id}.portifact.dev/a?b=1`,
        confirmed: true,
        locale: "es",
        reason: "harassment",
        details: "line one\nline two",
        createdAt: NOW,
      });
    const shown = await run("report", "rep_full");
    expect(shown.exitCode).toBe(0);
    expect(shown.output).toContain(`address    "https://${id}.portifact.dev/a?b=1"`);
    expect(shown.output).toContain("notice     full: the reporter confirmed");
    expect(shown.output).toContain('name       "Ada Lovelace"');
    expect(shown.output).toContain("email      given");
    expect(shown.output).toContain("language   es");
    expect(shown.output).toContain('details    "line one\\nline two"');
    expect(shown.output).not.toContain("reporter@example.test");
    expect((await run("reports", "--limit", "500")).output).toContain("full-notice");
    expect(await run("report", "rep_none")).toEqual({
      exitCode: 1,
      output: "No report with that ID.",
    });
    expect(await run("resolve-report", "rep_full", "actioned", "--withhold-notice")).toEqual({
      exitCode: 0,
      output: "Report rep_full marked actioned. The reporter's email is withheld.",
    });
  });

  it("refuses a --report that names no report", async () => {
    const user = await owner();
    const id = await artifact(user.id);
    expect(
      await run("suspend-artifact", id, "--reason", "spam", ...WHY, "--report", "rep_nope"),
    ).toEqual({
      exitCode: 1,
      output: "No report with that ID.",
    });
    const [row] = await db().select().from(schema.artifacts).where(eq(schema.artifacts.id, id));
    expect(row?.state).toBe("active");
  });

  it("sends a withheld statement later, once", async () => {
    const user = await owner();
    const id = await artifact(user.id);
    await run("suspend-artifact", id, "--reason", "child_safety", ...WHY, "--withhold-notice");
    expect((await run("send-statement", "artifact", id)).output).toMatch(
      /^Sending the withheld statement dec_\w+; the people affected are emailed shortly/,
    );
    expect((await run("send-statement", "artifact", id)).exitCode).toBe(1);
    expect((await run("send-statement", "artifact", id, ...WHY)).output).toMatch(
      /^Recorded and sending dec_/,
    );
    expect((await run("decisions", "artifact", id)).output).toContain("notice pending");
  });

  it("shows how many reports one email sent in the last day, so spam can be withheld", async () => {
    const user = await owner();
    const id = await artifact(user.id);
    for (const n of [1, 2, 3]) {
      await db()
        .insert(schema.abuseReports)
        .values({
          id: `rep_spammy_${n}`,
          artifactId: id,
          reporterEmail: "Spammy@example.test",
          reason: "spam",
          createdAt: NOW - n * 1000,
        });
    }
    expect((await run("report", "rep_spammy_1")).output).toContain(
      "email      given (3 report(s) with it in the last 24 hours)",
    );
  });

  it("records a statement of reasons, withheld or sent, and lists who it was sent to", async () => {
    const user = await owner();
    const id = await artifact(user.id);
    expect(
      (
        await run(
          "suspend-artifact",
          id,
          "--reason",
          "child_safety",
          ...WHY,
          "--source",
          "notice",
          "--withhold-notice",
        )
      ).output,
    ).toContain("The statement of reasons is recorded and withheld: nobody is emailed.");
    const listed = await run("decisions", "artifact", id);
    expect(listed.output).toMatch(
      /^dec_\w+ {2}\S+ {2}suspend {2}child_safety {2}notice {2}notice withheld$/m,
    );
    expect(listed.output).toContain('  facts   "It asks for bank passwords."');
    expect(listed.output).toContain('  ground  "Acceptable Use Policy: phishing."');
    expect(await run("decisions", "artifact", "zzzzzzzzzz")).toEqual({
      exitCode: 0,
      output: "No decisions recorded.",
    });
    expect((await run("decisions", "account", "nobody@example.test")).exitCode).toBe(1);
  });

  it("holds a suspended artifact, lists it, refuses its reinstatement and releases it", async () => {
    const user = await owner();
    const id = await artifact(user.id);
    expect((await run("hold-artifact", id, "--ground", "Authority")).output).toBe(
      "Suspend the artifact first: a held artifact is never served.",
    );
    await run("suspend-artifact", id, "--reason", "child_safety", ...WHY);
    const held = await run(
      "hold-artifact",
      id,
      "--ground",
      "Authority request 7",
      "--until",
      "2027-11-12",
    );
    expect(held.output).toMatch(
      new RegExp(`^Held ${id} \\(hold_\\w+\\) until 2027-11-12T00:00:00.000Z\\.`),
    );
    expect(await run("hold-artifact", id, "--ground", "Again")).toMatchObject({
      exitCode: 1,
      output: expect.stringContaining("is already held"),
    });
    expect(
      await run("hold-artifact", id, "--ground", "Again", "--until", "2028-01-31T12:00:00Z"),
    ).toEqual({
      exitCode: 0,
      output: expect.stringMatching(/release date is now 2028-01-31T12:00:00.000Z/),
    });
    expect((await run("holds")).output).toContain(`${id}  open`);
    const shown = await run("hold", id);
    expect(shown.output).toContain('ground    "Authority request 7"');
    expect(shown.output).toContain(`owner     ${user.id}  ${user.email}`);
    expect(await run("hold", "zzzzzzzzzz")).toEqual({
      exitCode: 1,
      output: "zzzzzzzzzz has no open hold.",
    });
    expect((await run("reinstate-artifact", id, ...LIFT)).output).toBe(
      "This artifact has a legal hold; release it first.",
    );
    const files = memoryFiles();
    await runOperator(db(), ["export-tombstones", "--out", "h.jsonl"], NOW, files);
    expect(files.store.get("h.jsonl")).toContain(`"artifactId":"${id}"`);
    expect((await run("release-hold", id)).output).toContain(`Released the hold on ${id}.`);
    expect(await run("release-hold", id)).toEqual({
      exitCode: 1,
      output: `${id} has no open hold.`,
    });
    expect((await run("holds", "--all", "--limit", "500")).output).toContain(`${id}  released`);
    // The file is the truth as of the export: applying it reopens a hold released since, the
    // safe side, and the operator releases it again.
    const applied = await runOperator(db(), ["apply-tombstones", "--file", "h.jsonl"], NOW, files);
    expect(applied.output).toContain("1 legal hold(s) put back (0 artifact(s) suspended again)");
    expect((await run("holds")).output).toContain(`${id}  open`);
    expect((await run("release-hold", id)).exitCode).toBe(0);
  });
});
