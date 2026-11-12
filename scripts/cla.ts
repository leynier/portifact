// The contributor license agreement check (docs/licensing.md, contributing.md). Pure logic, unit
// tested; scripts/cla-main.ts runs it in the `cla` workflow with data read from GitHub.
//
// This check matches declared contributor identities to signature records; it does not
// authenticate signatures or establish ownership. What it can verify is that each contributor's
// own authenticated GitHub account posted the submission statement on the pull request, which is
// the record of assent cla.md section 13 describes. Who owns the material is the maintainer's
// review before merge.
import { createHash } from "node:crypto";

export interface AgreementVersion {
  /** SHA-256 of cla.md's text with LF line endings, as published for this version. */
  sha256: string;
  /** Whether new submissions may adopt this version; earlier records keep their own version. */
  acceptsNewSubmissions: boolean;
}

/**
 * Every published version that has a statement format, keyed by number. A published entry never
 * changes: a new text is a new version with its own digest (docs/releasing.md, "Contributor
 * license agreement"). Version 1.0 is not listed: nobody but the maintainer contributed while it
 * was published, nobody signed it, and it was withdrawn before any signature.
 */
export const AGREEMENT_VERSIONS: Readonly<Record<string, AgreementVersion>> = {
  "2.0": {
    sha256: "93ea88ec08f6ce189eb0b39653c5d2eece4e31d00dde8110d7438a26ededeec0",
    acceptsNewSubmissions: true,
  },
};

/** The version new contributors sign; cla.md names it and hashes to its digest. */
export const CLA_VERSION = "2.0";

/** The file contributors index their signature in, at the repository root. */
export const SIGNERS_FILE = "cla-signers.md";

/** The agreement's file, at the repository root. */
export const AGREEMENT_FILE = "cla.md";

/** The most commits GitHub's pull request commits endpoint lists. */
export const MAX_COMMITS = 250;

function digestOf(version: string): string {
  const entry = AGREEMENT_VERSIONS[version];
  if (!entry) throw new Error(`unknown agreement version ${version}`);
  return entry.sha256;
}

/** The statement a signature line in the signers file carries for a version. */
export function signatureStatement(version: string): string {
  return `I have read and agree to the Portifact Individual Contributor License Agreement, version ${version}, whose text in cla.md has the SHA-256 digest ${digestOf(version)}.`;
}

/** The statement a contributor posts as a comment on each pull request: their assent. */
export function submissionStatement(version: string): string {
  return `I sign the Portifact Individual Contributor License Agreement, version ${version}, whose text in cla.md has the SHA-256 digest ${digestOf(version)}, and I submit my contributions in this pull request under it. I have identified in this pull request any material in it that I did not create, and I intend this comment to be my electronic signature.`;
}

export const SIGNATURE_STATEMENT = signatureStatement(CLA_VERSION);
export const SUBMISSION_STATEMENT = submissionStatement(CLA_VERSION);

