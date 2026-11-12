// Operator commands for abuse handling (plan section 13): list and resolve reports, suspend and
// reinstate artifacts and accounts; for backups (plan section 10): review the storage
// reconciliation's findings, and export and re-apply tombstones around a D1 Time Travel restore;
// for the budget (plan section 12): show the state and the alerts, and override the automatic
// protection; for email delivery (plan section 17): list and lift suppressed addresses; and for
// paid plans (premium plan section 3, F1): show, grant, change and remove an owner's plan, the
// only way a plan is ever granted; for workspaces (premium plan T1): create one with its first
// admin and plan, show, list and delete them, the only way a workspace is created or deleted
// while there is no billing; and for custom domains (decision 0006): show one, detach one
// (abuse on a customer's domain) and reconcile with Cloudflare after a restore. They run only from `scripts/operator.ts` on the operator's machine, with the deploy
// credentials, against the D1 binding; no web route reaches them. Each command calls the same
// services the tests cover, and prints plain text without secrets.
import {
  AbuseReason,
  BACKGROUND,
  DEFAULT_REGION,
  DecisionSource,
  isWorkspaceId,
  LegalHoldLine,
  OpaqueToken,
  OwnerPlanExport,
  PLAN_NAMES,
  PlanName,
  REGIONS,
  ScimTokenId,
  ServiceTokenId,
  StatementText,
  TombstoneMarker,
  WorkspacePolicyExport,
} from "@portifact/contracts";
import {
  type Db,
  type GlobalDb,
  isRegion,
  type Region,
  type RegionalDb,
  type Regions,
  regionsFromEnv,
  sameDatabase,
  schema,
  withRequestContext,
} from "@portifact/db";
import {
  BUDGET_LEVELS,
  type BudgetLevel,
  budgetCycle,
  decisionSource,
  emailHint,
  PROTECTION_STEPS,
  shareLinkStatus,
} from "@portifact/domain";
import {
  accountSuspension,
  applyIntegrationTombstones,
  applyLegalHolds,
  applyOwnerPlans,
  applyTombstones,
  applyWorkspacePolicies,
  artifactHandles,
  type BudgetState,
  blockHostname,
  checkGrant,
  clearBudgetOverride,
  clearRequestPolicies,
  createWorkspace,
  type DomainDeps,
  deleteWorkspace,
  detachDomain,
  domainDbsOf,
  exportLegalHolds,
  exportOwnerPlans,
  exportTombstones,
  exportWorkspacePolicies,
  findScimToken,
  findServiceToken,
  getBudgetState,
  getOwnerPlan,
  getWorkspaceDetail,
  hashSecret,
  liftEmailSuppression,
  listAbuseReports,
  listAllWorkspaces,
  listBlockedHostnames,
  listBudgetAlerts,
  listDecisions,
  listEmailSuppressions,
  listLegalHolds,
  listStorageFindings,
  type OwnerPlanState,
  operatorRevokeScimToken,
  operatorRevokeServiceToken,
  ownerRegion,
  placeLegalHold,
  rebuildArtifactDirectory,
  reconcileCustomDomains,
  reinstateAccount,
  reinstateArtifact,
  reinstateBrand,
  releaseGuardForPlan,
  releaseLegalHold,
  removeOwnerPlan,
  resolveAbuseReport,
  setBudgetOverride,
  setOwnerPlan,
  showBrand,
  suspendAccount,
  suspendArtifact,
  suspendBrand,
  unblockHostname,
  type WorkspaceDetail,
} from "@portifact/services";
import { eq, sql } from "drizzle-orm";

export const OPERATOR_USAGE = `Usage: bun run --cwd apps/jobs operator [--local | --config <file>] <command>

  --local          the local D1 state of wrangler dev in apps/app
  --config <file>  a Wrangler configuration whose remote DB binding replaces production
                   (a scratch database for a backup drill); relative to apps/jobs

Commands:
  reports [--status open|actioned|dismissed|all] [--limit N]
  report <report-id>           (one report in full: the address, the notice's parts, the outcome email)
  resolve-report <report-id> actioned|dismissed [--withhold-notice]
  show-artifact <artifact-id>
  find-share-link              (reads the reported link or token from standard input)
  find-service-token           (reads a leaked service token from standard input)
  revoke-service-token <service-token-id>
  find-scim-token              (reads a leaked SCIM token from standard input)
  revoke-scim-token <scim-token-id>
  suspend-artifact <artifact-id> --reason <reason> --facts <text> --ground <text> [--source notice|review] [--report <report-id>] [--note <text>] [--withhold-notice]
  reinstate-artifact <artifact-id> --facts <text> [--source notice|review] [--withhold-notice]
  suspend-account <user-id|email> --reason <reason> --facts <text> --ground <text> [--source notice|review] [--report <report-id>] [--note <text>] [--withhold-notice]
  reinstate-account <user-id|email> --facts <text> [--source notice|review] [--withhold-notice]
  brand <owner: user-id|email|workspace-id>
  suspend-brand <owner> --reason <reason> --facts <text> --ground <text> [--source notice|review] [--report <report-id>] [--withhold-notice]
  reinstate-brand <owner> --facts <text> [--source notice|review] [--withhold-notice]
  decisions artifact|account|brand <id|email>   (statements of reasons and who they were sent to)
  hold-artifact <artifact-id> --ground <text> [--until <date>]   (a suspended artifact only)
  release-hold <artifact-id>
  holds [--all] [--limit N]
  storage-report [--limit N]
  export-tombstones --out <file> [--region all|<region>]   (with more than one region: all, or a region with its own database)
  apply-tombstones [--file <file>] [--region all|<region>]
  budget
  budget-alerts [--limit N]
  budget-override <level> --note <text> [--steps 1-${PROTECTION_STEPS.length}] [--hours N]
  budget-override clear
  email-suppressions [--limit N]
  lift-email-suppression <email>
  show-domain <hostname>
  detach-domain <hostname>
  block-domain <name> --note <text>   (also every name under it; detaches the domains it covers)
  unblock-domain <name>
  blocked-domains
  reconcile-domains            (needs CF_CONTENT_ZONE_ID and CF_HOSTNAMES_TOKEN in the environment)
  plan <owner>
  set-plan <owner> <plan> [--seats N] [--until <ISO date>] [--note <text>]
           [--overrides <json>] [--no-grace]
  remove-plan <owner> [--no-grace]
                               (a lower plan or a removal holds what the old plan kept for
                               60 days; --no-grace ends every hold at once, for abuse)
  export-plans --out <file>
  apply-plans --file <file>
  export-policies --out <file>
  apply-policies --file <file> [--allow-lifting]
                               (--allow-lifting also lifts restrictions the file does not have)
  clear-request-policies <slug|workspace-id> --confirm <slug>
                               (lifts the request policies only: network allowlists, maximum
                               session age, allowed clients, SSO required; for admins locked out)
  workspaces [--sso-required]  (--sso-required lists only those that require single sign-on)
  workspace <slug|workspace-id>
  workspace-create <slug> --name <name> --admin <user-id|email>
                   [--plan team|enterprise --seats N [--until <ISO date>] [--note <text>]]
  workspace-delete <slug|workspace-id> --confirm <slug>

Owners: <user-id|email> for a personal space, workspace:<slug> or a workspace ID for a workspace.

Reasons: ${AbuseReason.options.join(", ")}
Plans: ${PLAN_NAMES.join(", ")} (--overrides: {"limits":{...},"features":{...}}, totals after seats)
Budget levels: ${BUDGET_LEVELS.join(", ")} (--steps applies to protect100)`;

/** Files the backup commands read and write; the script passes the real file system. */
export interface OperatorFiles {
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
}

const noFiles: OperatorFiles = {
  read: async () => Promise.reject(new Error("No file access.")),
  write: async () => Promise.reject(new Error("No file access.")),
};

/** The token of a reported share link: the fragment of `…/s#<token>`, or the bare token. */
export function shareLinkToken(text: string): string | null {
  const trimmed = text.trim();
  const candidate = trimmed.includes("#") ? trimmed.slice(trimmed.lastIndexOf("#") + 1) : trimmed;
  const parsed = OpaqueToken.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Parses JSON lines against a schema; any bad line refuses the whole file. */
function parseJsonLines<T>(
  text: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): { ok: true; items: T[] } | { ok: false; line: number } {
  const items: T[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return { ok: false, line: index + 1 };
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) return { ok: false, line: index + 1 };
    items.push(parsed.data);
  }
  return { ok: true, items };
}

