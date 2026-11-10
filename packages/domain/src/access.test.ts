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
    expect(checkAccessChange("public", created, new Date("2026-11-01T00:14:59.999Z"))).toEqual({
      ok: false,
      code: "account_too_new_for_public",
      message: "Accounts can make artifacts public 15 minutes after they are created.",
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

describe("canRead in the workspace and domain modes (decision 0010)", () => {
  const ws = "ws_0123456789abcdef0123456789abcdef";
  type Who =
    | "anonymous"
    | "admin"
    | "editor"
    | "member"
    | "domain"
    | "unicodeDomain"
    | "unicodeSpelling"
    | "unverified"
    | "subdomain"
    | "listed"
    | "outsider";
  const viewers: Record<Exclude<Who, "anonymous">, Viewer> = {
    admin: { userId: "u_admin", verifiedEmails: ["admin@acme.example"] },
    editor: { userId: "u_editor", verifiedEmails: ["editor@elsewhere.example"] },
    member: { userId: "u_member", verifiedEmails: ["member@elsewhere.example"] },
    domain: { userId: "u_domain", verifiedEmails: ["dana@ACME.example"] },
    // An address at an internationalized domain matches in its ASCII form only: the mailbox was
    // proven for the address as written, and other spellings fold onto the same name.
    unicodeDomain: { userId: "u_idn", verifiedEmails: ["ida@xn--bcher-kva.example"] },
    unicodeSpelling: { userId: "u_spelled", verifiedEmails: ["ida@bücher.example"] },
    // The address is at the domain but not verified, so the session gives no verified email.
    unverified: { userId: "u_unverified", verifiedEmails: [] },
    subdomain: { userId: "u_sub", verifiedEmails: ["sam@eng.acme.example"] },
    listed: { userId: "u_listed", verifiedEmails: ["lee@partner.example"] },
    outsider: { userId: "u_out", verifiedEmails: ["out@other.example"] },
  };
  const roles: Partial<Record<Who, Actor["role"]>> = {
    admin: "admin",
    editor: "editor",
    member: "member",
  };
  const actor = (who: Who, ownerId: string): Actor | null => {
    const role = roles[who];
    if (who === "anonymous" || !role) return null;
    return { userId: viewers[who].userId, ownerId, role, region: "default" };
  };
  const decide = (
    mode: AccessPolicy["mode"],
    who: Who,
    feature: boolean,
    ownerId: string = ws,
  ): "read" | "sign_in" | "no" => {
    const viewer = who === "anonymous" ? null : viewers[who];
    const result = canRead(
      {
        mode,
        ownerId,
        readers: ["lee@partner.example"],
        domains: { featureAvailable: feature, verified: ["acme.example", "xn--bcher-kva.example"] },
      },
      viewer,
      actor(who, ownerId),
    );
    if (result.ok) {
      expect(result).toEqual(GRANTED);
      return "read";
    }
    if (result.code === "unauthenticated") {
      expect(result.message).toBe("Sign in to open this artifact.");
      return "sign_in";
    }
    expect(result).toEqual({
      ok: false,
      code: "forbidden",
      message: "Your account does not have access to this artifact.",
    });
    return "no";
  };
  const WHO: Who[] = [
    "anonymous",
    "admin",
    "editor",
    "member",
    "domain",
    "unicodeDomain",
    "unicodeSpelling",
    "unverified",
    "subdomain",
    "listed",
    "outsider",
  ];
  // Expected answers, in the order of WHO.
  const table: [AccessPolicy["mode"], boolean, string][] = [
    ["public", true, "read read read read read read read read read read read"],
    ["authenticated", true, "sign_in read read read read read read read read read read"],
    ["restricted", true, "sign_in read read no no no no no no read no"],
    ["workspace", true, "sign_in read read read no no no no no no no"],
    ["workspace", false, "sign_in read read read no no no no no no no"],
    ["domain", true, "sign_in read read read read read no no no no no"],
    // A lapsed plan falls back to members only, never wider.
    ["domain", false, "sign_in read read read no no no no no no no"],
  ];
  for (const [mode, feature, expected] of table) {
    it(`${mode} with the feature ${feature ? "on" : "off"}`, () => {
      expect(WHO.map((who) => decide(mode, who, feature)).join(" ")).toBe(expected);
    });
  }

  it("never grants through a domain when the services found none", () => {
    expect(
      canRead({ mode: "domain", ownerId: ws, readers: [] }, viewers.domain, null),
    ).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("does not let a role on another workspace count as membership", () => {
    const other = "ws_ffffffffffffffffffffffffffffffff";
    for (const mode of ["workspace", "domain"] as const) {
      expect(
        canRead({ mode, ownerId: ws, readers: [] }, viewers.member, actor("member", other)),
      ).toMatchObject({ ok: false, code: "forbidden" });
      expect(
        canRead({ mode, ownerId: ws, readers: [] }, viewers.outsider, actor("member", ws)),
      ).toMatchObject({ ok: false, code: "forbidden" });
    }
  });

  it("reads like restricted without readers on a personal owner (after a transfer)", () => {
    const personal = "u_admin";
    const ownerActor = personalActor(personal);
    for (const mode of ["workspace", "domain"] as const) {
      const p: AccessPolicy = {
        mode,
        ownerId: personal,
        readers: [],
        domains: { featureAvailable: true, verified: ["acme.example"] },
      };
      expect(canRead(p, viewers.admin, ownerActor)).toEqual(GRANTED);
      expect(canRead(p, viewers.domain, null)).toMatchObject({ ok: false, code: "forbidden" });
      // A personal space has no members: only its owner's own actor counts.
      expect(
        canRead(p, viewers.member, {
          ...ownerActor,
          userId: viewers.member.userId,
          role: "member",
        }),
      ).toMatchObject({ ok: false, code: "forbidden" });
    }
  });

  it("matches only well-formed addresses", () => {
    const p: AccessPolicy = {
      mode: "domain",
      ownerId: ws,
      readers: [],
      domains: { featureAvailable: true, verified: ["acme.example"] },
    };
    for (const email of ["acme.example", "@acme.example", "x@", "x@acme.example.", "x@[1.2.3.4]"]) {
      expect(canRead(p, { userId: "u_x", verifiedEmails: [email] }, null).ok, email).toBe(false);
    }
  });
});
