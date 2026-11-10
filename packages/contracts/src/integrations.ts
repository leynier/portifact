// Shapes of issue integrations (premium plan T7, feature `integrations`, decision 0018): an
// owner's connections to GitHub Issues or Linear, managed by its admins through the dashboard
// session only, and the issues the owner side creates from comment threads, which the jobs
// Worker sends. Credentials never appear in any of these shapes after they are pasted.
import { z } from "zod";
import { ArtifactId } from "./core.ts";

/** The services a connection can reach. Each has one fixed API host (decision 0018). */
export const INTEGRATION_SERVICES = ["github", "linear"] as const;
export const IntegrationService = z.enum(INTEGRATION_SERVICES);
export type IntegrationService = z.infer<typeof IntegrationService>;

/** Safety caps and timings of integrations; not plan values (decision 0018). */
export const INTEGRATION_LIMITS = {
  /** Connections one owner can have. */
  perOwner: 5,
  /** Repositories or teams one connection allows. */
  targetsPerConnection: 10,
  labelMax: 60,
  /** The longest credential accepted; GitHub tokens and Linear keys are far shorter. */
  credentialMax: 255,
  credentialMin: 20,
  /** The identity the service reports, as kept for display. */
  identityMax: 100,
  /** A Linear team's name as kept for display. */
  targetNameMax: 100,
  /** The issue title the person edits. */
  titleMax: 200,
  /** Characters of the anchor's quote sent at most. */
  quoteMax: 500,
  /** Characters of the thread's first message sent at most. */
  messageMax: 3_000,
  /** Connections created per owner and day. */
  createsPerOwnerPerDay: 20,
  /** Checks against the service (create, change of credential, test) per owner and hour. */
  checksPerOwnerPerHour: 30,
  /** Issues requested per owner and UTC day. */
  issuesPerOwnerPerDay: 200,
  /** Issues requested on one thread that are not failed. */
  issuesPerThread: 5,
  /** Attempts the jobs Worker makes per owner and UTC day, retries included. */
  attemptsPerOwnerPerDay: 1_000,
  /** One call to the service. */
  timeoutMs: 10_000,
  /** Bytes of a response read at most; a larger answer is a failure. */
  responseReadBytes: 256 * 1024,
  /** Credential checks one admin may run per hour, across every owner. */
  checksPerAdminPerHour: 20,
  /** Delays before the 2nd to 5th attempts of an issue; attempts never exceed one more. */
  retryDelaysMs: [60_000, 300_000, 1_800_000, 7_200_000],
  /** An attempt that started this long ago without a result is taken over. */
  attemptStaleMs: 5 * 60_000,
  /** Recent issues read to find one whose creation answer was lost. */
  recentIssuesChecked: 30,
} as const;

/** The fixed API endpoints. Never a host from input (decision 0018). */
export const INTEGRATION_API = {
  github: "https://api.github.com",
  linear: "https://api.linear.app/graphql",
} as const;

/** The web hosts an issue's URL must be on, as each service returns it. */
export const INTEGRATION_WEB_HOSTS = {
  github: "github.com",
  linear: "linear.app",
} as const;

export const IntegrationConnectionId = z
  .string()
  .regex(/^ic_[0-9a-f]{32}$/, "Invalid connection id");
export type IntegrationConnectionId = z.infer<typeof IntegrationConnectionId>;

export const ThreadIssueId = z.string().regex(/^ti_[0-9a-f]{32}$/, "Invalid issue request id");

/**
 * A GitHub repository as `owner/name`: GitHub's own character rules (an owner of 1 to 39 letters,
 * digits and hyphens, a name of letters, digits, `.`, `_` and `-`, never `.` or `..`).
 */
export const GitHubRepo = z
  .string()
  .max(140)
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/,
    "Use owner/repository.",
  );

/** A Linear team ID (a UUID, as Linear's API returns it). */
export const LinearTeamId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Use a team ID.");

const label = z.string().trim().min(1).max(INTEGRATION_LIMITS.labelMax);
const credential = z
  .string()
  .trim()
  .min(INTEGRATION_LIMITS.credentialMin, "That does not look like a token or key.")
  .max(INTEGRATION_LIMITS.credentialMax)
  .regex(/^[\x21-\x7e]+$/, "That does not look like a token or key.");