/** SHA-256 of an agreement's text, with CRLF read as LF so a checkout's line endings do not matter. */
export function agreementDigest(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

export interface Account {
  /** GitHub's numeric account ID, which never changes or passes to another person. */
  id: number;
  login: string;
}

/**
 * Accounts that never sign, by numeric ID: the maintainer, who owns the copyright and offers the
 * commercial license, and the automation the repository uses. An exemption removes only the
 * obligation to sign, never the signers file's integrity checks.
 */
export const EXEMPT_ACCOUNTS: ReadonlyMap<number, string> = new Map([
  [36774373, "leynier"],
  [49699333, "dependabot[bot]"],
  [41898282, "github-actions[bot]"],
  // The image optimizer the repository uses: its commits recompress existing images.
  [31301654, "imgbot[bot]"],
]);

// GitHub logins are 1 to 39 characters of letters, digits and single hyphens, not starting or
// ending with one.
const LOGIN = "[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}";
// `- @login (id), Full Name, YYYY-MM-DD: statement`.
const SIGNATURE = new RegExp(
  `^- @(${LOGIN}) \\((\\d{1,12})\\), (.+), (\\d{4}-\\d{2}-\\d{2}): (.*)$`,
);
// GitHub's noreply address with the account ID, the one form that names an account for sure.
const NOREPLY = /^(\d{1,12})\+([A-Za-z0-9-]+(?:\[bot\])?)@users\.noreply\.github\.com$/i;
const TRAILER = /^co-authored-by:\s*(.*?)\s*<([^<>\s]+)>\s*$/gim;

export interface Signature {
  login: string;
  id: number;
  name: string;
  date: string;
  version: string;
  line: string;
}

export interface ParsedSigners {
  signatures: Signature[];
  /** Every list item, as written, so a malformed record is still a record. */
  items: string[];
  errors: string[];
}

function isDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function versionOfStatement(statement: string): string | undefined {
  return Object.keys(AGREEMENT_VERSIONS).find((v) => signatureStatement(v) === statement);
}

/** Reads the signature lines; any other list item is an error, other lines are prose. */
export function parseSigners(text: string): ParsedSigners {
  const signatures: Signature[] = [];
  const items: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trimEnd();
    if (!line.startsWith("- ")) return;
    items.push(line);
    const where = `${SIGNERS_FILE} line ${index + 1}`;
    const match = SIGNATURE.exec(line);
    if (!match) {
      errors.push(`${where} is not "- @login (account ID), Full Name, YYYY-MM-DD: <statement>"`);
      return;
    }
    const [, login = "", id = "", name = "", date = "", statement = ""] = match;
    if (name.trim() === "") errors.push(`${where} has no name`);
    if (!isDate(date)) errors.push(`${where} has an invalid date "${date}"`);
    const version = versionOfStatement(statement);
    if (version === undefined) {
      errors.push(`${where} does not carry the exact statement of a published agreement version`);
      return;
    }
    const key = `${Number(id)}@${version}`;
    if (seen.has(key))
      errors.push(`${where} signs account ${id} a second time for version ${version}`);
    seen.add(key);
    signatures.push({ login, id: Number(id), name: name.trim(), date, version, line });
  });
  return { signatures, items, errors };
}

export interface PullRequestCommit {
  sha: string;
  /** The GitHub account the commit's author email belongs to, or null when none does. */
  author: Account | null;
  /** The GitHub account of the committer email, or null; `web-flow` for commits made on GitHub. */
  committerLogin: string | null;
  /** Whether GitHub verified the commit's signature. */
  verified: boolean;
  message: string;
}

export interface PullRequestComment {
  id: number;
  author: Account;
  body: string;
  createdAt: string;
  updatedAt: string;
  url: string;
}

/** What the workflow saw of the pull request, to prove it read one complete head. */
export interface Snapshot {
  /** The head the event that started the run names. */
  eventHeadSha: string;
  /** The pull request's head read before and after the commits, comments and files. */
  headShaBefore: string;
  headShaAfter: string;
  /** The commit count the pull request reports. */
  reportedCommits: number;
}

export interface ClaInput {
  /** The pull request's author, as GitHub authenticated them. */
  author: Account;
  commits: readonly PullRequestCommit[];
  comments: readonly PullRequestComment[];
  snapshot: Snapshot;
  /** The signers file on the base branch, undefined when it does not exist there. */
  baseSigners: string | undefined;
  /** The signers file at the pull request's head, undefined when it does not exist there. */
  headSigners: string | undefined;
  /** cla.md at the pull request's head, undefined when it does not exist there. */
  headAgreement: string | undefined;
}

export interface EvidenceEntry {
  id: number;
  login: string;
  version: string;
  sha256: string;
  comment: { id: number; url: string; createdAt: string; updatedAt: string; bodySha256: string };
}

export interface Evidence {
  headSha: string;
  commits: string[];
  contributors: EvidenceEntry[];
}

export interface ClaResult {
  problems: string[];
  /** Accounts that have to have signed, in order, without exempt accounts. */
  required: Account[];
  /** What the maintainer archives for each contributor who assented (cla.md section 13). */
  evidence: Evidence;
}

const isExempt = (account: Account) => EXEMPT_ACCOUNTS.has(account.id);
const short = (sha: string) => sha.slice(0, 12);
const name = (account: Account) => `@${account.login} (${account.id})`;

/** The accounts a commit message's Co-authored-by trailers name, and the ones it cannot place. */
export function coAuthors(message: string): { accounts: Account[]; unresolved: string[] } {
  const accounts: Account[] = [];
  const unresolved: string[] = [];
  for (const [, who = "", email = ""] of message.matchAll(TRAILER)) {
    const match = NOREPLY.exec(email);
    if (match) accounts.push({ id: Number(match[1]), login: match[2] ?? "" });
    else unresolved.push(who || email);
  }
  return { accounts, unresolved };
}

