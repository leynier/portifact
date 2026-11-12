// The scratch Worker of decision 0026's feasibility experiments 2 and 3 (deployed half). Only
// `drill/runbook.ts` deploys it, under a `pf-exp-` name, to a scratch account resource set it
// deletes afterwards; it is never part of the product. Every request needs the run's random
// token (a Worker secret). It exports the spike's documents object and drives it through the
// same `Drill` as the local test, plus single commands for the billing workload.
import { ArtifactDocuments } from "../src/documents.ts";
import {
  DRILL_LIMITS,
  Drill,
  idsFor,
  matches,
  SCENARIOS,
  type ScenarioIds,
  type ScenarioState,
  type TombstoneExport,
} from "../src/drill.ts";
import type { Caller } from "../src/model.ts";

export { ArtifactDocuments };

interface DrillWorkerEnv {
  DOCUMENTS: DurableObjectNamespace<ArtifactDocuments>;
  JOURNAL: R2Bucket;
  MAIN: D1Database;
  DRILL_TOKEN: string;
}

const BENCH_AUTHOR = "v_bench";

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

function authorized(request: Request, env: DrillWorkerEnv): boolean {
  const url = new URL(request.url);
  const given =
    request.headers.get("Authorization")?.replace(/^Bearer /, "") ??
    url.searchParams.get("token") ??
    "";
  return env.DRILL_TOKEN.length >= 32 && same(given, env.DRILL_TOKEN);
}

type Body = Record<string, unknown>;

async function scenarios(
  drill: Drill,
  run: string,
  states: ScenarioState[],
  step: "before" | "after" | "afterExport",
): Promise<ScenarioState[]> {
  for (const [index, scenario] of SCENARIOS.entries()) {
    const state = states[index] ?? {};
    states[index] = state;
    await scenario[step]?.(drill, idsFor(index, run), state);
  }
  return states;
}

async function probeAll(drill: Drill, run: string, actions: Record<string, string>) {
  const results = [];
  for (const [index, scenario] of SCENARIOS.entries()) {
    const ids = idsFor(index, run);
    const probe = await drill.probe(ids.artifact, scenario.probeOwner(ids), ids.visitor);
    const action = actions[ids.artifact] ?? "missing";
    results.push({
      name: scenario.name,
      transition: scenario.transition,
      action,
      expectedAction: scenario.action,
      probe,
      expected: scenario.expected,
      pass: matches(probe, scenario.expected) && action === scenario.action,
    });
  }
  return results;
}

/** The follow-ups of the local test that end quarantines and check identities, observed here. */
async function followUps(drill: Drill, run: string) {
  const find = (name: string): ScenarioIds =>
    idsFor(
      SCENARIOS.findIndex((scenario) => scenario.name === name),
      run,
    );
  const t = find("transfer after the restore point");
  const adopted = await drill.resolve(t.artifact, "adopt");
  const h = find("hold after the export (missing from it)");
  const n = find("new artifact after the restore point");
  const g = find("grant after the restore point");
  const a = find("author erasure after the restore point");
  const observed = {
    transferAdopt: adopted.ok,
    transferNewOwnerWrite: await drill.ownerWrite(t.artifact, t.newOwner),
    transferFormerOwnerRead: await drill.ownerRead(t.artifact, t.owner),
    transferForgedFormerOwner: await drill.direct(
      t.artifact,
      { artifactId: t.artifact, region: "default", ownerId: t.owner, generation: 0, epoch: 99 },
      { kind: "owner" },
    ),
    heldQuarantineErase: (await drill.resolve(h.artifact, "erase")).ok,
    heldQuarantineAdopt: (await drill.resolve(h.artifact, "adopt")).ok,
    heldAfterAdopt: await drill.ownerRead(h.artifact, h.owner),
    newArtifactErase: (await drill.resolve(n.artifact, "erase")).ok,
    lostGrantRegrant: await drill.regrant(g.artifact, g.visitor),
    lostGrantWrite: await drill.visitorWrite(g.artifact, g.visitor, { again: true }),
    erasedAuthorRegrant: await drill.regrant(a.artifact, a.visitor),
  };
  const expected = {
    transferAdopt: true,
    transferNewOwnerWrite: "ok",
    transferFormerOwnerRead: "forbidden",
    transferForgedFormerOwner: "stale",
    heldQuarantineErase: false,
    heldQuarantineAdopt: true,
    heldAfterAdopt: "held",
    newArtifactErase: true,
    lostGrantRegrant: "granted",
    lostGrantWrite: "ok",
    erasedAuthorRegrant: "retired",
  };
  return { observed, expected };
}

