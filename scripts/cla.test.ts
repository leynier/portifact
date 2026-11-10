import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLA_VERSION,
  checkCla,
  EXEMPT_LOGINS,
  parseCommits,
  parseSigners,
  SIGNATURE_STATEMENT,
  SIGNERS_FILE,
} from "./cla.ts";

const sign = (login: string, name = "Ada Lovelace", date = "2026-11-09") =>
  `- @${login}, ${name}, ${date}: ${SIGNATURE_STATEMENT}`;
const file = (...lines: string[]) => ["# Signers", "", "Prose.", "", ...lines, ""].join("\n");
const commit = (login: string | null, sha = "0123456789abcdef0123") => ({ sha, login });

describe("parseSigners", () => {
  it("reads signature lines and ignores headings and prose", () => {
    const parsed = parseSigners(file(sign("ada"), sign("Grace-H", "Grace Hopper, PhD")));
    expect(parsed.errors).toEqual([]);
    expect(parsed.signatures.map(({ login, name, date }) => ({ login, name, date }))).toEqual([
      { login: "ada", name: "Ada Lovelace", date: "2026-11-09" },
      { login: "Grace-H", name: "Grace Hopper, PhD", date: "2026-11-09" },
    ]);
  });

  it("accepts Windows line endings and trailing spaces", () => {
    expect(parseSigners(`${sign("ada")}  \r\n`).errors).toEqual([]);
  });

  it("refuses malformed items, bad dates, another statement, invalid logins and duplicates", () => {
    const parsed = parseSigners(
      file(
        "- someone agreed",
        sign("ada", "Ada", "2026-02-30"),
        sign("ada", "Ada", "2026-11-09").replace("version 1.0", "version 0.9"),
        sign("-bad"),
        sign("a".repeat(40)),
        sign("Ada"),
        `- @ada,  , 2026-11-09: ${SIGNATURE_STATEMENT}`,
      ),
    );
    expect(parsed.errors).toEqual([
      `${SIGNERS_FILE} line 5 is not "- @login, Full Name, YYYY-MM-DD: <statement>"`,
      `${SIGNERS_FILE} line 6 has an invalid date "2026-02-30"`,
      `${SIGNERS_FILE} line 7 does not carry the exact statement from contributing.md`,
      `${SIGNERS_FILE} line 7 signs @ada a second time`,
      `${SIGNERS_FILE} line 8 is not "- @login, Full Name, YYYY-MM-DD: <statement>"`,
      `${SIGNERS_FILE} line 9 is not "- @login, Full Name, YYYY-MM-DD: <statement>"`,
      `${SIGNERS_FILE} line 10 signs @Ada a second time`,
      `${SIGNERS_FILE} line 11 has no name`,
      `${SIGNERS_FILE} line 11 signs @ada a second time`,
    ]);
  });

  it("names the agreement's version in the statement", () => {
    expect(SIGNATURE_STATEMENT).toContain(`version ${CLA_VERSION}`);
    expect(SIGNATURE_STATEMENT).not.toContain("—");
  });
});

