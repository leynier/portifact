import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Account,
  AGREEMENT_VERSIONS,
  type AgreementVersions,
  agreementDigest,
  CLA_VERSION,
  type ClaInput,
  checkCla,
  coAuthors,
  DIGEST_PLACEHOLDER,
  EXEMPT_ACCOUNTS,
  EXEMPT_EMAILS,
  HEAD_LINE_PREFIX,
  MAX_COMMITS,
  MAX_FILES,
  type PullRequestComment,
  type PullRequestCommit,
  parseComments,
  parseCommits,
  parseFiles,
  parseSigners,
  parseSnapshot,
  SIGNERS_FILE,
  STATEMENT,
  statement,
  statementTemplate,
  WEB_FLOW,
} from "./cla.ts";

const root = join(import.meta.dirname, "..");
const AGREEMENT = readFileSync(join(root, "cla.md"), "utf8");
const DIGEST = AGREEMENT_VERSIONS[CLA_VERSION]?.sha256 ?? "";
const HEAD = "f".repeat(40);

const ada: Account = { id: 101, login: "ada" };
const bob: Account = { id: 202, login: "bob" };
const carol: Account = { id: 303, login: "carol" };
const maintainer: Account = { id: 36774373, login: "leynier" };
const dependabot: Account = { id: 49699333, login: "dependabot[bot]" };

const record = (
  who: Account,
  name = "Ada Lovelace",
  date = "2026-11-12",
  version = CLA_VERSION,
  digest = DIGEST,
) => `- @${who.login} (${who.id}), ${name}, ${date}, version ${version}, SHA-256 ${digest}`;
const file = (...lines: string[]) =>
  ["# Signers", "", "Prose.", "", "## Signatures", ...lines, ""].join("\n");
const commit = (
  author: Account | null,
  options: Partial<PullRequestCommit> = {},
): PullRequestCommit => ({
  sha: HEAD,
  author,
  committer: author,
  verified: false,
  message: "feat: something",
  ...options,
});
let commentId = 1;
const say = (who: Account, body = STATEMENT, edited = false): PullRequestComment => ({
  id: commentId++,
  author: who,
  body,
  createdAt: "2026-11-12T10:00:00Z",
  updatedAt: edited ? "2026-11-12T11:00:00Z" : "2026-11-12T10:00:00Z",
  url: `https://github.com/leynier/portifact/pull/1#issuecomment-${commentId}`,
});
/** The statement of someone who did not open the pull request, approving a head. */
const approve = (who: Account, head = HEAD) => say(who, `${STATEMENT}\n${HEAD_LINE_PREFIX}${head}`);

const signed = file(record(ada));
/** A pull request by `author` whose head is in the commit list, read consistently. */
const pr = (overrides: Partial<ClaInput> = {}): ClaInput => {
  const commits = overrides.commits ?? [commit(overrides.author ?? ada)];
  const changedFiles = overrides.changedFiles ?? ["src/index.ts"];
  return {
    author: ada,
    comments: [],
    baseSigners: signed,
    headSigners: signed,
    baseAgreement: AGREEMENT,
    headAgreement: AGREEMENT,
    ...overrides,
    commits,
    changedFiles,
    snapshot: overrides.snapshot ?? {
      eventHeadSha: HEAD,
      headShaBefore: HEAD,
      headShaAfter: HEAD,
      reportedCommits: commits.length,
      reportedFiles: changedFiles.length,
    },
  };
};
const refusedRecord = (who: Account) =>
  `the pull request adds a record for @${who.login} (${who.id}) that the account did not confirm with its own statement on the pull request: each contributor signs for themself`;
const notPosted = (who: Account) =>
  `@${who.login} (${who.id}) has not posted the statement as a comment on this pull request from their own account, as contributing.md explains`;
const noRecord = (who: Account) =>
  `@${who.login} (${who.id}) has no signature record of a version accepting new submissions in ${SIGNERS_FILE}: add yours as contributing.md explains`;

