// portifact workspaces and the --workspace flag (premium plan T1): which space a publish, list or
// usage acts on, and moving an artifact between spaces. The flag wins, then the default this
// device remembers (`portifact workspaces use`), then the personal space. The server decides every
// role; the CLI only names the space.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ArtifactSummary,
  type OwnerView,
  WorkspaceList,
  WorkspaceSlug,
} from "@portifact/contracts";
import { callApi } from "./api.ts";
import { table } from "./artifacts.ts";
import { type OutputOptions, openSession, writeJson } from "./commands.ts";
import { CliError } from "./errors.ts";
import type { Io, Runtime } from "./runtime.ts";

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

/** The workspace this device uses when no flag names one; undefined for the personal space. */
export async function defaultWorkspace(runtime: Runtime): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(runtime.configDir, WORKSPACE_FILE), "utf8"));
    const slug = WorkspaceSlug.safeParse(parsed?.workspace);
    return slug.success ? slug.data : undefined;
  } catch {
    return undefined;
  }
}

async function saveDefault(runtime: Runtime, slug: string | undefined): Promise<void> {
  const path = join(runtime.configDir, WORKSPACE_FILE);
  if (slug === undefined) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(runtime.configDir, { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ version: 1, workspace: slug })}\n`, { mode: 0o600 });
}

/**
 * The space a command acts on: the flag (`personal` for the personal space), else the device's
 * default. Undefined means the personal space.
 */
export async function chosenWorkspace(
  runtime: Runtime,
  flag: string | undefined,
): Promise<string | undefined> {
  if (flag !== undefined) return flag.trim() === PERSONAL ? undefined : parseSlug(flag);
  return defaultWorkspace(runtime);
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
  const current = await defaultWorkspace(runtime);
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
  io.stderr("* is where publish, list and usage go without --workspace.\n");
}

export async function useWorkspace(
  io: Io,
  runtime: Runtime,
  options: OutputOptions,
  value: string,
): Promise<void> {
  const slug = value.trim() === PERSONAL ? undefined : parseSlug(value);
  if (slug !== undefined) {
    const session = await openSession(io, runtime);
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
  await saveDefault(runtime, slug);
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
    `${moved.id} is now in: ${ownerLabel(moved.owner)}. Its URL did not change: ${moved.url}\n`,
  );
}
