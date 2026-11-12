import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Account,
  AGREEMENT_VERSIONS,
  agreementDigest,
  CLA_VERSION,
  type ClaInput,
  checkCla,
  coAuthors,
  EXEMPT_ACCOUNTS,
  MAX_COMMITS,
  type PullRequestComment,
  type PullRequestCommit,
  parseComments,
  parseCommits,
  parseSigners,
  parseSnapshot,
  SIGNATURE_STATEMENT,
  SIGNERS_FILE,
  SUBMISSION_STATEMENT,
  signatureStatement,
  submissionStatement,
} from "./cla.ts";

const root = join(import.meta.dirname, "..");
const AGREEMENT = readFileSync(join(root, "cla.md"), "utf8");
const HEAD = "f".repeat(40);

const ada: Account = { id: 101, login: "ada" };
const bob: Account = { id: 202, login: "bob" };
const carol: Account = { id: 303, login: "carol" };
const maintainer: Account = { id: 36774373, login: "leynier" };
const dependabot: Account = { id: 49699333, login: "dependabot[bot]" };

const sign = (who: Account, name = "Ada Lovelace", date = "2026-11-12") =>
  `- @${who.login} (${who.id}), ${name}, ${date}: ${SIGNATURE_STATEMENT}`;
const file = (...lines: string[]) => ["# Signers", "", "Prose.", "", ...lines, ""].join("\n");
const commit = (
  author: Account | null,
  options: Partial<PullRequestCommit> & { sha?: string } = {},
): PullRequestCommit => ({
  sha: HEAD,
  author,
  committerLogin: author?.login ?? null,
  verified: false,
  message: "feat: something",
  ...options,
});
let commentId = 1;
const assent = (
  who: Account,
  body = `Signing.\n\n${SUBMISSION_STATEMENT}\n`,
): PullRequestComment => ({
  id: commentId++,
  author: who,
  body,
  createdAt: "2026-11-12T10:00:00Z",
  updatedAt: "2026-11-12T10:00:00Z",
  url: `https://github.com/leynier/portifact/pull/1#issuecomment-${commentId}`,
});

/** A pull request by `author` whose last commit is the head, read consistently. */
const pr = (overrides: Partial<ClaInput> = {}): ClaInput => {
  const commits = overrides.commits ?? [commit(overrides.author ?? ada)];
  return {
    author: ada,
    comments: [],
    baseSigners: file(),
    headSigners: file(),
    headAgreement: AGREEMENT,
    ...overrides,
    commits,
    snapshot: overrides.snapshot ?? {
      eventHeadSha: HEAD,
      headShaBefore: HEAD,
      headShaAfter: HEAD,
      reportedCommits: commits.length,
    },
  };
};

describe("agreement versions", () => {
  it("pins the committed cla.md to the current version's digest", () => {
    expect(agreementDigest(AGREEMENT)).toBe(AGREEMENT_VERSIONS[CLA_VERSION]?.sha256);
    expect(AGREEMENT).toContain(`\nVersion ${CLA_VERSION}\n`);
  });

  it("refuses changed agreement text that keeps the version number", () => {
    const edited = AGREEMENT.replace("royalty-free", "royalty-bearing");
    expect(edited).toContain(`Version ${CLA_VERSION}`);
    expect(agreementDigest(edited)).not.toBe(AGREEMENT_VERSIONS[CLA_VERSION]?.sha256);
  });

  it("reads CRLF checkouts as the same text", () => {
    expect(agreementDigest(AGREEMENT.replace(/\n/g, "\r\n"))).toBe(agreementDigest(AGREEMENT));
  });

  it("names the version and digest in both statements, without em dashes", () => {
    const digest = AGREEMENT_VERSIONS[CLA_VERSION]?.sha256 ?? "";
    for (const statement of [SIGNATURE_STATEMENT, SUBMISSION_STATEMENT]) {
      expect(statement).toContain(`version ${CLA_VERSION}`);
      expect(statement).toContain(digest);
      expect(statement).not.toContain("—");
    }
    expect(() => signatureStatement("0.1")).toThrow("unknown agreement version 0.1");
    expect(() => submissionStatement("0.1")).toThrow("unknown agreement version 0.1");
  });

  it("does not quote a digest inside the agreement, which would make it circular", () => {
    expect(AGREEMENT).not.toMatch(/[0-9a-f]{64}/);
  });

  it("keeps the exempt accounts' IDs and logins", () => {
    expect([...EXEMPT_ACCOUNTS.values()]).toEqual([
      "leynier",
      "dependabot[bot]",
      "github-actions[bot]",
      "imgbot[bot]",
    ]);
  });
});

