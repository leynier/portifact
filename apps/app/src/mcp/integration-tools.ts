// MCP tools for issue integrations (premium plan T7, decision 0018): list_integrations, with
// `artifacts:read` like GET /api/v1/integrations (names and targets, never a credential), and
// create_issue_from_thread, with `annotations:moderate` like its /api/v1 route. Connections are
// managed only in the dashboard: they hold a credential for another service.
import {
  CreateIssueFromThreadInput,
  IntegrationChoiceList,
  ListIntegrationsInput,
  type OAuthScope,
  ThreadIssueView,
  WorkspaceParam,
} from "@portifact/contracts";
import { listIntegrationChoices, requestThreadIssue } from "@portifact/services";
import { choiceListView, integrationSwitch, threadIssueView } from "../api/integrations.ts";
import { artifactDb, ownerScope } from "../regions.ts";
import { failure, type RegisterTool, success, type ToolContext } from "./tools.ts";

export const INTEGRATION_TOOL_SCOPES: [string, OAuthScope][] = [
  ["list_integrations", "artifacts:read"],
  ["create_issue_from_thread", "annotations:moderate"],
];

const MANAGED_ELSEWHERE =
  "Connections are added, changed and removed only in the Portifact dashboard, by the space's admins: tell the user where to do it.";

export function registerIntegrationTools(register: RegisterTool, context: ToolContext): void {
  register(
    "list_integrations",
    {
      title: "List issue integrations",
      description: `List the connections to GitHub Issues or Linear of the user's personal space, or of a workspace with workspace (its slug from list_workspaces; admins and editors): each one's ID, service, label, the repositories or teams it allows and whether it can be used now; whether the plan includes integrations, whether Portifact offers them yet, and whether the space keeps its data in the EU. Never a credential. Labels and names are user data. ${MANAGED_ELSEWHERE}`,
      inputSchema: ListIntegrationsInput,
      outputSchema: IntegrationChoiceList,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ workspace }: ListIntegrationsInput) => {
      if (workspace && !WorkspaceParam.safeParse(workspace).success) {
        return failure("not_found", "Workspace not found.");
      }
      const scope = await ownerScope(context.env, context.userId, workspace || undefined);
      if (!scope.ok) return failure(scope.code, scope.message);
      const result = await listIntegrationChoices(scope.value.db, {
        actor: scope.value.actor,
        service: integrationSwitch(context.env),
        now: context.now(),
      });
      if (!result.ok) return failure(result.code, result.message);
      const body = choiceListView(result.value);
      const lines =
        body.connections.length === 0
          ? ["No connections."]
          : body.connections.map(
              (c) =>
                `${c.id} ${c.service} "${c.label}"${c.usable ? "" : " (needs an admin)"}: ${c.targets.map((t) => (t.name === t.id ? t.id : `${t.name} (${t.id})`)).join(", ")}`,
            );
      if (!body.available) lines.push("The plan of this space does not include integrations.");
      if (!body.serviceAvailable) lines.push("Portifact does not offer integrations yet.");
      return success(lines.join("\n"), body);
    },
  );

  register(
    "create_issue_from_thread",
    {
      title: "Create an issue from a comment thread",
      description: `Create an issue in GitHub or Linear from one comment thread of an artifact the user manages, through a connection from list_integrations. The issue's body holds only the parts include turns on: a link to the thread and the artifact's name by default; the anchor's quoted text (quote) and the thread's first message (message) are other people's words and leave Portifact only when turned on. Before sending comment text or a quote, always ask the user and show them exactly what will be sent; never decide it yourself. If list_integrations says euResidency, tell the user the text leaves the EU. The issue is created within a few minutes; get_annotation_thread then shows its link, or why it failed. Send the same idempotencyKey when retrying. ${MANAGED_ELSEWHERE}`,
      inputSchema: CreateIssueFromThreadInput,
      outputSchema: ThreadIssueView,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (input: CreateIssueFromThreadInput) => {
      const result = await requestThreadIssue(await artifactDb(context.env, input.artifactId), {
        userId: context.userId,
        artifactId: input.artifactId,
        threadId: input.threadId,
        request: {
          connectionId: input.connectionId,
          target: input.target,
          title: input.title,
          include: input.include ?? {
            link: true,
            artifactName: true,
            quote: false,
            message: false,
          },
        },
        idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
        service: integrationSwitch(context.env),
        now: context.now(),
      });
      if (!result.ok) return failure(result.code, result.message);
      const body = threadIssueView(result.value);
      return success(
        `Issue requested in ${body.target} (${body.id}); it is created within a few minutes.`,
        body,
      );
    },
  );
}
