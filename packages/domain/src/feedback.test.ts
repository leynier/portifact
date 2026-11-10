import { describe, expect, it } from "vitest";
import type { Actor } from "./actor.ts";
import { decodeFeedbackCursor, encodeFeedbackCursor, feedbackReach } from "./feedback.ts";

const WS = "ws_0123456789abcdef0123456789abcdef";
const actor = (role: Actor["role"], ownerId = WS, userId = "u_1"): Actor => ({
  userId,
  ownerId,
  role,
  region: "default",
});
const viewer = (emails: string[] = ["me@example.com"]) => ({
  userId: "u_1",
  verifiedEmails: emails,
});

describe("feedbackReach", () => {
  it("gives the owner side every mode and every thread, in every state but the gone ones", () => {
    for (const role of ["admin", "editor"] as const) {
      const reach = feedbackReach(actor(role), viewer(), undefined);
      expect(reach.role).toBe("owner");
      expect(reach.openModes).toBeNull();
      expect(reach.scopeOf).toEqual({ owner: "all", everyone: "all" });
      const states = new Set(reach.readable.map((pair) => pair.state));
      expect(states).toEqual(new Set(["active", "archived", "suspended"]));
      expect(reach.readable).toHaveLength(9);
    }
    const personal = feedbackReach(actor("admin", "u_1"), viewer(), undefined);
    expect(personal.role).toBe("owner");
  });

  it("gives a member what canRead and the comment rules allow a participant", () => {
    const reach = feedbackReach(actor("member"), viewer(), {
      featureAvailable: true,
      verified: [],
    });
    expect(reach.role).toBe("participant");
    expect(reach.openModes).toEqual(["public", "authenticated", "workspace", "domain"]);
    expect(reach.readerList).toBe(true);
    expect(reach.scopeOf).toEqual({ owner: "own", everyone: "all" });
    expect(reach.readable).toEqual([
      { state: "active", mode: "open" },
      { state: "active", mode: "locked" },
    ]);
  });

  it("does not let a member without a verified address through the reader list", () => {
    const reach = feedbackReach(actor("member"), viewer([]), undefined);
    expect(reach.readerList).toBe(false);
    expect(reach.openModes).toEqual(["public", "authenticated", "workspace", "domain"]);
  });

  it("gives a viewer with no role on a workspace only the modes open to anyone", () => {
    const stranger: Actor = { ...actor("member"), userId: "u_2" };
    const reach = feedbackReach(stranger, viewer(), undefined);
    expect(reach.openModes).toEqual(["public", "authenticated"]);
  });
});

describe("feedback cursors", () => {
  const position = { updatedAt: 1_762_600_000_000, threadId: crypto.randomUUID() };

  it("round-trip", () => {
    const cursor = encodeFeedbackCursor(position);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeFeedbackCursor(cursor)).toEqual(position);
  });

  it("refuse anything else", () => {
    for (const text of [
      `a${position.updatedAt}.${position.threadId}`,
      `f${position.updatedAt}.not-a-uuid`,
      `f${"1".repeat(16)}.${position.threadId}`,
      `f.${position.threadId}`,
      `f1.${position.threadId.toUpperCase()}`,
      `f1.${position.threadId}x`,
    ]) {
      expect(decodeFeedbackCursor(btoa(text)), text).toBeUndefined();
    }
    expect(decodeFeedbackCursor("%%%")).toBeUndefined();
  });
});
