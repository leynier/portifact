import { SUGGESTION_LIMITS, SUGGESTION_STATES } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  attemptOverdue,
  checkDecide,
  checkMark,
  checkSuggestionThreadState,
  checkWithdraw,
  firstMessageDeletion,
  plannableKind,
} from "./lifecycle.ts";

const code = (result: { ok: boolean; code?: string }) => (result.ok ? "ok" : result.code);

describe("deciding and withdrawing suggestions", () => {
  it("lets only the owner side decide, and only a pending suggestion", () => {
    expect(checkDecide("owner", "pending")).toEqual({ ok: true, value: true });
    expect(code(checkDecide("participant", "pending"))).toBe("forbidden");
    expect(code(checkDecide(null, "pending"))).toBe("forbidden");
    expect(code(checkDecide("owner", "applying"))).toBe("version_conflict");
    for (const state of ["accepted", "rejected", "withdrawn", "outdated", null] as const) {
      expect(code(checkDecide("owner", state))).toBe("invalid_input");
    }
  });

  it("lets only the author withdraw, and only a pending suggestion", () => {
    expect(checkWithdraw("u1", "u1", "pending")).toEqual({ ok: true, value: true });
    expect(code(checkWithdraw("u2", "u1", "pending"))).toBe("forbidden");
    expect(code(checkWithdraw("u1", "u1", "applying"))).toBe("version_conflict");
    expect(code(checkWithdraw("u1", "u1", "accepted"))).toBe("invalid_input");
    expect(code(checkWithdraw("u1", "u1", "withdrawn"))).toBe("invalid_input");
  });

  it("refuses resolving an undecided suggestion's thread, never reopening or comments", () => {
    for (const state of SUGGESTION_STATES) {
      const undecided = state === "pending" || state === "applying";
      expect(code(checkSuggestionThreadState("suggestion", state, "resolved"))).toBe(
        undecided ? "invalid_input" : "ok",
      );
      expect(code(checkSuggestionThreadState("suggestion", state, "open"))).toBe("ok");
    }
    expect(checkSuggestionThreadState("comment", null, "resolved")).toEqual({ ok: true, value: true });
    // Only a suggestion's state counts, whatever a comment row would hold.
    expect(checkSuggestionThreadState("comment", "pending", "resolved").ok).toBe(true);
  });

  it("withdraws a pending suggestion when its first message goes, and waits while applying", () => {
    const withdraws = (value: boolean) => ({ ok: true, value: { withdraws: value } });
    expect(firstMessageDeletion("suggestion", "pending", true)).toEqual(withdraws(true));
    expect(firstMessageDeletion("suggestion", "pending", false)).toEqual(withdraws(false));
    expect(firstMessageDeletion("suggestion", "accepted", true)).toEqual(withdraws(false));
    expect(firstMessageDeletion("comment", null, true)).toEqual(withdraws(false));
    expect(firstMessageDeletion("comment", "pending", true)).toEqual(withdraws(false));
    expect(code(firstMessageDeletion("suggestion", "applying", true))).toBe("version_conflict");
    expect(code(firstMessageDeletion("suggestion", "applying", false))).toBe("ok");
  });
});

describe("marking change-list items", () => {
  it("lets the owner side mark, reports no change, and needs room to reopen", () => {
    const changed = { ok: true, value: "changed" };
    expect(checkMark("owner", "open", "applied", 5, 10)).toEqual(changed);
    expect(checkMark("owner", "applied", "applied", 5, 10)).toEqual({
      ok: true,
      value: "unchanged",
    });
    expect(code(checkMark("participant", "open", "applied", 0, 10))).toBe("forbidden");
    expect(code(checkMark(null, "open", "dismissed", 0, 10))).toBe("forbidden");
    expect(checkMark("owner", "dismissed", "open", 9, 10)).toEqual(changed);
    expect(code(checkMark("owner", "dismissed", "open", 10, 10))).toBe("quota_exceeded");
    expect(checkMark("owner", "closed_by_version", "open", 9, 10)).toEqual(changed);
    // A full list never stops closing items.
    expect(checkMark("owner", "open", "dismissed", 10, 10)).toEqual(changed);
  });
});

describe("acceptance attempts and plannable files", () => {
  it("is overdue after its deliveries or its time, not before", () => {
    const fresh = { deliveries: SUGGESTION_LIMITS.attemptDeliveries - 1, createdAt: 1_000 };
    expect(attemptOverdue(fresh, 1_000 + SUGGESTION_LIMITS.attemptMs - 1)).toBe(false);
    expect(attemptOverdue(fresh, 1_000 + SUGGESTION_LIMITS.attemptMs)).toBe(true);
    expect(attemptOverdue({ ...fresh, deliveries: fresh.deliveries + 1 }, 1_000)).toBe(true);
  });

  it("plans a document's entrypoint and a site's HTML pages only", () => {
    expect(plannableKind("markdown", { path: "a.md", contentType: "x" }, "a.md")).toBe("markdown");
    expect(plannableKind("text", { path: "a.txt", contentType: "x" }, "a.txt")).toBe("text");
    expect(plannableKind("markdown", { path: "b.md", contentType: "x" }, "a.md")).toBeNull();
    expect(
      plannableKind("site", { path: "a.html", contentType: "Text/HTML; charset=utf-8" }, "x"),
    ).toBe("html");
    expect(plannableKind("site", { path: "a.css", contentType: "text/css" }, "a.css")).toBeNull();
    expect(plannableKind("site", { path: "a", contentType: "" }, "a")).toBeNull();
    expect(plannableKind("site", { path: "a", contentType: " text/html ;x" }, "a")).toBe("html");
  });
});
