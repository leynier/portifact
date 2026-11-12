// Shapes of issue integrations (premium plan T7, feature `integrations`, decision 0018): an
// owner's connections to GitHub Issues, Linear or Jira Cloud, managed by its admins through the dashboard
// session only, and the issues the owner side creates from comment threads, which the jobs
// Worker sends. Credentials never appear in any of these shapes after they are pasted.
import { z } from "zod";
import { ArtifactId } from "./core.ts";

/** The services a connection can reach. Each has one fixed API host (decision 0018). */
export const INTEGRATION_SERVICES = ["github", "linear", "jira"] as const;
export const IntegrationService = z.enum(INTEGRATION_SERVICES);
export type IntegrationService = z.infer<typeof IntegrationService>;

/**
 * The services a connection can be made to: the issue trackers, plus Slack (decision 0025), whose
 * connection previews links and creates no issue. A Slack connection is never an issue target.
 */
export const CONNECTION_SERVICES = [...INTEGRATION_SERVICES, "slack"] as const;
export const ConnectionService = z.enum(CONNECTION_SERVICES);
export type ConnectionService = z.infer<typeof ConnectionService>;

/** Whether a service named in a response is one this build knows. */
export function isIntegrationService(value: string): value is IntegrationService {
  return (INTEGRATION_SERVICES as readonly string[]).includes(value);
}

/**
 * A service as a response the CLI and MCP read names it: one of `INTEGRATION_SERVICES`, or one a
 * newer server added. Released clients validate responses, so a closed enum here would make every
 * client older than a new service fail on a thread or a listing that mentions it (decision 0018,
 * "Addendum: Jira"). Inputs keep the strict `IntegrationService`.
 */
export const IntegrationServiceName = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);

/** Safety caps and timings of integrations; not plan values (decision 0018). */
export const INTEGRATION_LIMITS = {
  /** Connections one owner can have. */
  perOwner: 5,
  /** Repositories or teams one connection allows. */
  targetsPerConnection: 10,
  labelMax: 60,
  /** The longest credential accepted; GitHub tokens, Linear keys and Atlassian tokens are shorter. */
  credentialMax: 255,
  /** The longest Atlassian account email accepted with a Jira token. */
  accountMax: 254,
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
  /**
   * How much earlier than its request a found Jira issue may say it was created and still be
   * adopted after a lost answer: clock skew between Portifact and Jira (decision 0018, "Jira").
   */
  lookupSkewMs: 120_000,
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

/**
 * The fixed API endpoints. Never a host from input (decision 0018). Jira goes through Atlassian's
 * API gateway, `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/...`: the origin is fixed and
 * the site is named only by its validated cloud ID in the path (decision 0018, "Jira").
 */
export const INTEGRATION_API = {
  github: "https://api.github.com",
  linear: "https://api.linear.app/graphql",
  jira: "https://api.atlassian.com",
  /** Slack's Web API (decision 0025): `auth.test`, `auth.revoke` and, later, `chat.unfurl`. */
  slack: "https://slack.com",
} as const satisfies Record<ConnectionService, string>;

/**
 * Bounds of the Slack connection (decision 0025): the inbound events endpoint and the calls to
 * Slack's Web API. Safety caps, not plan values.
 */
export const SLACK_LIMITS = {
  /** Bytes of an inbound request's body read at most. */
  bodyBytes: 64 * 1024,
  /** How far `X-Slack-Request-Timestamp` may be from the Worker's clock (Slack's own advice). */
  timestampSkewSeconds: 300,
  /** One call to Slack's Web API. */
  timeoutMs: 5_000,
  /** Bytes of Slack's answer read at most. */
  responseReadBytes: 16 * 1024,
  /** A started connection that was never completed is deleted after this long. */
  pendingMs: 24 * 3_600_000,
  /** Bot token characters accepted at most. */
  tokenMax: 255,
  /** Distinct artifacts one `link_shared` event previews at most (decision 0025). */
  linksPerEvent: 5,
  /** Links of one event looked at at most, previewable or not. */
  linksScanned: 50,
  /** Characters of a posted URL looked at at most; a longer one is ignored. */
  urlMax: 2048,
  /** Code points of an artifact's name in a preview at most, the ellipsis included. */
  nameMax: 150,
} as const;

/**
 * The version of the manifest Portifact shows (`slackManifest`), stored on a connection when it is
 * completed, so the page can tell which connections run an older one. Raise it when the manifest
 * changes.
 */
export const SLACK_MANIFEST_VERSION = 1;

/**
 * The web hosts an issue's URL must be on. Jira's is a suffix: an issue's link is
 * `https://<site>.atlassian.net/browse/<KEY>`, built by Portifact from the site name the gateway
 * confirmed and the key Jira returned, only ever rendered as a link and never fetched.
 */
export const INTEGRATION_WEB_HOSTS = {
  github: "github.com",
  linear: "linear.app",
  jira: "atlassian.net",
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

/**
 * A Jira project key: an uppercase letter, then uppercase letters, digits or underscores, 2 to 10
 * characters (Jira Cloud's rule). It is the target of a Jira connection.
 */
export const JiraProjectKey = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{1,9}$/, "Use a project key, such as ENG.");

/** An Atlassian cloud ID (a UUID), as `https://<site>.atlassian.net/_edge/tenant_info` shows it. */
export const JiraCloudId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "Use the cloud ID.");