/**
 * Parses the JSON lines `export-tombstones` writes: tombstone markers and legal holds. Any bad
 * line refuses the whole file; a file from before holds were exported has none.
 */
export function parseTombstones(
  text: string,
): { ok: true; markers: TombstoneMarker[]; holds: LegalHoldLine[] } | { ok: false; line: number } {
  const RestoreLine = TombstoneMarker.or(LegalHoldLine);
  const parsed = parseJsonLines(text, RestoreLine);
  if (!parsed.ok) return parsed;
  const markers: TombstoneMarker[] = [];
  const holds: LegalHoldLine[] = [];
  for (const item of parsed.items) {
    if ("legalHold" in item) holds.push(item);
    else markers.push(item);
  }
  return { ok: true, markers, holds };
}

/** Which database the script binds: production, the local dev state or another configuration. */
export type OperatorTarget =
  | { ok: true; target: "production" | "local"; config: null; args: string[] }
  | { ok: true; target: "config"; config: string; args: string[] }
  | { ok: false; message: string };

/** Takes the script's own `--local` and `--config <file>` flags out of the command arguments. */
export function operatorTarget(argv: readonly string[]): OperatorTarget {
  const args: string[] = [];
  let local = false;
  let config: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--local") {
      local = true;
    } else if (arg === "--config") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, message: "--config needs a Wrangler configuration file." };
      }
      config = value;
      i += 1;
    } else {
      args.push(arg);
    }
  }
  if (local && config !== null) {
    return { ok: false, message: "Use --local or --config, not both." };
  }
  if (config !== null) return { ok: true, target: "config", config, args };
  return { ok: true, target: local ? "local" : "production", config: null, args };
}

export interface OperatorResult {
  exitCode: number;
  output: string;
}

const usage = (message: string): OperatorResult => ({
  exitCode: 2,
  output: `${message}\n\n${OPERATOR_USAGE}`,
});