describe("agreement versions", () => {
  it("pins the committed cla.md to the current version's digest", () => {
    expect(agreementDigest(AGREEMENT)).toBe(DIGEST);
    expect(AGREEMENT).toContain(`\nVersion ${CLA_VERSION}\n`);
  });

  it("refuses changed agreement text that keeps the version number", () => {
    const edited = AGREEMENT.replace("royalty-free", "royalty-bearing");
    expect(edited).toContain(`Version ${CLA_VERSION}`);
    expect(agreementDigest(edited)).not.toBe(DIGEST);
  });

  it("reads CRLF checkouts as the same text", () => {
    expect(agreementDigest(AGREEMENT.replace(/\n/g, "\r\n"))).toBe(agreementDigest(AGREEMENT));
  });

  it("quotes the statement in cla.md with a placeholder for its digest", () => {
    expect(AGREEMENT).toContain(statementTemplate(CLA_VERSION));
    expect(STATEMENT).toBe(statementTemplate(CLA_VERSION).replace(DIGEST_PLACEHOLDER, DIGEST));
    expect(AGREEMENT).toContain(`${HEAD_LINE_PREFIX}<full SHA of the head commit>`);
    expect(AGREEMENT).not.toMatch(/[0-9a-f]{64}/);
  });

  it("states the review's wording, without em dashes", () => {
    expect(STATEMENT).toMatch(
      /^I have read and agree to the Portifact Individual Contributor License Agreement, version /,
    );
    expect(STATEMENT).toContain("permit proprietary licensing without payment");
    expect(STATEMENT).toContain(DIGEST);
    expect(STATEMENT).not.toContain("—");
    expect(() => statement("0.1")).toThrow("unknown agreement version 0.1");
  });

  it("keeps the exempt accounts' IDs and emails", () => {
    expect([...EXEMPT_ACCOUNTS.values()]).toEqual([
      "leynier",
      "dependabot[bot]",
      "github-actions[bot]",
      "imgbot[bot]",
    ]);
    for (const id of EXEMPT_EMAILS.values()) expect(EXEMPT_ACCOUNTS.has(id)).toBe(true);
  });
});

describe("parseSigners", () => {
  it("reads signature records and ignores headings and prose", () => {
    const parsed = parseSigners(
      file(record(ada), record({ id: 7, login: "Grace-H" }, "Grace Hopper, PhD")),
    );
    expect(parsed.errors).toEqual([]);
    expect(
      parsed.records.map(({ login, id, name, version }) => ({ login, id, name, version })),
    ).toEqual([
      { login: "ada", id: 101, name: "Ada Lovelace", version: CLA_VERSION },
      { login: "Grace-H", id: 7, name: "Grace Hopper, PhD", version: CLA_VERSION },
    ]);
  });

  it("accepts Windows line endings and trailing spaces", () => {
    expect(parseSigners(`${record(ada)}  \r\n`).errors).toEqual([]);
  });

  it("refuses malformed items, bad dates, unknown versions or digests, invalid logins and duplicates", () => {
    const parsed = parseSigners(
      [
        "- someone agreed",
        record(ada, "Ada", "2026-02-30"),
        record(ada, "Ada", "2026-11-12", "1.0"),
        record(ada, "Ada", "2026-11-12", CLA_VERSION, "0".repeat(64)),
        record({ id: 1, login: "-bad" }),
        record({ id: 1, login: "a".repeat(40) }),
        record({ id: 101, login: "Ada-renamed" }),
        `- @ada (101),  , 2026-11-12, version ${CLA_VERSION}, SHA-256 ${DIGEST}`,
      ].join("\n"),
    );
    const format = `"- @login (account ID), Full Legal Name, YYYY-MM-DD, version X.Y, SHA-256 <digest>"`;
    expect(parsed.errors).toEqual([
      `${SIGNERS_FILE} line 1 is not ${format}`,
      `${SIGNERS_FILE} line 2 has an invalid date "2026-02-30"`,
      `${SIGNERS_FILE} line 3 does not name a published agreement version with its digest`,
      `${SIGNERS_FILE} line 4 does not name a published agreement version with its digest`,
      `${SIGNERS_FILE} line 5 is not ${format}`,
      `${SIGNERS_FILE} line 6 is not ${format}`,
      `${SIGNERS_FILE} line 7 records account 101 a second time for version ${CLA_VERSION}`,
      `${SIGNERS_FILE} line 8 has no name`,
      `${SIGNERS_FILE} line 8 records account 101 a second time for version ${CLA_VERSION}`,
    ]);
    expect(parsed.items).toHaveLength(8);
  });
});

