import { ANNOTATION_LIMITS, type AnnotationsState, type ArtifactState } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  type AnnotationAction,
  type AnnotationRole,
  type AnnotationUsageSnapshot,
  type AnnotationWrite,
  checkAnnotationAction,
  checkAnnotationModeChange,
  checkAnnotationWrite,
  checkDeleteOwnMessage,
  checkEditMessage,
  checkResolve,
  checkThreadWritable,
  messageBodyVisible,
  moderationTransition,
  threadVisible,
} from "./annotations.ts";

const ACTIONS: AnnotationAction[] = ["read", "participate", "delete_own", "resolve", "moderate"];
type Outcome = "ok" | "not_found" | "forbidden" | "artifact_archived";

function outcomes(role: AnnotationRole | null, state: ArtifactState, mode: AnnotationsState) {
  return ACTIONS.map((action) => {
    const result = checkAnnotationAction({ role, state, mode }, action);
    return result.ok ? "ok" : result.code;
  });
}

// Columns follow ACTIONS: read, participate, delete_own, resolve, moderate (plan section 8).
const MATRIX: [AnnotationRole | null, ArtifactState, AnnotationsState, Outcome[]][] = [
  ["owner", "active", "open", ["ok", "ok", "ok", "ok", "ok"]],
  ["owner", "active", "locked", ["ok", "forbidden", "ok", "ok", "ok"]],
  ["owner", "active", "off", ["ok", "forbidden", "forbidden", "forbidden", "forbidden"]],
  [
    "owner",
    "archived",
    "open",
    ["ok", "artifact_archived", "artifact_archived", "artifact_archived", "artifact_archived"],
  ],
  ["owner", "suspended", "open", ["ok", "forbidden", "forbidden", "forbidden", "forbidden"]],
  ["participant", "active", "open", ["ok", "ok", "ok", "ok", "forbidden"]],
  ["participant", "active", "locked", ["ok", "forbidden", "ok", "forbidden", "forbidden"]],
  [
    "participant",
    "active",
    "off",
    ["forbidden", "forbidden", "forbidden", "forbidden", "forbidden"],
  ],
  [
    "participant",
    "archived",
    "open",
    ["not_found", "not_found", "not_found", "not_found", "not_found"],
  ],
  [
    "participant",
    "suspended",
    "open",
    ["not_found", "not_found", "not_found", "not_found", "not_found"],
  ],
  [null, "active", "open", ["not_found", "not_found", "not_found", "not_found", "not_found"]],
];

describe("annotation permissions", () => {
  it.each(MATRIX)("%s on a %s artifact with annotations %s", (role, state, mode, expected) => {
    expect(outcomes(role, state, mode)).toEqual(expected);
  });

  it("treats drafts and deleted artifacts as missing for everyone", () => {
    for (const state of ["draft", "purging", "deleted"] as const) {
      expect(outcomes("owner", state, "open")).toEqual(Array(5).fill("not_found"));
      expect(checkAnnotationModeChange({ role: "owner", state }).ok).toBe(false);
    }
  });

  it("explains why a locked or disabled artifact refuses a comment", () => {
    expect(
      checkAnnotationAction(
        { role: "participant", state: "active", mode: "locked" },
        "participate",
      ),
    ).toEqual({
      ok: false,
      code: "forbidden",
      message: "Annotations are locked: threads can be read but not added to.",
    });
    expect(
      checkAnnotationAction({ role: "participant", state: "active", mode: "off" }, "read"),
    ).toMatchObject({ message: "Annotations are off for this artifact." });
  });

  it("lets only the owner change the mode, on active and archived artifacts", () => {
    expect(checkAnnotationModeChange({ role: "owner", state: "active" })).toEqual({
      ok: true,
      value: true,
    });
    expect(checkAnnotationModeChange({ role: "owner", state: "archived" }).ok).toBe(true);
    expect(checkAnnotationModeChange({ role: "owner", state: "suspended" })).toMatchObject({
      code: "forbidden",
    });
    expect(checkAnnotationModeChange({ role: "participant", state: "active" })).toMatchObject({
      code: "not_found",
    });
    expect(checkAnnotationModeChange({ role: null, state: "active" })).toMatchObject({
      code: "not_found",
    });
  });
});