/** Splits `--name value` options from positional arguments. */
export function parseArgs(argv: readonly string[]): {
  positional: string[];
  options: Map<string, string>;
} {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        options.set(arg.slice(2), "");
      } else {
        options.set(arg.slice(2), value);
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

async function userIdFor(db: GlobalDb, value: string): Promise<string | undefined> {
  if (!value.includes("@")) return value;
  const [row] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${value.toLowerCase()}`)
    .limit(1);
  return row?.id;
}

/** The owner a plan command names: an account by ID or email, or a workspace by slug or ID. */
async function ownerIdFor(db: GlobalDb, value: string): Promise<string | undefined> {
  if (value.startsWith("workspace:") || isWorkspaceId(value)) {
    const key = value.startsWith("workspace:") ? value.slice("workspace:".length) : value;
    const [row] = await db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(isWorkspaceId(key) ? eq(schema.workspaces.id, key) : eq(schema.workspaces.slug, key))
      .limit(1);
    return row?.id;
  }
  return userIdFor(db, value);
}

function oneLine(text: string | null): string {
  return (text ?? "").replace(/\s+/g, " ").slice(0, 200);
}

const iso = (ms: number) => new Date(ms).toISOString();
const usd = (value: number) => `US$${value.toFixed(2)}`;
const list = (actions: readonly string[]) => (actions.length > 0 ? actions.join(", ") : "none");

function budgetLines(state: BudgetState): string[] {
  const lines = [
    `cycle       ${iso(state.cycleStart)}`,
    `measured    ${state.measuredAt > 0 ? iso(state.measuredAt) : "never"} (analytics ${state.analytics})`,
    `projected   ${usd(state.projectedUsd)}`,
    `automatic   ${state.automatic.level}: ${list(state.automatic.actions)} (since ${iso(state.levelChangedAt)})`,
  ];
  if (state.override) {
    const o = state.override;
    const until = o.until === null ? "until cleared" : `until ${iso(o.until)}`;
    const steps = o.level === "protect100" ? ` (${o.steps} step(s))` : "";
    const note = o.note ? `: ${oneLine(o.note)}` : "";
    lines.push(`override    ${o.level}${steps}, ${until}, set ${iso(o.setAt)}${note}`);
  }
  const overridden = state.effective.overridden ? " (override)" : "";
  lines.push(`effective   ${state.effective.level}: ${list(state.effective.actions)}${overridden}`);
  if (state.metrics) {
    for (const [key, value] of Object.entries(state.metrics)) {
      lines.push(`  ${key.padEnd(15)}${value === null ? "unmeasured" : value}`);
    }
  }
  return lines;
}

async function budgetOverride(
  global: GlobalDb,
  args: string[],
  options: Map<string, string>,
  now: number,
): Promise<OperatorResult> {
  const [level] = args;
  if (level === "clear") {
    const state = await clearBudgetOverride(global, now);
    if (!state) return { exitCode: 0, output: "No budget state." };
    return { exitCode: 0, output: ["Override cleared.", ...budgetLines(state)].join("\n") };
  }
  if (!BUDGET_LEVELS.includes(level as BudgetLevel)) {
    return usage("budget-override needs a budget level or clear.");
  }
  const note = options.get("note")?.trim();
  if (!note) return usage("budget-override needs --note with the reason.");
  const steps = Number(options.get("steps") ?? 1);
  if (!Number.isInteger(steps) || steps < 1 || steps > PROTECTION_STEPS.length) {
    return usage(`--steps must be 1 to ${PROTECTION_STEPS.length}.`);
  }
  const hours = options.has("hours") ? Number(options.get("hours")) : null;
  if (hours !== null && (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 31)) {
    return usage("--hours must be more than 0 and at most 744.");
  }
  const state = await setBudgetOverride(global, {
    level: level as BudgetLevel,
    steps,
    until: hours === null ? null : now + Math.round(hours * 3_600_000),
    note,
    now,
  });
  return { exitCode: 0, output: ["Override set.", ...budgetLines(state)].join("\n") };
}

function alertLine(a: {
  createdAt: number;
  kind: string;
  projectedUsd: number;
  notifiedAt: number | null;
}) {
  return `${iso(a.createdAt)}  ${a.kind}  ${usd(a.projectedUsd)}  ${a.notifiedAt ? "emailed" : "not emailed"}`;
}

const count = (value: number) => value.toLocaleString("en-US");

function meter(label: string, used: number, limit: number, column: number | undefined): string {
  const stored = column === undefined ? "no row yet, defaults to free" : `column ${count(column)}`;
  return `${label.padEnd(12)}${count(used)} of ${count(limit)} (${stored})`;
}

function planLines(ownerId: string, state: OwnerPlanState): string[] {
  const { row, entitlements: e, account, annotations } = state;
  const until = (value: number | null) => (value === null ? "no end" : `until ${iso(value)}`);
  const lines = [`owner       ${ownerId}`];
  if (row) {
    const overrides = row.overrides === null ? "" : `, overrides ${JSON.stringify(row.overrides)}`;
    const note = row.note ? `: ${oneLine(row.note)}` : "";
    lines.push(
      `row         ${row.plan}, ${row.seats} seat(s), ${until(row.validUntil)}${overrides}`,
      `granted     by ${oneLine(row.grantedBy)}, ${iso(row.createdAt)}, updated ${iso(row.updatedAt)}${note}`,
    );
  } else {
    lines.push("row         none (free)");
  }
  lines.push(
    `effective   ${e.plan}, ${e.seats} seat(s), ${until(e.validUntil)}`,
    `features    ${list(e.features)}`,
    meter("active", account?.activeArtifacts ?? 0, e.limits.activeArtifacts, account?.activeLimit),
    meter(
      "storage",
      (account?.storedBytes ?? 0) + (account?.reservedBytes ?? 0),
      e.limits.accountBytes,
      account?.bytesLimit,
    ),
    meter(
      "comments",
      annotations?.messages ?? 0,
      e.limits.annotationMessages,
      annotations?.messagesLimit,
    ),
    meter("comment B", annotations?.bytes ?? 0, e.limits.annotationBytes, annotations?.bytesLimit),
    `per version ${count(e.limits.artifactBytes)} bytes; traffic ${count(e.limits.requestsPerMonth)} requests and ${count(e.limits.bytesPerMonth)} bytes a month`,
    `audit log   kept ${count(e.limits.auditRetentionDays)} days`,
  );
  if (e.grace) {
    const g = e.grace;
    if (g.unreadable) {
      lines.push(
        "grace       UNREADABLE: held at the most every retention may be until a set-plan or remove-plan stores a readable one",
      );
    }
    lines.push(
      `grace       until ${iso(g.until)}, holding ${g.plan}: ${count(g.limits.retainedPreviousVersions)} previous version(s) for ${count(g.limits.previousVersionRetentionDays)} days, access log ${count(g.limits.accessLogRetentionDays)} days, audit log ${count(g.limits.auditRetentionDays)} days, archives ${count(g.limits.archiveMonths)} months`,
      `held reads  ${list(g.features)}`,
      ...g.slots.map(
        (slot) =>
          `  ${slot.reason.padEnd(8)} ${slot.plan.padEnd(10)} from ${iso(slot.from)} until ${iso(slot.until)}${slot.folded ? ` (folded: ${slot.folded} holds)` : ""}`,
      ),
    );
  } else {
    lines.push("grace       none");
  }
  return lines;
}

/** `--until`: an ISO date or date and time, read as UTC. */
function parseUntil(value: string | undefined): number | null | "invalid" {
  if (value === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(value)) return "invalid";
  const ms = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isFinite(ms) ? ms : "invalid";
}

/** The database of the region an owner's data lives in (its workspace's, or the default one). */
async function ownerDb(regions: Regions, ownerId: string): Promise<RegionalDb> {
  return regions.get(await ownerRegion(regions.global, ownerId)).db;
}

/** The owner's region's bucket: a plan change that lapses comment retention deletes its record. */
async function ownerBucket(regions: Regions, ownerId: string): Promise<R2Bucket | undefined> {
  return regions.get(await ownerRegion(regions.global, ownerId)).bucket;
}

/**
 * When the guard record was deleted but the plan change then failed: the workspace's comment
 * retention no longer agrees with R2, so it deletes nothing until an admin saves it again.
 */
function guardReleasedLines(ownerId: string, guard: "none" | "released" | "kept"): string[] {
  return guard === "released"
    ? [
        `The comment retention guard record of ${ownerId} was deleted before the plan change failed: its comment retention is now paused (it deletes nothing) until an admin saves it again on the Policies page.`,
      ]
    : [];
}

/**
 * What the operator is told when a plan change takes `policies` from a workspace with comment
 * retention and its guard record could not be deleted first (decision 0023, "Restores").
 */
function guardKeptLines(ownerId: string, bound: boolean): string[] {
  return bound
    ? [
        `Warning: the comment retention guard record of ${ownerId} could not be deleted (R2 refused). A restore of the global database to before this change would let its restored comment retention delete again. Delete it now: npx wrangler r2 object delete <bucket>/system/comment-retention/${ownerId} --remote (the bucket of the workspace's region), then check that it is gone.`,
      ]
    : [
        `Warning: no bucket is bound here (--local or --config), so the comment retention guard record of ${ownerId} was not deleted; the guard is not maintained in this database. Against production, run the command with operator.wrangler.jsonc, or delete system/comment-retention/${ownerId} from the workspace region's bucket.`,
      ];
}

async function setPlan(
  regions: Regions,
  args: string[],
  options: Map<string, string>,
  now: number,
): Promise<OperatorResult> {
  const [who, plan] = args;
  const name = PlanName.safeParse(plan);
  if (!who || !name.success) return usage("set-plan needs an owner and a plan.");
  const seats = options.has("seats") ? Number(options.get("seats")) : 1;
  const validUntil = parseUntil(options.get("until"));
  if (validUntil === "invalid") return usage("--until must be an ISO date, like 2027-01-31.");
  let overrides: unknown = null;
  if (options.has("overrides")) {
    try {
      overrides = JSON.parse(options.get("overrides") ?? "");
    } catch {
      return usage("--overrides must be JSON.");
    }
  }
  const userId = await ownerIdFor(regions.global, who);
  if (!userId) return { exitCode: 1, output: "Account or workspace not found." };
  // A plan without `policies` lapses comment retention: its guard record goes first.
  const bucket = await ownerBucket(regions, userId);
  const guard = await releaseGuardForPlan(
    regions.global,
    bucket,
    userId,
    { plan: name.data, seats, validUntil, overrides },
    now,
  );
  const result = await setOwnerPlan(await ownerDb(regions, userId), {
    ownerId: userId,
    plan: name.data,
    seats,
    validUntil,
    overrides,
    grantedBy: "operator",
    note: options.get("note")?.trim() || null,
    now,
    noGrace: options.has("no-grace"),
  });
  if (!result.ok) {
    return {
      exitCode: 1,
      output: [result.message, ...guardReleasedLines(userId, guard)].join("\n"),
    };
  }
  if (guard === "kept") {
    return {
      exitCode: 1,
      output: [
        `Granted ${name.data} to ${userId}.`,
        ...guardKeptLines(userId, bucket !== undefined),
      ].join("\n"),
    };
  }
  return {
    exitCode: 0,
    output: [`Set the plan of ${userId} to ${name.data}.`, ...planLines(userId, result.value)].join(
      "\n",
    ),
  };
}

function workspaceLines(detail: WorkspaceDetail, plan: OwnerPlanState): string {
  return [
    `workspace   ${detail.slug} (${detail.id})`,
    `name        ${oneLine(detail.name)}`,
    `region      ${detail.region}`,
    `created     ${iso(detail.createdAt)} by ${detail.createdBy}`,
    `seats       ${detail.seats.used} of ${detail.seats.limit} (members and pending invitations)`,
    `artifacts   ${detail.artifacts}`,
    "members",
    ...detail.members.map(
      (member) => `  ${member.role.padEnd(7)} ${member.userId}  ${emailHint(member.email)}`,
    ),
    "invitations",
    ...(detail.invitations.length === 0
      ? ["  none"]
      : detail.invitations.map(
          (invitation) =>
            `  ${invitation.role.padEnd(7)} ${invitation.id}  ${emailHint(invitation.email)}  until ${iso(invitation.expiresAt)}`,
        )),
    ...planLines(detail.id, plan),
  ].join("\n");
}

async function createWorkspaceCommand(
  regions: Regions,
  args: string[],
  options: Map<string, string>,
  now: number,
): Promise<OperatorResult> {
  const global = regions.global;
  // The region is chosen once, here, and never changes (decision 0005): only a region this
  // configuration binds, so the workspace's data has somewhere to go.
  const region = options.get("region") ?? DEFAULT_REGION;
  if (!isRegion(region)) return usage(`--region must be one of: ${REGIONS.join(", ")}.`);
  if (!regions.all().some((handles) => handles.region === region)) {
    return usage(`Region ${region} is not bound in this configuration.`);
  }
  const db = regions.get(region).db;
  const [slug] = args;
  const name = options.get("name")?.trim();
  const admin = options.get("admin");
  if (!slug || !name || !admin) {
    return usage("workspace-create needs a slug, --name and --admin.");
  }
  const planOption = options.get("plan");
  const plan = planOption === undefined ? null : PlanName.safeParse(planOption);
  if (plan && (!plan.success || (plan.data !== "team" && plan.data !== "enterprise"))) {
    return usage("--plan must be team or enterprise.");
  }
  if (!plan && (options.has("seats") || options.has("until"))) {
    return usage("--seats and --until go with --plan.");
  }
  const seats = options.has("seats") ? Number(options.get("seats")) : 1;
  const validUntil = parseUntil(options.get("until"));
  if (validUntil === "invalid") return usage("--until must be an ISO date, like 2027-01-31.");
  const note = options.get("note")?.trim() || null;
  const userId = await userIdFor(global, admin);
  if (!userId) return { exitCode: 1, output: "Account not found." };
  // The plan is checked before the workspace exists, so a bad value creates nothing.
  if (plan?.success) {
    const checked = checkGrant({
      ownerId: "ws_check",
      plan: plan.data,
      seats,
      validUntil,
      overrides: null,
      grantedBy: "operator",
      note,
      now,
    });
    if (!checked.ok) return { exitCode: 1, output: checked.message };
  }
  const created = await createWorkspace(regions.global, {
    slug,
    name,
    adminUserId: userId,
    now,
    region,
  });
  if (!created.ok) return { exitCode: 1, output: created.message };
  const lines = [
    `Created workspace ${created.value.slug} (${created.value.id}) with ${userId} as its admin.`,
  ];
  if (plan?.success) {
    const granted = await setOwnerPlan(db, {
      ownerId: created.value.id,
      plan: plan.data,
      seats,
      validUntil,
      overrides: null,
      grantedBy: "operator",
      note,
      now,
    });
    if (!granted.ok) {
      return {
        exitCode: 1,
        output: [
          ...lines,
          `The plan was not granted: ${granted.message} Run set-plan workspace:${created.value.slug}.`,
        ].join("\n"),
      };
    }
    lines.push(`Granted ${plan.data} with ${seats} seat(s).`);
  } else {
    lines.push("No plan: it is on free, with one seat, until set-plan grants one.");
  }
  const detail = await getWorkspaceDetail(regions, created.value.id, now);
  if (detail) lines.push(workspaceLines(detail, await getOwnerPlan(db, detail.id, now)));
  return { exitCode: 0, output: lines.join("\n") };
}

const RESTORE_COMMANDS = new Set(["export-tombstones", "apply-tombstones"]);
const RESTORE_REGION_USAGE =
  "With more than one region, export-tombstones and apply-tombstones need --region all, or --region <region> for a region whose own database was restored alone (never the default region, whose database is the global one).";

/**
 * The regions a restore command covers (decision 0005): the one `--region` names, or every region
 * with `--region all`. With one region the flag may be left out; with more it must be given, so
 * nobody re-applies tombstones to a region by accident. A region whose database is the global
 * database (the default region's) can only be restored with everything that database holds:
 * the global rows and the directory of every region, so it needs `--region all` when another
 * region has its own database. A string is the refusal to print.
 */
function restoreRegions(regions: Regions, option: string | undefined): Regions | string {
  if (option === "all" || (option === undefined && regions.all().length === 1)) return regions;
  if (option === undefined) return RESTORE_REGION_USAGE;
  // A named region was checked against the configuration before the command ran.
  const handles = regions.get(option as Parameters<Regions["get"]>[0]);
  if (sameDatabase(handles.db) && regions.all().some((other) => !sameDatabase(other.db))) {
    return `Region ${option}'s database is the global database: restoring it rewinds the global rows and the artifact directory of every region, so use --region all.`;
  }
  return { global: regions.global, get: () => handles, all: () => [handles] };
}

/** Runs one operator command against the database. */
/** Whether the operator was given every region or one control database (tests, a drill). */
function isRegions(target: Db | Regions): target is Regions {
  return !("$client" in target);
}

/**
 * The regions of a single control database handed to the operator: a region's own handle (a
 * test's) as the default region, or a bare database (a drill's scratch copy) wrapped as one.
 */
function singleDatabase(target: Db | RegionalDb): Regions {
  if (!("global" in target)) {
    return regionsFromEnv(withRequestContext({ DB: target.$client }, BACKGROUND));
  }
  const handles = { region: DEFAULT_REGION, db: target, accessDb: undefined, bucket: undefined };
  return { global: target.global, get: () => handles, all: () => [handles] };
}

/**
 * Runs one operator command. `target` is every region the operator's configuration binds
 * (decision 0005) or one control database, which is then the default region. `--region <name>`
 * picks the region a command that reads or writes regional data acts on (the default region
 * without it); commands that name an artifact find its region in the directory, and the scans
 * (`storage-report`, `export-tombstones`) cover every region.
 */
export async function runOperator(
  target: Db | Regions,
  argv: readonly string[],
  now: number,
  files: OperatorFiles = noFiles,
  domains: DomainDeps | null = null,
): Promise<OperatorResult> {
  const { positional, options } = parseArgs(argv);
  const [command, ...args] = positional;
  const regions = isRegions(target) ? target : singleDatabase(target);
  const global = regions.global;
  const regionOption = options.get("region");
  // `--region all` names every region, for the restore commands only.
  const regionName = regionOption === "all" ? DEFAULT_REGION : (regionOption ?? DEFAULT_REGION);
  if (regionOption === "all" && !RESTORE_COMMANDS.has(command ?? "")) {
    return usage("--region all is only for export-tombstones and apply-tombstones.");
  }
  if (!isRegion(regionName) || !regions.all().some((h) => h.region === regionName)) {
    return usage(
      `--region must be one of: ${regions
        .all()
        .map((h) => h.region)
        .join(", ")}.`,
    );
  }
  const db = regions.get(regionName).db;
  /** The database of the region that holds an artifact (the directory says), or `db`. */
  const artifactDb = async (artifactId: string) =>
    (await artifactHandles(regions, artifactId))?.db ?? db;
  const reasonOption = () => AbuseReason.safeParse(options.get("reason"));
  const suspendOptions = () => ({
    reportId: options.get("report") || undefined,
    note: options.get("note") || undefined,
    now,
  });
  /**
   * The statement of reasons the command records and emails (docs/operations.md, "Reports"): the
   * facts and, for a restriction, the ground, as bounded plain text; `--withhold-notice` records it
   * without emailing anyone, where the law requires silence. A string is the refusal to print.
   */
  const statementOption = (restricting: boolean) => {
    const source = DecisionSource.safeParse(options.get("source") ?? undefined);
    if (options.has("source") && !source.success) return "--source must be notice or review.";
    const facts = options.get("facts") ?? "";
    const ground = restricting ? (options.get("ground") ?? "") : "-";
    const text = StatementText.safeParse({ facts, ground });
    if (!text.success) {
      return restricting
        ? "--facts and --ground are required plain text (facts up to 2,000 characters, ground up to 500)."
        : "--facts is required plain text, up to 2,000 characters.";
    }
    return {
      facts: text.data.facts,
      ...(restricting ? { ground: text.data.ground } : {}),
      source: decisionSource(
        source.success ? source.data : undefined,
        options.get("report") || undefined,
      ),
      withhold: options.has("withhold-notice"),
    };
  };
  const noticeLine = (withhold: boolean) =>
    withhold
      ? "The statement of reasons is recorded and withheld: nobody is emailed."
      : "The statement of reasons is recorded; the people affected are emailed shortly (see: decisions).";

  switch (command) {
    case "reports": {
      const status = options.get("status") ?? "open";
      if (!["open", "actioned", "dismissed", "all"].includes(status)) {
        return usage(`Unknown status: ${status}`);
      }
      const limit = Number(options.get("limit") ?? 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        return usage("--limit must be 1 to 500.");
      }
      const reports = await listAbuseReports(global, {
        status: status === "all" ? undefined : (status as "open"),
        limit,
      });
      if (reports.length === 0) return { exitCode: 0, output: "No reports." };
      // Report text is untrusted: it is printed as one plain line, never interpreted.
      const lines = reports.map(
        (r) =>
          `${r.id}  ${new Date(r.createdAt).toISOString()}  ${r.status}  ${r.artifactId}  ${r.reason}  ${r.confirmed ? "full-notice" : "report"}  ${r.reporterEmail ? "has-email" : "anonymous"}  ${oneLine(r.details)}`,
      );
      return { exitCode: 0, output: lines.join("\n") };
    }
    case "report": {
      const [reportId] = args;
      if (!reportId) return usage("report needs a report ID.");
      const [r] = await global
        .select()
        .from(schema.abuseReports)
        .where(eq(schema.abuseReports.id, reportId))
        .limit(1);
      if (!r) return { exitCode: 1, output: "No report with that ID." };
      // Untrusted text: each field on its own plain line, JSON-quoted, never interpreted. The
      // reporter's email is read from D1 only when replying.
      return {
        exitCode: 0,
        output: [
          `report     ${r.id}  ${r.status}  ${iso(r.createdAt)}`,
          `artifact   ${r.artifactId}`,
          `address    ${r.address === null ? "none (an ID was given)" : JSON.stringify(r.address)}`,
          `reason     ${r.reason}`,
          `notice     ${r.confirmed ? "full: the reporter confirmed it is accurate, complete and in good faith" : "not confirmed"}`,
          `name       ${r.reporterName === null ? "none" : JSON.stringify(oneLine(r.reporterName))}`,
          `email      ${r.reporterEmail ? "given" : "none"}`,
          `language   ${r.locale ?? "en"}`,
          `outcome    ${r.outcomeNotice ?? "none"}${r.outcomeNotifiedAt ? ` ${iso(r.outcomeNotifiedAt)}` : ""}`,
          `details    ${JSON.stringify(r.details ?? "")}`,
        ].join("\n"),
      };
    }
    case "resolve-report": {
      const [reportId, status] = args;
      if (!reportId || (status !== "actioned" && status !== "dismissed")) {
        return usage("resolve-report needs a report ID and actioned or dismissed.");
      }
      const withhold = options.has("withhold-notice");
      const result = await resolveAbuseReport(global, { reportId, status, now, withhold });
      if (!result.ok) return { exitCode: 1, output: result.message };
      const told = {
        pending: "The reporter is emailed the outcome shortly.",
        withheld: "The reporter's email is withheld.",
        none: "The report has no email: nobody to tell.",
        unchanged: "It was resolved before: nobody is emailed again.",
      }[result.value.notice];
      return { exitCode: 0, output: `Report ${reportId} marked ${status}. ${told}` };
    }
    case "show-artifact": {
      const [artifactId] = args;
      if (!artifactId) return usage("show-artifact needs an artifact ID.");
      const [row] = await (await artifactDb(artifactId))
        .select({
          id: schema.artifacts.id,
          state: schema.artifacts.state,
          accessMode: schema.artifacts.accessMode,
          ownerId: schema.artifacts.ownerId,
          suspensionReason: schema.artifacts.suspensionReason,
        })
        .from(schema.artifacts)
        .where(eq(schema.artifacts.id, artifactId))
        .limit(1);
      if (!row) return { exitCode: 1, output: "Artifact not found." };
      const account = await accountSuspension(db, row.ownerId);
      return {
        exitCode: 0,
        output: [
          `artifact  ${row.id}`,
          `state     ${row.state}${row.suspensionReason ? ` (${row.suspensionReason})` : ""}`,
          `access    ${row.accessMode}`,
          `owner     ${row.ownerId}${account ? ` (account suspended: ${account.reason})` : ""}`,
        ].join("\n"),
      };
    }
    case "find-share-link": {
      // The token comes from standard input, never from the command line, so it stays out of
      // the shell's history; only its hash is compared and nothing prints it.
      const token = shareLinkToken(await files.read("/dev/stdin"));
      if (!token)
        return usage("find-share-link reads a share link or its token from standard input.");
      const [link] = await db
        .select()
        .from(schema.shareLinks)
        .where(eq(schema.shareLinks.tokenHash, await hashSecret(token)))
        .limit(1);
      if (!link) return { exitCode: 1, output: "No share link has this token." };
      return {
        exitCode: 0,
        output: [
          `artifact  ${link.artifactId}`,
          `link      ${link.id}  ${shareLinkStatus(link, now)}`,
          `created   ${new Date(link.createdAt).toISOString()} by ${link.createdBy ?? "a deleted account"}`,
          "Suspending the artifact ends every link to it.",
        ].join("\n"),
      };
    }
    case "find-service-token": {
      // A leaked secret comes from standard input, never the command line, and is never printed;
      // only its hash is compared (decision 0011).
      const found = await findServiceToken(global, await files.read("/dev/stdin"));
      if (!found) return { exitCode: 1, output: "No service token has this secret." };
      const [workspace] = await global
        .select({ slug: schema.workspaces.slug })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, found.workspaceId))
        .limit(1);
      return {
        exitCode: 0,
        output: [
          `token      ${found.id}  ${found.label}`,
          `workspace  ${workspace?.slug ?? found.workspaceId}`,
          `expires    ${new Date(found.expiresAt).toISOString()}`,
          `Revoke it with: revoke-service-token ${found.id}`,
        ].join("\n"),
      };
    }
    case "revoke-service-token": {
      const [tokenId] = args;
      if (!tokenId || !ServiceTokenId.safeParse(tokenId).success) {
        return usage("revoke-service-token needs a service token ID (st_ and 32 hex characters).");
      }
      const revoked = await operatorRevokeServiceToken(global, tokenId, now);
      return {
        exitCode: revoked ? 0 : 1,
        output: revoked
          ? `Revoked ${tokenId}; its next request is refused. A tombstone keeps a restore from bringing it back.`
          : "No service token has this ID (already revoked, or its workspace was deleted).",
      };
    }
    case "find-scim-token": {
      // Like a service token (decision 0017): the secret comes from standard input and is never
      // printed; only its hash is compared.
      const found = await findScimToken(global, await files.read("/dev/stdin"));
      if (!found) return { exitCode: 1, output: "No SCIM token has this secret." };
      const [workspace] = await global
        .select({ slug: schema.workspaces.slug })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, found.workspaceId))
        .limit(1);
      return {
        exitCode: 0,
        output: [
          `token      ${found.id}  ${found.label}`,
          `workspace  ${workspace?.slug ?? found.workspaceId}`,
          `expires    ${new Date(found.expiresAt).toISOString()}`,
          `Revoke it with: revoke-scim-token ${found.id}`,
        ].join("\n"),
      };
    }
    case "revoke-scim-token": {
      const [tokenId] = args;
      if (!tokenId || !ScimTokenId.safeParse(tokenId).success) {
        return usage("revoke-scim-token needs a SCIM token ID (sc_ and 32 hex characters).");
      }
      const revoked = await operatorRevokeScimToken(global, tokenId, now);
      return {
        exitCode: revoked ? 0 : 1,
        output: revoked
          ? `Revoked ${tokenId}; the directory's next request is refused. A tombstone keeps a restore from bringing it back.`
          : "No SCIM token has this ID (already revoked, or its workspace was deleted).",
      };
    }
    case "suspend-artifact": {
      const [artifactId] = args;
      const reason = reasonOption();
      if (!artifactId || !reason.success) {
        return usage("suspend-artifact needs an artifact ID and a valid --reason.");
      }
      const statement = statementOption(true);
      if (typeof statement === "string") return usage(statement);
      const result = await suspendArtifact(await artifactDb(artifactId), {
        artifactId,
        reason: reason.data,
        ...suspendOptions(),
        statement,
      });
      if (!result.ok) return { exitCode: 1, output: result.message };
      return {
        exitCode: 0,
        output: result.value.changed
          ? `Suspended ${artifactId} (${result.value.suspensionId}). ${noticeLine(statement.withhold)}`
          : `${artifactId} was already suspended (${result.value.suspensionId}); nothing was recorded or sent.`,
      };
    }
    case "reinstate-artifact": {
      const [artifactId] = args;
      if (!artifactId) return usage("reinstate-artifact needs an artifact ID.");
      const statement = statementOption(false);
      if (typeof statement === "string") return usage(statement);
      const result = await reinstateArtifact(await artifactDb(artifactId), {
        artifactId,
        now,
        statement,
      });
      if (!result.ok) return { exitCode: 1, output: result.message };
      return {
        exitCode: 0,
        output: result.value.changed
          ? `Reinstated ${artifactId} as ${result.value.state}. ${noticeLine(statement.withhold)}`
          : `${artifactId} was not suspended; it is ${result.value.state}.`,
      };
    }
    case "suspend-account": {
      const [who] = args;
      const reason = reasonOption();
      if (!who || !reason.success) {
        return usage("suspend-account needs a user ID or email and a valid --reason.");
      }
      const statement = statementOption(true);
      if (typeof statement === "string") return usage(statement);
      const userId = await userIdFor(global, who);
      if (!userId) return { exitCode: 1, output: "Account not found." };
      const result = await suspendAccount(db, {
        userId,
        reason: reason.data,
        ...suspendOptions(),
        statement,
      });
      if (!result.ok) return { exitCode: 1, output: result.message };
      return {
        exitCode: 0,
        output: result.value.changed
          ? `Suspended account ${userId} and ${result.value.artifacts} artifact(s). ${noticeLine(statement.withhold)}`
          : `Account ${userId} was already suspended; nothing was recorded or sent.`,
      };
    }
    case "reinstate-account": {
      const [who] = args;
      if (!who) return usage("reinstate-account needs a user ID or email.");
      const statement = statementOption(false);
      if (typeof statement === "string") return usage(statement);
      const userId = await userIdFor(global, who);
      if (!userId) return { exitCode: 1, output: "Account not found." };
      const result = await reinstateAccount(db, { userId, now, statement });
      if (!result.ok) return { exitCode: 1, output: result.message };
      const held =
        result.value.held > 0
          ? ` ${result.value.held} artifact(s) with a legal hold stay suspended.`
          : "";
      return {
        exitCode: 0,
        output: result.value.changed
          ? `Reinstated account ${userId} and ${result.value.artifacts} artifact(s).${held} ${noticeLine(statement.withhold)}`
          : `Account ${userId} was not suspended.`,
      };
    }
    case "brand": {
      const [who] = args;
      if (!who) return usage("brand needs a user ID, email or workspace ID.");
      const ownerId = await userIdFor(global, who);
      if (!ownerId) return { exitCode: 1, output: "Account not found." };
      const state = await showBrand(db, ownerId, now);
      if (!state.brand) return { exitCode: 0, output: `${ownerId} has no brand.` };
      // The name and link are the owner's text: one plain line each, never interpreted.
      const b = state.brand;
      return {
        exitCode: 0,
        output: [
          `owner       ${ownerId}`,
          `name        ${JSON.stringify(oneLine(b.name))}`,
          `link        ${b.link === null ? "none" : JSON.stringify(oneLine(b.link))}`,
          `accent      ${b.accentColor ?? "none"}`,
          `logo        ${b.logo ? `${b.logo.type} ${b.logo.width}x${b.logo.height} ${b.logo.bytes} bytes ${b.logo.sha256}` : "none"}`,
          `suspended   ${state.suspendedAt === null ? "no" : `${iso(state.suspendedAt)} (${state.suspensionReason})`}`,
          `shown       ${state.shown ? "yes" : "no (default bar)"}`,
        ].join("\n"),
      };
    }
    case "suspend-brand": {
      const [who] = args;
      const reason = reasonOption();
      if (!who || !reason.success) {
        return usage("suspend-brand needs an owner and a valid --reason.");
      }
      const statement = statementOption(true);
      if (typeof statement === "string") return usage(statement);
      const ownerId = await userIdFor(global, who);
      if (!ownerId) return { exitCode: 1, output: "Account not found." };
      const result = await suspendBrand(db, {
        ownerId,
        reason: reason.data,
        now,
        reportId: options.get("report") || undefined,
        statement,
      });
      if (!result.ok) return { exitCode: 1, output: result.message };
      return {
        exitCode: 0,
        output: result.value.suspended
          ? `Suspended the brand of ${ownerId}; its viewer shows the default bar. ${noticeLine(statement.withhold)}`
          : `The brand of ${ownerId} was already suspended; nothing was recorded or sent.`,
      };
    }
    case "reinstate-brand": {
      const [who] = args;
      if (!who) return usage("reinstate-brand needs an owner.");
      const statement = statementOption(false);
      if (typeof statement === "string") return usage(statement);
      const ownerId = await userIdFor(global, who);
      if (!ownerId) return { exitCode: 1, output: "Account not found." };
      const result = await reinstateBrand(db, { ownerId, now, statement });
      if (!result.ok) return { exitCode: 1, output: result.message };
      return {
        exitCode: 0,
        output: result.value.reinstated
          ? `Reinstated the brand of ${ownerId}. ${noticeLine(statement.withhold)}`
          : `The brand of ${ownerId} was not suspended.`,
      };
    }
    case "decisions": {
      const [kind, who] = args;
      if ((kind !== "artifact" && kind !== "account" && kind !== "brand") || !who) {
        return usage("decisions needs artifact, account or brand and an ID or email.");
      }
      const targetId = kind === "artifact" ? who : await userIdFor(global, who);
      if (!targetId) return { exitCode: 1, output: "Account not found." };
      const where = kind === "artifact" ? await artifactDb(targetId) : db;
      const decisions = await listDecisions(where, kind, targetId);
      if (decisions.length === 0) return { exitCode: 0, output: "No decisions recorded." };
      // The operator's own text, as JSON strings on their lines; the sends are the proof.
      return {
        exitCode: 0,
        output: decisions
          .map((d) =>
            [
              `${d.id}  ${iso(d.createdAt)}  ${d.action}  ${d.reason ?? "-"}  ${d.source}  notice ${d.notice}${d.notifiedAt ? ` ${iso(d.notifiedAt)}` : ""}`,
              `  facts   ${JSON.stringify(d.facts)}`,
              ...(d.ground === null ? [] : [`  ground  ${JSON.stringify(d.ground)}`]),
              ...d.sends.map((send) => `  sent    ${iso(send.sentAt)} to ${send.userId}`),
            ].join("\n"),
          )
          .join("\n"),
      };
    }
    case "hold-artifact": {
      const [artifactId] = args;
      const ground = options.get("ground") ?? "";
      if (!artifactId || !ground.trim()) {
        return usage("hold-artifact needs an artifact ID and --ground <text>.");
      }
      const until = options.get("until");
      const releaseAt = until === undefined ? null : Date.parse(until);
      if (releaseAt !== null && Number.isNaN(releaseAt)) {
        return usage("--until must be a date, like 2027-11-12.");
      }
      const result = await placeLegalHold(await artifactDb(artifactId), {
        artifactId,
        ground,
        releaseAt,
        now,
      });
      if (!result.ok) return { exitCode: 1, output: result.message };
      const hold = result.value.hold;
      return {
        exitCode: 0,
        output: result.value.changed
          ? `Held ${artifactId} (${hold.id})${hold.releaseAt ? ` until ${iso(hold.releaseAt)}` : " until released"}. Nothing deletes, moves or serves it meanwhile.`
          : `${artifactId} was already held (${hold.id}).`,
      };
    }
    case "release-hold": {
      const [artifactId] = args;
      if (!artifactId) return usage("release-hold needs an artifact ID.");
      const result = await releaseLegalHold(await artifactDb(artifactId), { artifactId, now });
      return result.released
        ? {
            exitCode: 0,
            output: `Released the hold on ${artifactId}. It stays suspended until reinstate-artifact; a deletion that waited goes on at its next run.`,
          }
        : { exitCode: 1, output: `${artifactId} has no open hold.` };
    }
    case "holds": {
      const limit = Number(options.get("limit") ?? 100);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        return usage("--limit must be 1 to 500.");
      }
      const rows = [];
      for (const handles of regions.all()) {
        rows.push(...(await listLegalHolds(handles.db, { all: options.has("all"), limit })));
      }
      if (rows.length === 0) return { exitCode: 0, output: "No holds." };
      return {
        exitCode: 0,
        output: rows
          .map(
            (row) =>
              `${row.id}  ${row.artifactId}  ${row.releasedAt === null ? "open" : `released ${iso(row.releasedAt)}`}  since ${iso(row.createdAt)}  until ${row.releaseAt === null ? "released" : iso(row.releaseAt)}  owner ${row.ownerId}  ground ${JSON.stringify(oneLine(row.ground))}`,
          )
          .join("\n"),
      };
    }
    case "storage-report": {
      const limit = Number(options.get("limit") ?? 100);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        return usage("--limit must be 1 to 1000.");
      }
      const findings = await listStorageFindings(db, limit);
      if (findings.length === 0) return { exitCode: 0, output: "No storage findings." };
      const lines = findings.map(
        (f) =>
          `${f.kind}  ${f.r2Key}  first ${new Date(f.firstSeenAt).toISOString()}  last ${new Date(f.lastSeenAt).toISOString()}${f.detail ? `  ${f.detail}` : ""}`,
      );
      return { exitCode: 0, output: lines.join("\n") };
    }
    case "export-tombstones": {
      const out = options.get("out");
      if (!out) return usage("export-tombstones needs --out <file>.");
      const chosen = restoreRegions(regions, regionOption);
      if (typeof chosen === "string") return usage(chosen);
      const markers = await exportTombstones(chosen);
      // Legal holds go with the markers, so a restore never loses or reopens one.
      const holds = await exportLegalHolds(chosen);
      const lines = [...markers, ...holds].map((line) => `${JSON.stringify(line)}\n`);
      await files.write(out, lines.join(""));
      return {
        exitCode: 0,
        output: `Wrote ${markers.length} tombstone marker(s) and ${holds.length} legal hold(s) to ${out}.`,
      };
    }
    case "apply-tombstones": {
      const file = options.get("file");
      let markers: TombstoneMarker[] = [];
      let holds: LegalHoldLine[] = [];
      if (file !== undefined) {
        if (!file) return usage("--file needs a path.");
        const parsed = parseTombstones(await files.read(file));
        if (!parsed.ok) {
          return {
            exitCode: 1,
            output: `Line ${parsed.line} of ${file} is not a tombstone marker; nothing was applied.`,
          };
        }
        markers = parsed.markers;
        holds = parsed.holds;
      }
      const chosen = restoreRegions(regions, regionOption);
      if (typeof chosen === "string") return usage(chosen);
      // Holds first: a re-applied deletion never takes an artifact a hold keeps.
      const held = await applyLegalHolds(chosen, holds, now);
      const result = await applyTombstones(chosen, markers, now);
      // Issue connections, per region from the stored markers (decision 0018).
      const { integrations } = await applyIntegrationTombstones(chosen);
      // A restore of the global database rewinds the artifact directory too (decision 0005).
      let directory = 0;
      for (const handles of chosen.all()) {
        directory += await rebuildArtifactDirectory(regions.global, handles.db, handles.region);
      }
      return {
        exitCode: 0,
        output: `Applied tombstones: ${result.inserted} restored, ${result.artifacts} artifact(s) claimed for purging, ${result.accounts} account(s) and ${result.workspaces} workspace(s) deleted again, ${result.shareLinks} share link(s) revoked again, ${result.serviceTokens} service token(s) deleted again, ${result.groups} group(s) and ${result.groupMembers} group membership(s) removed again, ${result.ssoProviders} single sign-on provider(s) removed again, ${result.members} membership(s) ended again, ${result.invitations} invitation(s) withdrawn again, ${result.commentThreads} comment thread(s) and ${result.commentMessages} message(s) deleted again, ${result.noticeOptOuts} email preference(s) turned off again, ${result.noticeMutes} notice mute(s) set again, ${result.sessions} session(s) ended again, ${result.oauthTokens} app token(s) revoked again, ${result.oauthGrants} app consent(s) withdrawn again, ${integrations} issue connection(s) removed again, ${directory} artifact directory row(s) rebuilt, ${held.restored} legal hold(s) put back (${held.suspended} artifact(s) suspended again). The jobs Worker purges them on its next runs.${held.missing.length > 0 ? ` Held artifacts missing after the restore: ${held.missing.join(", ")}.` : ""}`,
      };
    }
    case "budget": {
      const state = await getBudgetState(global, now);
      if (!state)
        return { exitCode: 0, output: "No budget state yet: the jobs Worker has not run." };
      const alerts = await listBudgetAlerts(global, {
        cycleStart: budgetCycle(now).start,
        limit: 20,
      });
      const alertLines = alerts.length > 0 ? alerts.map((a) => `  ${alertLine(a)}`) : ["  none"];
      return {
        exitCode: 0,
        output: [...budgetLines(state), "alerts this cycle", ...alertLines].join("\n"),
      };
    }
    case "budget-alerts": {
      const limit = Number(options.get("limit") ?? 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        return usage("--limit must be 1 to 500.");
      }
      const alerts = await listBudgetAlerts(global, { limit });
      if (alerts.length === 0) return { exitCode: 0, output: "No budget alerts." };
      const lines = alerts.map(
        (a) => `${a.id}  cycle ${iso(a.cycleStart).slice(0, 7)}  ${a.level}  ${alertLine(a)}`,
      );
      return { exitCode: 0, output: lines.join("\n") };
    }
    case "budget-override":
      return budgetOverride(global, args, options, now);
    case "email-suppressions": {
      const limit = Number(options.get("limit") ?? 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        return usage("--limit must be 1 to 500.");
      }
      const rows = await listEmailSuppressions(global, { now, limit });
      if (rows.length === 0) return { exitCode: 0, output: "No email suppressions." };
      // Addresses are stored only as a hash and a masked hint, so the hint is all there is.
      const lines = rows.map(
        (r) =>
          `${r.id}  ${r.hint}  ${r.reason}  since ${iso(r.createdAt)}  updated ${iso(r.updatedAt)}  until ${iso(r.expiresAt)}`,
      );
      return { exitCode: 0, output: lines.join("\n") };
    }
    case "lift-email-suppression": {
      const [email] = args;
      if (!email?.includes("@")) return usage("lift-email-suppression needs the email address.");
      const lifted = await liftEmailSuppression(global, email);
      return {
        exitCode: lifted ? 0 : 1,
        output: lifted
          ? `Lifted the suppression of ${emailHint(email)}. Email Service keeps its own list: remove the address there too if sends still fail (docs/operations.md).`
          : `No suppression for ${emailHint(email)}.`,
      };
    }
    case "plan": {
      const [who] = args;
      if (!who) return usage("plan needs an owner.");
      const userId = await ownerIdFor(db.global, who);
      if (!userId) return { exitCode: 1, output: "Account or workspace not found." };
      return {
        exitCode: 0,
        output: planLines(
          userId,
          await getOwnerPlan(await ownerDb(regions, userId), userId, now),
        ).join("\n"),
      };
    }
    case "set-plan":
      return setPlan(regions, args, options, now);
    case "remove-plan": {
      const [who] = args;
      if (!who) return usage("remove-plan needs an owner.");
      const userId = await ownerIdFor(db.global, who);
      if (!userId) return { exitCode: 1, output: "Account or workspace not found." };
      const bucket = await ownerBucket(regions, userId);
      const guard = await releaseGuardForPlan(regions.global, bucket, userId, null, now);
      const result = await removeOwnerPlan(await ownerDb(regions, userId), {
        ownerId: userId,
        now,
        noGrace: options.has("no-grace"),
      });
      if (!result.ok) {
        return {
          exitCode: 1,
          output: [result.message, ...guardReleasedLines(userId, guard)].join("\n"),
        };
      }
      if (guard === "kept") {
        return {
          exitCode: 1,
          output: [
            `Removed the plan of ${userId}.`,
            ...guardKeptLines(userId, bucket !== undefined),
          ].join("\n"),
        };
      }
      const held = result.value.state.entitlements.grace;
      const head = result.value.removed
        ? `Removed the plan of ${userId}; it is on free.${held ? ` What it kept is held until ${iso(held.until)}.` : ""}`
        : `${userId} had no plan.`;
      return { exitCode: 0, output: [head, ...planLines(userId, result.value.state)].join("\n") };
    }
    case "export-plans": {
      const out = options.get("out");
      if (!out) return usage("export-plans needs --out <file>.");
      const plans = await exportOwnerPlans(global, now);
      await files.write(out, plans.map((plan) => `${JSON.stringify(plan)}\n`).join(""));
      return { exitCode: 0, output: `Wrote ${plans.length} plan(s) to ${out}.` };
    }
    case "apply-plans": {
      const file = options.get("file");
      if (!file) return usage("apply-plans needs --file <file>.");
      const parsed = parseJsonLines(await files.read(file), OwnerPlanExport);
      if (!parsed.ok) {
        return {
          exitCode: 1,
          output: `Line ${parsed.line} of ${file} is not an exported plan; nothing was applied.`,
        };
      }
      const result = await applyOwnerPlans(regions, parsed.items, now);
      const lines = [
        `Applied ${result.applied} plan(s); skipped ${result.skipped} (ended, or the account or workspace is gone).`,
      ];
      if (result.extra.length > 0) {
        lines.push(
          `${result.extra.length} owner(s) have a plan the file does not list; remove each with remove-plan if it ended after the export:`,
          ...result.extra.map((ownerId) => `  ${ownerId}`),
        );
      }
      return { exitCode: 0, output: lines.join("\n") };
    }
    case "export-policies": {
      const out = options.get("out");
      if (!out) return usage("export-policies needs --out <file>.");
      const items = await exportWorkspacePolicies(global);
      await files.write(out, items.map((item) => `${JSON.stringify(item)}\n`).join(""));
      return { exitCode: 0, output: `Wrote ${items.length} workspace policy(ies) to ${out}.` };
    }
    case "apply-policies": {
      const file = options.get("file");
      if (!file) return usage("apply-policies needs --file <file>.");
      const parsed = parseJsonLines(await files.read(file), WorkspacePolicyExport);
      if (!parsed.ok) {
        return {
          exitCode: 1,
          output: `Line ${parsed.line} of ${file} is not an exported workspace policy; nothing was applied.`,
        };
      }
      const result = await applyWorkspacePolicies(global, parsed.items, now, {
        allowLifting: options.has("allow-lifting"),
      });
      if (!result.ok) {
        return {
          exitCode: 1,
          output: `Line ${result.index + 1} of ${file} is not a valid workspace policy (${result.message}); nothing was applied.`,
        };
      }
      const lines = [
        `Applied ${result.applied} workspace policy(ies); skipped ${result.skipped} (unchanged, or the workspace is gone).`,
      ];
      if (result.lifting.length > 0) {
        lines.push(
          `${result.lifting.length} workspace(s) were left as they are because the file would lift a restriction they have now (an export older than it); run again with --allow-lifting only if lifting them is intended:`,
          ...result.lifting.map((item) => `  ${item.workspaceId}: ${item.fields.join(", ")}`),
        );
      }
      if (result.ssoUnusable.length > 0) {
        lines.push(
          `${result.ssoUnusable.length} workspace(s) were left as they are because the file requires single sign-on and the workspace's provider cannot sign anyone in now (removed, no verified domain it serves, or a plan without sso); set the provider up again, then have an admin require it from the Policies page:`,
          ...result.ssoUnusable.map((id) => `  ${id}`),
        );
      }
      if (result.extra.length > 0) {
        lines.push(
          `${result.extra.length} workspace(s) have a policy the file does not list; review each on its Policies page (it was set before the restore point):`,
          ...result.extra.map((id) => `  ${id}`),
        );
      }
      if (result.retentionCleared.length > 0) {
        lines.push(
          `${result.retentionCleared.length} of them had a maximum life of artifacts or a comment retention the restore brought back (an admin had removed it after the restore point); it was removed again so it archives or deletes nothing:`,
          ...result.retentionCleared.map((id) => `  ${id}`),
        );
      }
      if (result.commentHeld.length > 0) {
        lines.push(
          `${result.commentHeld.length} workspace(s) kept their comment retention because the file's is stricter (shorter, new, or taking effect earlier); apply-policies never tightens deletion, so an admin sets it again from the Policies page if it is wanted:`,
          ...result.commentHeld.map((id) => `  ${id}`),
        );
      }
      lines.push(
        "Comment retention deletes again by itself where the applied policy's rule is the one its admins last saved (the guard record agrees); anywhere else it stays paused until an admin saves the rule again. Take the export before the restore: one taken after it only re-applies the restored rules.",
      );
      return { exitCode: 0, output: lines.join("\n") };
    }
    case "clear-request-policies": {
      const [key] = args;
      if (!key) return usage("clear-request-policies needs a slug or workspace ID.");
      const detail = await getWorkspaceDetail(regions, key, now);
      if (!detail) return { exitCode: 1, output: "Workspace not found." };
      if (options.get("confirm") !== detail.slug) {
        return usage(
          `clear-request-policies needs --confirm ${detail.slug} to lift its request policies.`,
        );
      }
      const result = await clearRequestPolicies(global, detail.id, now);
      if (result.outcome === "missing") return { exitCode: 1, output: "Workspace not found." };
      if (result.outcome === "conflict") {
        return {
          exitCode: 1,
          output: `The policies of ${detail.slug} kept changing while lifting its request policies; nothing was changed. Run the command again.`,
        };
      }
      if (result.outcome === "unchanged") {
        return {
          exitCode: 0,
          output: `Workspace ${detail.slug} has no request policy; nothing changed.`,
        };
      }
      return {
        exitCode: 0,
        output: `Lifted ${result.fields.join(" and ")} of workspace ${detail.slug} (${detail.id}); its other policies are unchanged. The audit log records it as the operator.`,
      };
    }
    case "workspaces": {
      // `--sso-required`: the workspaces that require single sign-on, before switching SSO off
      // (docs/releasing.md, "SSO"): with it off nobody can meet the requirement (decision 0021).
      const ssoOnly = options.has("sso-required");
      const all = await listAllWorkspaces(global);
      const rows = ssoOnly ? all.filter((row) => row.policy.ssoRequired) : all;
      if (rows.length === 0) {
        return {
          exitCode: 0,
          output: ssoOnly ? "No workspace requires single sign-on." : "No workspaces.",
        };
      }
      return {
        exitCode: 0,
        output: rows
          .map(
            (row) =>
              `${row.slug}  ${row.id}  ${row.members} member(s)  created ${iso(row.createdAt)}  ${oneLine(row.name)}`,
          )
          .join("\n"),
      };
    }
    case "workspace": {
      const [key] = args;
      if (!key) return usage("workspace needs a slug or workspace ID.");
      const detail = await getWorkspaceDetail(regions, key, now);
      if (!detail) return { exitCode: 1, output: "Workspace not found." };
      return {
        exitCode: 0,
        output: workspaceLines(
          detail,
          await getOwnerPlan(regions.get(detail.region).db, detail.id, now),
        ),
      };
    }
    case "workspace-create":
      return createWorkspaceCommand(regions, args, options, now);
    case "workspace-delete": {
      const [key] = args;
      if (!key) return usage("workspace-delete needs a slug or workspace ID.");
      const detail = await getWorkspaceDetail(regions, key, now);
      if (!detail) return { exitCode: 1, output: "Workspace not found." };
      if (options.get("confirm") !== detail.slug) {
        return usage(
          `workspace-delete needs --confirm ${detail.slug} to delete it and its artifacts.`,
        );
      }
      const result = await deleteWorkspace(regions, {
        workspaceId: detail.id,
        now,
      });
      if (!result.ok) return { exitCode: 1, output: result.message };
      return {
        exitCode: 0,
        output: `Deleted workspace ${detail.slug} (${detail.id}): ${detail.members.length} membership(s) and its invitations removed, ${detail.artifacts} artifact(s) claimed for purging. The jobs Worker purges them and its storage on its next runs.`,
      };
    }
    case "show-domain": {
      const [hostname] = args;
      if (!hostname) return usage("show-domain needs a hostname.");
      const name = hostname.trim().toLowerCase().replace(/\.$/, "");
      const [row] = await db
        .select()
        .from(schema.customDomains)
        .where(eq(schema.customDomains.hostname, name))
        .limit(1);
      const claims = await db
        .select({
          ownerId: schema.domainClaims.ownerId,
          artifactId: schema.domainClaims.artifactId,
        })
        .from(schema.domainClaims)
        .where(eq(schema.domainClaims.hostname, name));
      if (!row && claims.length === 0) return { exitCode: 1, output: "No custom domain or claim." };
      const lines: string[] = [];
      if (row) {
        lines.push(
          `domain    ${row.hostname}`,
          `state     ${row.state}${row.detachReason ? ` (${row.detachReason})` : ""}`,
          `artifact  ${row.artifactId}`,
          `owner     ${row.ownerId}`,
          `verified  ${iso(row.verifiedAt)}, checked ${iso(row.checkedAt)}, ${row.missedChecks} missed`,
          `cloudflare ${row.cfHostnameId ?? "none yet"}`,
        );
      }
      for (const claim of claims) lines.push(`claim     ${claim.ownerId} for ${claim.artifactId}`);
      return { exitCode: 0, output: lines.join("\n") };
    }
    case "detach-domain": {
      const [hostname] = args;
      if (!hostname) return usage("detach-domain needs a hostname.");
      const name = hostname.trim().toLowerCase().replace(/\.$/, "");
      const detached = await detachDomain(
        domainDbsOf(db),
        name,
        "operator",
        now,
        {},
        {
          type: "operator",
        },
      );
      return detached
        ? {
            exitCode: 0,
            output: `Detached ${name}: it no longer serves, and the queue deletes its Cloudflare hostname.`,
          }
        : {
            exitCode: 1,
            output: "No attached domain with that hostname (or it is already being removed).",
          };
    }
    case "block-domain": {
      const [name] = args;
      const note = options.get("note")?.trim();
      if (!name || !note) return usage("block-domain needs a name and --note with the reason.");
      const result = await blockHostname(domainDbsOf(db), { name, note, now });
      if (!result.ok) return { exitCode: 1, output: result.message };
      const { detached } = result.value;
      return {
        exitCode: 0,
        output: `Blocked ${result.value.name} and every name under it. Detached: ${detached.length === 0 ? "none" : detached.join(", ")}.`,
      };
    }
    case "unblock-domain": {
      const [name] = args;
      if (!name) return usage("unblock-domain needs a name.");
      return (await unblockHostname(db.global, name))
        ? {
            exitCode: 0,
            output: `Unblocked ${name.trim().toLowerCase()}. Detached domains stay detached.`,
          }
        : { exitCode: 1, output: "That name is not blocked." };
    }
    case "blocked-domains": {
      const rows = await listBlockedHostnames(db.global);
      if (rows.length === 0) return { exitCode: 0, output: "No blocked names." };
      return {
        exitCode: 0,
        output: rows
          .map((row) => `${row.name}  ${iso(row.createdAt)}  ${oneLine(row.note)}`)
          .join("\n"),
      };
    }
    case "reconcile-domains": {
      if (!domains) {
        return {
          exitCode: 1,
          output:
            "reconcile-domains needs CF_CONTENT_ZONE_ID and CF_HOSTNAMES_TOKEN in the environment.",
        };
      }
      const result = await reconcileCustomDomains(domainDbsOf(db), [db], domains, now);
      const section = (label: string, names: string[]) =>
        `${label}: ${names.length === 0 ? "none" : names.join(", ")}`;
      return {
        exitCode: 0,
        output: [
          section("Detached (Cloudflare no longer has them)", result.detached),
          section("Deleted from Cloudflare (no row)", result.removed),
          section("Cleared from artifacts (no active domain)", result.cleared),
        ].join("\n"),
      };
    }
    default:
      return usage(command ? `Unknown command: ${command}` : "No command given.");
  }
}
