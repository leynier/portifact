// portifact workspaces and the --workspace flag (premium plan T1): which space a publish, list or
// usage acts on, and moving an artifact between spaces. The flag wins, then the default this
// device remembers (`portifact workspaces use`), then the personal space. The server decides every
// role; the CLI only names the space.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ArtifactSummary,
  type OwnerView,
  WorkspaceGroupList,
  WorkspaceList,
  WorkspaceSlug,
} from "@portifact/contracts";
import { describePolicy } from "@portifact/domain";
import { z } from "zod";
import { plain } from "./annotations.ts";
import { callApi } from "./api.ts";
import { table } from "./artifacts.ts";
import { type OutputOptions, openSession, signedInPrincipal, writeJson } from "./commands.ts";
import { CliError } from "./errors.ts";
import { messages } from "./messages.ts";
import type { Io, Runtime } from "./runtime.ts";
import { type Session, serviceTokenOf } from "./session.ts";

/** The device's default space, next to the credentials file. */
export const WORKSPACE_FILE = "workspace.json";

/** The word that names the personal space wherever a workspace slug is accepted. */
export const PERSONAL = "personal";

function parseSlug(value: string): string {
  const parsed = WorkspaceSlug.safeParse(value.trim());
  if (!parsed.success) {
    throw new CliError(
      "invalid_input",
      `${JSON.stringify(value)} is not a workspace slug. Run \`portifact workspaces\` to see yours, or use ${PERSONAL}.`,
    );
  }
  return parsed.data;
}

/**
 * The default workspace is the signed-in account's choice on this device: stored with the server
 * and the account's user ID, so another account signing in here never acts on it, and removed
 * on logout (`forgetDefaultWorkspace`).
 */
const StoredDefault = z.object({
  version: z.literal(2),
  server: z.string(),
  userId: z.string(),
  workspace: WorkspaceSlug,
});

/** The workspace the signed-in account chose on this device; undefined for the personal space. */
export async function defaultWorkspace(session: Session): Promise<string | undefined> {
  // A service token acts on its own workspace: the server picks it when no slug is sent.
  if (serviceTokenOf(session.runtime)) return undefined;
  let stored: z.infer<typeof StoredDefault>;
  try {
    const parsed = StoredDefault.safeParse(
      JSON.parse(await readFile(join(session.runtime.configDir, WORKSPACE_FILE), "utf8")),
    );
    if (!parsed.success) return undefined;
    stored = parsed.data;
  } catch {
    return undefined;
  }
  if (stored.server !== session.server.origin) return undefined;
  const { userId } = await signedInPrincipal(session);
  return stored.userId === userId ? stored.workspace : undefined;
}

async function saveDefault(session: Session, slug: string | undefined): Promise<void> {
  const { configDir } = session.runtime;
  if (slug === undefined) {
    await forgetDefaultWorkspace(configDir);
    return;
  }
  const { userId } = await signedInPrincipal(session);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const body = { version: 2, server: session.server.origin, userId, workspace: slug };
  await writeFile(join(configDir, WORKSPACE_FILE), `${JSON.stringify(body)}\n`, { mode: 0o600 });
}

/** Removes the stored default; `logout` calls it so the next account starts in its own space. */
export async function forgetDefaultWorkspace(configDir: string): Promise<void> {
  await rm(join(configDir, WORKSPACE_FILE), { force: true });
}

/**
 * The space a command acts on: the flag (`personal` for the personal space), else the signed-in
 * account's default. Undefined means the personal space.
 */
export async function chosenWorkspace(
  session: Session,
  flag: string | undefined,
): Promise<string | undefined> {
  if (flag !== undefined) return flag.trim() === PERSONAL ? undefined : parseSlug(flag);
  return defaultWorkspace(session);
}

/**
 * The space a command acts on from its flag alone (`personal` or none for the personal space),
 * for commands the device's default does not cover, such as `webhooks`.
 */
export function flaggedWorkspace(flag: string | undefined): string | undefined {
  return flag === undefined || flag.trim() === PERSONAL ? undefined : parseSlug(flag);
}

/** `?workspace=<slug>` for the API, or an empty string for the personal space. */
export function workspaceQuery(slug: string | undefined, extra?: URLSearchParams): string {
  const query = new URLSearchParams(extra);
  if (slug !== undefined) query.set("workspace", slug);
  return query.size > 0 ? `?${query}` : "";
}

