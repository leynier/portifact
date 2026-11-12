import { describe, expect, it } from "vitest";
import { dataGate } from "../src/gate.ts";
import {
  beginTransaction,
  type GrantClaims,
  issueCode,
  newVisitorId,
  openValue,
  redeem,
  sealValue,
  socketDeadline,
} from "../src/grants.ts";
import { NOW } from "./harness.ts";

const HOST = "abc.portifact.dev";

describe("the grant handoff", () => {
  it("redeems once, in the browser that began it, on its host, before it expires", async () => {
    const victim = await beginTransaction();
    const { code, pending } = await issueCode(victim.nonceHash, HOST, "g_1", NOW);
    expect(await redeem(pending, code, victim.nonce, "other.portifact.dev", NOW)).toEqual({
      ok: false,
    });
    expect(await redeem(pending, code, null, HOST, NOW)).toEqual({ ok: false });
    expect(await redeem(pending, "wrong", victim.nonce, HOST, NOW)).toEqual({ ok: false });
    expect(await redeem(pending, code, victim.nonce, HOST, NOW + 60_000)).toEqual({ ok: false });
    expect(await redeem(pending, code, victim.nonce, HOST, NOW)).toEqual({
      ok: true,
      grantId: "g_1",
    });
    expect(await redeem(pending, code, victim.nonce, HOST, NOW)).toEqual({ ok: false });
    expect(await redeem(undefined, code, victim.nonce, HOST, NOW)).toEqual({ ok: false });
  });

  it("refuses the attacker's code planted in the victim's browser (session fixation, finding 3)", async () => {
    const attacker = await beginTransaction();
    const victim = await beginTransaction();
    const { code, pending } = await issueCode(attacker.nonceHash, HOST, "g_attacker", NOW);
    expect(await redeem(pending, code, victim.nonce, HOST, NOW)).toEqual({ ok: false });
  });

  it("seals the grant cookie under versioned keys and opens old ones until they are retired", async () => {
    const claims: GrantClaims = {
      grant: "g_1",
      artifact: "abc",
      visitor: newVisitorId(),
      claimsUntil: NOW + 60_000,
      grantUntil: NOW + 86_400_000,
    };
    const v1 = { current: "k1", keys: { k1: "first-secret-0123456789abcdef0123" } };
    const sealed = await sealValue(v1, claims);
    const rotated = {
      current: "k2",
      keys: { k1: v1.keys.k1, k2: "second-secret-0123456789abcdef012" },
    };
    expect(await openValue(rotated, sealed)).toEqual(claims);
    expect((await sealValue(rotated, claims)).startsWith("k2.")).toBe(true);
    const retired = { current: "k2", keys: { k2: rotated.keys.k2 } };
    expect(await openValue(retired, sealed)).toBeNull();
    expect(await openValue(rotated, `${sealed}x`)).toBeNull();
    expect(await openValue(rotated, "garbage")).toBeNull();
    await expect(sealValue({ current: "k9", keys: {} }, claims)).rejects.toThrow();
  });

  it("gives a live connection no more than the claims allow", () => {
    const claims: GrantClaims = {
      grant: "g",
      artifact: "a",
      visitor: "v",
      claimsUntil: NOW + 5_000,
      grantUntil: NOW + 1_000,
    };
    expect(socketDeadline(claims, NOW)).toBe(NOW + 1_000);
    expect(
      socketDeadline({ ...claims, grantUntil: NOW + 10 ** 9, claimsUntil: NOW + 10 ** 9 }, NOW),
    ).toBe(NOW + 60_000);
  });

  it("makes random visitor IDs that carry nothing about the account", () => {
    const one = newVisitorId();
    expect(one).toMatch(/^v_[A-Za-z0-9_-]{22}$/);
    expect(newVisitorId()).not.toBe(one);
  });

  it("keeps the API gate same-origin only", () => {
    const origin = "https://abc.portifact.dev";
    const request = (headers: Record<string, string>) =>
      new Request(`${origin}/__portifact/data/c/items`, { headers });
    expect(dataGate(request({ "Sec-Fetch-Site": "same-origin" }), false)).toBe("allowed");
    expect(dataGate(request({ "Sec-Fetch-Site": "same-site" }), false)).toBe("refused");
    const write = {
      "Sec-Fetch-Site": "same-origin",
      Origin: origin,
      "Content-Type": "application/json",
    };
    expect(dataGate(request(write), true)).toBe("allowed");
    expect(dataGate(request({ ...write, Origin: "https://evil.portifact.dev" }), true)).toBe(
      "refused",
    );
    expect(dataGate(request({ ...write, "Content-Type": "text/plain" }), true)).toBe("refused");
    expect(
      dataGate(request({ "Sec-Fetch-Site": "same-origin", Upgrade: "websocket" }), false),
    ).toBe("refused");
  });
});
