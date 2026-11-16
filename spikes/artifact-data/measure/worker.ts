// The scratch Worker of decision 0026's delivery 8 measurements. Only `measure/runbook.ts` deploys
// it, under a `pf-exp-` name, and deletes it afterwards; it is never part of the product. It
// exports the production documents object (`apps/data`'s `ArtifactDocuments`, unchanged) and
// drives it through the same RPC methods and live upgrade the app, content and jobs Workers use,
// so the billed figures are the real object's. Every request needs the run's random token.
import { PLANS, type PlanName } from "@portifact/contracts";
import {
  type ArtifactDataLimits,
  LIVE_CONNECT_HEADER,
  type LiveConnectRequest,
} from "@portifact/contracts/artifact-data";
import { ArtifactDocuments } from "../../../apps/data/src/documents.ts";

export { ArtifactDocuments };

interface MeasureEnv {
  DOCUMENTS: DurableObjectNamespace<ArtifactDocuments>;
  MEASURE_TOKEN: string;
}

const OWNER = "u_measure";

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

function authorized(request: Request, env: MeasureEnv): boolean {
  const url = new URL(request.url);
  const given =
    request.headers.get("Authorization")?.replace(/^Bearer /, "") ??
    url.searchParams.get("token") ??
    "";
  return env.MEASURE_TOKEN.length >= 32 && same(given, env.MEASURE_TOKEN);
}

