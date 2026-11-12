// The contributor license agreement check (docs/licensing.md, contributing.md). Pure logic, unit
// tested; scripts/cla-main.ts runs it in the `cla` workflow with data read from GitHub.
//
// This check matches declared contributor identities to signature records; it does not
// authenticate signatures or establish ownership. What it can verify is that each contributor's
// own authenticated GitHub account posted the statement on the pull request, which is the record
// of assent cla.md section 13 describes. Who owns the material is the maintainer's review before
// merge.
import { createHash } from "node:crypto";

export interface AgreementVersion {
  /** SHA-256 of cla.md's text with LF line endings, as published for this version. */
  sha256: string;
  /** Whether new submissions may adopt this version; earlier records keep their own version. */
  acceptsNewSubmissions: boolean;
}

export type AgreementVersions = Readonly<Record<string, AgreementVersion>>;

/**
 * Every published version that has a statement, keyed by number. A published entry never
 * changes: a new text is a new version with its own digest (docs/releasing.md, "Contributor
 * license agreement"). Version 1.0 is not listed: nobody but the maintainer contributed while it
 * was published, nobody signed it, and it was withdrawn before any signature.
 */
export const AGREEMENT_VERSIONS: AgreementVersions = {
  "2.0": {
    sha256: "bd9f987b3aed7bd8dd5dd9fd6bd280681d526b9ca884c1a2ac686058dac70106",
    acceptsNewSubmissions: true,
  },
};

/** The version new contributors sign; cla.md names it and hashes to its digest. */
export const CLA_VERSION = "2.0";

/** The file that indexes signature records, at the repository root. */
export const SIGNERS_FILE = "cla-signers.md";

/** The agreement's file, at the repository root. */
export const AGREEMENT_FILE = "cla.md";

/** Files only an exempt account's pull request may change: the agreement and its check. */
export const PROTECTED_FILES: readonly string[] = [
  AGREEMENT_FILE,
  "scripts/cla.ts",
  "scripts/cla-main.ts",
  ".github/workflows/cla.yml",
];

/** The most commits GitHub's pull request commits endpoint lists. */
export const MAX_COMMITS = 250;

/** The most files GitHub's pull request files endpoint lists. */
export const MAX_FILES = 3000;

/** The placeholder cla.md quotes the statement with, so the agreement never names its own digest. */
export const DIGEST_PLACEHOLDER = "<digest>";

/** How the second line of a statement names the head commit the person approves. */
export const HEAD_LINE_PREFIX = "Head commit: ";

/** The statement as cla.md quotes it, with the digest left as a placeholder. */
export function statementTemplate(version: string): string {
  return `I have read and agree to the Portifact Individual Contributor License Agreement, version ${version}, identified by the SHA-256 digest ${DIGEST_PLACEHOLDER} of cla.md. I intend this comment to be my electronic signature. I grant its licenses for my contributions in this pull request and for any earlier contributions I identify in it, and I understand that they permit proprietary licensing without payment except where mandatory law requires otherwise. I have identified in this pull request any material in it that I did not create.`;
}

/** The statement a contributor posts, alone, as a comment on each pull request: their assent. */
export function statement(
  version: string,
  versions: AgreementVersions = AGREEMENT_VERSIONS,
): string {
  const entry = versions[version];
  if (!entry) throw new Error(`unknown agreement version ${version}`);
  return statementTemplate(version).replace(DIGEST_PLACEHOLDER, entry.sha256);
}

export const STATEMENT = statement(CLA_VERSION);

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

/**
 * Commit emails of exempt accounts that are not GitHub noreply addresses, taken from the
 * repository's own history, by lowercase address. GitHub writes them in the Co-authored-by
 * trailer when a contributor applies one of the maintainer's review suggestions.
 */
export const EXEMPT_EMAILS: ReadonlyMap<string, number> = new Map([
  ["leynier41@gmail.com", 36774373],
  ["imgbothelp@gmail.com", 31301654],
]);

/** The account GitHub commits as when someone commits through its web interface or API. */
export const WEB_FLOW: Account = { id: 19864447, login: "web-flow" };

// GitHub logins are 1 to 39 characters of letters, digits and single hyphens, not starting or
// ending with one.
const LOGIN = "[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}";
// `- @login (id), Full Legal Name, YYYY-MM-DD, version X.Y, SHA-256 <64 hex>`.
const RECORD = new RegExp(
  `^- @(${LOGIN}) \\((\\d{1,12})\\), (.+), (\\d{4}-\\d{2}-\\d{2}), version (\\d+\\.\\d+), SHA-256 ([0-9a-f]{64})$`,
);
// GitHub's noreply address with the account ID, the one form that names an account for sure.
const NOREPLY = /^(\d{1,12})\+([A-Za-z0-9-]+(?:\[bot\])?)@users\.noreply\.github\.com$/i;
const TRAILER_KEY = /^co-authored-by:/i;
const TRAILER_VALUE = /^([^<>]*[^<>\s])\s*<([^<>\s]+)>$/;

