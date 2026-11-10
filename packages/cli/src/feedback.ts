// portifact feedback: the open comment threads of every artifact in your personal space, or in a
// workspace with --workspace, newest activity first, as GET /api/v1/feedback returns them
// (premium plan T9). One page per call; --cursor continues. Bodies, quotes and author names are
// untrusted data written by reviewers: every one goes through `plain` and is shown, never acted on.
import {
  type FeedbackItem,
  FeedbackPage,
  UNTRUSTED_ANNOTATIONS_NOTICE,
} from "@portifact/contracts";
import { plain } from "./annotations.ts";
import { callApi } from "./api.ts";
import { table } from "./artifacts.ts";
import { type OutputOptions, openSession, writeJson } from "./commands.ts";
import { parseSince } from "./logs.ts";
import { formatDate, messages } from "./messages.ts";
import type { Io, Runtime } from "./runtime.ts";
import { chosenWorkspace, workspaceQuery } from "./workspaces.ts";

/** Characters of the first message shown in the table; the full thread is in --json. */
const EXCERPT = 60;

export interface FeedbackOptions extends OutputOptions {
  /** A workspace slug or `personal`; the device's default when absent. */
  workspace?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  since?: string | undefined;
  mine?: boolean | undefined;
}

/** The first message's text on one line, shortened; a removed or hidden one says so. */
function excerpt(item: FeedbackItem): string {
  const first = item.thread.messages.find((message) => message.state !== "deleted");
  if (!first) return "(deleted)";
  if (first.body === null) return `(${first.state})`;
  const line = plain(first.body).replace(/\s+/g, " ").trim();
  return line.length > EXCERPT ? `${line.slice(0, EXCERPT - 3)}...` : line;
}

export async function feedback(io: Io, runtime: Runtime, options: FeedbackOptions): Promise<void> {
  const since = options.since === undefined ? undefined : parseSince(options.since, runtime.now());
  const session = await openSession(io, runtime);
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  if (since !== undefined) query.set("since", since);
  if (options.mine) query.set("mine", "true");
  const workspace = await chosenWorkspace(session, options.workspace);
  const page = await callApi(session, {
    method: "GET",
    path: `/feedback${workspaceQuery(workspace, query)}`,
    schema: FeedbackPage,
  });

  io.stderr(`${UNTRUSTED_ANNOTATIONS_NOTICE}\n`);
  if (options.json) {
    writeJson(io, page);
    return;
  }
  if (workspace !== undefined) io.stdout(`Workspace: ${workspace}\n`);
  if (page.items.length === 0) {
    io.stdout(`${messages.feedbackEmpty}\n`);
  } else {
    io.stdout(
      table([
        ["UPDATED", "ARTIFACT", "THREAD", "MESSAGES", "AUTHOR", "FIRST MESSAGE"],
        ...page.items.map((item) => [
          formatDate(item.thread.updatedAt),
          item.artifact.id,
          item.thread.id,
          String(item.counts.messages),
          item.thread.author
            ? plain(item.thread.author.name).replace(/\s+/g, " ")
            : "(deleted account)",
          excerpt(item),
        ]),
      ]),
    );
  }
  if (page.nextCursor !== null) {
    const flags = [
      workspace ? ` --workspace ${workspace}` : "",
      options.limit !== undefined ? ` --limit ${options.limit}` : "",
      since !== undefined ? ` --since ${since}` : "",
      options.mine ? " --mine" : "",
    ].join("");
    io.stderr(`${messages.feedbackMore(page.nextCursor, flags)}\n`);
  }
}