describe("checkCla", () => {
  const signed = file(sign("ada"));

  it("passes a contributor who signs in their first pull request", () => {
    expect(
      checkCla({
        author: "ada",
        commits: [commit("ada")],
        baseSigners: file(),
        headSigners: signed,
      }),
    ).toEqual({ problems: [], required: ["ada"] });
  });

  it("passes a contributor who signed before, matching logins in any case", () => {
    expect(
      checkCla({
        author: "ADA",
        commits: [commit("Ada")],
        baseSigners: signed,
        headSigners: signed,
      }).problems,
    ).toEqual([]);
  });

  it("refuses an author who has not signed", () => {
    expect(
      checkCla({
        author: "eve",
        commits: [commit("eve")],
        baseSigners: signed,
        headSigners: signed,
      }).problems,
    ).toEqual([
      `@eve has not signed the contributor license agreement: add your line to ${SIGNERS_FILE} as contributing.md explains`,
    ]);
  });

  it("requires every commit author to sign, not only the pull request's author", () => {
    const result = checkCla({
      author: "ada",
      commits: [commit("ada"), commit("bob")],
      baseSigners: signed,
      headSigners: signed,
    });
    expect(result.required).toEqual(["ada", "bob"]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("@bob has not signed");
  });

  it("lets a commit author in the pull request sign for themself", () => {
    expect(
      checkCla({
        author: "ada",
        commits: [commit("ada"), commit("bob")],
        baseSigners: signed,
        headSigners: file(sign("ada"), sign("bob", "Bob")),
      }).problems,
    ).toEqual([]);
  });

  it("refuses a signature added for someone who did not author the pull request", () => {
    const { problems } = checkCla({
      author: "ada",
      commits: [commit("ada")],
      baseSigners: signed,
      headSigners: file(sign("ada"), sign("carol", "Carol")),
    });
    expect(problems).toEqual([
      "the pull request adds a signature for @carol, who is not one of its authors: each contributor signs for themself",
    ]);
  });

  it("refuses removing or changing a signature from the base branch", () => {
    const base = file(sign("ada"), sign("bob", "Bob"));
    const removed = checkCla({
      author: "ada",
      commits: [commit("ada")],
      baseSigners: base,
      headSigners: signed,
    });
    expect(removed.problems).toEqual([
      "the signature of @bob on the base branch was removed or changed",
    ]);
    const changed = checkCla({
      author: "bob",
      commits: [commit("bob")],
      baseSigners: base,
      headSigners: file(sign("ada"), sign("bob", "Robert")),
    });
    expect(changed.problems).toEqual([
      "the signature of @bob on the base branch was removed or changed",
    ]);
  });

  it("refuses commits whose author email belongs to no GitHub account", () => {
    const { problems } = checkCla({
      author: "ada",
      commits: [commit(null, "fedcba9876543210fedc")],
      baseSigners: signed,
      headSigners: signed,
    });
    expect(problems).toEqual([
      "commit fedcba987654 has an author email that belongs to no GitHub account, so its signature cannot be checked: use an email linked to your account and push again",
    ]);
  });

  it("refuses a pull request that deletes the signers file or breaks its format", () => {
    expect(
      checkCla({ author: "ada", commits: [], baseSigners: signed, headSigners: undefined })
        .problems,
    ).toEqual([`${SIGNERS_FILE} is missing at the head of the pull request`]);
    expect(
      checkCla({
        author: "ada",
        commits: [],
        baseSigners: signed,
        headSigners: `${signed}- @mallory said yes\n`,
      }).problems,
    ).toEqual([`${SIGNERS_FILE} line 6 is not "- @login, Full Name, YYYY-MM-DD: <statement>"`]);
  });

  it("works when the base branch has no signers file yet", () => {
    expect(
      checkCla({ author: "ada", commits: [], baseSigners: undefined, headSigners: signed })
        .problems,
    ).toEqual([]);
  });

  it("exempts the maintainer and automation, even without a signers file", () => {
    for (const author of EXEMPT_LOGINS) {
      expect(
        checkCla({
          author,
          commits: [commit("leynier"), commit("dependabot[bot]")],
          baseSigners: undefined,
          headSigners: undefined,
        }),
      ).toEqual({ problems: [], required: [] });
    }
    expect(
      checkCla({ author: "Leynier", commits: [], baseSigners: "", headSigners: "" }).required,
    ).toEqual([]);
  });

  it("does not exempt other bots", () => {
    expect(
      checkCla({ author: "renovate[bot]", commits: [], baseSigners: "", headSigners: "" }).problems,
    ).toHaveLength(1);
  });
});

describe("parseCommits", () => {
  it("reads gh's JSON lines, with a null login for unlinked authors", () => {
    expect(parseCommits('{"sha":"a","login":"ada"}\n\n{"sha":"b","login":null}\n')).toEqual([
      { sha: "a", login: "ada" },
      { sha: "b", login: null },
    ]);
  });

  it("fails on a line without a sha", () => {
    expect(() => parseCommits('{"login":"ada"}')).toThrow("commit without a sha");
  });
});

describe("committed signers file", () => {
  const root = join(import.meta.dirname, "..");

  it("parses without errors", () => {
    expect(parseSigners(readFileSync(join(root, SIGNERS_FILE), "utf8")).errors).toEqual([]);
  });

  it("quotes the exact statement in contributing.md and names the version in cla.md", () => {
    expect(readFileSync(join(root, "contributing.md"), "utf8")).toContain(SIGNATURE_STATEMENT);
    expect(readFileSync(join(root, "cla.md"), "utf8")).toContain(`Version ${CLA_VERSION}`);
  });
});
