// MCP tools for custom domains (premium plan P7, decision 0006): add_custom_domain,
// verify_custom_domain, list_custom_domains, get_custom_domain and remove_custom_domain. Each
// calls the same service as its /api/v1 route, with the same scope, and returns the same body,
// so the plan gate, the role checks and the errors are the API's.
import {
  AddCustomDomainInput,
  CustomDomainList,
  CustomDomainRemoved,
  CustomDomainView,
  ERROR_STATUS,
  type ErrorCode,
  HostnameToolInput,
  ListCustomDomainsInput,
  type OAuthScope,
  RemoveCustomDomainInput,
} from "@portifact/contracts";
import type { RegionalDb } from "@portifact/db";
import {
  addCustomDomain,
  getCustomDomain,
  hashRequest,
  removeCustomDomain,
  runIdempotent,
  type StoredResponse,
  verifyCustomDomain,
} from "@portifact/services";
import { customDomainListView, customDomainView, domainListing } from "../api/domains.ts";
import { regionsOf } from "../regions.ts";
import { failure, type RegisterTool, success, type ToolContext } from "./tools.ts";

export const DOMAIN_TOOL_SCOPES: [string, OAuthScope][] = [
  ["add_custom_domain", "artifacts:share"],
  ["verify_custom_domain", "artifacts:share"],
  ["list_custom_domains", "artifacts:read"],
  ["get_custom_domain", "artifacts:read"],
  ["remove_custom_domain", "artifacts:share"],
];

/** What the tools add to every domain: the bar's effect, which the owner may want to change. */
const BAR_NOTE =
  "While the artifact's Portifact bar is on, visits to the custom domain still open in the viewer on app.portifact.com; turn the bar off (set_portifact_bar) for the domain to stay in the address bar. Ask the user before changing it.";

function describe(view: CustomDomainView): string {
  const [txt, cname] = view.records;
  switch (view.state) {
    case "pending":
      return [
        `${view.hostname} is waiting for its DNS records${view.problem === "txt_missing" ? " (the TXT record does not hold the value yet; DNS changes can take a few minutes)" : ""}.`,
        `Ask the user to create: TXT ${txt?.name} = ${txt?.value}, and CNAME ${cname?.name} -> ${cname?.value}. Then call verify_custom_domain.`,
      ].join(" ");
    case "provisioning":
      return `${view.hostname} is proven; Cloudflare is issuing its certificate${view.problem === "certificate_pending" || view.problem === "cname_elsewhere" ? ` (check that the CNAME points at ${cname?.value})` : ""}. Call verify_custom_domain again in a few minutes.`;
    case "active":
      return `${view.hostname} serves ${view.artifactId}. Keep the TXT record: it is checked daily and the domain is removed after three misses. The name must keep pointing at ${cname?.value}, checked daily too.${view.problem === "txt_missing" ? " The TXT record is missing now." : ""}${view.problem === "cname_elsewhere" ? ` The name does not point at ${cname?.value} now; ask the user to point it back.` : ""}`;
    case "removing":
      return `${view.hostname} is being removed.`;
  }
}

