// Custom domains (premium plan P7, decision 0006). Adding a domain to an artifact
// (`POST /api/v1/artifacts/:id/domain`, Idempotency-Key), verifying and removing one
// (`POST /api/v1/domains/:hostname/verify`, `DELETE /api/v1/domains/:hostname`) need
// `artifacts:share`, because a domain changes where an artifact is reachable; reading them
// (`GET /api/v1/domains`, `GET /api/v1/domains/:hostname`) needs `artifacts:read`. The MCP tools
// and `portifact domains` call the same services and present them through these views.
import {
  CustomDomainAdd,
  CustomDomainList,
  CustomDomainListQuery,
  CustomDomainRemoved,
  CustomDomainView,
  cnameTarget,
  ERROR_STATUS,
  txtRecordName,
  txtRecordValue,
} from "@portifact/contracts";
import {
  addCustomDomain,
  artifactCustomDomains,
  type DomainDeps,
  type DomainListing,
  type DomainRecord,
  getCustomDomain,
  listCustomDomains,
  removeCustomDomain,
  verifyCustomDomain,
} from "@portifact/services";
import type { Hono } from "hono";
import type { Env } from "../env.ts";
import { personalScope, regionsOf } from "../regions.ts";
import { error, type Guarded, idempotent, iso, readJson } from "./http.ts";

export function customDomainView(env: Pick<Env, "CONTENT_DOMAIN">, record: DomainRecord) {
  return CustomDomainView.parse({
    hostname: record.hostname,
    artifactId: record.artifactId,
    state: record.state,
    records: [
      { type: "TXT", name: txtRecordName(record.hostname), value: txtRecordValue(record.token) },
      { type: "CNAME", name: record.hostname, value: cnameTarget(env.CONTENT_DOMAIN) },
    ],
    claimExpiresAt: record.claimExpiresAt === null ? null : iso(record.claimExpiresAt),
    verifiedAt: record.verifiedAt === null ? null : iso(record.verifiedAt),
    checkedAt: record.checkedAt === null ? null : iso(record.checkedAt),
    missedChecks: record.missedChecks,
    problem: record.problem,
  });
}

export function customDomainListView(env: Pick<Env, "CONTENT_DOMAIN">, listing: DomainListing) {
  return CustomDomainList.parse({
    available: listing.available,
    enabled: listing.enabled,
    limit: listing.limit,
    used: listing.used,
    cnameTarget: cnameTarget(env.CONTENT_DOMAIN),
    domains: listing.domains.map((record) => customDomainView(env, record)),
  });
}

/** Lists the caller's domains, or one artifact's with its owner's plan. */
export async function domainListing(
  env: Env,
  domains: DomainDeps | null,
  input: { userId: string; artifactId?: string | undefined; now: number },
) {
  const regions = regionsOf(env);
  if (input.artifactId !== undefined) {
    return artifactCustomDomains(regions, domains, {
      userId: input.userId,
      artifactId: input.artifactId,
      now: input.now,
    });
  }
  const { actor } = await personalScope(env, input.userId);
  return listCustomDomains(regions, domains, { actor, now: input.now });
}

/** The routes, through `guarded` like every /api/v1 route. */
export function domainRoutes(
  api: Hono<{ Bindings: Env }>,
  guarded: Guarded,
  domainsFor: (env: Env) => DomainDeps | null,
  now: () => number,
) {
  api.post(
    "/api/v1/artifacts/:artifactId/domain",
    guarded("artifacts:share", async (c, userId) => {
      const body = await readJson(c, CustomDomainAdd, 1024);
      if (!body.ok) return body.response;
      const artifactId = c.req.param("artifactId") as string;
      const at = now();
      return idempotent(
        c,
        { userId, operation: "domain.add", request: { artifactId, ...body.value }, now: at },
        async () => {
          const result = await addCustomDomain(regionsOf(c.env), domainsFor(c.env), {
            userId,
            artifactId,
            hostname: body.value.hostname,
            contentDomain: c.env.CONTENT_DOMAIN,
            now: at,
          });
          if (!result.ok) {
            return {
              status: ERROR_STATUS[result.code],
              body: { error: { code: result.code, message: result.message } },
            };
          }
          return { status: 201, body: customDomainView(c.env, result.value) };
        },
      );
    }),
  );

  api.get(
    "/api/v1/domains",
    guarded("artifacts:read", async (c, userId) => {
      const query = CustomDomainListQuery.safeParse(c.req.query());
      if (!query.success) {
        return error(c, "invalid_input", query.error.issues[0]?.message ?? "Invalid query.");
      }
      const result = await domainListing(c.env, domainsFor(c.env), {
        userId,
        artifactId: query.data.artifactId,
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(customDomainListView(c.env, result.value));
    }),
  );

  api.get(
    "/api/v1/domains/:hostname",
    guarded("artifacts:read", async (c, userId) => {
      const result = await getCustomDomain(regionsOf(c.env), {
        userId,
        hostname: c.req.param("hostname") as string,
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(customDomainView(c.env, result.value));
    }),
  );

  api.post(
    "/api/v1/domains/:hostname/verify",
    guarded("artifacts:share", async (c, userId) => {
      const result = await verifyCustomDomain(regionsOf(c.env), domainsFor(c.env), {
        userId,
        hostname: c.req.param("hostname") as string,
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(customDomainView(c.env, result.value));
    }),
  );

  api.delete(
    "/api/v1/domains/:hostname",
    guarded("artifacts:share", async (c, userId) => {
      const result = await removeCustomDomain(regionsOf(c.env), {
        userId,
        hostname: c.req.param("hostname") as string,
        now: now(),
      });
      if (!result.ok) return error(c, result.code, result.message);
      return c.json(CustomDomainRemoved.parse({ hostname: result.value.hostname, removed: true }));
    }),
  );
}