function snapshotProblems(input: ClaInput): string[] {
  const { snapshot, commits } = input;
  const problems: string[] = [];
  if (
    snapshot.headShaBefore !== snapshot.eventHeadSha ||
    snapshot.headShaAfter !== snapshot.eventHeadSha
  ) {
    problems.push(
      "the pull request's head changed while the check read it: the check runs again on the new head",
    );
  }
  if (snapshot.reportedCommits > MAX_COMMITS) {
    problems.push(
      `the pull request has ${snapshot.reportedCommits} commits, more than the ${MAX_COMMITS} the check can read: split it`,
    );
  } else if (commits.length !== snapshot.reportedCommits) {
    problems.push(
      `the check read ${commits.length} commits of the ${snapshot.reportedCommits} the pull request reports, so its view is incomplete`,
    );
  }
  if (commits.length > 0 && commits.at(-1)?.sha !== snapshot.eventHeadSha) {
    problems.push("the commit list read does not end at the pull request's head");
  }
  return problems;
}

/** The latest comment by the account that carries a statement accepted for new submissions. */
function assentOf(account: Account, comments: readonly PullRequestComment[]) {
  let found: { comment: PullRequestComment; version: string } | undefined;
  for (const comment of comments) {
    if (comment.author.id !== account.id) continue;
    const lines = comment.body.split(/\r?\n/).map((line) => line.trim());
    for (const [version, entry] of Object.entries(AGREEMENT_VERSIONS)) {
      if (entry.acceptsNewSubmissions && lines.includes(submissionStatement(version))) {
        found = { comment, version };
      }
    }
  }
  return found;
}

/**
 * A pull request passes when it was read as one complete head, every contributor (its author,
 * each commit author and each co-author) has a signature record and posted the submission
 * statement from their own account on it, and the signers file keeps every record of the base
 * branch and only gains records whose account assented on this pull request. Exempt accounts do
 * not sign but get every integrity check.
 */