export function registerDomainTools(
  register: RegisterTool,
  context: ToolContext,
  db: RegionalDb,
): void {
  register(
    "add_custom_domain",
    {
      title: "Add a custom domain",
      description:
        "Start serving one of the user's artifacts from a hostname the user controls, such as docs.example.com (a subdomain; not an apex domain or a wildcard). One domain per artifact. Returns the two DNS records the user must create at their DNS provider: a TXT record that proves they control the name (keep it: it is checked daily) and a CNAME to Portifact. Then call verify_custom_domain. A domain changes where the artifact is reachable: only call it after the user asked for this domain on this artifact. Custom domains are part of a paid plan (plan_required otherwise), and the plan sets how many. " +
        BAR_NOTE,
      inputSchema: AddCustomDomainInput,
      outputSchema: CustomDomainView,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args: AddCustomDomainInput) => {
      const { idempotencyKey, artifactId, hostname } = args;
      const now = context.now();
      const run = async (): Promise<StoredResponse> => {
        const result = await addCustomDomain(regionsOf(context.env), context.domains, {
          userId: context.userId,
          artifactId,
          hostname,
          contentDomain: context.env.CONTENT_DOMAIN,
          now,
        });
        if (!result.ok) {
          return {
            status: ERROR_STATUS[result.code],
            body: { error: { code: result.code, message: result.message } },
          };
        }
        return { status: 201, body: customDomainView(context.env, result.value) };
      };
      let response: StoredResponse;
      if (!idempotencyKey) {
        response = await run();
      } else {
        // The API's operation name, so a key used there and here answers the same domain.
        const outcome = await runIdempotent(
          db,
          {
            actorId: context.userId,
            key: idempotencyKey,
            operation: "domain.add",
            requestHash: await hashRequest({ artifactId, hostname }),
            now,
          },
          run,
        );
        if (outcome.kind === "mismatch") {
          return failure("invalid_input", "This idempotency key was used for a different request.");
        }
        if (outcome.kind === "in_progress") {
          return failure(
            "version_conflict",
            "A request with this idempotency key is still running.",
          );
        }
        response = outcome.response;
      }
      const body = response.body as
        | CustomDomainView
        | { error: { code: ErrorCode; message: string } };
      if ("error" in body) return failure(body.error.code, body.error.message);
      return success(`${describe(body)} ${BAR_NOTE}`, body);
    },
  );

  register(
    "verify_custom_domain",
    {
      title: "Check a custom domain",
      description:
        "Check a custom domain of the user's artifact again: the TXT record of a pending domain (which proves the user controls the name, after which Portifact sets up the hostname and its certificate), whether a proven domain is active yet, and the TXT record of an active one. Safe to call again. Returns the domain with its state (pending, provisioning, active, removing) and any problem found.",
      inputSchema: HostnameToolInput,
      outputSchema: CustomDomainView,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ hostname }: HostnameToolInput) => {
      const result = await verifyCustomDomain(regionsOf(context.env), context.domains, {
        userId: context.userId,
        hostname,
        now: context.now(),
      });
      if (!result.ok) return failure(result.code, result.message);
      const body = customDomainView(context.env, result.value);
      return success(describe(body), body);
    },
  );

  register(
    "list_custom_domains",
    {
      title: "List custom domains",
      description:
        "List the user's custom domains and pending ones, oldest first, with the DNS records each needs, its state and problems, plus how many the plan allows (limit, used) and whether custom domains are available at all. Pass artifactId for one artifact's domain and its owner's plan.",
      inputSchema: ListCustomDomainsInput,
      outputSchema: CustomDomainList,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ artifactId }: ListCustomDomainsInput) => {
      const result = await domainListing(context.env, context.domains, {
        userId: context.userId,
        artifactId,
        now: context.now(),
      });
      if (!result.ok) return failure(result.code, result.message);
      const body = customDomainListView(context.env, result.value);
      const lines =
        body.domains.length === 0
          ? ["No custom domains."]
          : body.domains.map(
              (domain) => `${domain.hostname} ${domain.state} for ${domain.artifactId}`,
            );
      lines.push(`Plan: ${body.used} of ${body.limit} custom domain(s) used.`);
      if (!body.available) lines.push("Custom domains are not available on this server yet.");
      return success(lines.join("\n"), body);
    },
  );

  register(
    "get_custom_domain",
    {
      title: "Get a custom domain",
      description:
        "Get one of the user's custom domains by hostname: its state, the DNS records it needs and any problem the last check found.",
      inputSchema: HostnameToolInput,
      outputSchema: CustomDomainView,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ hostname }: HostnameToolInput) => {
      const result = await getCustomDomain(regionsOf(context.env), {
        userId: context.userId,
        hostname,
        now: context.now(),
      });
      if (!result.ok) return failure(result.code, result.message);
      const body = customDomainView(context.env, result.value);
      return success(describe(body), body);
    },
  );

  register(
    "remove_custom_domain",
    {
      title: "Remove a custom domain",
      description:
        "Stop serving the user's artifact on a custom domain (or drop a pending one). The artifact keeps its Portifact address; adding the domain again needs a new DNS proof. Ask the user first, then pass confirm equal to the hostname. Returns the removed hostname.",
      inputSchema: RemoveCustomDomainInput,
      outputSchema: CustomDomainRemoved,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ hostname, confirm }: RemoveCustomDomainInput) => {
      if (confirm.trim().toLowerCase() !== hostname.trim().toLowerCase()) {
        return failure("invalid_input", "Pass confirm equal to the hostname to remove it.");
      }
      const result = await removeCustomDomain(regionsOf(context.env), {
        userId: context.userId,
        hostname,
        now: context.now(),
      });
      if (!result.ok) return failure(result.code, result.message);
      const body = CustomDomainRemoved.parse({ hostname: result.value.hostname, removed: true });
      return success(`Removed ${body.hostname}.`, body);
    },
  );
}
