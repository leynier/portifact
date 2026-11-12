// Reproductions of the bypasses the adversarial review of the contributor agreement found
// (findings 2, 4, 5 and 6), written against the check as it was. Each must fail before the fix.
import { describe, expect, it } from "vitest";
import { checkCla, SIGNATURE_STATEMENT } from "./cla.ts";

const sign = (login: string, name = "Ada Lovelace") =>
  `- @${login}, ${name}, 2026-11-09: ${SIGNATURE_STATEMENT}`;
const file = (...lines: string[]) => ["# Signers", "", ...lines, ""].join("\n");
const commit = (login: string | null, sha = "0123456789abcdef0123") => ({ sha, login });

describe("bypasses of the old check", () => {
  it("finding 2: Alice signs for Bob when a commit names Bob as its author", () => {
    const { problems } = checkCla({
      author: "alice",
      commits: [commit("alice"), commit("bob")],
      baseSigners: file(sign("alice")),
      headSigners: file(sign("alice"), sign("bob", "Bob")),
    });
    expect(problems).not.toEqual([]);
  });

  it("finding 4: an exempt account's pull request deletes every signature", () => {
    const { problems } = checkCla({
      author: "dependabot[bot]",
      commits: [commit("dependabot[bot]")],
      baseSigners: file(sign("alice"), sign("bob", "Bob")),
      headSigners: undefined,
    });
    expect(problems).not.toEqual([]);
  });

  it("finding 4: an exempt account's pull request fabricates a signature", () => {
    const { problems } = checkCla({
      author: "leynier",
      commits: [commit("leynier")],
      baseSigners: file(),
      headSigners: file(sign("carol", "Carol")),
    });
    expect(problems).not.toEqual([]);
  });

  it("finding 5: an unsigned co-author is invisible", () => {
    // The old input has no commit messages at all, so a Co-authored-by trailer cannot be seen.
    const { problems, required } = checkCla({
      author: "alice",
      commits: [commit("alice")],
      baseSigners: file(sign("alice")),
      headSigners: file(sign("alice")),
    });
    expect(problems).toEqual([]);
    expect(required).toContain("mallory");
  });

  it("finding 6: a list of 251 commits passes as if it were complete", () => {
    const commits = Array.from({ length: 251 }, (_, i) =>
      commit("alice", i.toString(16).padStart(40, "0")),
    );
    const { problems } = checkCla({
      author: "alice",
      commits,
      baseSigners: file(sign("alice")),
      headSigners: file(sign("alice")),
    });
    expect(problems).not.toEqual([]);
  });
});
