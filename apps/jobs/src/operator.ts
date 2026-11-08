// Operator commands for abuse handling (plan section 13): list and resolve reports, suspend and
// reinstate artifacts and accounts; for backups (plan section 10): review the storage
// reconciliation's findings, and export and re-apply tombstones around a D1 Time Travel restore;
// for the budget (plan section 12): show the state and the alerts, and override the automatic
// protection; and for email delivery (plan section 17): list and lift suppressed addresses. They run only from `scripts/operator.ts` on the operator's machine, with the deploy
// credentials, against the D1 binding; no web route reaches them. Each command calls the same
// services the tests cover, and prints plain text without secrets.
import { AbuseReason, TombstoneMarker } from "@portifact/contracts";
import { type Db, schema } from "@portifact/db";
import {
  BUDGET_LEVELS,
  type BudgetLevel,
  budgetCycle,
  emailHint,
  PROTECTION_STEPS,
} from "@portifact/domain";
import {
  accountSuspension,
  applyTombstones,
  type BudgetState,
  clearBudgetOverride,
  exportTombstones,
  getBudgetState,
  liftEmailSuppression,
  listAbuseReports,
  listBudgetAlerts,
  listEmailSuppressions,
  listStorageFindings,
  reinstateAccount,
  reinstateArtifact,
  resolveAbuseReport,
  setBudgetOverride,
  suspendAccount,
  suspendArtifact,
} from "@portifact/services";
import { eq, sql } from "drizzle-orm";