describe("parseSigners", () => {
  it("reads signature lines with account IDs and ignores headings and prose", () => {
    const parsed = parseSigners(
      file(sign(ada), sign({ id: 7, login: "Grace-H" }, "Grace Hopper, PhD")),
    );
    expect(parsed.errors).toEqual([]);
    expect(
      parsed.signatures.map(({ login, id, name, version }) => ({ login, id, name, version })),
    ).toEqual([
      { login: "ada", id: 101, name: "Ada Lovelace", version: CLA_VERSION },
      { login: "Grace-H", id: 7, name: "Grace Hopper, PhD", version: CLA_VERSION },
    ]);
  });

  it("accepts Windows line endings and trailing spaces", () => {
    expect(parseSigners(`${sign(ada)}  \r\n`).errors).toEqual([]);
  });

  it("refuses malformed items, bad dates, unknown statements, invalid logins and duplicates", () => {
    const parsed = parseSigners(
      file(
        "- someone agreed",
        sign(ada, "Ada", "2026-02-30"),
        sign(ada).replace(`version ${CLA_VERSION}`, "version 1.0"),
        `- @ada, Ada, 2026-11-12: ${SIGNATURE_STATEMENT}`,
        sign({ id: 1, login: "-bad" }),
        sign({ id: 1, login: "a".repeat(40) }),
        sign({ id: 101, login: "Ada-renamed" }),
        `- @ada (101),  , 2026-11-12: ${SIGNATURE_STATEMENT}`,
      ),
    );
    const format = `"- @login (account ID), Full Name, YYYY-MM-DD: <statement>"`;
    expect(parsed.errors).toEqual([
      `${SIGNERS_FILE} line 5 is not ${format}`,
      `${SIGNERS_FILE} line 6 has an invalid date "2026-02-30"`,
      `${SIGNERS_FILE} line 7 does not carry the exact statement of a published agreement version`,
      `${SIGNERS_FILE} line 8 is not ${format}`,
      `${SIGNERS_FILE} line 9 is not ${format}`,
      `${SIGNERS_FILE} line 10 is not ${format}`,
      `${SIGNERS_FILE} line 11 signs account 101 a second time for version ${CLA_VERSION}`,
      `${SIGNERS_FILE} line 12 has no name`,
      `${SIGNERS_FILE} line 12 signs account 101 a second time for version ${CLA_VERSION}`,
    ]);
    expect(parsed.items).toHaveLength(8);
  });
});

describe("coAuthors", () => {
  it("resolves GitHub noreply addresses with an account ID and lists the rest", () => {
    expect(
      coAuthors(
        [
          "fix: a thing",
          "",
          "Co-authored-by: Bob <202+bob@users.noreply.github.com>",
          "co-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>",
          "Co-Authored-By: Mallory <mallory@example.com>",
          "Co-authored-by: Old Form <oldform@users.noreply.github.com>",
        ].join("\n"),
      ),
    ).toEqual({
      accounts: [bob, dependabot],
      unresolved: ["Mallory", "Old Form"],
    });
  });
});

