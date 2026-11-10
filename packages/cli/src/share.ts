// portifact share create | list | revoke: share links of one artifact (premium plan P4, decision
// 0008), through /api/v1/artifacts/:id/share-links. The link's URL holds its secret and is
// printed once, by create; nothing else ever shows it. A password is read from a file, never
// from the command line, so it stays out of the shell's history and the process list.
import { readFile } from "node:fs/promises";
import {
  ShareLinkCreated,
  ShareLinkId,
  ShareLinkList,
  ShareLinkRevoked,
} from "@portifact/contracts";
import { plain } from "./annotations.ts";
import { callApi } from "./api.ts";
import { parseArtifactId, table } from "./artifacts.ts";
import { type OutputOptions, openSession, writeJson } from "./commands.ts";
import { CliError } from "./errors.ts";
import { formatDate, messages } from "./messages.ts";
import type { Io, Runtime } from "./runtime.ts";

const UNIT_MS = { h: 3_600_000, d: 86_400_000 } as const;

/** `--expires` as an ISO date: a duration from now (`12h`, `7d`) or an ISO date and time. */
export function parseExpiry(value: string, now: number): string {
  const trimmed = value.trim();
  const relative = /^([0-9]{1,4})([hd])$/.exec(trimmed);
  if (relative) {
    const amount = Number(relative[1]) * UNIT_MS[relative[2] as keyof typeof UNIT_MS];
    return new Date(now + amount).toISOString();
  }
  const at = Date.parse(trimmed);
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed) || Number.isNaN(at)) {
    throw new CliError("invalid_input", messages.errors.invalidExpiry(value));
  }
  return new Date(at).toISOString();
}

export interface CreateShareOptions extends OutputOptions {
  label: string;
  expires?: string | undefined;
  passwordFile?: string | undefined;
}

/** The first line of the password file, without its line ending. */
async function readPassword(path: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new CliError("invalid_input", messages.errors.notFoundPath(path));
  }
  const password = text.split(/\r?\n/, 1)[0] ?? "";
  if (password.length === 0) throw new CliError("invalid_input", messages.errors.emptyPassword);
  return password;
}

export async function createShare(
  io: Io,
  runtime: Runtime,
  id: string,
  options: CreateShareOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  const expiresAt =
    options.expires === undefined ? undefined : parseExpiry(options.expires, runtime.now());
  const password =
    options.passwordFile === undefined ? undefined : await readPassword(options.passwordFile);
  const session = await openSession(io, runtime);
  const created = await callApi(session, {
    method: "POST",
    path: `/artifacts/${artifactId}/share-links`,
    body: {
      label: options.label,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(password === undefined ? {} : { password }),
    },
    schema: ShareLinkCreated,
  });
  if (options.json) {
    writeJson(io, created);
    return;
  }
  io.stdout(
    `${messages.shareCreated(created.link.id, artifactId, created.url, created.link.expiresAt)}\n`,
  );
}

export async function listShares(
  io: Io,
  runtime: Runtime,
  id: string,
  options: OutputOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  const session = await openSession(io, runtime);
  const list = await callApi(session, {
    method: "GET",
    path: `/artifacts/${artifactId}/share-links`,
    schema: ShareLinkList,
  });
  if (options.json) {
    writeJson(io, list);
    return;
  }
  if (list.links.length === 0) {
    io.stdout(`${messages.sharesEmpty(artifactId)}\n`);
  } else {
    io.stdout(
      table([
        ["ID", "LABEL", "STATE", "PASSWORD", "EXPIRES", "LAST USED", "CREATED"],
        ...list.links.map((link) => [
          link.id,
          plain(link.label),
          link.state,
          link.hasPassword ? "yes" : "no",
          link.expiresAt === null ? "never" : formatDate(link.expiresAt),
          link.lastUsedOn ?? "-",
          formatDate(link.createdAt),
        ]),
      ]),
    );
  }
  if (!list.enabled) io.stdout(`${messages.sharesPaused}\n`);
}

export interface RevokeShareOptions extends OutputOptions {
  yes?: boolean;
}

export async function revokeShare(
  io: Io,
  runtime: Runtime,
  id: string,
  link: string,
  options: RevokeShareOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  const parsed = ShareLinkId.safeParse(link.trim());
  if (!parsed.success)
    throw new CliError("invalid_input", messages.errors.invalidShareLinkId(link));
  const linkId = parsed.data;
  if (!options.yes && !runtime.prompt) {
    throw new CliError(
      "invalid_input",
      messages.errors.shareRevokeConfirmationRequired(artifactId, linkId),
    );
  }
  const session = await openSession(io, runtime);
  if (!options.yes && runtime.prompt) {
    const answer = await runtime.prompt(messages.confirmShareRevoke(linkId));
    if (answer.trim().toLowerCase() !== "revoke") {
      throw new CliError("cancelled", messages.errors.shareRevokeCancelled);
    }
  }
  const result = await callApi(session, {
    method: "DELETE",
    path: `/artifacts/${artifactId}/share-links/${linkId}`,
    schema: ShareLinkRevoked,
  });
  if (options.json) {
    writeJson(io, result);
    return;
  }
  io.stdout(`${messages.shareRevoked(linkId, artifactId)}\n`);
}
