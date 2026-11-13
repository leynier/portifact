import { DRAFT_LIMITS, type TextOperation } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { addToDraft, removeFromDraft } from "./draft-edit.ts";

function op(start: number, exact: string, after: string, path = "index.md"): TextOperation {
  return {
    kind: "text",
    target: {
      schema: 1,
      path,
      anchor: {
        kind: "text",
        quote: { exact, prefix: "", suffix: "" },
        position: { start, end: start + exact.length },
      },
    },
    after,
  };
}

describe("the owner's draft", () => {
  it("adds operations in order and replaces one on the same text (coalescing)", () => {
    const first = addToDraft(null, op(0, "cat", "dog"));
    if (!first.ok) throw new Error("refused");
    const second = addToDraft(first.edit, op(10, "hat", "cap"));
    if (!second.ok) throw new Error("refused");
    expect(second.edit.operations.map((o) => (o.kind === "text" ? o.after : null))).toEqual([
      "dog",
      "cap",
    ]);
    // `cat` to `dog` to `fox` is one operation from `cat` to `fox`.
    const third = addToDraft(second.edit, op(0, "cat", "fox"));
    if (!third.ok) throw new Error("refused");
    expect(third.edit.operations.map((o) => (o.kind === "text" ? o.after : null))).toEqual([
      "cap",
      "fox",
    ]);
  });

  it("keeps a draft to one page", () => {
    const first = addToDraft(null, op(0, "cat", "dog"));
    if (!first.ok) throw new Error("refused");
    expect(addToDraft(first.edit, op(0, "cat", "dog", "other.md"))).toEqual({
      ok: false,
      reason: "other_page",
    });
  });

  it("refuses a draft at its limit and an operation the contracts refuse", () => {
    let edit = null;
    for (let i = 0; i < DRAFT_LIMITS.operationsMax; i += 1) {
      const next = addToDraft(edit, op(i * 10, "word", `w${i}`));
      if (!next.ok) throw new Error(`refused at ${i}`);
      edit = next.edit;
    }
    expect(addToDraft(edit, op(5_000, "word", "x"))).toEqual({ ok: false, reason: "full" });
    expect(addToDraft(null, op(0, "cat", "cat"))).toEqual({ ok: false, reason: "invalid" });
  });

  it("removes an operation, and an empty draft is nothing", () => {
    const first = addToDraft(null, op(0, "cat", "dog"));
    const second = first.ok ? addToDraft(first.edit, op(10, "hat", "cap")) : first;
    if (!second.ok) throw new Error("refused");
    expect(removeFromDraft(second.edit, 0)?.operations).toHaveLength(1);
    const one = removeFromDraft(second.edit, 1);
    expect(one && removeFromDraft(one, 0)).toBeNull();
  });
});