function opId(now: number): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${String(Math.floor(now)).padStart(13, "0")}.${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function envelope(artifactId: string, now?: number) {
  return {
    artifactId,
    region: "default",
    ownerId: OWNER,
    generation: 0,
    epoch: 0,
    ...(now === undefined ? {} : { opId: opId(now) }),
  };
}

/**
 * The limits a phase runs under: a plan's real ones for the hostile phases, or the plan's with the
 * daily counters raised for the unit-cost phases, so they measure cost per command, not a refusal.
 */
function limitsFor(plan: PlanName, roomy: boolean): ArtifactDataLimits {
  const base = PLANS[plan].data.perArtifact;
  if (!roomy) return base;
  return {
    ...base,
    rowsWrittenPerDay: 10_000_000,
    cleanupRowsPerDay: 10_000_000,
    rowsReadPerDay: 100_000_000,
    exportRowsPerDay: 100_000_000,
    liveMessagesPerDay: 1_000_000,
    documentsPerCollection: 100_000,
    bytesPerArtifact: 500_000_000,
    writesPerAuthorPerMinute: 1_000,
    deletesPerAuthorPerMinute: 1_000,
    readsPerCallerPerMinute: 10_000,
  };
}

/** A visitor ID in the journal's shape. */
function visitor(index: number): string {
  return `v_measure${String(index).padStart(10, "0")}`;
}

function body(index: number, bytes: number): Record<string, unknown> {
  return { tag: `t${index % 10}`, n: index, text: "x".repeat(Math.max(0, bytes - 40)) };
}

interface Answer {
  ok?: boolean;
  code?: string;
  value?: unknown;
  cost?: { rowsRead?: number; rowsWritten?: number };
  storage?: { bytes?: number };
}

interface Tally {
  ok: number;
  refused: Record<string, number>;
  rowsRead: number;
  rowsWritten: number;
  bytes: number;
  ids: string[];
  ms: number;
}

function tally(): Tally {
  return { ok: 0, refused: {}, rowsRead: 0, rowsWritten: 0, bytes: 0, ids: [], ms: 0 };
}

function add(into: Tally, raw: unknown): Answer {
  const answer = (raw ?? {}) as Answer;
  if (answer.ok) into.ok += 1;
  else {
    const code = answer.code ?? "unknown";
    into.refused[code] = (into.refused[code] ?? 0) + 1;
  }
  into.rowsRead += answer.cost?.rowsRead ?? 0;
  into.rowsWritten += answer.cost?.rowsWritten ?? 0;
  into.bytes = Math.max(into.bytes, answer.storage?.bytes ?? 0);
  return answer;
}

interface Step {
  /** One of the kinds `step` handles. */
  kind: string;
  artifact: string;
  plan?: PlanName;
  /** The plan's real limits (hostile phases) instead of the roomy ones. */
  real?: boolean;
  count?: number;
  /** Visitors the commands rotate through. */
  authors?: number;
  /** The first visitor index, so phases use separate authors. */
  authorBase?: number;
  /** Document bytes for creates and replacements. */
  bytes?: number;
  ids?: string[];
  /** Commands are stamped this long before now (the alarm phase). */
  backdateMs?: number;
  /** Bulk size for owner bulk commands. */
  bulk?: number;
}

async function step(env: MeasureEnv, input: Step): Promise<Tally> {
  const out = tally();
  const started = Date.now();
  const stub = env.DOCUMENTS.get(env.DOCUMENTS.idFromName(input.artifact));
  const limits = limitsFor(input.plan ?? "free", input.real !== true);
  const count = input.count ?? 1;
  const authors = Math.max(1, input.authors ?? 1);
  const base = input.authorBase ?? 0;
  const bytes = input.bytes ?? 200;
  const ids = input.ids ?? [];
  const at = () => Date.now() - (input.backdateMs ?? 0);
  const page = (index: number, canWrite = true) => ({
    kind: "visitor" as const,
    author: visitor(base + (index % authors)),
    canWrite,
  });
  for (let index = 0; index < count; index++) {
    const now = at();
    let answer: Answer;
    switch (input.kind) {
      case "declare": {
        // Two collections: visitors' own notes with one index, and a shared board.
        add(
          out,
          await stub.ownerCommand(
            envelope(input.artifact, now),
            OWNER,
            { kind: "declare", declaration: { name: "notes", mode: "own", indexed: ["tag"] } },
            limits,
            now,
          ),
        );
        answer = add(
          out,
          await stub.ownerCommand(
            envelope(input.artifact, now + 1),
            OWNER,
            { kind: "declare", declaration: { name: "board", mode: "shared" } },
            limits,
            now + 1,
          ),
        );
        break;
      }
      case "page_create":
        answer = add(
          out,
          await stub.pageCommand(
            envelope(input.artifact, now),
            page(index),
            { kind: "create", collection: "notes", body: body(index, bytes) },
            limits,
            now,
          ),
        );
        if (answer.ok) out.ids.push((answer.value as { _id: string })._id);
        break;
      case "board_create":
        answer = add(
          out,
          await stub.pageCommand(
            envelope(input.artifact, now),
            page(index),
            { kind: "create", collection: "board", body: body(index, bytes) },
            limits,
            now,
          ),
        );
        break;
      case "page_replace":
        answer = add(
          out,
          await stub.pageCommand(
            envelope(input.artifact, now),
            page(index),
            {
              kind: "replace",
              collection: "notes",
              id: ids[index % ids.length] ?? "",
              body: body(index + 1, bytes),
            },
            limits,
            now,
          ),
        );
        break;
      case "page_get":
        answer = add(
          out,
          await stub.pageCommand(
            envelope(input.artifact),
            page(index),
            { kind: "get", collection: "notes", id: ids[index % ids.length] ?? "" },
            limits,
            now,
          ),
        );
        break;
      case "page_query":
        answer = add(
          out,
          await stub.pageCommand(
            envelope(input.artifact),
            page(index),
            { kind: "query", query: { collection: "notes", limit: 20 } },
            limits,
            now,
          ),
        );
        break;
      case "page_remove":
        answer = add(
          out,
          await stub.pageCommand(
            envelope(input.artifact, now),
            page(index),
            { kind: "remove", collection: "notes", id: ids[index % ids.length] ?? "" },
            limits,
            now,
          ),
        );
        break;
      case "owner_create":
        answer = add(
          out,
          await stub.ownerCommand(
            envelope(input.artifact, now),
            OWNER,
            { kind: "create", collection: "board", body: body(index, bytes) },
            limits,
            now,
          ),
        );
        break;
      case "owner_bulk_create": {
        const size = input.bulk ?? 100;
        answer = add(
          out,
          await stub.ownerCommand(
            envelope(input.artifact, now),
            OWNER,
            {
              kind: "bulk_create",
              input: {
                collection: "board",
                documents: Array.from({ length: size }, (_, n) => body(index * size + n, bytes)),
              },
            },
            limits,
            now,
          ),
        );
        if (answer.ok) out.ids.push(...((answer.value as { ids?: string[] }).ids ?? []));
        break;
      }
      case "owner_query":
        answer = add(
          out,
          await stub.ownerCommand(
            envelope(input.artifact),
            OWNER,
            { kind: "query", query: { collection: "board", limit: 100 } },
            limits,
            now,
          ),
        );
        break;
      case "owner_count":
        answer = add(
          out,
          await stub.ownerCommand(
            envelope(input.artifact),
            OWNER,
            { kind: "count", count: { collection: "board" } },
            limits,
            now,
          ),
        );
        break;
      case "owner_export": {
        // Every page of the export, `count` times.
        let after: unknown = null;
        for (let pageIndex = 0; pageIndex < 10_000; pageIndex++) {
          answer = add(
            out,
            await stub.ownerCommand(
              envelope(input.artifact),
              OWNER,
              { kind: "export", after: after as never },
              limits,
              at(),
            ),
          );
          const value = answer.value as { next?: unknown } | undefined;
          if (!answer.ok || value?.next === null || value?.next === undefined) break;
          after = value.next;
        }
        break;
      }
      case "owner_bulk_remove": {
        const size = input.bulk ?? 100;
        const slice = ids.slice(index * size, index * size + size);
        if (slice.length === 0) break;
        answer = add(
          out,
          await stub.ownerCommand(
            envelope(input.artifact, now),
            OWNER,
            { kind: "bulk_remove", collection: "board", ids: slice },
            limits,
            now,
          ),
        );
        break;
      }
      case "oversize":
        answer = add(
          out,
          await stub.pageCommand(
            envelope(input.artifact, now),
            page(index),
            { kind: "create", collection: "notes", body: body(index, 200_000) },
            limits,
            now,
          ),
        );
        break;
      case "no_grant_write":
        // A visitor whose grant does not allow writing now (terms not current).
        answer = add(
          out,
          await stub.pageCommand(
            envelope(input.artifact, now),
            page(index, false),
            { kind: "create", collection: "notes", body: body(index, bytes) },
            limits,
            now,
          ),
        );
        break;
      default:
        throw new Error(`unknown step ${input.kind}`);
    }
  }
  out.ms = Date.now() - started;
  return out;
}

/** The content Worker's live connect, as `openLiveConnection` builds it. */
async function live(request: Request, env: MeasureEnv): Promise<Response> {
  const url = new URL(request.url);
  const artifact = url.searchParams.get("artifact") ?? "";
  const plan = (url.searchParams.get("plan") ?? "free") as PlanName;
  const author = Number(url.searchParams.get("author") ?? "0");
  const now = Date.now();
  const connect: LiveConnectRequest = {
    envelope: envelope(artifact),
    author: visitor(author),
    principal: `grant:${visitor(author)}`,
    deadline: now + 60_000,
    limits: limitsFor(plan, url.searchParams.get("real") !== "true"),
    now,
  };
  const stub = env.DOCUMENTS.get(env.DOCUMENTS.idFromName(artifact));
  return stub.fetch(
    new Request("https://documents.invalid/live", {
      headers: { upgrade: "websocket", [LIVE_CONNECT_HEADER]: JSON.stringify(connect) },
    }),
  );
}

async function renew(env: MeasureEnv, input: Record<string, unknown>): Promise<boolean> {
  const artifact = String(input.artifact);
  const author = Number(input.author ?? 0);
  const plan = (input.plan ?? "free") as PlanName;
  const now = Date.now();
  const stub = env.DOCUMENTS.get(env.DOCUMENTS.idFromName(artifact));
  return stub.liveRenew(
    envelope(artifact),
    String(input.socketId),
    `grant:${visitor(author)}`,
    now + 60_000,
    limitsFor(plan, input.real !== true),
    now,
  );
}

export default {
  async fetch(request: Request, env: MeasureEnv): Promise<Response> {
    if (!authorized(request, env)) return new Response(null, { status: 404 });
    const path = new URL(request.url).pathname;
    if (path === "/live") return live(request, env);
    const input = (await request.json()) as Record<string, unknown>;
    if (path === "/step") return Response.json(await step(env, input as unknown as Step));
    if (path === "/steps") {
      // Several artifacts' steps in parallel (the fan-out phase).
      const steps = input.steps as Step[];
      return Response.json(await Promise.all(steps.map((one) => step(env, one))));
    }
    if (path === "/renew") return Response.json({ ok: await renew(env, input) });
    if (path === "/control") {
      const stub = env.DOCUMENTS.get(env.DOCUMENTS.idFromName(String(input.artifact)));
      return Response.json(await stub.lifecycleControl());
    }
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<MeasureEnv>;