/** Where an artifact lives, in one line. */
export function ownerLabel(owner: OwnerView): string {
  return owner.kind === "workspace" ? `${owner.name} (workspace ${owner.slug})` : "Personal space";
}

export async function workspaces(io: Io, runtime: Runtime, options: OutputOptions): Promise<void> {
  const session = await openSession(io, runtime);
  const list = await callApi(session, {
    method: "GET",
    path: "/workspaces",
    schema: WorkspaceList,
  });
  const current = await defaultWorkspace(session);
  if (options.json) {
    writeJson(io, { ...list, default: current ?? null });
    return;
  }
  const mark = (selected: boolean) => (selected ? "*" : " ");
  io.stdout(
    table([
      [" ", "SLUG", "ROLE", "NAME"],
      [mark(current === undefined), PERSONAL, "owner", "Personal space"],
      ...list.items.map((item) => [mark(item.slug === current), item.slug, item.role, item.name]),
    ]),
  );
  // Each workspace's policies (decision 0015) bind everyone in it, admins included.
  for (const item of list.items) {
    const policy = describePolicy(item.policy);
    if (policy.length > 0) io.stdout(`Policies of ${item.slug}: ${policy.join("; ")}.\n`);
  }
  io.stderr("* is where publish, list and usage go without --workspace.\n");
}

/**
 * A workspace's groups, for its admins and editors (a service token needs `artifacts:share`):
 * the IDs `portifact access group add` takes, their names and member counts, never members.
 */
export async function workspaceGroups(
  io: Io,
  runtime: Runtime,
  options: OutputOptions,
  value: string,
): Promise<void> {
  const slug = parseSlug(value);
  const session = await openSession(io, runtime);
  const list = await callApi(session, {
    method: "GET",
    path: `/workspaces/${encodeURIComponent(slug)}/groups`,
    schema: WorkspaceGroupList,
  });
  if (options.json) {
    writeJson(io, list);
    return;
  }
  if (list.items.length === 0) {
    io.stdout(`${messages.groupsNone(slug)}\n`);
  } else {
    io.stdout(
      table([
        ["ID", "MEMBERS", "NAME"],
        ...list.items.map((item) => [item.id, String(item.members), plain(item.name)]),
      ]),
    );
  }
  if (!list.available) io.stderr(`${messages.groupsLapsed}\n`);
}

export async function useWorkspace(
  io: Io,
  runtime: Runtime,
  options: OutputOptions,
  value: string,
): Promise<void> {
  if (serviceTokenOf(runtime)) {
    throw new CliError("invalid_input", messages.errors.serviceTokenWorkspace);
  }
  const slug = value.trim() === PERSONAL ? undefined : parseSlug(value);
  const session = await openSession(io, runtime);
  if (slug !== undefined) {
    const list = await callApi(session, {
      method: "GET",
      path: "/workspaces",
      schema: WorkspaceList,
    });
    if (!list.items.some((item) => item.slug === slug)) {
      throw new CliError(
        "not_found",
        `You are not a member of a workspace ${slug}. Run \`portifact workspaces\` to see yours.`,
      );
    }
  }
  await saveDefault(session, slug);
  if (options.json) {
    writeJson(io, { default: slug ?? null });
    return;
  }
  io.stdout(
    slug === undefined
      ? "publish, list and usage now use your personal space.\n"
      : `publish, list and usage now use the workspace ${slug}. Run \`portifact workspaces use ${PERSONAL}\` to go back.\n`,
  );
}

export interface TransferOptions extends OutputOptions {
  to: string;
}

export async function transfer(
  io: Io,
  runtime: Runtime,
  options: TransferOptions,
  artifactId: string,
): Promise<void> {
  const workspace = options.to.trim() === PERSONAL ? null : parseSlug(options.to);
  const session = await openSession(io, runtime);
  const moved = await callApi(session, {
    method: "POST",
    path: `/artifacts/${artifactId}/transfer`,
    body: { workspace },
    schema: ArtifactSummary,
  });
  if (options.json) {
    writeJson(io, moved);
    return;
  }
  io.stdout(
    `${moved.id} is now in: ${ownerLabel(moved.owner)}. Its URL did not change: ${moved.url}\nThe people who manage it there now also see who opened it before the move.\n`,
  );
}
