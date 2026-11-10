// The contributor license agreement check (docs/licensing.md, contributing.md). Pure logic, unit
// tested; scripts/cla-main.ts runs it in the `cla` workflow with data read from GitHub.

/** The agreement version contributors sign; a new version needs a new statement. */
export const CLA_VERSION = "1.0";

/** The exact statement each signature line carries. */
export const SIGNATURE_STATEMENT = `I have read the Portifact Individual Contributor License Agreement, version ${CLA_VERSION}, in cla.md, and I agree to it for all my past and future contributions to Portifact.`;

/** The file contributors sign by adding a line, at the repository root. */
export const SIGNERS_FILE = "cla-signers.md";

/**
 * Accounts that never sign: the maintainer, who owns the copyright and offers the commercial
 * license, and GitHub's automation. Compared in lowercase, like GitHub logins.
 */
export const EXEMPT_LOGINS: ReadonlySet<string> = new Set([
  "leynier",
  "dependabot[bot]",
  "github-actions[bot]",
]);

// `- @login, Full Name, YYYY-MM-DD: statement`. GitHub logins are 1 to 39 characters of
// letters, digits and single hyphens, not starting or ending with one.
const SIGNATURE =
  /^- @([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}), (.+), (\d{4}-\d{2}-\d{2}): (.*)$/;

export interface Signature {
  login: string;
  name: string;
  date: string;
  line: string;
}

export interface ParsedSigners {
  signatures: Signature[];
  errors: string[];
}

function isDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Reads the signature lines; any other list item is an error, other lines are prose. */
export function parseSigners(text: string): ParsedSigners {
  const signatures: Signature[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trimEnd();
    if (!line.startsWith("- ")) return;
    const where = `${SIGNERS_FILE} line ${index + 1}`;
    const match = SIGNATURE.exec(line);
    if (!match) {
      errors.push(`${where} is not "- @login, Full Name, YYYY-MM-DD: <statement>"`);
      return;
    }
    const [, login = "", name = "", date = "", statement = ""] = match;
    if (name.trim() === "") errors.push(`${where} has no name`);
    if (!isDate(date)) errors.push(`${where} has an invalid date "${date}"`);
    if (statement !== SIGNATURE_STATEMENT) {
      errors.push(`${where} does not carry the exact statement from contributing.md`);
    }
    const key = login.toLowerCase();
    if (seen.has(key)) errors.push(`${where} signs @${login} a second time`);
    seen.add(key);
    signatures.push({ login, name: name.trim(), date, line });
  });
  return { signatures, errors };
}

export interface PullRequestCommit {
  sha: string;
  /** The GitHub account the commit's author email belongs to, or null when none does. */
  login: string | null;
}

export interface ClaInput {
  /** The pull request's author. */
  author: string;
  commits: readonly PullRequestCommit[];
  /** The signers file on the base branch, undefined when it does not exist there. */
  baseSigners: string | undefined;
  /** The signers file at the pull request's head, undefined when it does not exist there. */
  headSigners: string | undefined;
}

export interface ClaResult {
  problems: string[];
  /** Logins that have to have signed, in order, without exempt accounts. */
  required: string[];
}

/**
 * A pull request passes when its author and every commit author have signed at its head, and
 * the signers file only gains lines that those people added for themselves: no signature on
 * the base branch is removed or changed, and nobody signs for someone else.
 */
export function checkCla(input: ClaInput): ClaResult {
  const problems: string[] = [];
  const contributors = new Map<string, string>();
  const add = (login: string) => {
    const key = login.toLowerCase();
    if (!contributors.has(key)) contributors.set(key, login);
  };
  add(input.author);
  for (const commit of input.commits) {
    if (commit.login === null) {
      problems.push(
        `commit ${commit.sha.slice(0, 12)} has an author email that belongs to no GitHub account, so its signature cannot be checked: use an email linked to your account and push again`,
      );
    } else add(commit.login);
  }
  const required = [...contributors.entries()]
    .filter(([key]) => !EXEMPT_LOGINS.has(key))
    .map(([, login]) => login);
  if (required.length === 0) return { problems, required };

  if (input.headSigners === undefined) {
    problems.push(`${SIGNERS_FILE} is missing at the head of the pull request`);
    return { problems, required };
  }
  const head = parseSigners(input.headSigners);
  problems.push(...head.errors);
  const base = parseSigners(input.baseSigners ?? "").signatures;
  const headLines = new Set(head.signatures.map((s) => s.line));
  for (const signature of base) {
    if (!headLines.has(signature.line)) {
      problems.push(
        `the signature of @${signature.login} on the base branch was removed or changed`,
      );
    }
  }
  const baseLines = new Set(base.map((s) => s.line));
  for (const signature of head.signatures) {
    if (baseLines.has(signature.line)) continue;
    if (!contributors.has(signature.login.toLowerCase())) {
      problems.push(
        `the pull request adds a signature for @${signature.login}, who is not one of its authors: each contributor signs for themself`,
      );
    }
  }
  const signed = new Set(head.signatures.map((s) => s.login.toLowerCase()));
  for (const login of required) {
    if (!signed.has(login.toLowerCase())) {
      problems.push(
        `@${login} has not signed the contributor license agreement: add your line to ${SIGNERS_FILE} as contributing.md explains`,
      );
    }
  }
  return { problems, required };
}

/** Reads the JSON lines `gh api --jq '.[] | {sha, login: .author.login}'` prints. */
export function parseCommits(text: string): PullRequestCommit[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const value = JSON.parse(line) as { sha?: unknown; login?: unknown };
      if (typeof value.sha !== "string") throw new Error(`commit without a sha: ${line}`);
      return { sha: value.sha, login: typeof value.login === "string" ? value.login : null };
    });
}