const targets = z
  .array(z.string().trim().min(1).max(140))
  .min(1, "Choose at least one repository or team.")
  .max(INTEGRATION_LIMITS.targetsPerConnection)
  .refine((list) => new Set(list.map((t) => t.toLowerCase())).size === list.length, {
    message: "List each target once.",
  });

/** Body of POST /api/v1/integrations/connections (dashboard session only). */
export const IntegrationCreate = z.strictObject({
  service: IntegrationService,
  label,
  credential,
  /** GitHub: `owner/repo`; Linear: team IDs. Checked against the service before saving. */
  targets,
});
export type IntegrationCreate = z.infer<typeof IntegrationCreate>;

/** Body of PATCH /api/v1/integrations/connections/:id: any of the three. */
export const IntegrationUpdate = z
  .strictObject({
    label: label.optional(),
    credential: credential.optional(),
    targets: targets.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Send label, credential or targets.",
  });
export type IntegrationUpdate = z.infer<typeof IntegrationUpdate>;

export const IntegrationTarget = z.object({
  /** `owner/repo` or a Linear team ID. */
  id: z.string(),
  /** What people see: the repository, or the team's name as Linear reported it. */
  name: z.string(),
});
export type IntegrationTarget = z.infer<typeof IntegrationTarget>;

/**
 * `credential_rejected`: the service refused the credential (revoked, expired); `key_unavailable`:
 * it was sealed with a key the Workers no longer hold. Either needs an admin to paste a new one.
 */
export const IntegrationAttention = z.enum(["credential_rejected", "key_unavailable"]);
export type IntegrationAttention = z.infer<typeof IntegrationAttention>;

/** What the owner side sees to pick a connection: names and targets, never the credential. */
export const IntegrationChoice = z.object({
  id: IntegrationConnectionId,
  service: IntegrationService,
  label: z.string(),
  targets: z.array(IntegrationTarget),
  /** False while it needs an admin's attention: issues cannot be created through it. */
  usable: z.boolean(),
});
export type IntegrationChoice = z.infer<typeof IntegrationChoice>;

/** GET /api/v1/integrations and the MCP `list_integrations` tool. */
export const IntegrationChoiceList = z.object({
  connections: z.array(IntegrationChoice),
  /** The owner's plan includes `integrations`. */
  available: z.boolean(),
  /** The platform offers integrations at all (`INTEGRATIONS_ENABLED`). */
  serviceAvailable: z.boolean(),
  /** The owner's region keeps its data in the EU: comment text sent leaves the EU. */
  euResidency: z.boolean(),
});
export type IntegrationChoiceList = z.infer<typeof IntegrationChoiceList>;

/** A connection as its admins see it: the credential only as its last four characters. */
export const IntegrationConnectionView = IntegrationChoice.extend({
  /** The account the credential acts as, as the service reported it at the last check. */
  identity: z.string(),
  credentialHint: z.string(),
  attention: IntegrationAttention.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  createdBy: z.string().nullable(),
});
export type IntegrationConnectionView = z.infer<typeof IntegrationConnectionView>;

/** GET /api/v1/integrations/connections (admins, dashboard session only). */
export const IntegrationConnectionList = z.object({
  connections: z.array(IntegrationConnectionView),
  available: z.boolean(),
  serviceAvailable: z.boolean(),
  limit: z.number().int(),
  targetLimit: z.number().int(),
});
export type IntegrationConnectionList = z.infer<typeof IntegrationConnectionList>;

/** Why a check of a credential failed, in words for the admin. */
export const IntegrationCheckProblem = z.enum([
  "credential_rejected",
  "missing_permission",
  "target_unreachable",
  "issues_disabled",
  "service_unavailable",
  "rate_limited",
]);
export type IntegrationCheckProblem = z.infer<typeof IntegrationCheckProblem>;

/** POST /api/v1/integrations/connections/:id/test. */
export const IntegrationTestResult = z.object({
  ok: z.boolean(),
  identity: z.string().nullable(),
  problem: IntegrationCheckProblem.nullable(),
  /** The target the problem is about, when one is. */
  target: z.string().nullable(),
  message: z.string(),
});
export type IntegrationTestResult = z.infer<typeof IntegrationTestResult>;

