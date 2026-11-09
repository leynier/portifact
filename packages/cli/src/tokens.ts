// portifact tokens list | revoke: the apps holding live tokens for the account and revoking one
// of them, through GET and DELETE /api/v1/tokens (decision 0003). A token's ID is its app's
// client ID: revoking it ends every token that app holds for the account, on every device, like
// "Disconnect" on the dashboard. App names are untrusted text from whoever registered the app.
import { type TokenGrant, TokenGrantList, TokenRevokeResult } from "@portifact/contracts";
import { plain } from "./annotations.ts";
import { callApi } from "./api.ts";
import { table } from "./artifacts.ts";
import { type OutputOptions, openSession, writeJson } from "./commands.ts";
import { CliError } from "./errors.ts";
import { formatDate, messages } from "./messages.ts";
import type { Io, Runtime } from "./runtime.ts";

/** Longest client ID accepted; Client ID Metadata Document IDs are https URLs. */
const CLIENT_ID_MAX = 2048;

export async function listTokens(io: Io, runtime: Runtime, options: OutputOptions): Promise<void> {
  const session = await openSession(io, runtime);
  const list = await callApi(session, { method: "GET", path: "/tokens", schema: TokenGrantList });
  if (options.json) {
    writeJson(io, list);
    return;
  }
  if (list.items.length === 0) {
    io.stdout(`${messages.tokensEmpty}\n`);
    return;
  }
  io.stdout(
    table([
      ["ID", "APP", "USES", "LAST TOKEN", "EXPIRES", "SCOPES"],
      ...list.items.map((grant) => [
        oneLine(grant.clientId),
        `${appName(grant)}${grant.current ? " (this CLI)" : ""}`,
        grant.resources.length ? grant.resources.join(", ") : "-",
        formatDate(grant.lastIssuedAt),
        grant.expiresAt === null ? "never" : formatDate(grant.expiresAt),
        grant.scopes.map(oneLine).join(" "),
      ]),
    ]),
  );
  io.stdout(`${messages.tokensNote}\n`);
}

export interface RevokeTokenOptions extends OutputOptions {
  /** Confirms without a prompt. */
  yes?: boolean;
}

export async function revokeToken(
  io: Io,
  runtime: Runtime,
  id: string,
  options: RevokeTokenOptions,
): Promise<void> {
  const clientId = parseTokenId(id);
  if (!options.yes && !runtime.prompt) {
    throw new CliError("invalid_input", messages.errors.revokeConfirmationRequired(clientId));
  }
  const session = await openSession(io, runtime);

  if (!options.yes && runtime.prompt) {
    const { items } = await callApi(session, {
      method: "GET",
      path: "/tokens",
      schema: TokenGrantList,
    });
    const grant = items.find((item) => item.clientId === clientId);
    if (!grant) throw new CliError("not_found", messages.errors.tokenNotFound(clientId));
    const answer = await runtime.prompt(
      messages.confirmRevoke(appName(grant), oneLine(clientId), grant.current),
    );
    if (answer.trim().toLowerCase() !== "revoke") {
      throw new CliError("cancelled", messages.errors.revokeCancelled);
    }
  }

  const result = await callApi(session, {
    method: "DELETE",
    path: `/tokens/${encodeURIComponent(clientId)}`,
    schema: TokenRevokeResult,
  });
  // The server already ended this device's tokens with the rest of the app's; forget them here,
  // as logout would.
  if (result.current) await session.store.remove(session.server.origin);
  if (options.json) {
    writeJson(io, { ...result, signedOut: result.current });
    return;
  }
  io.stdout(
    `${result.current ? messages.revokedSelf(session.server.origin) : messages.revokedToken(oneLine(clientId))}\n`,
  );
}

/** A token ID as the API names it: the app's client ID, one line of printable text. */
export function parseTokenId(value: string): string {
  if (
    value.length === 0 ||
    value.length > CLIENT_ID_MAX ||
    /[\s\p{Cc}]/u.test(value) ||
    plain(value) !== value
  ) {
    throw new CliError("invalid_input", messages.errors.invalidTokenId(oneLine(value)));
  }
  return value;
}

function appName(grant: TokenGrant): string {
  const name = grant.name === null ? "" : oneLine(grant.name).trim();
  return name || messages.tokensUnnamed;
}

/** Untrusted text on one line, without anything that could change the terminal. */
function oneLine(value: string): string {
  return plain(value).replace(/[\n\t]+/g, " ");
}