describe("thread and message rules", () => {
  it("shows visitors only the current version's threads", () => {
    expect(threadVisible("participant", "v2", "v2")).toBe(true);
    expect(threadVisible("participant", "v1", "v2")).toBe(false);
    expect(threadVisible("participant", "v1", null)).toBe(false);
    expect(threadVisible("owner", "v1", "v2")).toBe(true);
  });

  it("takes new messages only on the current version", () => {
    expect(checkThreadWritable("v2", "v2").ok).toBe(true);
    expect(checkThreadWritable("v1", "v2")).toMatchObject({ code: "version_conflict" });
    expect(checkThreadWritable("v1", null)).toMatchObject({ code: "version_conflict" });
  });

  it("lets the owner or the thread's author resolve it", () => {
    expect(checkResolve("owner", "u_owner", "u_a").ok).toBe(true);
    expect(checkResolve("participant", "u_a", "u_a").ok).toBe(true);
    expect(checkResolve("participant", "u_b", "u_a")).toMatchObject({ code: "forbidden" });
  });

  it("lets only the author edit a visible message", () => {
    expect(checkEditMessage("u_a", { authorId: "u_a", state: "visible" }).ok).toBe(true);
    expect(checkEditMessage("u_owner", { authorId: "u_a", state: "visible" })).toMatchObject({
      code: "forbidden",
      message: "You can only edit your own messages.",
    });
    expect(checkEditMessage("u_a", { authorId: "u_a", state: "hidden" })).toMatchObject({
      code: "forbidden",
      message: "The owner hid this message; it cannot be edited.",
    });
    expect(checkEditMessage("u_a", { authorId: "u_a", state: "deleted" })).toMatchObject({
      code: "not_found",
    });
  });

  it("lets only the author delete through the own-message path", () => {
    expect(checkDeleteOwnMessage("u_a", { authorId: "u_a", state: "hidden" }).ok).toBe(true);
    expect(checkDeleteOwnMessage("u_b", { authorId: "u_a", state: "visible" })).toMatchObject({
      code: "forbidden",
    });
  });

  it("moves messages between visible, hidden and deleted, and no-ops on repeats", () => {
    const visible = { authorId: "u_a", state: "visible" } as const;
    const hidden = { authorId: "u_a", state: "hidden" } as const;
    const deleted = { authorId: "u_a", state: "deleted" } as const;
    expect(moderationTransition(visible, "hide")).toEqual({ ok: true, value: "hidden" });
    expect(moderationTransition(hidden, "hide")).toEqual({ ok: true, value: null });
    expect(moderationTransition(hidden, "unhide")).toEqual({ ok: true, value: "visible" });
    expect(moderationTransition(visible, "unhide")).toEqual({ ok: true, value: null });
    expect(moderationTransition(visible, "delete")).toEqual({ ok: true, value: "deleted" });
    expect(moderationTransition(hidden, "delete")).toEqual({ ok: true, value: "deleted" });
    expect(moderationTransition(deleted, "delete")).toEqual({ ok: true, value: null });
    expect(moderationTransition(deleted, "hide")).toMatchObject({ code: "not_found" });
    expect(moderationTransition(deleted, "unhide")).toMatchObject({ code: "not_found" });
  });

  it("shows a hidden body only to the owner and its author, and a deleted one to nobody", () => {
    const hidden = { authorId: "u_a", state: "hidden" } as const;
    expect(messageBodyVisible("owner", "u_owner", hidden)).toBe(true);
    expect(messageBodyVisible("participant", "u_a", hidden)).toBe(true);
    expect(messageBodyVisible("participant", "u_b", hidden)).toBe(false);
    expect(messageBodyVisible("participant", "u_b", { authorId: "u_a", state: "visible" })).toBe(
      true,
    );
    expect(messageBodyVisible("owner", "u_a", { authorId: "u_a", state: "deleted" })).toBe(false);
  });
});

describe("annotation limits", () => {
  const idle: AnnotationUsageSnapshot = {
    authorWritesLastMinute: 0,
    authorWritesLast24h: 0,
    artifactWritesLast24h: 0,
    artifactThreads: 0,
    threadMessages: 0,
    ownerMessages: 0,
    ownerBytes: 0,
  };
  const thread = { kind: "thread", addedBytes: 100 } as const;
  const code = (usage: Partial<AnnotationUsageSnapshot>, write: AnnotationWrite = thread) => {
    const result = checkAnnotationWrite({ ...idle, ...usage }, write);
    return result.ok ? "ok" : result.code;
  };

  it("allows five writes a minute and 100 a day per author", () => {
    expect(code({ authorWritesLastMinute: 4 })).toBe("ok");
    expect(code({ authorWritesLastMinute: 5 })).toBe("rate_limited");
    expect(code({ authorWritesLast24h: 99 })).toBe("ok");
    expect(code({ authorWritesLast24h: 100 })).toBe("rate_limited");
    expect(code({ artifactWritesLast24h: ANNOTATION_LIMITS.artifactWritesPer24h - 1 })).toBe("ok");
    expect(code({ artifactWritesLast24h: ANNOTATION_LIMITS.artifactWritesPer24h })).toBe(
      "rate_limited",
    );
  });

  it("checks rate limits before quotas", () => {
    expect(
      checkAnnotationWrite({ ...idle, authorWritesLastMinute: 5, ownerMessages: 5_000 }, thread),
    ).toMatchObject({ code: "rate_limited" });
  });

  it("caps threads per artifact only when starting a thread", () => {
    expect(code({ artifactThreads: 999 })).toBe("ok");
    expect(code({ artifactThreads: 1_000 })).toBe("quota_exceeded");
    expect(code({ artifactThreads: 1_000 }, { kind: "reply", addedBytes: 1 })).toBe("ok");
  });

  it("caps messages per thread only when replying", () => {
    const reply = { kind: "reply", addedBytes: 1 } as const;
    expect(code({ threadMessages: 199 }, reply)).toBe("ok");
    expect(code({ threadMessages: 200 }, reply)).toBe("quota_exceeded");
    expect(code({ threadMessages: 200 })).toBe("ok");
  });

  it("caps the owner's messages and bytes, and lets edits that add no message through", () => {
    expect(code({ ownerMessages: 4_999 })).toBe("ok");
    expect(code({ ownerMessages: 5_000 })).toBe("quota_exceeded");
    expect(code({ ownerMessages: 5_000 }, { kind: "edit", addedBytes: 0 })).toBe("ok");
    expect(code({ ownerBytes: 49_999_900 })).toBe("ok");
    expect(code({ ownerBytes: 49_999_901 })).toBe("quota_exceeded");
    expect(code({ ownerBytes: 50_000_000 }, { kind: "edit", addedBytes: -10 })).toBe("ok");
    expect(code({ ownerBytes: 50_000_000 }, { kind: "edit", addedBytes: 1 })).toBe(
      "quota_exceeded",
    );
  });
});