/**
 * Which parts of the thread go into the issue. The link and the artifact's name are on unless
 * the person turns them off; the quote and the first message are other people's words and are
 * sent only when the person turns them on (decision 0018, "What is sent").
 */
export const IssueParts = z.strictObject({
  link: z.boolean().default(true),
  artifactName: z.boolean().default(true),
  quote: z.boolean().default(false),
  message: z.boolean().default(false),
});
export type IssueParts = z.infer<typeof IssueParts>;

/** Body of POST /api/v1/artifacts/:id/annotations/threads/:threadId/issue. */
export const ThreadIssueCreate = z.strictObject({
  connectionId: IntegrationConnectionId,
  /** `owner/repo` or a Linear team ID among the connection's targets. */
  target: z.string().trim().min(1).max(140),
  title: z.string().trim().min(1).max(INTEGRATION_LIMITS.titleMax),
  include: IssueParts.default({ link: true, artifactName: true, quote: false, message: false }),
});
export type ThreadIssueCreate = z.input<typeof ThreadIssueCreate>;

/** Input of the MCP `list_integrations` tool. */
export const ListIntegrationsInput = z.object({
  workspace: z
    .string()
    .max(40)
    .optional()
    .describe(
      "The workspace slug, as list_workspaces returns it. Omit it for your personal space.",
    ),
});
export type ListIntegrationsInput = z.infer<typeof ListIntegrationsInput>;

/** Input of the MCP `create_issue_from_thread` tool. */
export const CreateIssueFromThreadInput = z.object({
  artifactId: ArtifactId,
  threadId: z.string().min(1).max(200).describe("The thread's ID, as list_annotations returns it."),
  connectionId: IntegrationConnectionId.describe("A connection from list_integrations."),
  target: z
    .string()
    .trim()
    .min(1)
    .max(140)
    .describe("One of the connection's targets: owner/repo on GitHub, a team ID on Linear."),
  title: z.string().trim().min(1).max(INTEGRATION_LIMITS.titleMax).describe("The issue's title."),
  include: IssueParts.optional().describe(
    "Which parts go into the issue. link and artifactName default to true; quote and message (other people's words) default to false.",
  ),
  idempotencyKey: z
    .string()
    .min(8)
    .max(128)
    .optional()
    .describe("Send the same key when retrying, so a retry never creates a second issue."),
});
export type CreateIssueFromThreadInput = z.infer<typeof CreateIssueFromThreadInput>;

export const ThreadIssueState = z.enum(["pending", "created", "failed"]);
export type ThreadIssueState = z.infer<typeof ThreadIssueState>;

/** Why an issue was not created, in words the person who asked reads. */
export const ThreadIssueFailure = z.enum([
  "credential_rejected",
  "target_unreachable",
  "rejected",
  "connection_removed",
  "unavailable",
  "plan_lapsed",
  "service_unavailable",
  "invalid_response",
  /** An admin removed the repository or team from the connection before the issue was sent. */
  "target_removed",
  /** The artifact moved to another owner before the issue was sent. */
  "artifact_moved",
  /** The person who asked no longer acts for the owner (left, removed or account deleted). */
  "requester_left",
  /** The thread was deleted, or is no longer one the person who asked reads. */
  "thread_gone",
]);
export type ThreadIssueFailure = z.infer<typeof ThreadIssueFailure>;

/**
 * An issue linked to a thread. Everyone who sees the thread sees a created one; a pending or
 * failed one is shown only to the person who asked.
 */
export const ThreadIssueView = z.object({
  id: ThreadIssueId,
  service: IntegrationService,
  /** `owner/repo`, or the Linear team's name. */
  target: z.string(),
  state: ThreadIssueState,
  /** `#123` on GitHub, the identifier (`ENG-42`) on Linear; null until created. */
  key: z.string().nullable(),
  /** On the service's own web host; null until created. */
  url: z.url().nullable(),
  failure: ThreadIssueFailure.nullable(),
  own: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type ThreadIssueView = z.infer<typeof ThreadIssueView>;

/** What an issue's body is built from (`issueBody` in the domain). */
export interface IssueSource {
  service: IntegrationService;
  /** The thread in the viewer. */
  link: string;
  artifactName: string;
  quote: string | null;
  message: string | null;
  /** The marker that finds an issue whose creation answer was lost (`ti_…`). */
  reference: string;
}
