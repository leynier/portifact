// MCP tools for sharing (plan section 6, "Acceso y ciclo"): set_access, add_reader and
// remove_reader. Each one is a change to the access policy, validated as the body of
// PATCH /api/v1/artifacts/:id/access and applied by the same service with the same scope, so
// the new-account wait before public access, the reader limits and the errors are the API's.
import {
  AccessPolicyView,
  AccessUpdate,
  GroupChangeInput,
  type OAuthScope,
  ReaderChangeInput,
  SetAccessInput,
} from "@portifact/contracts";
import type { RegionalDb } from "@portifact/db";
import { updateAccess } from "@portifact/services";
import { artifactDb } from "../regions.ts";
import { failure, type RegisterTool, success, type ToolContext } from "./tools.ts";

export const ACCESS_TOOL_SCOPES: [string, OAuthScope][] = [
  ["set_access", "artifacts:share"],
  ["add_reader", "artifacts:share"],
  ["remove_reader", "artifacts:share"],
  ["add_group", "artifacts:share"],
  ["remove_group", "artifacts:share"],
];

const CHANGE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export function registerAccessTools(
  register: RegisterTool,
  context: ToolContext,
  db: RegionalDb,
): void {
  /** Validates `change` as the API's body and applies it; the result is the API's answer. */
  const apply = async (
    artifactId: string,
    change: Record<string, unknown>,
    summary: (body: AccessPolicyView) => string,
  ) => {
    const parsed = AccessUpdate.safeParse(change);
    if (!parsed.success) {
      // Worded like the API's body validation, so both answer with the same message.
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
      return failure("invalid_input", `${where}${issue?.message ?? "Invalid input."}`);
    }
    const result = await updateAccess(await artifactDb(context.env, artifactId), {
      userId: context.userId,
      artifactId,
      change: parsed.data,
      now: context.now(),
    });
    if (!result.ok) return failure(result.code, result.message);
    const body = AccessPolicyView.parse(result.value);
    return success(summary(body), body);
  };

  const describe = (artifactId: string, body: AccessPolicyView) => {
    const members = body.audience?.members ?? 0;
    const domains = body.audience?.domains ?? [];
    const lapsed = body.audience?.featureAvailable === false;
    const who =
      body.mode === "public"
        ? "anyone with the link"
        : body.mode === "authenticated"
          ? "anyone signed in to Portifact"
          : body.mode === "workspace"
            ? `the ${members} member(s) of its workspace, after signing in`
            : body.mode === "domain"
              ? lapsed
                ? `the ${members} member(s) of its workspace only, because the workspace's plan does not include workspace sharing now`
                : `the ${members} member(s) of its workspace and anyone signed in with a verified address at ${domains.length > 0 ? domains.join(", ") : "no verified domain yet"}`
              : `the owner, ${body.readers.length} reader(s) on the list${body.groups.length > 0 ? ` and the members of ${body.groups.length} group(s) (${body.groups.map((group) => `${group.name}: ${group.members}`).join(", ")})` : ""}, after signing in`;
    return `${artifactId} can now be opened by ${who}; ${body.indexable ? "indexable" : "noindex"}, ${body.embeddable ? "embeddable" : "not embeddable"}.`;
  };

  register(
    "set_access",
    {
      title: "Set who can open an artifact",
      description:
        "Change who can open the user's artifact: mode restricted (the owner and the readers on the list, after signing in; the default), authenticated (anyone signed in to Portifact), public (anyone with the link), and for an artifact a workspace owns, workspace (every member of that workspace) or domain (every member plus anyone signed in with a verified address at one of the workspace's verified email domains; its admins verify domains in the dashboard). The workspace modes need a plan with workspace sharing (plan_required) and refuse a personal artifact (invalid_input). For public artifacts, indexable lets search engines index it and embeddable lets other sites frame it; both are off by default and apply only while the artifact is public. Widening access exposes the artifact to more people: ask the user first, and only call it with authenticated, public, workspace, domain, indexable or embeddable after the user asked for exactly that. New accounts wait 15 minutes before making anything public (account_too_new_for_public). A workspace whose policy forbids public access refuses public for everyone, admins included (policy_refused; its policy is in list_workspaces). Readers whose access ends lose it within a minute. Returns the access policy.",
      inputSchema: SetAccessInput,
      outputSchema: AccessPolicyView,
      annotations: CHANGE,
    },
    async (args: SetAccessInput) => {
      const { artifactId, ...change } = args;
      return apply(artifactId, change, (body) => describe(artifactId, body));
    },
  );

  register(
    "add_reader",
    {
      title: "Add readers",
      description:
        "Add email addresses to the reader list of the user's artifact. In restricted mode only the owner and these readers can open it, after signing in with that verified address; Portifact sends them no email, so share the link yourself. Adding readers shows them the artifact: only add addresses the user gave you for this artifact. A workspace's reader domain policy (readerDomains in list_workspaces) refuses addresses at other domains (policy_refused). Returns the access policy.",
      inputSchema: ReaderChangeInput,
      outputSchema: AccessPolicyView,
      annotations: CHANGE,
    },
    async (args: ReaderChangeInput) =>
      apply(args.artifactId, { addReaders: args.emails }, (body) =>
        describe(args.artifactId, body),
      ),
  );

  register(
    "add_group",
    {
      title: "Add workspace groups",
      description:
        "List groups of the artifact's own workspace on the artifact (IDs from list_groups). In restricted mode the members of these groups can open it, after signing in, like readers on the list; in other modes groups only carry comment exceptions. Needs a plan with workspace sharing (plan_required) and refuses a personal artifact (invalid_input). Adding a group shows the artifact to every one of its members: ask the user first and only add the groups they named for this artifact. Returns the access policy.",
      inputSchema: GroupChangeInput,
      outputSchema: AccessPolicyView,
      annotations: CHANGE,
    },
    async (args: GroupChangeInput) =>
      apply(args.artifactId, { addGroups: args.groups }, (body) => describe(args.artifactId, body)),
  );

  register(
    "remove_group",
    {
      title: "Remove workspace groups",
      description:
        "Remove groups from the artifact. Their members' open read sessions stop working at once, unless a reader entry or their role still lets them read. Removing a group that is not on the artifact changes nothing. Returns the access policy.",
      inputSchema: GroupChangeInput,
      outputSchema: AccessPolicyView,
      annotations: CHANGE,
    },
    async (args: GroupChangeInput) =>
      apply(args.artifactId, { removeGroups: args.groups }, (body) =>
        describe(args.artifactId, body),
      ),
  );

  register(
    "remove_reader",
    {
      title: "Remove readers",
      description:
        "Remove email addresses from the reader list of the user's artifact. Their open read sessions stop working within a minute. Removing an address that is not on the list changes nothing. Returns the access policy.",
      inputSchema: ReaderChangeInput,
      outputSchema: AccessPolicyView,
      annotations: CHANGE,
    },
    async (args: ReaderChangeInput) =>
      apply(args.artifactId, { removeReaders: args.emails }, (body) =>
        describe(args.artifactId, body),
      ),
  );
}