/** A line of `cla-signers.md` naming who signed which version. */
export interface SignatureRecord {
  login: string;
  id: number;
  name: string;
  date: string;
  version: string;
  line: string;
}

export interface ParsedSigners {
  records: SignatureRecord[];
  /** Every list item, as written, so a malformed record is still a record. */
  items: string[];
  errors: string[];
}

function isDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Reads the signature records; any other list item is an error, other lines are prose. */
export function parseSigners(
  text: string,
  versions: AgreementVersions = AGREEMENT_VERSIONS,
): ParsedSigners {
  const records: SignatureRecord[] = [];
  const items: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trimEnd();
    if (!line.startsWith("- ")) return;
    items.push(line);
    const where = `${SIGNERS_FILE} line ${index + 1}`;
    const match = RECORD.exec(line);
    if (!match) {
      errors.push(
        `${where} is not "- @login (account ID), Full Legal Name, YYYY-MM-DD, version X.Y, SHA-256 <digest>"`,
      );
      return;
    }
    const [, login = "", id = "", name = "", date = "", version = "", digest = ""] = match;
    if (name.trim() === "") errors.push(`${where} has no name`);
    if (!isDate(date)) errors.push(`${where} has an invalid date "${date}"`);
    if (versions[version]?.sha256 !== digest) {
      errors.push(`${where} does not name a published agreement version with its digest`);
      return;
    }
    const key = `${Number(id)}@${version}`;
    if (seen.has(key))
      errors.push(`${where} records account ${id} a second time for version ${version}`);
    seen.add(key);
    records.push({ login, id: Number(id), name: name.trim(), date, version, line });
  });
  return { records, items, errors };
}

export interface PullRequestCommit {
  sha: string;
  /** The GitHub account the commit's author email belongs to, or null when none does. */
  author: Account | null;
  /** The GitHub account of the committer email, or null; web-flow for commits made on GitHub. */
  committer: Account | null;
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
  /** The pull request's head read before and after the commits, comments, files and contents. */
  headShaBefore: string;
  headShaAfter: string;
  /** The commit and changed file counts the pull request reports. */
  reportedCommits: number;
  reportedFiles: number;
}

