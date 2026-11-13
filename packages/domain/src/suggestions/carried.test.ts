import type { Edit, Proof, SuggestionProofs, TextOperation } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  DOC_URL,
  edit,
  elementOperation,
  pageTextOf,
  plan,
  RENDERER,
  TITLE,
  textOperation,
} from "../testing/suggestions/harness.ts";
import { carriedProofs, carryRequest, operationsOn, plannedOn, proofsOfPlan } from "./carried.ts";
import { buildPlan } from "./plan.ts";
import { carryAll } from "./relocate.ts";

const OLD = "First paragraph.\n\nSecond paragraph here.\n\nA [linked](https://x.test) word.";
const NEXT =
  "First paragraph, now much longer than before.\n\nSecond paragraph here.\n\nA [linked](https://x.test) word.";

const proof = (start: number): Proof => ({
  unit: "utf16",
  start,
  end: start + 1,
  before: "a",
  after: "b",
  shownBefore: "a",
  shownAfter: "b",
  nodeLeft: "",
  nodeRight: "",
  identity: [],
});

describe("a suggestion's proofs", () => {
  it("keeps a plan's proofs by operation, null for what the plan never located", async () => {
    const second = textOperation(await edit("markdown", OLD, "Second", "Next"));
    const crossing = textOperation(await edit("markdown", OLD, "A linked", "One linked"));
    const operations = [crossing, elementOperation("remove"), second];
    const built = await plan("markdown", OLD, operations);
    const proofs = proofsOfPlan(built, operations, "ver_1");
    expect(proofs.versionId).toBe("ver_1");
    expect(proofs.operations).toHaveLength(3);
    // The structure operation has no text; the other two were located (one applied, one listed).
    expect(proofs.operations[1]).toBeNull();
    const located = proofs.operations[2];
    expect(located?.proof.before).toBe("Second");
    const anchor = (second as TextOperation).target.anchor;
    expect(located?.start).toBe(anchor.kind === "text" ? anchor.position.start : -1);
    expect(plannedOn(proofs, "ver_1")).toBe(true);
    expect(plannedOn(proofs, "ver_2")).toBe(false);
    expect(plannedOn(null, "ver_1")).toBe(false);
    expect(plannedOn({ format: 1, versionId: "ver_1", operations: [null] }, "ver_1")).toBe(false);
  });

  it("gives the operations at their carried positions only on the proofs' version", async () => {
    const change = await edit("markdown", OLD, "Second", "Next");
    const submitted: Edit = { operations: [textOperation(change), elementOperation("remove")] };
    const proofs: SuggestionProofs = {
      format: 1,
      versionId: "ver_2",
      operations: [{ start: 40, end: 46, proof: proof(3) }, null],
    };
    const moved = operationsOn(submitted, proofs, "ver_2");
    const anchor = (moved[0] as TextOperation).target.anchor;
    expect(anchor.kind === "text" && anchor.position).toEqual({ start: 40, end: 46 });
    expect(anchor.kind === "text" && anchor.quote.exact).toBe("Second");
    expect(moved[1]).toBe(submitted.operations[1]);
    expect(operationsOn(submitted, proofs, "ver_1")).toBe(submitted.operations);
    expect(operationsOn(submitted, null, "ver_1")).toBe(submitted.operations);
  });

  it("keeps no proof for a text operation the plan could not place", async () => {
    const placed = textOperation(await edit("markdown", OLD, "Second", "Next"));
    const lost = textOperation({ start: 2, end: 8, before: "absent", after: "there" });
    const built = await plan("markdown", OLD, [lost, placed]);
    const proofs = proofsOfPlan(built, [lost, placed], "ver_1");
    expect(proofs.operations[0]).toBeNull();
    expect(proofs.operations[1]?.proof.before).toBe("Second");
  });

  it("moves only text operations that have an entry", async () => {
    const text = textOperation(await edit("markdown", OLD, "Second", "Next"));
    const structure = elementOperation("remove");
    const entry = { start: 40, end: 46, proof: proof(3) };
    const moved = operationsOn(
      { operations: [text, structure] },
      { format: 1, versionId: "v", operations: [null, entry] },
      "v",
    );
    expect(moved[0]).toBe(text);
    expect(moved[1]).toBe(structure);
  });

  it("carries a planned suggestion and outdates one never planned or not all text", async () => {
    const change = await edit("markdown", OLD, "Second", "Next");
    const operation = textOperation(change);
    const built = await plan("markdown", OLD, [operation]);
    const proofs = proofsOfPlan(built, [operation], "ver_1");
    const submitted: Edit = { operations: [operation] };
    expect(carryRequest(submitted, null, "ver_1")).toEqual({ outdated: "not_planned" });
    expect(carryRequest(submitted, proofs, "ver_9")).toEqual({ outdated: "not_planned" });
    expect(
      carryRequest({ operations: [operation, elementOperation("remove")] }, proofs, "ver_1"),
    ).toEqual({ outdated: "not_planned" });
    expect(
      carryRequest(
        { operations: [elementOperation("remove")] },
        { ...proofs, operations: [proofs.operations[0] ?? null] },
        "ver_1",
      ),
    ).toEqual({ outdated: "not_planned" });
    const request = carryRequest(submitted, proofs, "ver_1");
    if (!("items" in request)) throw new Error("not carriable");
    const results = carryAll("markdown", OLD, NEXT, request.items, {
      title: TITLE,
      pageUrl: DOC_URL,
      renderer: RENDERER,
      otherFilesUnchanged: false,
    });
    const carried = carriedProofs(results, "ver_2");
    if ("outdated" in carried) throw new Error(carried.outdated);
    const entry = carried.operations[0];
    const text = Array.from(await pageTextOf("markdown", NEXT));
    expect(text.slice(entry?.start, entry?.end).join("")).toBe("Second");
    expect(carried.versionId).toBe("ver_2");
    // The carried positions are what the next plan uses.
    const next = operationsOn(submitted, carried, "ver_2");
    const replanned = await plan("markdown", NEXT, next);
    expect(replanned.applied).toHaveLength(1);
    expect(replanned.newSource).toContain("Next paragraph here.");
  });

  it("outdates the whole suggestion when one operation is outdated", () => {
    const ok = { status: "carried" as const, edit: { start: 1, end: 2, before: "a", after: "b" } };
    expect(
      carriedProofs(
        [
          { ...ok, proof: proof(1) },
          { status: "outdated", reason: "target_changed" },
        ],
        "ver_2",
      ),
    ).toEqual({ outdated: "target_changed" });
    expect(carriedProofs([{ ...ok, proof: proof(1) }], "ver_2")).toEqual({
      format: 1,
      versionId: "ver_2",
      operations: [{ start: 1, end: 2, proof: proof(1) }],
    });
  });
});

describe("a file that cannot be read", () => {
  it("lists every operation without parsing or rendering anything", async () => {
    const page =
      "<!doctype html><html><head><title>t</title></head><body><p>Second</p></body></html>";
    const change = await edit("html", page, "Second", "Next");
    const built = await plan("html", page, [textOperation(change, "index.html")]);
    expect(built.applied).toHaveLength(1);
    const refused = await buildPlan({
      binding: {
        artifactId: "k7d2qm4xab",
        versionId: "ver_1",
        path: "index.html",
        fileSha256: "0".repeat(64),
        renderer: RENDERER.label,
        subject: "th_1",
        revision: 1,
      },
      people: { submitter: true, acceptor: true },
      kind: "html",
      source: page,
      operations: [textOperation(change, "index.html")],
      pageUrl: DOC_URL,
      renderer: RENDERER,
      refuse: "not_eligible",
    });
    expect(refused.applied).toEqual([]);
    expect(refused.listed.map((item) => item.reason)).toEqual(["not_eligible"]);
    expect(refused.listed[0]?.location).toEqual({ unresolved: true });
    expect(refused.output).toBeNull();
    expect(refused.work.parses + refused.work.renders + refused.work.indexes).toBe(0);
  });
});
