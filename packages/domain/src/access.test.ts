import { describe, expect, it } from "vitest";
import { type AccessPolicy, canManage, canRead, checkAccessChange, type Viewer } from "./access.ts";

/** What every allowed decision returns, exactly. */
const GRANTED = { ok: true, value: true };
const owner: Viewer = { userId: "u_owner", verifiedEmails: ["owner@example.com"] };
const reader: Viewer = {
  userId: "u_reader",
  verifiedEmails: ["ana@example.com", "ana@work.example"],
};
const stranger: Viewer = { userId: "u_stranger", verifiedEmails: ["x@example.com"] };
const policy = (mode: AccessPolicy["mode"], readers: string[] = []): AccessPolicy => ({
  mode,
  ownerId: owner.userId,
  readers,
});

describe("canRead", () => {
  it("lets anyone read public artifacts, signed in or not", () => {
    expect(canRead(policy("public"), null)).toEqual(GRANTED);
    expect(canRead(policy("public"), stranger)).toEqual(GRANTED);
  });

  it("asks anonymous visitors to sign in for protected artifacts", () => {
    expect(canRead(policy("authenticated"), null)).toMatchObject({
      ok: false,
      code: "unauthenticated",
    });
    expect(canRead(policy("restricted"), null)).toMatchObject({
      ok: false,
      code: "unauthenticated",
    });
  });

  it("lets any signed-in account read authenticated artifacts", () => {
    expect(canRead(policy("authenticated"), stranger)).toEqual(GRANTED);
  });

  it("restricts to the owner and listed verified emails", () => {
    const restricted = policy("restricted", ["ana@work.example"]);
    expect(canRead(restricted, owner)).toEqual(GRANTED);
    expect(canRead(restricted, reader)).toEqual(GRANTED);
    expect(canRead(restricted, stranger)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("starts with only the owner when no reader is listed", () => {
    expect(canRead(policy("restricted"), reader)).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("canManage", () => {
  it("allows only the owner", () => {
    expect(canManage(policy("public"), owner)).toEqual(GRANTED);
    expect(canManage(policy("restricted", ["ana@example.com"]), reader)).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(canManage(policy("public"), null)).toMatchObject({ ok: false, code: "unauthenticated" });
  });
});

describe("checkAccessChange", () => {
  const created = new Date("2026-11-01T00:00:00Z");

  it("blocks public access during the first 15 minutes of an account", () => {
    expect(
      checkAccessChange("public", created, new Date("2026-11-01T00:14:59.999Z")),
    ).toMatchObject({
      ok: false,
      code: "account_too_new_for_public",
    });
  });

  it("allows public access from minute 15", () => {
    expect(checkAccessChange("public", created, new Date("2026-11-01T00:15:00Z"))).toEqual(GRANTED);
  });

  it("never blocks private modes", () => {
    expect(checkAccessChange("restricted", created, created)).toEqual(GRANTED);
    expect(checkAccessChange("authenticated", created, created)).toEqual(GRANTED);
  });
});