/**
 * A Jira Cloud site's name, the `<name>` of `<name>.atlassian.net`: one DNS label of lowercase
 * letters, digits and hyphens. Never called: it only builds issue links (decision 0018, "Jira").
 */
export const JiraSiteName = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, "Use the site name, such as acme.");

const label = z.string().trim().min(1).max(INTEGRATION_LIMITS.labelMax);
const credential = z
  .string()
  .trim()
  .min(INTEGRATION_LIMITS.credentialMin, "That does not look like a token or key.")
  .max(INTEGRATION_LIMITS.credentialMax)
  .regex(/^[\x21-\x7e]+$/, "That does not look like a token or key.");
const targets = z
  .array(z.string().trim().min(1).max(140))
  .min(1, "Choose at least one repository, team or project.")
  .max(INTEGRATION_LIMITS.targetsPerConnection)
  .refine((list) => new Set(list.map((t) => t.toLowerCase())).size === list.length, {
    message: "List each target once.",
  });

/**
 * The Atlassian account email a Jira API token goes with (Basic authentication). Part of the
 * sealed credential: never stored in the clear, shown, logged or audited (decision 0018, "Jira").
 */
const account = z
  .string()
  .trim()
  .min(3)
  .max(INTEGRATION_LIMITS.accountMax)
  .regex(/^[^\s@]+@[^\s@]+$/, "Use the email address of the token's Atlassian account.");

/** Connecting an issue tracker: the credential and targets, checked before anything is stored. */
export const IssueConnectionCreate = z
  .strictObject({
    service: IntegrationService,
    label,
    credential,
    /** GitHub: `owner/repo`; Linear: team IDs; Jira: project keys. Checked before saving. */
    targets,
    /** Jira only: the token's Atlassian account email. */
    account: account.optional(),
    /** Jira only: the site name (`acme`, or `acme.atlassian.net`), checked against the cloud ID. */
    site: z.string().trim().min(1).max(300).optional(),
    /** Jira only: the site's cloud ID. */
    cloudId: z.string().trim().toLowerCase().pipe(JiraCloudId).optional(),
  })
  .superRefine((body, ctx) => {
    const jira = body.service === "jira";
    for (const field of ["account", "site", "cloudId"] as const) {
      if (jira && body[field] === undefined) {
        ctx.addIssue({ code: "custom", path: [field], message: `Jira needs ${field}.` });
      }
      if (!jira && body[field] !== undefined) {
        ctx.addIssue({ code: "custom", path: [field], message: `Only Jira takes ${field}.` });
      }
    }
  });
export type IssueConnectionCreate = z.infer<typeof IssueConnectionCreate>;

/**
 * Starting a Slack connection (decision 0025): only a label. The server stores a pending row and
 * answers the manifest; the bot token and signing secret come with the PATCH that completes it.
 */
export const SlackConnectionCreate = z.strictObject({
  service: z.literal("slack"),
  label,
});

/** Body of POST /api/v1/integrations/connections (dashboard session only). */
export const IntegrationCreate = z.discriminatedUnion("service", [
  IssueConnectionCreate,
  SlackConnectionCreate,
]);
export type IntegrationCreate = z.infer<typeof IntegrationCreate>;

/**
 * Body of PATCH /api/v1/integrations/connections/:id: any of label, credential and targets. A Jira
 * token comes with its account's email (`account`), which is sealed with it.
 */
export const IntegrationUpdate = z
  .strictObject({
    label: label.optional(),
    credential: credential.optional(),
    targets: targets.optional(),
    account: account.optional(),
    /** Slack only: the app's bot token (`xoxb-`), checked with `auth.test`. */
    botToken: z.string().trim().min(1).max(SLACK_LIMITS.tokenMax).optional(),
    /** Slack only: the app's signing secret, sent with the bot token. */
    signingSecret: z.string().trim().min(1).max(128).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Send label, credential or targets.",
  })
  .refine((body) => (body.botToken === undefined) === (body.signingSecret === undefined), {
    message: "Send the bot token and the signing secret together.",
  })
  .refine((body) => body.account === undefined || body.credential !== undefined, {
    message: "Send the account's email only with a new token.",
  });
export type IntegrationUpdate = z.infer<typeof IntegrationUpdate>;

