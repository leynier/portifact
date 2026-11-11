// portifact integrations and portifact issue (premium plan T7, decision 0018): list a space's
// connections to GitHub Issues or Linear (names and targets, never a credential) and create an
// issue from one comment thread, through GET /api/v1/integrations and POST
// /api/v1/artifacts/:id/annotations/threads/:threadId/issue. Connections are managed only in the
// dashboard. The CLI adds no rule of its own: the server checks the role, the thread's
// visibility, the plan, the connection and the target. Comment text and the anchor's quote leave
// Portifact only with --quote and --message.
import { randomUUID } from "node:crypto";
import {
  IntegrationChoiceList,
  IntegrationConnectionId,
  ThreadIssueView,
} from "@portifact/contracts";
import { parseAnnotationId } from "./annotations.ts";
import { callApi, withRetries } from "./api.ts";
import { parseArtifactId, table } from "./artifacts.ts";
import { type OutputOptions, openSession, writeJson } from "./commands.ts";
import { CliError } from "./errors.ts";
import { messages } from "./messages.ts";
import type { Io, Runtime } from "./runtime.ts";
import { chosenWorkspace, workspaceQuery } from "./workspaces.ts";

export interface IntegrationListOptions extends OutputOptions {
  /** A workspace slug or `personal`; the device's default when absent. */
  workspace?: string | undefined;
}

/** Labels and names are chosen by people: shown on one line, never as terminal controls. */
function shown(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ");
}

export async function listIntegrations(
  io: Io,
  runtime: Runtime,
  options: IntegrationListOptions,
): Promise<void> {
  const session = await openSession(io, runtime);
  const workspace = await chosenWorkspace(session, options.workspace);
  const list = await callApi(session, {
    method: "GET",
    path: `/integrations${workspaceQuery(workspace, new URLSearchParams())}`,
    schema: IntegrationChoiceList,
  });
  if (options.json) {
    writeJson(io, list);
    return;
  }
  if (workspace !== undefined) io.stdout(`Workspace: ${workspace}\n`);
  if (list.connections.length === 0) {
    io.stdout(`${messages.integrationsEmpty}\n`);
  } else {
    io.stdout(
      table([
        ["ID", "SERVICE", "LABEL", "STATE", "TARGETS"],
        ...list.connections.map((connection) => [
          connection.id,
          connection.service,
          shown(connection.label),
          connection.usable ? "ready" : "needs an admin",
          connection.targets
            .map((target) =>
              target.name === target.id ? target.id : `${shown(target.name)} (${target.id})`,
            )
            .join(", "),
        ]),
      ]),
    );
  }
  if (!list.available) io.stdout(`${messages.integrationsPlan}\n`);
  if (!list.serviceAvailable) io.stdout(`${messages.integrationsUnavailable}\n`);
  if (list.euResidency) io.stdout(`${messages.integrationsEu}\n`);
}

export interface IssueOptions extends OutputOptions {
  connection: string;
  target: string;
  title: string;
  /** Sends the anchor's quoted text: other people's words. */
  quote?: boolean | undefined;
  /** Sends the thread's first message: other people's words. */
  message?: boolean | undefined;
  /** Commander's `--no-link`: leaves out the link to the thread. */
  link?: boolean | undefined;
  /** Commander's `--no-name`: leaves out the artifact's name. */
  name?: boolean | undefined;
}

export async function createIssue(
  io: Io,
  runtime: Runtime,
  id: string,
  thread: string,
  options: IssueOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  const threadId = parseAnnotationId(thread, "thread");
  const connection = IntegrationConnectionId.safeParse(options.connection);
  if (!connection.success) {
    throw new CliError("invalid_input", messages.errors.invalidConnection(options.connection));
  }
  const session = await openSession(io, runtime);
  // One key for every attempt, so a retry after a lost answer never creates a second issue.
  const idempotencyKey = randomUUID();
  const issue = await withRetries(session, () =>
    callApi(session, {
      method: "POST",
      path: `/artifacts/${artifactId}/annotations/threads/${threadId}/issue`,
      headers: { "idempotency-key": idempotencyKey },
      body: {
        connectionId: connection.data,
        target: options.target,
        title: options.title,
        include: {
          link: options.link !== false,
          artifactName: options.name !== false,
          quote: options.quote === true,
          message: options.message === true,
        },
      },
      schema: ThreadIssueView,
    }),
  );
  if (options.json) {
    writeJson(io, issue);
    return;
  }
  io.stdout(`${messages.issueRequested(shown(issue.target), issue.id)}\n`);
}