export const OPERATOR_USAGE = `Usage: bun run --cwd apps/jobs operator [--local | --config <file>] <command>

  --local          the local D1 state of wrangler dev in apps/app
  --config <file>  a Wrangler configuration whose remote DB binding replaces production
                   (a scratch database for a backup drill); relative to apps/jobs

Commands:
  reports [--status open|actioned|dismissed|all] [--limit N]
  resolve-report <report-id> actioned|dismissed
  show-artifact <artifact-id>
  suspend-artifact <artifact-id> --reason <reason> [--report <report-id>] [--note <text>]
  reinstate-artifact <artifact-id>
  suspend-account <user-id|email> --reason <reason> [--report <report-id>] [--note <text>]
  reinstate-account <user-id|email>
  storage-report [--limit N]
  export-tombstones --out <file>
  apply-tombstones [--file <file>]
  budget
  budget-alerts [--limit N]
  budget-override <level> --note <text> [--steps 1-${PROTECTION_STEPS.length}] [--hours N]
  budget-override clear
  email-suppressions [--limit N]
  lift-email-suppression <email>

Reasons: ${AbuseReason.options.join(", ")}
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

/** Parses the JSON lines `export-tombstones` writes; any bad line refuses the whole file. */
export function parseTombstones(
  text: string,
): { ok: true; markers: TombstoneMarker[] } | { ok: false; line: number } {
  const markers: TombstoneMarker[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return { ok: false, line: index + 1 };
    }
    const parsed = TombstoneMarker.safeParse(value);
    if (!parsed.success) return { ok: false, line: index + 1 };
    markers.push(parsed.data);
  }
  return { ok: true, markers };
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

async function userIdFor(db: Db, value: string): Promise<string | undefined> {
  if (!value.includes("@")) return value;
  const [row] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${value.toLowerCase()}`)
    .limit(1);
  return row?.id;
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
  db: Db,
  args: string[],
  options: Map<string, string>,
  now: number,
): Promise<OperatorResult> {
  const [level] = args;
  if (level === "clear") {
    const state = await clearBudgetOverride(db, now);
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
  const state = await setBudgetOverride(db, {
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

/** Runs one operator command against the database. */
export async function runOperator(
  db: Db,
  argv: readonly string[],
  now: number,
  files: OperatorFiles = noFiles,
): Promise<OperatorResult> {
  const { positional, options } = parseArgs(argv);
  const [command, ...args] = positional;
  const reasonOption = () => AbuseReason.safeParse(options.get("reason"));
  const suspendOptions = () => ({
    reportId: options.get("report") || undefined,
    note: options.get("note") || undefined,
    now,
  });

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
      const reports = await listAbuseReports(db, {
        status: status === "all" ? undefined : (status as "open"),
        limit,
      });
      if (reports.length === 0) return { exitCode: 0, output: "No reports." };
      // Report text is untrusted: it is printed as one plain line, never interpreted.
      const lines = reports.map(
        (r) =>
          `${r.id}  ${new Date(r.createdAt).toISOString()}  ${r.status}  ${r.artifactId}  ${r.reason}  ${r.reporterEmail ? "has-email" : "anonymous"}  ${oneLine(r.details)}`,
      );
      return { exitCode: 0, output: lines.join("\n") };
    }
    case "resolve-report": {
      const [reportId, status] = args;
      if (!reportId || (status !== "actioned" && status !== "dismissed")) {
        return usage("resolve-report needs a report ID and actioned or dismissed.");
      }
      const result = await resolveAbuseReport(db, { reportId, status, now });
      return result.ok
        ? { exitCode: 0, output: `Report ${reportId} marked ${status}.` }
        : { exitCode: 1, output: result.message };
    }
    case "show-artifact": {
      const [artifactId] = args;
      if (!artifactId) return usage("show-artifact needs an artifact ID.");
      const [row] = await db
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
    case "suspend-artifact": {
      const [artifactId] = args;
      const reason = reasonOption();
      if (!artifactId || !reason.success) {
        return usage("suspend-artifact needs an artifact ID and a valid --reason.");
      }
      const result = await suspendArtifact(db, {
        artifactId,
        reason: reason.data,
        ...suspendOptions(),
      });
      if (!result.ok) return { exitCode: 1, output: result.message };
      return {
        exitCode: 0,
        output: result.value.changed
          ? `Suspended ${artifactId} (${result.value.suspensionId}).`
          : `${artifactId} was already suspended (${result.value.suspensionId}).`,
      };
    }
    case "reinstate-artifact": {
      const [artifactId] = args;
      if (!artifactId) return usage("reinstate-artifact needs an artifact ID.");
      const result = await reinstateArtifact(db, { artifactId, now });
      if (!result.ok) return { exitCode: 1, output: result.message };
      return {
        exitCode: 0,
        output: result.value.changed
          ? `Reinstated ${artifactId} as ${result.value.state}.`
          : `${artifactId} was not suspended; it is ${result.value.state}.`,
      };
    }
    case "suspend-account": {
      const [who] = args;
      const reason = reasonOption();
      if (!who || !reason.success) {
        return usage("suspend-account needs a user ID or email and a valid --reason.");
      }
      const userId = await userIdFor(db, who);
      if (!userId) return { exitCode: 1, output: "Account not found." };
      const result = await suspendAccount(db, { userId, reason: reason.data, ...suspendOptions() });
      if (!result.ok) return { exitCode: 1, output: result.message };
      return {
        exitCode: 0,
        output: result.value.changed
          ? `Suspended account ${userId} and ${result.value.artifacts} artifact(s).`
          : `Account ${userId} was already suspended.`,
      };
    }
    case "reinstate-account": {
      const [who] = args;
      if (!who) return usage("reinstate-account needs a user ID or email.");
      const userId = await userIdFor(db, who);
      if (!userId) return { exitCode: 1, output: "Account not found." };
      const result = await reinstateAccount(db, { userId, now });
      if (!result.ok) return { exitCode: 1, output: result.message };
      return {
        exitCode: 0,
        output: result.value.changed
          ? `Reinstated account ${userId} and ${result.value.artifacts} artifact(s).`
          : `Account ${userId} was not suspended.`,
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
      const markers = await exportTombstones(db);
      await files.write(out, markers.map((marker) => `${JSON.stringify(marker)}\n`).join(""));
      return { exitCode: 0, output: `Wrote ${markers.length} tombstone marker(s) to ${out}.` };
    }
    case "apply-tombstones": {
      const file = options.get("file");
      let markers: TombstoneMarker[] = [];
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
      }
      const result = await applyTombstones(db, markers, now);
      return {
        exitCode: 0,
        output: `Applied tombstones: ${result.inserted} restored, ${result.artifacts} artifact(s) claimed for purging, ${result.accounts} account(s) deleted again. The jobs Worker purges them on its next runs.`,
      };
    }
    case "budget": {
      const state = await getBudgetState(db, now);
      if (!state)
        return { exitCode: 0, output: "No budget state yet: the jobs Worker has not run." };
      const alerts = await listBudgetAlerts(db, { cycleStart: budgetCycle(now).start, limit: 20 });
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
      const alerts = await listBudgetAlerts(db, { limit });
      if (alerts.length === 0) return { exitCode: 0, output: "No budget alerts." };
      const lines = alerts.map(
        (a) => `${a.id}  cycle ${iso(a.cycleStart).slice(0, 7)}  ${a.level}  ${alertLine(a)}`,
      );
      return { exitCode: 0, output: lines.join("\n") };
    }
    case "budget-override":
      return budgetOverride(db, args, options, now);
    case "email-suppressions": {
      const limit = Number(options.get("limit") ?? 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        return usage("--limit must be 1 to 500.");
      }
      const rows = await listEmailSuppressions(db, { now, limit });
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
      const lifted = await liftEmailSuppression(db, email);
      return {
        exitCode: lifted ? 0 : 1,
        output: lifted
          ? `Lifted the suppression of ${emailHint(email)}. Email Service keeps its own list: remove the address there too if sends still fail (docs/operations.md).`
          : `No suppression for ${emailHint(email)}.`,
      };
    }
    default:
      return usage(command ? `Unknown command: ${command}` : "No command given.");
  }
}
