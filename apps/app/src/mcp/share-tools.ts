// MCP tools for share links (premium plan P4, decision 0008): create_share_link,
// list_share_links and revoke_share_link. Each calls the same service as its
// /api/v1/artifacts/:id/share-links route, with the same scope (`artifacts:share`), and returns
// the same body, so the plan gate, the role checks and the errors are the API's.
import {
  CreateShareLinkInput,
  ListShareLinksInput,
  type OAuthScope,
  RevokeShareLinkInput,
  ShareLinkCreated,
  ShareLinkList,
  ShareLinkRevoked,
} from "@portifact/contracts";
import { createShareLink, listShareLinks, revokeShareLink } from "@portifact/services";
import { shareLinkCreatedView, shareLinkListView } from "../api/share-links.ts";
import { artifactDb } from "../regions.ts";
import { failure, type RegisterTool, success, type ToolContext } from "./tools.ts";

export const SHARE_TOOL_SCOPES: [string, OAuthScope][] = [
  ["create_share_link", "artifacts:share"],
  ["list_share_links", "artifacts:share"],
  ["revoke_share_link", "artifacts:share"],
];

export function registerShareTools(register: RegisterTool, context: ToolContext): void {
  register(
    "create_share_link",
    {
      title: "Create a share link",
      description:
        "Create a link that lets anyone who has it read one of the user's artifacts without a Portifact account, optionally with a password and an expiry (at most 365 days). Link visitors can only read the current version: no comments, no reader list entry, and they are never identified; the access log records only that the link was used. A link widens who can open the artifact: only call it after the user asked for a share link for this artifact. The returned url holds the link's secret and is shown only once: give it to the user and do not store or repeat it elsewhere; it cannot be listed again. Share links are part of a paid plan (plan_required otherwise). A workspace's policy (list_workspaces) may disable links, require a password or limit their lifetime (policy_refused otherwise). At most 20 active links per artifact. Returns the link and its url.",
      inputSchema: CreateShareLinkInput,
      outputSchema: ShareLinkCreated,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args: CreateShareLinkInput) => {
      const result = await createShareLink(await artifactDb(context.env, args.artifactId), {
        userId: context.userId,
        artifactId: args.artifactId,
        label: args.label,
        expiresAt: args.expiresAt === undefined ? null : Date.parse(args.expiresAt),
        password: args.password,
        now: context.now(),
      });
      if (!result.ok) return failure(result.code, result.message);
      const body = shareLinkCreatedView(context.env, result.value);
      return success(
        `Created share link "${body.link.label}" (${body.link.id}) for ${args.artifactId}. Give the user this url; it is shown only once: ${body.url}`,
        body,
      );
    },
  );

  register(
    "list_share_links",
    {
      title: "List share links",
      description:
        "List the share links of one of the user's artifacts that are not revoked, newest first: id, label, whether it has a password, created, expiry and the day it was last used. Never returns a link's url or secret. enabled is false when the owner's plan no longer includes share links: the links are kept but do not open until the plan includes them again.",
      inputSchema: ListShareLinksInput,
      outputSchema: ShareLinkList,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ artifactId }: ListShareLinksInput) => {
      const result = await listShareLinks(await artifactDb(context.env, artifactId), {
        userId: context.userId,
        artifactId,
        now: context.now(),
      });
      if (!result.ok) return failure(result.code, result.message);
      const body = shareLinkListView(result.value);
      const lines =
        body.links.length === 0
          ? [`${artifactId} has no share links.`]
          : body.links.map(
              (link) =>
                `${link.id} ${link.state}${link.hasPassword ? " with password" : ""} expires ${link.expiresAt ?? "never"}: ${link.label}`,
            );
      if (!body.enabled)
        lines.push("The owner's plan does not include share links now: they do not open.");
      return success(lines.join("\n"), body);
    },
  );

  register(
    "revoke_share_link",
    {
      title: "Revoke a share link",
      description:
        "Revoke one share link of the user's artifact. Anyone who has the link can no longer open the artifact with it, and sessions opened with it end within a minute. It cannot be undone: a new link has a new url. Ask the user before revoking. Returns the revoked link's id.",
      inputSchema: RevokeShareLinkInput,
      outputSchema: ShareLinkRevoked,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ artifactId, linkId }: RevokeShareLinkInput) => {
      const result = await revokeShareLink(await artifactDb(context.env, artifactId), {
        userId: context.userId,
        artifactId,
        linkId,
        now: context.now(),
      });
      if (!result.ok) return failure(result.code, result.message);
      const body = ShareLinkRevoked.parse({ id: result.value.id, revoked: true });
      return success(`Revoked share link ${linkId} of ${artifactId}.`, body);
    },
  );
}
