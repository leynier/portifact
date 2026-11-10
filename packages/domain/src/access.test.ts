import { describe, expect, it } from "vitest";
import { type AccessPolicy, canRead, checkAccessChange, type Viewer } from "./access.ts";
import { type Actor, authorize, personalActor } from "./actor.ts";

/** What every allowed decision returns, exactly. */
const GRANTED = { ok: true, value: true };
const owner: Viewer = { userId: "u_owner", verifiedEmails: ["owner@example.com"] };
const reader: Viewer = {
  userId: "u_reader",
  verifiedEmails: ["ana@example.com", "ana@work.example"],
};
const stranger: Viewer = { userId: "u_stranger", verifiedEmails: ["x@example.com"] };
/** The role each viewer has on the owner, as resolveActor gives it: only the owner has one. */
const actorOf = (viewer: Viewer | null): Actor | null =>
  viewer === owner ? personalActor(owner.userId) : null;
const read = (p: AccessPolicy, viewer: Viewer | null) => canRead(p, viewer, actorOf(viewer));
const policy = (mode: AccessPolicy["mode"], readers: string[] = []): AccessPolicy => ({
  mode,
  ownerId: owner.userId,
  readers,
});

describe("canRead", () => {
  it("lets anyone read public artifacts, signed in or not", () => {
    expect(read(policy("public"), null)).toEqual(GRANTED);
    expect(read(policy("public"), stranger)).toEqual(GRANTED);
  });

  it("asks anonymous visitors to sign in for protected artifacts", () => {
    expect(read(policy("authenticated"), null)).toMatchObject({
      ok: false,
      code: "unauthenticated",
    });
    expect(read(policy("restricted"), null)).toMatchObject({
      ok: false,
      code: "unauthenticated",
    });
  });

  it("lets any signed-in account read authenticated artifacts", () => {
    expect(read(policy("authenticated"), stranger)).toEqual(GRANTED);
  });

  it("restricts to the owner and listed verified emails", () => {
    const restricted = policy("restricted", ["ana@work.example"]);
    expect(read(restricted, owner)).toEqual(GRANTED);
    expect(read(restricted, reader)).toEqual(GRANTED);
    expect(read(restricted, stranger)).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("starts with only the owner when no reader is listed", () => {
    expect(read(policy("restricted"), reader)).toMatchObject({ ok: false, code: "forbidden" });
  });
});

describe("canRead with workspace roles", () => {
  const workspace = "ws_0123456789abcdef0123456789abcdef";
  const onWorkspace = (role: Actor["role"]): Actor => ({
    userId: reader.userId,
    ownerId: workspace,
    role,
    region: "default",
  });
  const restricted: AccessPolicy = { mode: "restricted", ownerId: workspace, readers: [] };

  it("lets admins and editors of the owner read every artifact, as the owner did", () => {
    expect(canRead(restricted, reader, onWorkspace("admin"))).toEqual(GRANTED);
    expect(canRead(restricted, reader, onWorkspace("editor"))).toEqual(GRANTED);
  });

  it("does not open a restricted artifact to a member who is not on the reader list", () => {
    expect(canRead(restricted, reader, onWorkspace("member"))).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(
      canRead({ ...restricted, readers: ["ana@example.com"] }, reader, onWorkspace("member")),
    ).toEqual(GRANTED);
  });

  it("ignores a role on another owner or held by someone else", () => {
    expect(
      canRead(restricted, reader, { ...onWorkspace("admin"), ownerId: owner.userId }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(canRead(restricted, stranger, onWorkspace("admin"))).toMatchObject({
      ok: false,
      code: "forbidden",
    });
  });

  it("still asks anonymous visitors to sign in", () => {
    expect(canRead(restricted, null, onWorkspace("admin"))).toMatchObject({
      ok: false,
      code: "unauthenticated",
    });
  });
});

describe("managing an artifact", () => {
  it("allows only the owner, and answers a stranger like a missing artifact", () => {
    expect(authorize(personalActor(owner.userId), "access")).toMatchObject({ ok: true });
    expect(authorize(null, "access")).toMatchObject({ ok: false, code: "not_found" });
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
