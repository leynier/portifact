// portifact review request | change | status | approve | request-changes | cancel: approval
// reviews of an artifact's current version (premium plan T6, decision 0013; not review mode,
// the commenting session), through /api/v1/artifacts/:id/review/request, /status and /verdict. Every write sends an
// Idempotency-Key, so a retried call is applied once. Reviewers' names and notes are untrusted
// and printed through `plain`.
import { randomUUID } from "node:crypto";
import { ApprovalReviewView } from "@portifact/contracts";
import { plain } from "./annotations.ts";
import { callApi } from "./api.ts";
import { parseArtifactId, table } from "./artifacts.ts";
import { type OutputOptions, openSession, writeJson } from "./commands.ts";
import { CliError } from "./errors.ts";
import { formatDate, messages } from "./messages.ts";
import type { Io, Runtime } from "./runtime.ts";

/** `--required` as a number, or null for every reviewer (`all`). */
export function parseRequired(value: string | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  if (value.trim().toLowerCase() === "all") return null;
  if (!/^[0-9]{1,2}$/.test(value.trim()) || Number(value) < 1) {
    throw new CliError("invalid_input", messages.errors.invalidRequired(value));
  }
  return Number(value);
}

async function write(
  io: Io,
  runtime: Runtime,
  id: string,
  request: { method: "POST" | "PATCH"; path: string; body: unknown },
) {
  const artifactId = parseArtifactId(id);
  const session = await openSession(io, runtime);
  return {
    artifactId,
    view: await callApi(session, {
      method: request.method,
      path: `/artifacts/${artifactId}${request.path}`,
      body: request.body,
      headers: { "idempotency-key": randomUUID() },
      schema: ApprovalReviewView,
    }),
  };
}

function print(io: Io, view: ApprovalReviewView) {
  const { review, request } = view;
  if (review.status === "none") {
    io.stdout(`${messages.reviewNone(view.artifactId)}\n`);
    return;
  }
  io.stdout(
    `${messages.reviewStatus(review.status, review.approvals, review.required, review.changesRequested, review.reviewers)}\n`,
  );
  if (!request || request.reviewers.length === 0) return;
  io.stdout(
    table([
      ["REVIEWER", "VERDICT", "DECIDED", "NOTE"],
      ...request.reviewers.map((reviewer) => [
        plain(reviewer.name ?? reviewer.email ?? "-") +
          (reviewer.you ? " (you)" : "") +
          (reviewer.active ? "" : " (no access)"),
        reviewer.verdict === null
          ? "pending"
          : reviewer.verdict === "approve"
            ? "approved"
            : "changes",
        reviewer.decidedAt === null ? "-" : formatDate(reviewer.decidedAt),
        reviewer.note === null ? "" : plain(reviewer.note).replaceAll("\n", " "),
      ]),
    ]),
  );
  if (request.reviewers.some((reviewer) => reviewer.note !== null)) {
    io.stdout(`${messages.reviewUntrusted}\n`);
  }
}

export interface RequestReviewOptions extends OutputOptions {
  reviewers: string[];
  required?: string | undefined;
  showStatus?: boolean | undefined;
}

export async function requestReview(
  io: Io,
  runtime: Runtime,
  id: string,
  options: RequestReviewOptions,
): Promise<void> {
  if (options.reviewers.length === 0)
    throw new CliError("invalid_input", messages.errors.noReviewers);
  const required = parseRequired(options.required);
  const { artifactId, view } = await write(io, runtime, id, {
    method: "POST",
    path: "/review/request",
    body: {
      reviewers: options.reviewers,
      ...(required !== undefined ? { requiredApprovals: required } : {}),
      ...(options.showStatus !== undefined ? { showStatus: options.showStatus } : {}),
    },
  });
  if (options.json) {
    writeJson(io, view);
    return;
  }
  io.stdout(`${messages.reviewRequested(artifactId, view.review.reviewers)}\n`);
  io.stdout(`${messages.reviewNewVersion}\n`);
}

export interface ChangeReviewOptions extends OutputOptions {
  add: string[];
  remove: string[];
  required?: string | undefined;
  showStatus?: boolean | undefined;
}

export async function changeReview(
  io: Io,
  runtime: Runtime,
  id: string,
  options: ChangeReviewOptions,
): Promise<void> {
  const required = parseRequired(options.required);
  const { artifactId, view } = await write(io, runtime, id, {
    method: "PATCH",
    path: "/review/request",
    body: {
      ...(options.add.length > 0 ? { add: options.add } : {}),
      ...(options.remove.length > 0 ? { remove: options.remove } : {}),
      ...(required !== undefined ? { requiredApprovals: required } : {}),
      ...(options.showStatus !== undefined ? { showStatus: options.showStatus } : {}),
    },
  });
  if (options.json) {
    writeJson(io, view);
    return;
  }
  io.stdout(`${messages.reviewChanged(artifactId)}\n`);
  print(io, view);
}

export async function reviewStatus(
  io: Io,
  runtime: Runtime,
  id: string,
  options: OutputOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  const session = await openSession(io, runtime);
  const view = await callApi(session, {
    method: "GET",
    path: `/artifacts/${artifactId}/review/status`,
    schema: ApprovalReviewView,
  });
  if (options.json) {
    writeJson(io, view);
    return;
  }
  print(io, view);
}

export interface VerdictOptions extends OutputOptions {
  note?: string | undefined;
}

export async function giveVerdict(
  io: Io,
  runtime: Runtime,
  id: string,
  verdict: "approve" | "changes",
  options: VerdictOptions,
): Promise<void> {
  const { artifactId, view } = await write(io, runtime, id, {
    method: "POST",
    path: "/review/verdict",
    body: { verdict, ...(options.note !== undefined ? { note: options.note } : {}) },
  });
  if (options.json) {
    writeJson(io, view);
    return;
  }
  io.stdout(`${messages.reviewVerdict(artifactId, verdict)}\n`);
  print(io, view);
}

export interface CancelReviewOptions extends OutputOptions {
  yes?: boolean;
}

export async function cancelReview(
  io: Io,
  runtime: Runtime,
  id: string,
  options: CancelReviewOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  if (!options.yes && !runtime.prompt) {
    throw new CliError(
      "invalid_input",
      messages.errors.reviewCancelConfirmationRequired(artifactId),
    );
  }
  const session = await openSession(io, runtime);
  if (!options.yes && runtime.prompt) {
    const answer = await runtime.prompt(messages.confirmReviewCancel(artifactId));
    if (answer.trim().toLowerCase() !== "cancel") {
      throw new CliError("cancelled", messages.errors.reviewCancelCancelled);
    }
  }
  const view = await callApi(session, {
    method: "DELETE",
    path: `/artifacts/${artifactId}/review/request`,
    schema: ApprovalReviewView,
  });
  if (options.json) {
    writeJson(io, view);
    return;
  }
  io.stdout(`${messages.reviewCancelled(artifactId)}\n`);
}