describe("coAuthors", () => {
  it("resolves noreply addresses with an account ID and exempt accounts' commit emails", () => {
    expect(
      coAuthors(
        [
          "fix: a thing",
          "",
          "Co-authored-by: Bob <202+bob@users.noreply.github.com>",
          "co-authored-by: dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>",
          "  CO-AUTHORED-BY: Leynier Gutiérrez González <Leynier41@Gmail.com>  ",
        ].join("\r\n"),
      ),
    ).toEqual({ accounts: [bob, dependabot, maintainer], unresolved: [] });
  });

  it("refuses anything that is not exactly one person with an address", () => {
    const lines = [
      "Mallory <mallory@example.com>",
      "Old Form <oldform@users.noreply.github.com>",
      "Mallory",
      "<202+bob@users.noreply.github.com>",
      "Bob <202+bob@users.noreply.github.com>, Carol <303+carol@users.noreply.github.com>",
      "Bob <202+bob@users.noreply.github.com> trailing",
      "",
    ];
    expect(coAuthors(lines.map((value) => `Co-authored-by: ${value}`).join("\n"))).toEqual({
      accounts: [],
      unresolved: lines,
    });
  });
});

describe("checkCla", () => {
  it("passes a contributor who signs and submits in their first pull request", () => {
    const comment = say(ada);
    const result = checkCla(
      pr({
        baseSigners: file(),
        headSigners: signed,
        comments: [comment],
        changedFiles: ["src/a.ts", SIGNERS_FILE],
      }),
    );
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
          sha256: DIGEST,
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
      checkCla(pr({ author: renamed, commits: [commit(renamed)], comments: [say(renamed)] }))
        .problems,
    ).toEqual([]);
  });

  it("requires a statement on every pull request, not only the first", () => {
    expect(checkCla(pr()).problems).toEqual([notPosted(ada)]);
  });

  it("refuses an author with a statement but no signature record", () => {
    expect(
      checkCla(pr({ baseSigners: file(), headSigners: file(), comments: [say(ada)] })).problems,
    ).toEqual([noRecord(ada)]);
  });

  describe("item 9: the statement is the whole comment", () => {
    it("accepts surrounding whitespace and CRLF line endings", () => {
      expect(
        checkCla(pr({ comments: [say(ada, `\r\n  ${STATEMENT}  \r\n\r\n`)] })).problems,
      ).toEqual([]);
      const body = `  ${STATEMENT}\r\n${HEAD_LINE_PREFIX}${HEAD}\r\n`;
      const both = file(record(ada), record(bob, "Bob"));
      expect(
        checkCla(
          pr({
            commits: [commit(bob)],
            headSigners: both,
            baseSigners: both,
            comments: [say(ada), say(bob, body)],
          }),
        ).problems,
      ).toEqual([]);
    });

    it("refuses text before or after the statement, quotes and paraphrases", () => {
      const whole =
        "@ada (101)'s statement must be the whole comment, with nothing before or after it: post it again as a new comment";
      expect(
        checkCla(pr({ comments: [say(ada, `Not really.\n${STATEMENT}\nJust quoting it.`)] }))
          .problems,
      ).toEqual([whole]);
      expect(checkCla(pr({ comments: [say(ada, `${STATEMENT}\nThanks!`)] })).problems).toEqual([
        whole,
      ]);
      expect(
        checkCla(pr({ comments: [say(ada, `${STATEMENT}\n${HEAD_LINE_PREFIX}${HEAD}`)] })).problems,
      ).toEqual([whole]);
      for (const body of [
        `> ${STATEMENT}`,
        STATEMENT.replace("I have read", "I may have read"),
        "I agree",
      ]) {
        expect(checkCla(pr({ comments: [say(ada, body)] })).problems, body).toHaveLength(1);
      }
    });

    it("refuses extra text after another person's head line", () => {
      const both = file(record(ada), record(bob, "Bob"));
      const body = `${STATEMENT}\n${HEAD_LINE_PREFIX}${HEAD}\nThanks`;
      expect(
        checkCla(
          pr({
            commits: [commit(bob)],
            headSigners: both,
            baseSigners: both,
            comments: [say(ada), say(bob, body)],
          }),
        ).problems,
      ).toEqual([
        "@bob (202)'s statement must be the whole comment, with nothing before or after it but the head commit line: post it again as a new comment",
      ]);
      expect(
        checkCla(
          pr({
            commits: [commit(bob)],
            headSigners: both,
            baseSigners: both,
            comments: [say(ada), say(bob, `${STATEMENT}\nThanks`)],
          }),
        ).problems,
      ).toEqual([
        "@bob (202)'s statement must be the whole comment, with nothing before or after it but the head commit line: post it again as a new comment",
      ]);
    });
  });

  describe("item 3: an edited comment does not count", () => {
    it("refuses a statement in a comment that was edited", () => {
      expect(checkCla(pr({ comments: [say(ada, STATEMENT, true)] })).problems).toEqual([
        "@ada (101)'s statement is in a comment that was edited, which does not count: post it again as a new comment",
      ]);
    });

    it("accepts a later unedited comment beside an edited one", () => {
      expect(checkCla(pr({ comments: [say(ada, STATEMENT, true), say(ada)] })).problems).toEqual(
        [],
      );
    });
  });

  describe("item 4: anyone but the author approves one head", () => {
    const both = {
      baseSigners: file(record(ada), record(bob, "Bob")),
      headSigners: file(record(ada), record(bob, "Bob")),
    };
    const commits = [commit(ada, { sha: "a".repeat(40) }), commit(bob)];

    it("requires a commit author who did not open the pull request to name the head", () => {
      expect(checkCla(pr({ ...both, commits, comments: [say(ada), say(bob)] })).problems).toEqual([
        `@bob (202) did not open this pull request, so their statement must be followed by the line "${HEAD_LINE_PREFIX}${HEAD}"`,
      ]);
      expect(
        checkCla(pr({ ...both, commits, comments: [say(ada), approve(bob)] })).problems,
      ).toEqual([]);
    });

    it("refuses a stale head after a later push, and a wrong one", () => {
      const stale = `@bob (202)'s statement names another commit than the pull request's head ${HEAD}: post it again naming the current head`;
      expect(
        checkCla(pr({ ...both, commits, comments: [say(ada), approve(bob, "a".repeat(40))] }))
          .problems,
      ).toEqual([stale]);
      expect(
        checkCla(pr({ ...both, commits, comments: [say(ada), approve(bob, "0123456")] })).problems,
      ).toEqual([stale]);
    });

    it("lets the author's earlier statement cover their own later push", () => {
      const later = [commit(ada, { sha: "a".repeat(40) }), commit(ada)];
      expect(checkCla(pr({ commits: later, comments: [say(ada)] })).problems).toEqual([]);
    });

    it("requires a co-author to sign and approve the head too", () => {
      const squashed = commit(ada, {
        message: "feat: squashed\n\nCo-authored-by: Bob <202+bob@users.noreply.github.com>",
      });
      const result = checkCla(pr({ commits: [squashed], comments: [say(ada)] }));
      expect(result.required).toEqual([ada, bob]);
      expect(result.problems).toEqual([noRecord(bob), notPosted(bob)]);
    });
  });

  describe("item 16 and finding 2: who really signed", () => {
    it("lets the author append a co-author's record that only the co-author's statement confirms", () => {
      const squashed = commit(ada, {
        message: "feat: x\n\nCo-authored-by: Bob <202+bob@users.noreply.github.com>",
      });
      const head = file(record(ada), record(bob, "Bob"));
      expect(
        checkCla(pr({ commits: [squashed], headSigners: head, comments: [say(ada), approve(bob)] }))
          .problems,
      ).toEqual([]);
      expect(
        checkCla(pr({ commits: [squashed], headSigners: head, comments: [say(ada)] })).problems,
      ).toEqual([refusedRecord(bob), notPosted(bob)]);
    });

    it("refuses Alice adding Bob's record when a commit names Bob as its author", () => {
      const { problems } = checkCla(
        pr({
          commits: [commit(ada, { sha: "a".repeat(40) }), commit(bob)],
          headSigners: file(record(ada), record(bob, "Bob")),
          comments: [say(ada)],
        }),
      );
      expect(problems).toContain(refusedRecord(bob));
    });

    it("refuses an assent from a different numeric account with the same login", () => {
      const impostor = { id: 999, login: "bob" };
      const { problems } = checkCla(
        pr({
          commits: [commit(ada, { sha: "a".repeat(40) }), commit(bob)],
          headSigners: file(record(ada), record(bob, "Bob")),
          comments: [say(ada), approve(impostor)],
        }),
      );
      expect(problems).toContain(refusedRecord(bob));
    });

    it("refuses a record whose login is not the commenting account's", () => {
      const line = `- @someone-else (101), Ada, 2026-11-12, version ${CLA_VERSION}, SHA-256 ${DIGEST}`;
      expect(
        checkCla(pr({ baseSigners: file(), headSigners: file(line), comments: [say(ada)] }))
          .problems,
      ).toEqual([refusedRecord({ id: 101, login: "someone-else" })]);
    });

    it("refuses a record added for someone who is not in the pull request", () => {
      expect(
        checkCla(
          pr({ headSigners: file(record(ada), record(carol, "Carol")), comments: [say(ada)] }),
        ).problems,
      ).toEqual([refusedRecord(carol)]);
    });
  });

  describe("item 1: an outside pull request cannot change the agreement or its check", () => {
    it("refuses changing cla.md together with its digest in one outside pull request", () => {
      const changed = AGREEMENT.replace("royalty-free", "royalty-bearing");
      const { problems } = checkCla(
        pr({
          comments: [say(ada)],
          headAgreement: changed,
          changedFiles: ["cla.md", "scripts/cla.ts"],
        }),
      );
      expect(problems).toEqual([
        "the pull request changes cla.md: only the maintainer publishes agreement changes (if your branch is behind develop, update it)",
        "the pull request changes scripts/cla.ts: only the maintainer changes the agreement's check",
      ]);
    });

    it("refuses an outside change to the check, its runner or its workflow, renames included", () => {
      for (const path of ["scripts/cla-main.ts", ".github/workflows/cla.yml"]) {
        expect(checkCla(pr({ comments: [say(ada)], changedFiles: [path] })).problems).toEqual([
          `the pull request changes ${path}: only the maintainer changes the agreement's check`,
        ]);
      }
      const renamed = parseFiles('{"filename":"scripts/old.ts","previous":"scripts/cla.ts"}');
      const snapshot = {
        eventHeadSha: HEAD,
        headShaBefore: HEAD,
        headShaAfter: HEAD,
        reportedCommits: 1,
        reportedFiles: 1,
      };
      expect(
        checkCla(pr({ comments: [say(ada)], changedFiles: renamed, snapshot })).problems,
      ).toEqual([
        "the pull request changes scripts/cla.ts: only the maintainer changes the agreement's check",
      ]);
    });

    it("refuses a deleted cla.md and an outside branch whose cla.md is behind", () => {
      expect(checkCla(pr({ comments: [say(ada)], headAgreement: undefined })).problems).toEqual([
        "cla.md is missing at the head of the pull request",
      ]);
      expect(
        checkCla(pr({ comments: [say(ada)], headAgreement: `${AGREEMENT}old\n` })).problems,
      ).toHaveLength(1);
    });

    it("lets the maintainer change them, but never with a new record in the same pull request", () => {
      const own = {
        author: maintainer,
        commits: [commit(maintainer)],
        changedFiles: ["cla.md", "scripts/cla.ts"],
      };
      expect(checkCla(pr({ ...own, headAgreement: `${AGREEMENT}\nchanged\n` })).problems).toEqual(
        [],
      );
      expect(
        checkCla(
          pr({
            ...own,
            headAgreement: `${AGREEMENT}\nchanged\n`,
            headSigners: file(record(ada), record(carol, "Carol")),
            comments: [approve(carol)],
          }),
        ).problems,
      ).toEqual([
        "the pull request adds a record for @carol (303) and also changes cla.md: publish an agreement change on its own, then sign the published text",
      ]);
      expect(
        checkCla(
          pr({
            ...own,
            baseAgreement: undefined,
            headSigners: file(record(ada), record(carol, "Carol")),
            comments: [approve(carol)],
          }),
        ).problems,
      ).toHaveLength(1);
    });
  });

  describe("item 5: an outside pull request only appends records", () => {
    it("refuses lines that render as records, hidden records and blank lines", () => {
      for (const forged of [
        `* @carol (303), Carol, 2026-11-12, version ${CLA_VERSION}, SHA-256 ${DIGEST}`,
        "<!-- - @carol (303) -->",
        "",
      ]) {
        expect(
          checkCla(pr({ comments: [say(ada)], headSigners: `${signed}${forged}\n` })).problems,
          forged,
        ).toEqual([
          `${SIGNERS_FILE} line 7 is not a record: a pull request may only append records ("- @login ...") at the end of the file`,
        ]);
      }
    });

    it("refuses edited prose and a record inserted anywhere but the end", () => {
      expect(
        checkCla(
          pr({ comments: [say(ada)], headSigners: signed.replace("Prose.", "Other prose.") }),
        ).problems,
      ).toEqual([
        `${SIGNERS_FILE} line 3 was changed or removed: a pull request may only append records at the end of the file`,
      ]);
      const inserted = file(record(bob, "Bob"), record(ada));
      expect(checkCla(pr({ comments: [say(ada)], headSigners: inserted })).problems).toContain(
        `${SIGNERS_FILE} line 6 was changed or removed: a pull request may only append records at the end of the file`,
      );
    });

    it("lets an exempt pull request edit prose, never records", () => {
      const own = { author: maintainer, commits: [commit(maintainer)] };
      expect(
        checkCla(pr({ ...own, headSigners: signed.replace("Prose.", "Better prose.") })).problems,
      ).toEqual([]);
    });
  });

  describe("finding 4: exemptions keep every integrity check", () => {
    const base = file(record(ada), record(bob, "Bob"));
    const exempt = (headSigners: string | undefined, baseSigners: string | undefined = base) =>
      checkCla(pr({ author: dependabot, commits: [commit(dependabot)], baseSigners, headSigners }))
        .problems;

    it("refuses deleting the signers file", () => {
      expect(exempt(undefined)).toEqual([
        `${SIGNERS_FILE} is missing at the head of the pull request`,
      ]);
    });

    it("refuses removing or altering a record", () => {
      const removed = `the record "${record(bob, "Bob").slice(0, 60)}" on the base branch was removed or changed`;
      expect(exempt(file(record(ada)))).toEqual([removed]);
      expect(exempt(file(record(ada), record(bob, "Robert")))).toEqual([
        removed,
        refusedRecord(bob),
      ]);
    });

    it("refuses fabricated records, from the maintainer too", () => {
      expect(
        checkCla(
          pr({
            author: maintainer,
            commits: [commit(maintainer)],
            headSigners: file(record(ada), record(carol, "Carol")),
          }),
        ).problems,
      ).toEqual([refusedRecord(carol)]);
    });

    it("refuses removing an unreadable record instead of ignoring it", () => {
      expect(exempt(file(record(ada)), file(record(ada), "- @bob said yes"))).toEqual([
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
  });

  describe("item 6: an exempt account's commit in someone else's pull request", () => {
    const check = (options: Partial<PullRequestCommit>) =>
      checkCla(
        pr({
          commits: [commit(maintainer, { sha: "b".repeat(40), ...options }), commit(ada)],
          comments: [say(ada)],
        }),
      ).problems;
    const refused = [
      "commit bbbbbbbbbbbb names the exempt account @leynier (36774373) as its author in a pull request opened by @ada (101), but GitHub does not report it as verified and committed by an exempt account or through GitHub: it may be someone else's work (maintainer: sign your commits)",
    ];

    it("refuses an unverified commit made through GitHub", () => {
      expect(check({ committer: WEB_FLOW, verified: false })).toEqual(refused);
    });

    it("refuses a committer that only shares the exempt account's login, or is unknown", () => {
      expect(check({ committer: { id: 4242, login: "Leynier" }, verified: true })).toEqual(refused);
      expect(check({ committer: { id: 1, login: "web-flow" }, verified: true })).toEqual(refused);
      expect(check({ committer: { id: WEB_FLOW.id, login: "other" }, verified: true })).toEqual(
        refused,
      );
      expect(check({ committer: null, verified: true })).toEqual(refused);
      expect(check({ committer: ada, verified: true })).toEqual(refused);
    });

    it("accepts a verified commit committed by an exempt account or through GitHub", () => {
      expect(check({ committer: WEB_FLOW, verified: true })).toEqual([]);
      expect(check({ committer: maintainer, verified: true })).toEqual([]);
    });

    it("does not ask it of the maintainer's own pull request", () => {
      expect(checkCla(pr({ author: maintainer, commits: [commit(maintainer)] })).problems).toEqual(
        [],
      );
    });
  });

  describe("items 2 and 8: co-author trailers", () => {
    it("accepts a review suggestion's trailer with the maintainer's commit email", () => {
      const message =
        "Apply suggestion\n\nCo-authored-by: Leynier Gutiérrez González <leynier41@gmail.com>";
      expect(
        checkCla(pr({ commits: [commit(ada, { message })], comments: [say(ada)] })).problems,
      ).toEqual([]);
    });

    it("refuses a trailer it cannot identify, tools included, in the maintainer's own pull request too", () => {
      const message = "feat: x\n\nCo-authored-by: Some Assistant <noreply@example.com>";
      const problem = `commit ${HEAD.slice(0, 12)} has a Co-authored-by trailer "Some Assistant <noreply@example.com>" that is not one person with a GitHub noreply address with an account ID (ID+login@users.noreply.github.com), so the co-author cannot be identified`;
      expect(
        checkCla(pr({ commits: [commit(ada, { message })], comments: [say(ada)] })).problems,
      ).toEqual([problem]);
      expect(
        checkCla(pr({ author: maintainer, commits: [commit(maintainer, { message })] })).problems,
      ).toEqual([problem]);
    });

    it("refuses a trailer without an address and one naming two people", () => {
      for (const value of [
        "Mallory",
        "Bob <202+bob@users.noreply.github.com>, Carol <303+carol@users.noreply.github.com>",
      ]) {
        expect(
          checkCla(
            pr({
              commits: [commit(ada, { message: `x\n\nCo-authored-by: ${value}` })],
              comments: [say(ada)],
            }),
          ).problems,
        ).toHaveLength(1);
      }
    });
  });

  describe("finding 5: every rights holder, not only commit authors", () => {
    it("requires the original author of an imported patch", () => {
      expect(
        checkCla(pr({ commits: [commit(carol, { committer: ada })], comments: [say(ada)] }))
          .required,
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
      expect(human.problems).toEqual([noRecord(carol), notPosted(carol)]);
    });

    it("refuses commits whose author email belongs to no GitHub account", () => {
      expect(checkCla(pr({ commits: [commit(null)], comments: [say(ada)] })).problems).toEqual([
        `commit ${HEAD.slice(0, 12)} has an author email that belongs to no GitHub account, so its author cannot be identified: use an email linked to your account and push again`,
      ]);
    });
  });

  describe("item 7 and finding 21: versions that no longer accept new signatures", () => {
    const OLD = "a".repeat(64);
    const versions: AgreementVersions = {
      "1.9": { sha256: OLD, acceptsNewSubmissions: false },
      [CLA_VERSION]: { sha256: DIGEST, acceptsNewSubmissions: true },
    };
    const oldRecord = record(ada, "Ada", "2026-11-01", "1.9", OLD);

    it("keeps a signer's records of several versions apart", () => {
      expect(parseSigners(file(oldRecord, record(ada)), versions).errors).toEqual([]);
      expect(parseSigners(file(record(ada), record(ada)), versions).errors).toEqual([
        `${SIGNERS_FILE} line 7 records account 101 a second time for version ${CLA_VERSION}`,
      ]);
    });

    it("refuses a new record of a version that no longer accepts signatures", () => {
      expect(
        checkCla(
          pr({
            versions,
            baseSigners: file(record(ada)),
            headSigners: file(record(ada), oldRecord),
            comments: [say(ada)],
          }),
        ).problems,
      ).toEqual([
        "the pull request adds a record of version 1.9, which no longer accepts new signatures",
      ]);
    });

    it("does not count an old version's record or statement for a new submission", () => {
      const oldOnly = file(oldRecord);
      expect(
        checkCla(
          pr({
            versions,
            baseSigners: oldOnly,
            headSigners: oldOnly,
            comments: [say(ada, statement("1.9", versions))],
          }),
        ).problems,
      ).toEqual([noRecord(ada), notPosted(ada)]);
      expect(
        checkCla(
          pr({
            versions,
            baseSigners: oldOnly,
            headSigners: file(oldRecord, record(ada)),
            comments: [say(ada)],
          }),
        ).problems,
      ).toEqual([]);
    });
  });

  describe("finding 6 and item 11: one complete, consistent view", () => {
    const ok = { comments: [say(ada)] };
    const snapshot = {
      eventHeadSha: HEAD,
      headShaBefore: HEAD,
      headShaAfter: HEAD,
      reportedCommits: 1,
      reportedFiles: 1,
    };

    it(`refuses more than ${MAX_COMMITS} commits or ${MAX_FILES} files`, () => {
      const commits = Array.from({ length: MAX_COMMITS + 1 }, (_, i) =>
        commit(ada, { sha: i === MAX_COMMITS ? HEAD : i.toString(16).padStart(40, "0") }),
      );
      expect(checkCla(pr({ ...ok, commits })).problems).toEqual([
        `the pull request has ${MAX_COMMITS + 1} commits, more than the ${MAX_COMMITS} the check can read: split it`,
      ]);
      expect(
        checkCla(pr({ ...ok, snapshot: { ...snapshot, reportedFiles: MAX_FILES + 1 } })).problems,
      ).toEqual([
        `the pull request changes ${MAX_FILES + 1} files, more than the ${MAX_FILES} the check can read: split it`,
      ]);
    });

    it("refuses a truncated commit or file list, or a failed read", () => {
      expect(
        checkCla(pr({ ...ok, snapshot: { ...snapshot, reportedCommits: 3 } })).problems,
      ).toEqual([
        "the check read 1 commits of the 3 the pull request reports, so its view is incomplete",
      ]);
      expect(
        checkCla(pr({ ...ok, commits: [], snapshot: { ...snapshot, reportedCommits: 1 } }))
          .problems,
      ).toEqual([
        "the check read 0 commits of the 1 the pull request reports, so its view is incomplete",
        "the commit list read does not contain the pull request's head",
      ]);
      expect(checkCla(pr({ ...ok, snapshot: { ...snapshot, reportedFiles: 2 } })).problems).toEqual(
        [
          "the check read 1 changed files of the 2 the pull request reports, so its view is incomplete",
        ],
      );
    });

    it("refuses a head that changed during collection or that the list does not contain", () => {
      expect(
        checkCla(pr({ ...ok, snapshot: { ...snapshot, headShaAfter: "e".repeat(40) } })).problems,
      ).toEqual([
        "the pull request's head changed while the check read it: the check runs again on the new head",
      ]);
      expect(
        checkCla(pr({ ...ok, snapshot: { ...snapshot, headShaBefore: "e".repeat(40) } })).problems,
      ).toHaveLength(1);
      expect(
        checkCla(pr({ ...ok, commits: [commit(ada, { sha: "d".repeat(40) })] })).problems,
      ).toEqual(["the commit list read does not contain the pull request's head"]);
    });

    it("accepts the head anywhere in the list", () => {
      const commits = [commit(ada), commit(ada, { sha: "d".repeat(40) })];
      expect(checkCla(pr({ ...ok, commits })).problems).toEqual([]);
    });
  });
});

describe("workflow readers", () => {
  it("reads commits, with null accounts for unlinked emails", () => {
    expect(
      parseCommits(
        '{"sha":"a","id":101,"login":"ada","committerId":19864447,"committer":"web-flow","verified":true,"message":"m"}\n\n{"sha":"b","id":null,"login":null}\n',
      ),
    ).toEqual([
      { sha: "a", author: ada, committer: WEB_FLOW, verified: true, message: "m" },
      { sha: "b", author: null, committer: null, verified: false, message: "" },
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
    expect(() => parseComments(JSON.stringify({ ...line, id: "5" }))).toThrow(
      "comment without an author",
    );
  });

  it("reads changed files with the old path of renames", () => {
    expect(parseFiles('{"filename":"a","previous":null}\n{"filename":"b","previous":"c"}')).toEqual(
      ["a", "b", "c"],
    );
  });

  it("reads the snapshot and refuses one without an author or counts", () => {
    const value = {
      authorId: 101,
      authorLogin: "ada",
      eventHeadSha: "h",
      headShaBefore: "h",
      headShaAfter: "h",
      reportedCommits: 2,
      reportedFiles: 3,
    };
    expect(parseSnapshot(JSON.stringify(value))).toEqual({
      author: ada,
      snapshot: {
        eventHeadSha: "h",
        headShaBefore: "h",
        headShaAfter: "h",
        reportedCommits: 2,
        reportedFiles: 3,
      },
    });
    expect(() => parseSnapshot(JSON.stringify({ ...value, authorId: "101" }))).toThrow("no author");
    expect(() => parseSnapshot(JSON.stringify({ ...value, reportedFiles: null }))).toThrow(
      "missing reportedFiles",
    );
  });
});

describe("committed documents", () => {
  it("the signers file parses without errors", () => {
    expect(parseSigners(readFileSync(join(root, SIGNERS_FILE), "utf8")).errors).toEqual([]);
  });

  it("contributing.md quotes the statement and a record with the current digest", () => {
    const contributing = readFileSync(join(root, "contributing.md"), "utf8");
    expect(contributing).toContain(STATEMENT);
    expect(contributing).toContain(`, version ${CLA_VERSION}, SHA-256 ${DIGEST}`);
    expect(contributing).toContain(`${HEAD_LINE_PREFIX}<full SHA of the head commit>`);
  });

  it("no document calls the agreement a draft pending review", () => {
    for (const path of ["cla.md", "contributing.md", "docs/licensing.md", "readme.md"]) {
      expect(readFileSync(join(root, path), "utf8"), path).not.toMatch(
        /draft pending|\(draft\)|pending (a lawyer|legal)/i,
      );
    }
  });

  it("keeps the three files with LF endings in every checkout", () => {
    const attributes = readFileSync(join(root, ".gitattributes"), "utf8");
    for (const path of ["cla.md", "cla-signers.md", "contributing.md"]) {
      expect(attributes).toContain(`${path} text eol=lf`);
    }
  });

  it("checks out the commit the workflow comes from, never the pull request's base commit", () => {
    // pull_request_target runs the workflow file of the base branch's tip. The pull request's
    // base.sha can be older, and then the new workflow runs an old check script that does not
    // take its arguments (it happened to a pull request opened before the check changed).
    const workflow = readFileSync(join(root, ".github/workflows/cla.yml"), "utf8");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression.
    expect(workflow).toContain("ref: ${{ github.sha }}");
    expect(workflow).not.toContain("pull_request.base.sha");
  });
});