describe("checkCla", () => {
  const signed = file(sign(ada));

  it("passes a contributor who signs and submits in their first pull request", () => {
    const comment = assent(ada);
    const result = checkCla(pr({ headSigners: signed, comments: [comment] }));
    expect(result.problems).toEqual([]);
    expect(result.required).toEqual([ada]);
    expect(result.evidence).toEqual({
      headSha: HEAD,
      commits: [HEAD],
      contributors: [
        {
          id: 101,
          login: "ada",
          version: CLA_VERSION,
          sha256: AGREEMENT_VERSIONS[CLA_VERSION]?.sha256,
          comment: {
            id: comment.id,
            url: comment.url,
            createdAt: comment.createdAt,
            updatedAt: comment.updatedAt,
            bodySha256: agreementDigest(comment.body),
          },
        },
      ],
    });
  });

  it("passes a returning contributor matched by account ID after a rename", () => {
    const renamed = { id: 101, login: "ADA-new" };
    expect(
      checkCla(
        pr({
          author: renamed,
          commits: [commit(renamed)],
          baseSigners: signed,
          headSigners: signed,
          comments: [assent(renamed)],
        }),
      ).problems,
    ).toEqual([]);
  });

  it("requires a submission comment on every pull request, not only the first", () => {
    expect(checkCla(pr({ baseSigners: signed, headSigners: signed })).problems).toEqual([
      "@ada (101) has not posted the submission statement as a comment on this pull request from their own account, as contributing.md explains",
    ]);
  });

  it("refuses a comment that only quotes or paraphrases the statement", () => {
    for (const body of [
      `> ${SUBMISSION_STATEMENT}`,
      SUBMISSION_STATEMENT.replace("I sign", "I will sign"),
      "I agree",
    ]) {
      expect(
        checkCla(pr({ baseSigners: signed, headSigners: signed, comments: [assent(ada, body)] }))
          .problems,
      ).toHaveLength(1);
    }
  });

  it("refuses an author with a comment but no signature record", () => {
    expect(checkCla(pr({ comments: [assent(ada)] })).problems).toEqual([
      `@ada (101) has no signature record in ${SIGNERS_FILE}: add your line as contributing.md explains`,
    ]);
  });

  it("requires every commit author to sign and submit, not only the pull request's author", () => {
    const result = checkCla(
      pr({
        commits: [commit(ada, { sha: "a".repeat(40) }), commit(bob)],
        baseSigners: signed,
        headSigners: signed,
        comments: [assent(ada)],
      }),
    );
    expect(result.required).toEqual([ada, bob]);
    expect(result.problems).toEqual([
      `@bob (202) has no signature record in ${SIGNERS_FILE}: add your line as contributing.md explains`,
      "@bob (202) has not posted the submission statement as a comment on this pull request from their own account, as contributing.md explains",
    ]);
  });

  it("lets a commit author sign for themself with their own comment", () => {
    expect(
      checkCla(
        pr({
          commits: [commit(ada, { sha: "a".repeat(40) }), commit(bob)],
          baseSigners: signed,
          headSigners: file(sign(ada), sign(bob, "Bob")),
          comments: [assent(ada), assent(bob)],
        }),
      ).problems,
    ).toEqual([]);
  });

  describe("finding 2: who really signed", () => {
    it("refuses Alice adding Bob's line when a commit names Bob as its author", () => {
      const { problems } = checkCla(
        pr({
          commits: [commit(ada, { sha: "a".repeat(40) }), commit(bob)],
          baseSigners: signed,
          headSigners: file(sign(ada), sign(bob, "Bob")),
          comments: [assent(ada)],
        }),
      );
      expect(problems).toContain(
        "the pull request adds a signature for @bob (202) that the account did not confirm with its own comment on the pull request: each contributor signs for themself",
      );
    });

    it("refuses spoofed author metadata: a commit claiming Bob does not make Bob assent", () => {
      const spoofed = commit(bob, { committerLogin: "ada" });
      const { problems } = checkCla(
        pr({
          commits: [spoofed],
          baseSigners: signed,
          headSigners: file(sign(ada), sign(bob, "Bob")),
          comments: [assent(ada)],
        }),
      );
      expect(problems.some((p) => p.includes("@bob (202)"))).toBe(true);
    });

    it("refuses an assent from a different numeric account with the same login", () => {
      const impostor = { id: 999, login: "bob" };
      const { problems } = checkCla(
        pr({
          commits: [commit(ada, { sha: "a".repeat(40) }), commit(bob)],
          baseSigners: signed,
          headSigners: file(sign(ada), sign(bob, "Bob")),
          comments: [assent(ada), assent(impostor)],
        }),
      );
      expect(problems).toContain(
        "the pull request adds a signature for @bob (202) that the account did not confirm with its own comment on the pull request: each contributor signs for themself",
      );
    });

    it("refuses a line whose login is not the commenting account's", () => {
      const line = `- @someone-else (101), Ada, 2026-11-12: ${SIGNATURE_STATEMENT}`;
      expect(checkCla(pr({ headSigners: file(line), comments: [assent(ada)] })).problems).toEqual([
        "the pull request adds a signature for @someone-else (101) that the account did not confirm with its own comment on the pull request: each contributor signs for themself",
      ]);
    });

    it("refuses a signature added for someone who is not in the pull request", () => {
      expect(
        checkCla(
          pr({
            baseSigners: signed,
            headSigners: file(sign(ada), sign(carol, "Carol")),
            comments: [assent(ada)],
          }),
        ).problems,
      ).toEqual([
        "the pull request adds a signature for @carol (303) that the account did not confirm with its own comment on the pull request: each contributor signs for themself",
      ]);
    });
  });

  describe("finding 3: the agreement's text is pinned", () => {
    it("refuses a first signature in a pull request that also changes cla.md", () => {
      const { problems } = checkCla(
        pr({
          headSigners: signed,
          comments: [assent(ada)],
          headAgreement: AGREEMENT.replace("including for proprietary exploitation", ""),
        }),
      );
      expect(problems).toEqual([
        "the pull request adds a signature for @ada (101) and also changes cla.md: publish an agreement change on its own, then sign the published text",
      ]);
    });

    it("refuses a pull request that deletes cla.md", () => {
      expect(
        checkCla(
          pr({
            baseSigners: signed,
            headSigners: signed,
            comments: [assent(ada)],
            headAgreement: undefined,
          }),
        ).problems,
      ).toEqual(["cla.md is missing at the head of the pull request"]);
    });

    it("lets the maintainer publish a new agreement text without signatures", () => {
      expect(
        checkCla(
          pr({
            author: maintainer,
            commits: [commit(maintainer)],
            headAgreement: `${AGREEMENT}\nchanged\n`,
          }),
        ).problems,
      ).toEqual([]);
    });
  });

  describe("finding 4: exemptions keep every integrity check", () => {
    const base = file(sign(ada), sign(bob, "Bob"));
    const exempt = (headSigners: string | undefined, baseSigners: string | undefined = base) =>
      checkCla(pr({ author: dependabot, commits: [commit(dependabot)], baseSigners, headSigners }))
        .problems;

    it("refuses deleting the signers file", () => {
      expect(exempt(undefined)).toEqual([
        `${SIGNERS_FILE} is missing at the head of the pull request`,
      ]);
    });

    it("refuses removing or altering a signature", () => {
      expect(exempt(file(sign(ada)))).toEqual([
        `the record "${sign(bob, "Bob").slice(0, 60)}" on the base branch was removed or changed`,
      ]);
      expect(exempt(file(sign(ada), sign(bob, "Robert")))).toEqual([
        `the record "${sign(bob, "Bob").slice(0, 60)}" on the base branch was removed or changed`,
        "the pull request adds a signature for @bob (202) that the account did not confirm with its own comment on the pull request: each contributor signs for themself",
      ]);
    });

    it("refuses fabricated signatures, from the maintainer too", () => {
      expect(
        checkCla(
          pr({
            author: maintainer,
            commits: [commit(maintainer)],
            headSigners: file(sign(carol, "Carol")),
          }),
        ).problems,
      ).toEqual([
        "the pull request adds a signature for @carol (303) that the account did not confirm with its own comment on the pull request: each contributor signs for themself",
      ]);
    });

    it("refuses removing an unreadable record instead of ignoring it", () => {
      expect(exempt(file(sign(ada)), file(sign(ada), "- @bob said yes"))).toEqual([
        `the record "- @bob said yes" on the base branch was removed or changed`,
      ]);
    });

    it("passes an exempt pull request that leaves the file alone, and one with no file anywhere", () => {
      expect(exempt(base)).toEqual([]);
      expect(
        checkCla(
          pr({
            author: dependabot,
            commits: [commit(dependabot)],
            baseSigners: undefined,
            headSigners: undefined,
          }),
        ).problems,
      ).toEqual([]);
    });

    it("does not exempt other bots or a lookalike login on another account", () => {
      const renovate = { id: 29139614, login: "renovate[bot]" };
      expect(checkCla(pr({ author: renovate, commits: [commit(renovate)] })).required).toEqual([
        renovate,
      ]);
      const lookalike = { id: 4242, login: "leynier" };
      expect(checkCla(pr({ author: lookalike, commits: [commit(lookalike)] })).required).toEqual([
        lookalike,
      ]);
    });

    it("refuses a commit attributed to an exempt account in someone else's pull request unless GitHub verified it", () => {
      const forged = commit(maintainer, {
        sha: "b".repeat(40),
        committerLogin: "ada",
        verified: true,
      });
      const { problems } = checkCla(
        pr({
          commits: [forged, commit(ada)],
          baseSigners: signed,
          headSigners: signed,
          comments: [assent(ada)],
        }),
      );
      expect(problems).toEqual([
        "commit bbbbbbbbbbbb names the exempt account @leynier (36774373) as its author in a pull request opened by @ada (101), without a signature GitHub verified for that account: it may be someone else's work",
      ]);
      for (const real of [
        commit(maintainer, { sha: "b".repeat(40), committerLogin: "web-flow", verified: true }),
        commit(maintainer, { sha: "b".repeat(40), committerLogin: "Leynier", verified: true }),
      ]) {
        expect(
          checkCla(
            pr({
              commits: [real, commit(ada)],
              baseSigners: signed,
              headSigners: signed,
              comments: [assent(ada)],
            }),
          ).problems,
        ).toEqual([]);
      }
    });
  });

  describe("finding 5: every rights holder, not only commit authors", () => {
    it("requires an unsigned co-author to sign and submit", () => {
      const squashed = commit(ada, {
        message: "feat: squashed work\n\nCo-authored-by: Bob <202+bob@users.noreply.github.com>",
      });
      const result = checkCla(
        pr({
          commits: [squashed],
          baseSigners: signed,
          headSigners: signed,
          comments: [assent(ada)],
        }),
      );
      expect(result.required).toEqual([ada, bob]);
      expect(result.problems).toHaveLength(2);
      const ok = checkCla(
        pr({
          commits: [squashed],
          baseSigners: signed,
          headSigners: file(sign(ada), sign(bob, "Bob")),
          comments: [assent(ada), assent(bob)],
        }),
      );
      expect(ok.problems).toEqual([]);
    });

    it("refuses a co-author it cannot identify", () => {
      const message = "feat: pasted\n\nCo-authored-by: Mallory <mallory@example.com>";
      expect(
        checkCla(
          pr({
            commits: [commit(ada, { message })],
            baseSigners: signed,
            headSigners: signed,
            comments: [assent(ada)],
          }),
        ).problems,
      ).toEqual([
        `commit ${HEAD.slice(0, 12)} has a Co-authored-by trailer for "Mallory" without a GitHub noreply address with an account ID (ID+login@users.noreply.github.com), so the co-author cannot be identified`,
      ]);
    });

    it("requires the original author of an imported patch", () => {
      const patch = commit(carol, { committerLogin: "ada" });
      expect(
        checkCla(
          pr({
            commits: [patch],
            baseSigners: signed,
            headSigners: signed,
            comments: [assent(ada)],
          }),
        ).required,
      ).toEqual([ada, carol]);
    });

    it("requires the human behind work an exempt bot opens or carries", () => {
      const human = checkCla(
        pr({
          author: dependabot,
          commits: [commit(dependabot, { sha: "c".repeat(40) }), commit(carol)],
        }),
      );
      expect(human.required).toEqual([carol]);
      expect(human.problems).toHaveLength(2);
    });

    it("refuses commits whose author email belongs to no GitHub account", () => {
      expect(
        checkCla(
          pr({
            commits: [commit(null)],
            baseSigners: signed,
            headSigners: signed,
            comments: [assent(ada)],
          }),
        ).problems,
      ).toEqual([
        `commit ${HEAD.slice(0, 12)} has an author email that belongs to no GitHub account, so its author cannot be identified: use an email linked to your account and push again`,
      ]);
    });
  });

  describe("finding 6: one complete, consistent view", () => {
    const ok = { baseSigners: signed, headSigners: signed, comments: [assent(ada)] };

    it(`refuses more than ${MAX_COMMITS} commits`, () => {
      const commits = Array.from({ length: MAX_COMMITS + 1 }, (_, i) =>
        commit(ada, { sha: i === MAX_COMMITS ? HEAD : i.toString(16).padStart(40, "0") }),
      );
      expect(checkCla(pr({ ...ok, commits })).problems).toEqual([
        `the pull request has ${MAX_COMMITS + 1} commits, more than the ${MAX_COMMITS} the check can read: split it`,
      ]);
    });

    it("refuses a truncated commit list or a failed read", () => {
      const snapshot = {
        eventHeadSha: HEAD,
        headShaBefore: HEAD,
        headShaAfter: HEAD,
        reportedCommits: 3,
      };
      expect(checkCla(pr({ ...ok, snapshot })).problems).toEqual([
        "the check read 1 commits of the 3 the pull request reports, so its view is incomplete",
      ]);
      expect(
        checkCla(pr({ ...ok, commits: [], snapshot: { ...snapshot, reportedCommits: 1 } }))
          .problems,
      ).toEqual([
        "the check read 0 commits of the 1 the pull request reports, so its view is incomplete",
      ]);
    });

    it("refuses a head that changed during collection or a list that ends elsewhere", () => {
      const moved = {
        eventHeadSha: HEAD,
        headShaBefore: HEAD,
        headShaAfter: "e".repeat(40),
        reportedCommits: 1,
      };
      expect(checkCla(pr({ ...ok, snapshot: moved })).problems).toEqual([
        "the pull request's head changed while the check read it: the check runs again on the new head",
      ]);
      expect(
        checkCla(pr({ ...ok, commits: [commit(ada, { sha: "d".repeat(40) })] })).problems,
      ).toEqual(["the commit list read does not end at the pull request's head"]);
    });
  });

  describe("finding 21: versions", () => {
    it("keeps a signer's records of several versions apart", () => {
      const parsed = parseSigners(file(sign(ada), sign(ada, "Ada", "2026-11-13")));
      expect(parsed.errors).toEqual([
        `${SIGNERS_FILE} line 6 signs account 101 a second time for version ${CLA_VERSION}`,
      ]);
    });
  });
});