export interface ClaInput {
  /** The pull request's author, as GitHub authenticated them. */
  author: Account;
  commits: readonly PullRequestCommit[];
  comments: readonly PullRequestComment[];
  /** The paths the pull request changes, with the old path of each rename. */
  changedFiles: readonly string[];
  snapshot: Snapshot;
  /** The signers file on the base branch, undefined when it does not exist there. */
  baseSigners: string | undefined;
  /** The signers file at the pull request's head, undefined when it does not exist there. */
  headSigners: string | undefined;
  /** cla.md on the base branch and at the pull request's head, undefined where it does not exist. */
  baseAgreement: string | undefined;
  headAgreement: string | undefined;
  /** The published versions; tests pass others. */
  versions?: AgreementVersions;
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

const isExempt = (account: Account | null) => account !== null && EXEMPT_ACCOUNTS.has(account.id);
const short = (sha: string) => sha.slice(0, 12);
const name = (account: Account) => `@${account.login} (${account.id})`;

/** The accounts a commit message's Co-authored-by trailers name, and the ones it cannot place. */
export function coAuthors(message: string): { accounts: Account[]; unresolved: string[] } {
  const accounts: Account[] = [];
  const unresolved: string[] = [];
  for (const raw of message.split(/\r?\n/)) {
    const line = raw.trim();
    if (!TRAILER_KEY.test(line)) continue;
    const value = line.slice("co-authored-by:".length).trim();
    const match = TRAILER_VALUE.exec(value);
    const email = match?.[2]?.toLowerCase() ?? "";
    const noreply = NOREPLY.exec(email);
    const exempt = EXEMPT_EMAILS.get(email);
    if (noreply) accounts.push({ id: Number(noreply[1]), login: noreply[2] ?? "" });
    else if (exempt !== undefined)
      accounts.push({ id: exempt, login: EXEMPT_ACCOUNTS.get(exempt) ?? "" });
    else unresolved.push(value);
  }
  return { accounts, unresolved };
}

function snapshotProblems(input: ClaInput): string[] {
  const { snapshot, commits, changedFiles } = input;
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
  if (!commits.some((commit) => commit.sha === snapshot.eventHeadSha)) {
    problems.push("the commit list read does not contain the pull request's head");
  }
  const files = new Set(changedFiles).size;
  if (snapshot.reportedFiles > MAX_FILES) {
    problems.push(
      `the pull request changes ${snapshot.reportedFiles} files, more than the ${MAX_FILES} the check can read: split it`,
    );
  } else if (files < snapshot.reportedFiles) {
    problems.push(
      `the check read ${files} changed files of the ${snapshot.reportedFiles} the pull request reports, so its view is incomplete`,
    );
  }
  return problems;
}

type Assent =
  | { ok: true; comment: PullRequestComment; version: string }
  | { ok: false; reason: string };

/**
 * The account's assent on this pull request: an unedited comment whose whole body is the
 * statement of a version accepting new submissions, followed, for anyone but the pull request's
 * author, by a line naming the current head commit.
 */
function assentOf(account: Account, input: ClaInput, versions: AgreementVersions): Assent {
  const head = input.snapshot.eventHeadSha;
  const namesHead = account.id !== input.author.id;
  const accepted = Object.entries(versions)
    .filter(([, entry]) => entry.acceptsNewSubmissions)
    .map(([version]) => ({ version, text: statement(version, versions) }));
  let reason = `${name(account)} has not posted the statement as a comment on this pull request from their own account, as contributing.md explains`;
  const whole = `${name(account)}'s statement must be the whole comment, with nothing before or after it${namesHead ? " but the head commit line" : ""}: post it again as a new comment`;
  let found: Assent | undefined;
  for (const comment of input.comments) {
    if (comment.author.id !== account.id) continue;
    const body = comment.body.replace(/\r\n/g, "\n").trim();
    for (const { version, text } of accepted) {
      if (!body.startsWith(text)) {
        if (body.includes(text)) reason = whole;
        continue;
      }
      const rest = body.slice(text.length);
      if (comment.updatedAt !== comment.createdAt) {
        reason = `${name(account)}'s statement is in a comment that was edited, which does not count: post it again as a new comment`;
      } else if (!namesHead) {
        if (rest === "") found = { ok: true, comment, version };
        else reason = whole;
      } else if (rest === `\n${HEAD_LINE_PREFIX}${head}`) {
        found = { ok: true, comment, version };
      } else if (rest.startsWith(`\n${HEAD_LINE_PREFIX}`) && !rest.slice(1).includes("\n")) {
        reason = `${name(account)}'s statement names another commit than the pull request's head ${head}: post it again naming the current head`;
      } else if (rest === "") {
        reason = `${name(account)} did not open this pull request, so their statement must be followed by the line "${HEAD_LINE_PREFIX}${head}"`;
      } else {
        reason = whole;
      }
    }
  }
  return found ?? { ok: false, reason };
}

/** For an outside pull request: the head file must be the base file plus records at its end. */
function appendOnlyProblems(base: string, head: string): string[] {
  const lines = (text: string) => {
    const all = text.split("\n");
    if (all.at(-1) === "") all.pop();
    return all;
  };
  const before = lines(base);
  const after = lines(head);
  const changed = before.findIndex((line, index) => after[index] !== line);
  if (changed !== -1) {
    return [
      `${SIGNERS_FILE} line ${changed + 1} was changed or removed: a pull request may only append records at the end of the file`,
    ];
  }
  const added = after.slice(before.length).findIndex((line) => !line.startsWith("- "));
  if (added !== -1) {
    return [
      `${SIGNERS_FILE} line ${before.length + added + 1} is not a record: a pull request may only append records ("- @login ...") at the end of the file`,
    ];
  }
  return [];
}

/**
 * A pull request passes when it was read as one complete head; every contributor (its author,
 * each commit author and each co-author) has a signature record and posted the statement from
 * their own account on it; and the agreement, its check and the signers file are intact: an
 * outside pull request changes none of the protected files and only appends records to the
 * signers file, and any pull request keeps every record and adds only records whose account
 * assented on it. Exempt accounts do not sign but get every integrity check.
 */
export function checkCla(input: ClaInput): ClaResult {
  const versions = input.versions ?? AGREEMENT_VERSIONS;
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
      const byGitHub =
        commit.committer?.id === WEB_FLOW.id && commit.committer.login === WEB_FLOW.login;
      if (
        outsider &&
        isExempt(commit.author) &&
        !(commit.verified && (isExempt(commit.committer) || byGitHub))
      ) {
        problems.push(
          `commit ${short(commit.sha)} names the exempt account ${name(commit.author)} as its author in a pull request opened by ${name(input.author)}, but GitHub does not report it as verified and committed by an exempt account or through GitHub: it may be someone else's work (maintainer: sign your commits)`,
        );
      }
    }
    const trailers = coAuthors(commit.message);
    for (const account of trailers.accounts) add(account);
    for (const who of trailers.unresolved) {
      problems.push(
        `commit ${short(commit.sha)} has a Co-authored-by trailer "${who.slice(0, 80)}" that is not one person with a GitHub noreply address with an account ID (ID+login@users.noreply.github.com), so the co-author cannot be identified`,
      );
    }
  }
  const required = [...contributors.values()].filter((account) => !isExempt(account));

  if (input.headAgreement === undefined) {
    problems.push(`${AGREEMENT_FILE} is missing at the head of the pull request`);
  }
  const agreementChanged =
    input.headAgreement === undefined ||
    input.baseAgreement === undefined ||
    agreementDigest(input.headAgreement) !== agreementDigest(input.baseAgreement);
  if (outsider) {
    if (agreementChanged && input.headAgreement !== undefined) {
      problems.push(
        `the pull request changes ${AGREEMENT_FILE}: only the maintainer publishes agreement changes (if your branch is behind develop, update it)`,
      );
    }
    for (const path of PROTECTED_FILES) {
      if (path !== AGREEMENT_FILE && input.changedFiles.includes(path)) {
        problems.push(
          `the pull request changes ${path}: only the maintainer changes the agreement's check`,
        );
      }
    }
  }

  const base = parseSigners(input.baseSigners ?? "", versions);
  const head =
    input.headSigners === undefined ? undefined : parseSigners(input.headSigners, versions);
  if (head === undefined) {
    if (input.baseSigners !== undefined || required.length > 0) {
      problems.push(`${SIGNERS_FILE} is missing at the head of the pull request`);
    }
  } else {
    problems.push(...head.errors);
    if (outsider)
      problems.push(...appendOnlyProblems(input.baseSigners ?? "", input.headSigners ?? ""));
    const headItems = new Set(head.items);
    for (const item of base.items) {
      if (!headItems.has(item)) {
        problems.push(
          `the record "${item.slice(0, 60)}" on the base branch was removed or changed`,
        );
      }
    }
    const baseItems = new Set(base.items);
    for (const record of head.records) {
      if (baseItems.has(record.line)) continue;
      const account = { id: record.id, login: record.login };
      if (agreementChanged) {
        problems.push(
          `the pull request adds a record for ${name(account)} and also changes ${AGREEMENT_FILE}: publish an agreement change on its own, then sign the published text`,
        );
      }
      const assent = assentOf(account, input, versions);
      if (!assent.ok || assent.comment.author.login.toLowerCase() !== record.login.toLowerCase()) {
        problems.push(
          `the pull request adds a record for ${name(account)} that the account did not confirm with its own statement on the pull request: each contributor signs for themself`,
        );
      } else if (!versions[record.version]?.acceptsNewSubmissions) {
        problems.push(
          `the pull request adds a record of version ${record.version}, which no longer accepts new signatures`,
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
    const recorded = head?.records.some(
      (record) => record.id === account.id && versions[record.version]?.acceptsNewSubmissions,
    );
    if (!recorded) {
      problems.push(
        `${name(account)} has no signature record of a version accepting new submissions in ${SIGNERS_FILE}: add yours as contributing.md explains`,
      );
    }
    const assent = assentOf(account, input, versions);
    if (!assent.ok) {
      problems.push(assent.reason);
      continue;
    }
    evidence.contributors.push({
      id: account.id,
      login: assent.comment.author.login,
      version: assent.version,
      sha256: versions[assent.version]?.sha256 ?? "",
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

function count(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number") throw new Error(`missing ${key}`);
  return field;
}

/** Reads the JSON lines the workflow's `gh api .../commits` prints. */
export function parseCommits(input: string): PullRequestCommit[] {
  return jsonLines(input).map((value) => ({
    sha: text(value, "sha"),
    author: accountOf(value.id, value.login),
    committer: accountOf(value.committerId, value.committer),
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

/** Reads the JSON lines the workflow's `gh api .../files` prints: each path and a rename's old one. */
export function parseFiles(input: string): string[] {
  return jsonLines(input).flatMap((value) => [
    text(value, "filename"),
    ...(typeof value.previous === "string" ? [value.previous] : []),
  ]);
}

/** Reads the pull request's author and snapshot the workflow writes as one JSON object. */
export function parseSnapshot(input: string): { author: Account; snapshot: Snapshot } {
  const value = JSON.parse(input) as Record<string, unknown>;
  const author = accountOf(value.authorId, value.authorLogin);
  if (author === null) throw new Error("the pull request snapshot has no author");
  return {
    author,
    snapshot: {
      eventHeadSha: text(value, "eventHeadSha"),
      headShaBefore: text(value, "headShaBefore"),
      headShaAfter: text(value, "headShaAfter"),
      reportedCommits: count(value, "reportedCommits"),
      reportedFiles: count(value, "reportedFiles"),
    },
  };
}
