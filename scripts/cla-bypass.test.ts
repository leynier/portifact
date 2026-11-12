// Reproductions of the attacks the independent review of pull request 242 found, written against
// the check at 84154948. Each must fail before the fix.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ClaInput, checkCla, SIGNATURE_STATEMENT, SUBMISSION_STATEMENT } from "./cla.ts";

const AGREEMENT = readFileSync(join(import.meta.dirname, "..", "cla.md"), "utf8");
const HEAD = "f".repeat(40);
const ada = { id: 101, login: "ada" };
const bob = { id: 202, login: "bob" };
const maintainer = { id: 36774373, login: "leynier" };
const line = (who: { id: number; login: string }) =>
  `- @${who.login} (${who.id}), Someone, 2026-11-12: ${SIGNATURE_STATEMENT}`;
const file = (...lines: string[]) => ["# Signers", "", ...lines, ""].join("\n");
const comment = (author: { id: number; login: string }, body = SUBMISSION_STATEMENT, edited = false) => ({
  id: 1,
  author,
  body,
  createdAt: "2026-11-12T10:00:00Z",
  updatedAt: edited ? "2026-11-12T11:00:00Z" : "2026-11-12T10:00:00Z",
  url: "u",
});
const commit = (author: { id: number; login: string }, more: Record<string, unknown> = {}) => ({
  sha: HEAD,
  author,
  committerLogin: author.login,
  verified: false,
  message: "m",
  ...more,
});
const input = (more: Partial<ClaInput> & Record<string, unknown>): ClaInput =>
  ({
    author: ada,
    commits: [commit(ada)],
    comments: [comment(ada)],
    snapshot: { eventHeadSha: HEAD, headShaBefore: HEAD, headShaAfter: HEAD, reportedCommits: 1 },
    baseSigners: file(line(ada)),
    headSigners: file(line(ada)),
    headAgreement: AGREEMENT,
    ...more,
  }) as ClaInput;

describe("bypasses of the check at 84154948", () => {
  it("1: a signed contributor changes cla.md and its digest in one pull request", () => {
    const changed = AGREEMENT.replace("royalty-free", "royalty-bearing");
    const { problems } = checkCla(
      input({ headAgreement: changed, baseAgreement: AGREEMENT, changedFiles: ["cla.md", "scripts/cla.ts"] }),
    );
    expect(problems).not.toEqual([]);
  });

  it("2: a suggestion applied from the maintainer's review fails the pull request", () => {
    const message = "Apply suggestion\n\nCo-authored-by: Leynier Gutiérrez González <leynier41@gmail.com>";
    expect(checkCla(input({ commits: [commit(ada, { message })] })).problems).toEqual([]);
  });

  it("3: a statement edited into someone's comment is accepted", () => {
    const { problems } = checkCla(input({ comments: [comment(ada, SUBMISSION_STATEMENT, true)] }));
    expect(problems).not.toEqual([]);
  });

  it("4: a commit author's old statement covers whatever is pushed after it", () => {
    const { problems } = checkCla(
      input({
        commits: [commit(bob)],
        comments: [comment(ada), comment(bob)],
        baseSigners: file(line(ada), line(bob)),
        headSigners: file(line(ada), line(bob)),
      }),
    );
    expect(problems).not.toEqual([]);
  });

  it("5: the signers file gains a line that renders as a record but is not one", () => {
    for (const forged of [
      `* @carol (303), Carol, 2026-11-12: ${SIGNATURE_STATEMENT}`,
      "<!-- - @carol (303) -->",
      "Prose that now says something else.",
    ]) {
      expect(checkCla(input({ headSigners: file(line(ada), forged) })).problems, forged).not.toEqual([]);
    }
  });

  it("6: a commit naming the maintainer, committed by another account with the same login, passes", () => {
    const forged = commit(maintainer, { sha: "b".repeat(40), committerLogin: "Leynier", committerId: 4242, verified: true });
    const { problems } = checkCla(
      input({
        commits: [forged, commit(ada)],
        snapshot: { eventHeadSha: HEAD, headShaBefore: HEAD, headShaAfter: HEAD, reportedCommits: 2 },
      }),
    );
    expect(problems).not.toEqual([]);
  });

  it("8: a Co-authored-by line without an address is ignored", () => {
    const message = "feat: x\n\nCo-authored-by: Mallory";
    expect(checkCla(input({ commits: [commit(ada, { message })] })).problems).not.toEqual([]);
  });

  it("9: a comment that adds text around the statement is accepted", () => {
    const body = `Not really.\n${SUBMISSION_STATEMENT}\nJust quoting it.`;
    expect(checkCla(input({ comments: [comment(ada, body)] })).problems).not.toEqual([]);
  });
});
