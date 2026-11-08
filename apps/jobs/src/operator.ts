// Operator commands for abuse handling (plan section 13): list and resolve reports, suspend and
// reinstate artifacts and accounts. They run only from `scripts/operator.ts` on the operator's
// machine, with the deploy credentials, against the D1 binding; no web route reaches them. Each
// command calls the same services the tests cover, and prints plain text without secrets.
import { AbuseReason } from "@portifact/contracts";
import { type Db, schema } from "@portifact/db";
import {
  accountSuspension,
  listAbuseReports,
  reinstateAccount,
  reinstateArtifact,
  resolveAbuseReport,
  suspendAccount,
  suspendArtifact,
} from "@portifact/services";
import { eq, sql } from "drizzle-orm";

export const OPERATOR_USAGE = `Usage: bun run --cwd apps/jobs operator [--local] <command>

Commands:
  reports [--status open|actioned|dismissed|all] [--limit N]
  resolve-report <report-id> actioned|dismissed
  show-artifact <artifact-id>
  suspend-artifact <artifact-id> --reason <reason> [--report <report-id>] [--note <text>]
  reinstate-artifact <artifact-id>
  suspend-account <user-id|email> --reason <reason> [--report <report-id>] [--note <text>]
  reinstate-account <user-id|email>

Reasons: ${AbuseReason.options.join(", ")}`;

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

/** Runs one operator command against the database. */
export async function runOperator(
  db: Db,
  argv: readonly string[],
  now: number,
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
    default:
      return usage(command ? `Unknown command: ${command}` : "No command given.");
  }
}
