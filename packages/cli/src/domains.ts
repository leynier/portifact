// portifact domains add | verify | list | info | remove: custom domains (premium plan P7,
// decision 0006), through /api/v1/artifacts/:id/domain and /api/v1/domains. The CLI adds no rule
// of its own: the server checks the hostname, the plan, the count and the roles.
import { randomUUID } from "node:crypto";
import {
  CustomDomainList,
  CustomDomainRemoved,
  type CustomDomainView,
  CustomDomainView as CustomDomainViewSchema,
  HostnameInput,
} from "@portifact/contracts";
import { callApi, withRetries } from "./api.ts";
import { parseArtifactId, table } from "./artifacts.ts";
import { type OutputOptions, openSession, writeJson } from "./commands.ts";
import { CliError } from "./errors.ts";
import { formatDate, messages } from "./messages.ts";
import type { Io, Runtime } from "./runtime.ts";

function parseHostname(value: string): string {
  const parsed = HostnameInput.safeParse(value);
  if (!parsed.success) throw new CliError("invalid_input", messages.errors.invalidHostname(value));
  // The server normalizes and checks the rest.
  return parsed.data.toLowerCase().replace(/\.$/, "");
}

const path = (hostname: string) => `/domains/${encodeURIComponent(hostname)}`;

/** The domain's state and what to do next, as lines for the terminal. */
export function domainLines(view: CustomDomainView): string[] {
  const lines = [messages.domainState(view.hostname, view.artifactId, view.state)];
  if (
    view.state === "pending" ||
    view.state === "provisioning" ||
    view.problem === "txt_missing" ||
    view.problem === "cname_elsewhere"
  ) {
    lines.push(
      messages.domainRecords,
      table([
        ["TYPE", "NAME", "VALUE"],
        ...view.records.map((record) => [record.type, record.name, record.value]),
      ]).trimEnd(),
    );
  }
  if (view.problem) lines.push(messages.domainProblem[view.problem]);
  if (view.state === "pending" && view.claimExpiresAt) {
    lines.push(messages.domainClaimExpires(formatDate(view.claimExpiresAt)));
  }
  if (view.state === "active" && view.missedChecks > 0) {
    lines.push(messages.domainMissedChecks(view.missedChecks));
  }
  return lines;
}

export async function addDomain(
  io: Io,
  runtime: Runtime,
  id: string,
  hostname: string,
  options: OutputOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  const host = parseHostname(hostname);
  const session = await openSession(io, runtime);
  // One key for every attempt, so a retry after a lost answer returns the first claim.
  const idempotencyKey = randomUUID();
  const view = await withRetries(session, () =>
    callApi(session, {
      method: "POST",
      path: `/artifacts/${artifactId}/domain`,
      headers: { "idempotency-key": idempotencyKey },
      body: { hostname: host },
      schema: CustomDomainViewSchema,
    }),
  );
  if (options.json) {
    writeJson(io, view);
    return;
  }
  io.stdout(
    `${[...domainLines(view), messages.domainNextVerify(view.hostname), messages.domainBarNote].join("\n")}\n`,
  );
}

export async function verifyDomain(
  io: Io,
  runtime: Runtime,
  hostname: string,
  options: OutputOptions,
): Promise<void> {
  const host = parseHostname(hostname);
  const session = await openSession(io, runtime);
  const view = await callApi(session, {
    method: "POST",
    path: `${path(host)}/verify`,
    schema: CustomDomainViewSchema,
  });
  if (options.json) {
    writeJson(io, view);
    return;
  }
  io.stdout(`${domainLines(view).join("\n")}\n`);
}

export async function domainInfo(
  io: Io,
  runtime: Runtime,
  hostname: string,
  options: OutputOptions,
): Promise<void> {
  const host = parseHostname(hostname);
  const session = await openSession(io, runtime);
  const view = await callApi(session, {
    method: "GET",
    path: path(host),
    schema: CustomDomainViewSchema,
  });
  if (options.json) {
    writeJson(io, view);
    return;
  }
  io.stdout(`${domainLines(view).join("\n")}\n`);
}

export interface ListDomainsOptions extends OutputOptions {
  artifact?: string | undefined;
}

export async function listDomains(
  io: Io,
  runtime: Runtime,
  options: ListDomainsOptions,
): Promise<void> {
  const artifactId = options.artifact === undefined ? undefined : parseArtifactId(options.artifact);
  const session = await openSession(io, runtime);
  const list = await callApi(session, {
    method: "GET",
    path: artifactId === undefined ? "/domains" : `/domains?artifactId=${artifactId}`,
    schema: CustomDomainList,
  });
  if (options.json) {
    writeJson(io, list);
    return;
  }
  if (list.domains.length === 0) {
    io.stdout(`${messages.domainsEmpty}\n`);
  } else {
    io.stdout(
      table([
        ["HOSTNAME", "ARTIFACT", "STATE", "PROBLEM", "VERIFIED"],
        ...list.domains.map((domain) => [
          domain.hostname,
          domain.artifactId,
          domain.state,
          domain.problem ?? "-",
          domain.verifiedAt === null ? "-" : formatDate(domain.verifiedAt),
        ]),
      ]),
    );
  }
  io.stdout(`${messages.domainsUsed(list.used, list.limit)}\n`);
  if (!list.available) io.stdout(`${messages.domainsUnavailable}\n`);
}

export interface RemoveDomainOptions extends OutputOptions {
  yes?: boolean;
}

export async function removeDomain(
  io: Io,
  runtime: Runtime,
  hostname: string,
  options: RemoveDomainOptions,
): Promise<void> {
  const name = parseHostname(hostname);
  if (!options.yes && !runtime.prompt) {
    throw new CliError("invalid_input", messages.errors.domainRemoveConfirmationRequired(name));
  }
  const session = await openSession(io, runtime);
  if (!options.yes && runtime.prompt) {
    const answer = await runtime.prompt(messages.confirmDomainRemove(name));
    if (answer.trim().toLowerCase() !== name) {
      throw new CliError("cancelled", messages.errors.domainRemoveCancelled);
    }
  }
  const result = await callApi(session, {
    method: "DELETE",
    path: path(name),
    schema: CustomDomainRemoved,
  });
  if (options.json) {
    writeJson(io, result);
    return;
  }
  io.stdout(`${messages.domainRemoved(result.hostname)}\n`);
}