async function benchCommand(
  drill: Drill,
  artifactId: string,
  kind: string,
  id: string | undefined,
) {
  const row = await drill.row(artifactId);
  if (row === null) return { ok: false, error: "no_row" };
  const stub = drill.stub(artifactId);
  const visitor: Caller = { kind: "visitor", author: BENCH_AUTHOR, canWrite: true };
  const ctx = (caller: Caller) => ({ caller, limits: DRILL_LIMITS, now: Date.now() });
  const owner = ctx({ kind: "owner" });
  const started = Date.now();
  let outcome: { ok: boolean; cost?: unknown; error?: string };
  switch (kind) {
    case "create":
      outcome = await stub.create(drill.envelope(row), ctx(visitor), "notes", { t: started });
      break;
    case "replace":
      outcome = await stub.replace(drill.envelope(row), ctx(visitor), "notes", id ?? "", {
        t: started,
      });
      break;
    case "get":
      outcome = await stub.get(drill.envelope(row, false), ctx(visitor), "notes", id ?? "");
      break;
    case "page":
      outcome = await stub.query(drill.envelope(row, false), ctx(visitor), {
        collection: "notes",
        limit: 20,
      });
      break;
    case "delete":
      outcome = await stub.remove(drill.envelope(row), ctx(visitor), "notes", id ?? "");
      break;
    case "ownerCreate":
      outcome = await stub.create(drill.envelope(row), owner, "notes", { t: started });
      break;
    case "count":
      outcome = await stub.count(drill.envelope(row, false), owner, "notes");
      break;
    case "export":
      outcome = await stub.exportPage(drill.envelope(row, false), owner, null, 100);
      break;
    default:
      return { ok: false, error: "unknown kind" };
  }
  const value = "value" in outcome ? (outcome.value as { _id?: string }) : undefined;
  return {
    ok: outcome.ok,
    error: outcome.error,
    cost: outcome.cost,
    id: value?._id,
    rpcMs: Date.now() - started,
  };
}

export default {
  async fetch(request: Request, env: DrillWorkerEnv): Promise<Response> {
    if (!authorized(request, env)) return new Response(null, { status: 404 });
    const url = new URL(request.url);
    const drill = new Drill({ db: env.MAIN, bucket: env.JOURNAL, documents: env.DOCUMENTS });
    if (url.pathname === "/live") {
      // A live connection for experiment 3: the visitor's socket on the benchmark artifact.
      const artifactId = url.searchParams.get("artifact") ?? "";
      const row = await drill.row(artifactId);
      if (row === null) return new Response(null, { status: 404 });
      const now = Date.now();
      return drill.stub(artifactId).fetch("https://data.internal/live", {
        headers: {
          Upgrade: "websocket",
          "X-Portifact-Envelope": JSON.stringify(drill.envelope(row, false)),
          "X-Portifact-Caller": JSON.stringify({
            author: BENCH_AUTHOR,
            principal: url.searchParams.get("principal") ?? "p_bench",
            deadline: now + Number(url.searchParams.get("deadlineMs") ?? "60000"),
            limits: DRILL_LIMITS,
            now,
          }),
        },
      });
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body = (await request.json()) as Body;
    const run = String(body.run ?? "");
    const states = (body.states as ScenarioState[] | undefined) ?? [];
    switch (url.pathname) {
      case "/setup":
        await drill.setup();
        return Response.json({ ok: true });
      case "/drill/before":
        return Response.json({ states: await scenarios(drill, run, states, "before") });
      case "/drill/after":
        return Response.json({ states: await scenarios(drill, run, states, "after") });
      case "/drill/after-export":
        return Response.json({ states: await scenarios(drill, run, states, "afterExport") });
      case "/drill/export":
        return Response.json(await drill.exportTombstones());
      case "/drill/window": {
        const ids = idsFor(
          SCENARIOS.findIndex((scenario) => scenario.name === "revocation after the restore point"),
          run,
        );
        return Response.json({
          windowWrite: await drill.visitorWrite(ids.artifact, ids.visitor, { window: true }),
        });
      }
      case "/drill/apply":
        await drill.applyTombstones(body.file as TombstoneExport);
        return Response.json({ ok: true });
      case "/drill/reconcile":
        return Response.json({ actions: await drill.reconcileAll() });
      case "/drill/probe":
        return Response.json({
          results: await probeAll(drill, run, body.actions as Record<string, string>),
        });
      case "/drill/follow-ups":
        return Response.json(await followUps(drill, run));
      case "/bench/prepare": {
        const artifactId = String(body.artifact);
        await drill.createArtifact(artifactId, "u_bench_owner");
        return Response.json({ ok: true });
      }
      case "/bench/command":
        return Response.json(
          await benchCommand(
            drill,
            String(body.artifact),
            String(body.kind),
            body.id === undefined ? undefined : String(body.id),
          ),
        );
      case "/bench/hold":
        await drill.hold(String(body.artifact));
        return Response.json({ ok: true });
      case "/bench/control":
        return Response.json({
          control: await drill.stub(String(body.artifact)).controlRecord(),
          objectId: env.DOCUMENTS.idFromName(String(body.artifact)).toString(),
        });
      case "/clear":
        return Response.json({ removed: await drill.clearBucket() });
      default:
        return new Response(null, { status: 404 });
    }
  },
} satisfies ExportedHandler<DrillWorkerEnv>;