export const IntegrationTarget = z.object({
  /** `owner/repo`, a Linear team ID or a Jira project key. */
  id: z.string(),
  /** What people see: the repository, or the team's or project's name as the service reported it. */
  name: z.string(),
});
export type IntegrationTarget = z.infer<typeof IntegrationTarget>;

/**
 * `credential_rejected`: the service refused the credential (revoked, expired); `key_unavailable`:
 * it was sealed with a key the Workers no longer hold. Either needs an admin to paste a new one.
 */
export const INTEGRATION_FAILING_REASONS = [
  "credential_rejected",
  "key_unavailable",
  /** Jira: the cloud ID no longer serves the stored site name (the site changed its address). */
  "site_mismatch",
  /** Slack: the app was uninstalled or its tokens revoked (`app_uninstalled`, `tokens_revoked`). */
  "app_uninstalled",
] as const;
/** Why a connection stopped working: the reason of `integration.failing`. */
export const IntegrationFailingReason = z.enum(INTEGRATION_FAILING_REASONS);
export type IntegrationFailingReason = z.infer<typeof IntegrationFailingReason>;

/**
 * Why a connection cannot be used: a failing reason, or `pending`, a Slack connection started and
 * not completed yet (it holds no credential).
 */
export const IntegrationAttention = z.enum([...INTEGRATION_FAILING_REASONS, "pending"]);
export type IntegrationAttention = z.infer<typeof IntegrationAttention>;

/** What the owner side sees to pick a connection: names and targets, never the credential. */
export const IntegrationChoice = z.object({
  id: IntegrationConnectionId,
  /** Tolerant: a client older than a service lists it as it comes (`IntegrationServiceName`). */
  service: IntegrationServiceName,
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
/**
 * How a Slack connection is set up (decision 0025): the events endpoint, the manifest Portifact
 * shows and Slack's prefilled "create from manifest" link. Nothing secret.
 */
export const SlackSetupView = z.object({
  requestUrl: z.url(),
  /** The manifest as JSON text, to copy into Slack. */
  manifest: z.string(),
  /** `https://api.slack.com/apps?new_app=1&manifest_json=…` */
  createUrl: z.url(),
  /** The manifest version the connection was completed with; null while pending. */
  manifestVersion: z.number().int().nullable(),
  /** Completed with an older manifest than the one shown now. */
  outdated: z.boolean(),
});
export type SlackSetupView = z.infer<typeof SlackSetupView>;

export const IntegrationConnectionView = IntegrationChoice.extend({
  /** Only the dashboard reads this, deployed with the server: the strict service. */
  service: ConnectionService,
  /** Slack only: how to set the app up; null for the other services. */
  slack: SlackSetupView.nullable(),
  /** Jira: the site's name (`acme` for `acme.atlassian.net`); null for the other services. */
  site: z.string().nullable(),
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
  /** Slack connections can be started and completed (`SLACK_ENABLED`, decision 0025). */
  slackAvailable: z.boolean(),
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
  /** Jira: the cloud ID is unknown, or its site is not the one named. */
  "site_mismatch",
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
  /**
   * Jira: the projects whose issue type Portifact had to change because the project no longer
   * has the stored one; the test saved the current one. Empty otherwise.
   */
  refreshed: z.array(z.string()).default([]),
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
  /** `owner/repo`, a Linear team ID or a Jira project key among the connection's targets. */
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
    .describe(
      "One of the connection's targets: owner/repo on GitHub, a team ID on Linear, a project key on Jira.",
    ),
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
  /** An admin removed the repository, team or project from the connection before the issue was sent. */
  "target_removed",
  /** The artifact moved to another owner before the issue was sent. */
  "artifact_moved",
  /** The person who asked no longer acts for the owner (left, removed or account deleted). */
  "requester_left",
  /** The thread was deleted, or is no longer one the person who asked reads. */
  "thread_gone",
  /** Jira: the connection's cloud ID no longer serves its site; an admin connects it again. */
  "site_changed",
]);
export type ThreadIssueFailure = z.infer<typeof ThreadIssueFailure>;

/**
 * An issue linked to a thread. Everyone who sees the thread sees a created one; a pending or
 * failed one is shown only to the person who asked.
 */
export const ThreadIssueView = z.object({
  id: ThreadIssueId,
  /** Tolerant, like `IntegrationChoice.service`: a client shows a newer service as it comes. */
  service: IntegrationServiceName,
  /** `owner/repo`, or the Linear team's or Jira project's name. */
  target: z.string(),
  state: ThreadIssueState,
  /** `#123` on GitHub, the identifier (`ENG-42`) on Linear and Jira; null until created. */
  key: z.string().nullable(),
  /** On the service's own web host; null until created. */
  url: z.url().nullable(),
  /**
   * Tolerant too: a value of `ThreadIssueFailure`, or one a newer server added, which clients show
   * with a neutral sentence.
   */
  failure: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/)
    .nullable(),
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