describe("workflow readers", () => {
  it("reads commits, with a null author for unlinked emails", () => {
    expect(
      parseCommits(
        '{"sha":"a","id":101,"login":"ada","committer":"web-flow","verified":true,"message":"m"}\n\n{"sha":"b","id":null,"login":null}\n',
      ),
    ).toEqual([
      { sha: "a", author: ada, committerLogin: "web-flow", verified: true, message: "m" },
      { sha: "b", author: null, committerLogin: null, verified: false, message: "" },
    ]);
    expect(() => parseCommits('{"login":"ada"}')).toThrow("missing sha");
  });

  it("reads comments and refuses one without an author", () => {
    const line = {
      id: 5,
      login: "ada",
      userId: 101,
      body: "x",
      createdAt: "t1",
      updatedAt: "t2",
      url: "u",
    };
    expect(parseComments(JSON.stringify(line))).toEqual([
      { id: 5, author: ada, body: "x", createdAt: "t1", updatedAt: "t2", url: "u" },
    ]);
    expect(parseComments(JSON.stringify({ ...line, body: null }))[0]?.body).toBe("");
    expect(() => parseComments(JSON.stringify({ ...line, userId: null }))).toThrow(
      "comment without an author",
    );
  });

  it("reads the snapshot and refuses one without an author", () => {
    const value = {
      authorId: 101,
      authorLogin: "ada",
      eventHeadSha: "h",
      headShaBefore: "h",
      headShaAfter: "h",
      reportedCommits: 2,
    };
    expect(parseSnapshot(JSON.stringify(value))).toEqual({
      author: ada,
      snapshot: { eventHeadSha: "h", headShaBefore: "h", headShaAfter: "h", reportedCommits: 2 },
    });
    expect(() => parseSnapshot(JSON.stringify({ ...value, authorId: "101" }))).toThrow("no author");
  });
});

describe("committed documents", () => {
  it("the signers file parses without errors", () => {
    expect(parseSigners(readFileSync(join(root, SIGNERS_FILE), "utf8")).errors).toEqual([]);
  });

  it("contributing.md quotes both exact statements", () => {
    const contributing = readFileSync(join(root, "contributing.md"), "utf8");
    expect(contributing).toContain(SIGNATURE_STATEMENT);
    expect(contributing).toContain(SUBMISSION_STATEMENT);
  });

  it("no document calls the agreement a draft pending review", () => {
    for (const path of ["cla.md", "contributing.md", "docs/licensing.md", "readme.md"]) {
      expect(readFileSync(join(root, path), "utf8"), path).not.toMatch(
        /draft pending|\(draft\)|pending (a lawyer|legal)/i,
      );
    }
  });
});
