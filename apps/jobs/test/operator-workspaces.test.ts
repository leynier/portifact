// The operator's workspace commands (premium plan T1): while there is no billing, the only way a
// workspace is created or deleted, and plans granted to a workspace like to an account.
import { env } from "cloudflare:test";
import { createDb, schema } from "@portifact/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { OPERATOR_USAGE, runOperator } from "../src/operator.ts";

const NOW = Date.UTC(2026, 10, 10, 12);
const db = () => createDb(env.DB);
const run = (...argv: string[]) => runOperator(db(), argv, NOW);
const slug = () => `op-${crypto.randomUUID().slice(0, 8)}`;

async function account(): Promise<{ id: string; email: string }> {
  const id = `u_${crypto.randomUUID()}`;
  const email = `${id}@example.test`;
  await db()
    .insert(schema.users)
    .values({
      id,
      name: "Admin",
      email,
      emailVerified: true,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
    });
  return { id, email };
}

async function workspaceRow(key: string) {
  const [row] = await db().select().from(schema.workspaces).where(eq(schema.workspaces.slug, key));
  return row;
}

describe("operator workspace commands", () => {
  it("creates a workspace with its first admin and a Team plan in one command", async () => {
    const admin = await account();
    const name = slug();
    const created = await run(
      "workspace-create",
      name,
      "--name",
      "Acme Docs",
      "--admin",
      admin.email,
      "--plan",
      "team",
      "--seats",
      "5",
    );
    expect(created.exitCode).toBe(0);
    const row = await workspaceRow(name);
    expect(row).toMatchObject({ name: "Acme Docs", region: "default", createdBy: admin.id });
    expect(created.output).toContain(
      `Created workspace ${name} (${row?.id}) with ${admin.id} as its admin.`,
    );
    expect(created.output).toContain("Granted team with 5 seat(s).");
    expect(created.output).toContain("seats       1 of 5 (members and pending invitations)");
    expect(created.output).toContain(`  admin   ${admin.id}`);
    const [member] = await db()
      .select()
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.workspaceId, row?.id as string));
    expect(member).toMatchObject({ userId: admin.id, role: "admin" });
    // The operator sees addresses only masked.
    expect(created.output).not.toContain(admin.email);
  });

  it("creates one without a plan, on free with one seat", async () => {
    const admin = await account();
    const name = slug();
    const created = await run("workspace-create", name, "--name", "Small", "--admin", admin.id);
    expect(created.exitCode).toBe(0);
    expect(created.output).toContain("No plan: it is on free, with one seat");
  });

  it("refuses bad input and creates nothing", async () => {
    const admin = await account();
    const name = slug();
    for (const [argv, message] of [
      [
        ["workspace-create", name, "--name", "X"],
        "workspace-create needs a slug, --name and --admin.",
      ],
      [
        ["workspace-create", name, "--name", "X", "--admin", admin.id, "--plan", "pro"],
        "--plan must be team or enterprise.",
      ],
      [
        ["workspace-create", name, "--name", "X", "--admin", admin.id, "--seats", "3"],
        "--seats and --until go with --plan.",
      ],
      [["workspace"], "workspace needs a slug or workspace ID."],
      [["workspace-delete"], "workspace-delete needs a slug or workspace ID."],
    ] as [string[], string][]) {
      expect(await run(...argv)).toEqual({
        exitCode: 2,
        output: `${message}\n\n${OPERATOR_USAGE}`,
      });
    }
    expect(
      await run("workspace-create", name, "--name", "X", "--admin", "nobody@example.test"),
    ).toEqual({ exitCode: 1, output: "Account not found." });
    expect(
      await run(
        "workspace-create",
        name,
        "--name",
        "X",
        "--admin",
        admin.id,
        "--plan",
        "team",
        "--seats",
        "0",
      ),
    ).toEqual({ exitCode: 1, output: "Seats must be a whole number from 1 to 10000." });
    expect(await run("workspace-create", "personal", "--name", "X", "--admin", admin.id)).toEqual({
      exitCode: 1,
      output: "The slug personal is reserved.",
    });
    expect(await workspaceRow(name)).toBeUndefined();
  });

  it("shows and lists workspaces, and grants plans by workspace:<slug>", async () => {
    const admin = await account();
    const name = slug();
    await run("workspace-create", name, "--name", "Shown", "--admin", admin.id);
    const row = await workspaceRow(name);
    const shown = await run("workspace", name);
    expect(shown.exitCode).toBe(0);
    expect(shown.output).toContain(`workspace   ${name} (${row?.id})`);
    expect((await run("workspace", row?.id as string)).output).toBe(shown.output);
    expect(await run("workspace", "no-such")).toEqual({
      exitCode: 1,
      output: "Workspace not found.",
    });
    expect((await run("workspaces")).output).toContain(`${name}  ${row?.id}  1 member(s)`);

    const granted = await run("set-plan", `workspace:${name}`, "team", "--seats", "3");
    expect(granted.exitCode).toBe(0);
    expect(granted.output).toContain(`Set the plan of ${row?.id} to team.`);
    expect((await run("plan", row?.id as string)).output).toContain("effective   team, 3 seat(s)");
    expect((await run("remove-plan", `workspace:${name}`)).exitCode).toBe(0);
    expect(await run("plan", "workspace:no-such")).toEqual({
      exitCode: 1,
      output: "Account or workspace not found.",
    });
  });

  it("deletes a workspace only with its slug confirmed", async () => {
    const admin = await account();
    const name = slug();
    await run("workspace-create", name, "--name", "Gone", "--admin", admin.id);
    const row = await workspaceRow(name);
    const unconfirmed = await run("workspace-delete", name);
    expect(unconfirmed.exitCode).toBe(2);
    expect(unconfirmed.output).toContain(`workspace-delete needs --confirm ${name}`);
    expect(await workspaceRow(name)).toBeDefined();
    const deleted = await run("workspace-delete", name, "--confirm", name);
    expect(deleted.exitCode).toBe(0);
    expect(deleted.output).toContain(`Deleted workspace ${name} (${row?.id}): 1 membership(s)`);
    expect(await workspaceRow(name)).toBeUndefined();
    const [pending] = await db()
      .select()
      .from(schema.workspaceDeletions)
      .where(eq(schema.workspaceDeletions.workspaceId, row?.id as string));
    expect(pending).toBeDefined();
    expect(await run("workspace-delete", name, "--confirm", name)).toEqual({
      exitCode: 1,
      output: "Workspace not found.",
    });
  });

  it("lists the workspace commands in the usage", () => {
    expect(OPERATOR_USAGE).toContain(
      "workspace-create <slug> --name <name> --admin <user-id|email>",
    );
    expect(OPERATOR_USAGE).toContain("workspace-delete <slug|workspace-id> --confirm <slug>");
  });
});