export function checkCla(input: ClaInput): ClaResult {
  const problems = snapshotProblems(input);
  const contributors = new Map<number, Account>();
  const add = (account: Account) => {
    if (!contributors.has(account.id)) contributors.set(account.id, account);
  };
  add(input.author);
  const outsider = !isExempt(input.author);
  for (const commit of input.commits) {
    if (commit.author === null) {
      problems.push(
        `commit ${short(commit.sha)} has an author email that belongs to no GitHub account, so its author cannot be identified: use an email linked to your account and push again`,
      );
    } else {
      add(commit.author);
      const viaGitHub = commit.committerLogin === "web-flow";
      const sameCommitter =
        commit.committerLogin?.toLowerCase() === commit.author.login.toLowerCase();
      if (
        outsider &&
        isExempt(commit.author) &&
        !(commit.verified && (viaGitHub || sameCommitter))
      ) {
        problems.push(
          `commit ${short(commit.sha)} names the exempt account ${name(commit.author)} as its author in a pull request opened by ${name(input.author)}, without a signature GitHub verified for that account: it may be someone else's work`,
        );
      }
    }
    const trailers = coAuthors(commit.message);
    for (const account of trailers.accounts) add(account);
    for (const who of trailers.unresolved) {
      problems.push(
        `commit ${short(commit.sha)} has a Co-authored-by trailer for "${who}" without a GitHub noreply address with an account ID (ID+login@users.noreply.github.com), so the co-author cannot be identified`,
      );
    }
  }
  const required = [...contributors.values()].filter((account) => !isExempt(account));

  const current = AGREEMENT_VERSIONS[CLA_VERSION];
  let agreementChanged = false;
  if (input.headAgreement === undefined) {
    problems.push(`${AGREEMENT_FILE} is missing at the head of the pull request`);
    agreementChanged = true;
  } else if (agreementDigest(input.headAgreement) !== current?.sha256) {
    agreementChanged = true;
  }

  const base = parseSigners(input.baseSigners ?? "");
  const head = input.headSigners === undefined ? undefined : parseSigners(input.headSigners);
  if (head === undefined) {
    if (input.baseSigners !== undefined || required.length > 0) {
      problems.push(`${SIGNERS_FILE} is missing at the head of the pull request`);
    }
  } else {
    problems.push(...head.errors);
    const headItems = new Set(head.items);
    for (const item of base.items) {
      if (!headItems.has(item)) {
        problems.push(
          `the record "${item.slice(0, 60)}" on the base branch was removed or changed`,
        );
      }
    }
    const baseItems = new Set(base.items);
    for (const signature of head.signatures) {
      if (baseItems.has(signature.line)) continue;
      const account = { id: signature.id, login: signature.login };
      if (agreementChanged) {
        problems.push(
          `the pull request adds a signature for ${name(account)} and also changes ${AGREEMENT_FILE}: publish an agreement change on its own, then sign the published text`,
        );
      }
      const assent = assentOf(account, input.comments);
      if (!assent || assent.comment.author.login.toLowerCase() !== signature.login.toLowerCase()) {
        problems.push(
          `the pull request adds a signature for ${name(account)} that the account did not confirm with its own comment on the pull request: each contributor signs for themself`,
        );
      } else if (!AGREEMENT_VERSIONS[signature.version]?.acceptsNewSubmissions) {
        problems.push(
          `the pull request adds a signature of version ${signature.version}, which no longer accepts new signatures`,
        );
      }
    }
  }

  const evidence: Evidence = {
    headSha: input.snapshot.eventHeadSha,
    commits: input.commits.map((commit) => commit.sha),
    contributors: [],
  };
  for (const account of required) {
    const signed = head?.signatures.some(
      (s) => s.id === account.id && AGREEMENT_VERSIONS[s.version]?.acceptsNewSubmissions,
    );
    if (!signed) {
      problems.push(
        `${name(account)} has no signature record in ${SIGNERS_FILE}: add your line as contributing.md explains`,
      );
    }
    const assent = assentOf(account, input.comments);
    if (!assent) {
      problems.push(
        `${name(account)} has not posted the submission statement as a comment on this pull request from their own account, as contributing.md explains`,
      );
      continue;
    }
    evidence.contributors.push({
      id: account.id,
      login: assent.comment.author.login,
      version: assent.version,
      sha256: AGREEMENT_VERSIONS[assent.version]?.sha256 ?? "",
      comment: {
        id: assent.comment.id,
        url: assent.comment.url,
        createdAt: assent.comment.createdAt,
        updatedAt: assent.comment.updatedAt,
        bodySha256: agreementDigest(assent.comment.body),
      },
    });
  }
  return { problems, required, evidence };
}

function jsonLines(text: string): Record<string, unknown>[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function accountOf(id: unknown, login: unknown): Account | null {
  return typeof id === "number" && typeof login === "string" ? { id, login } : null;
}

function text(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`missing ${key}: ${JSON.stringify(value)}`);
  return field;
}

/** Reads the JSON lines the workflow's `gh api .../commits` prints. */
export function parseCommits(input: string): PullRequestCommit[] {
  return jsonLines(input).map((value) => ({
    sha: text(value, "sha"),
    author: accountOf(value.id, value.login),
    committerLogin: typeof value.committer === "string" ? value.committer : null,
    verified: value.verified === true,
    message: typeof value.message === "string" ? value.message : "",
  }));
}

/** Reads the JSON lines the workflow's `gh api .../comments` prints. */
export function parseComments(input: string): PullRequestComment[] {
  return jsonLines(input).map((value) => {
    const author = accountOf(value.userId, value.login);
    if (author === null || typeof value.id !== "number") {
      throw new Error(`comment without an author or ID: ${JSON.stringify(value)}`);
    }
    return {
      id: value.id,
      author,
      body: typeof value.body === "string" ? value.body : "",
      createdAt: text(value, "createdAt"),
      updatedAt: text(value, "updatedAt"),
      url: text(value, "url"),
    };
  });
}

/** Reads the pull request's author and snapshot the workflow writes as one JSON object. */
export function parseSnapshot(input: string): { author: Account; snapshot: Snapshot } {
  const value = JSON.parse(input) as Record<string, unknown>;
  const author = accountOf(value.authorId, value.authorLogin);
  if (author === null || typeof value.reportedCommits !== "number") {
    throw new Error("the pull request snapshot has no author or commit count");
  }
  return {
    author,
    snapshot: {
      eventHeadSha: text(value, "eventHeadSha"),
      headShaBefore: text(value, "headShaBefore"),
      headShaAfter: text(value, "headShaAfter"),
      reportedCommits: value.reportedCommits,
    },
  };
}
