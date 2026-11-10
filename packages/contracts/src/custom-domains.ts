// Shapes of custom domains (premium plan P7, decision 0006): an owner on a paid plan serves one
// artifact from a hostname of their own (`docs.example.com`). The owner claims the hostname,
// publishes a TXT record that proves they control its DNS, and Portifact then creates the
// hostname in Cloudflare for SaaS. The owner adds, verifies, lists and removes domains through
// `/api/v1/artifacts/:id/domain` and `/api/v1/domains`, the MCP tools add_custom_domain,
// verify_custom_domain, list_custom_domains, get_custom_domain and remove_custom_domain, and
// `portifact domains`.
import { z } from "zod";
import { ArtifactId } from "./core.ts";

/** Lifetimes and safety values of custom domains; not plan values (the count is `customDomains`). */
export const CUSTOM_DOMAINS = {
  /** A claim waits this long for its TXT record; it never reaches Cloudflare. */
  claimTtlDays: 7,
  /**
   * A domain whose certificate is not active this long after the proof is detached: Cloudflare
   * bills a pending hostname, and HTTP validation takes minutes once the CNAME is in place.
   */
  provisioningMaxDays: 2,
  /** The TXT proof and Cloudflare's status are checked again this often. */
  recheckHours: 24,
  /** Re-checks the TXT proof may miss in a row before the domain is detached. */
  maxMissedChecks: 3,
  /** After a plan expires, its domains are kept this long before the newest are detached. */
  downgradeGraceDays: 7,
  /** The TXT record's name is this label followed by the hostname. */
  txtLabel: "_portifact",
  /** The TXT record's value is this prefix followed by the claim's token. */
  txtPrefix: "portifact-verify=",
  /** The CNAME target is this label under the content domain (`domains.portifact.dev`). */
  cnameLabel: "domains",
  /** The longest hostname input read. */
  inputMaxLength: 300,
} as const;

/** The name of the TXT record that proves control of `hostname`. */
export function txtRecordName(hostname: string): string {
  return `${CUSTOM_DOMAINS.txtLabel}.${hostname}`;
}

/** The value of the TXT record for a claim's token. */
export function txtRecordValue(token: string): string {
  return `${CUSTOM_DOMAINS.txtPrefix}${token}`;
}

/** The hostname customers point their CNAME at. */
export function cnameTarget(contentDomain: string): string {
  return `${CUSTOM_DOMAINS.cnameLabel}.${contentDomain}`;
}

/** What an owner types: checked and normalized by `normalizeHostname` in @portifact/domain. */
export const HostnameInput = z
  .string()
  .trim()
  .min(1, "Type a hostname, for example docs.example.com.")
  .max(CUSTOM_DOMAINS.inputMaxLength, "A hostname has at most 253 characters.");

/**
 * - `pending`: claimed, waiting for the TXT record.
 * - `provisioning`: proven, waiting for Cloudflare's hostname and certificate.
 * - `active`: the artifact is served on the hostname.
 * - `removing`: detached; the Cloudflare hostname is being deleted.
 */
export const CustomDomainState = z.enum(["pending", "provisioning", "active", "removing"]);
export type CustomDomainState = z.infer<typeof CustomDomainState>;

/** A DNS record the owner creates at their DNS provider. */
export const DnsRecord = z.object({
  type: z.enum(["TXT", "CNAME"]),
  name: z.string(),
  value: z.string(),
});
export type DnsRecord = z.infer<typeof DnsRecord>;

/**
 * What the last check found, when it found a problem: `txt_missing` (the TXT record does not hold
 * this claim's value), `certificate_pending` (Cloudflare has not activated the hostname yet,
 * usually because the CNAME is not in place), `cloudflare_unavailable` (Cloudflare did not
 * answer; checked again later) or `cname_elsewhere` (the name does not resolve to the CNAME
 * target: it is not activated, and an active domain is removed after `maxMissedChecks` daily
 * checks in a row).
 */
export const CustomDomainProblem = z.enum([
  "txt_missing",
  "certificate_pending",
  "cloudflare_unavailable",
  "cname_elsewhere",
]);
export type CustomDomainProblem = z.infer<typeof CustomDomainProblem>;

/** One domain or claim as an admin or editor of its owner sees it. */
export const CustomDomainView = z.object({
  hostname: z.string(),
  artifactId: ArtifactId,
  state: CustomDomainState,
  /** The two records to create: the TXT proof (keep it) and the CNAME. */
  records: z.array(DnsRecord),
  /** When a pending claim expires; null once proven. */
  claimExpiresAt: z.iso.datetime().nullable(),
  /** When the TXT proof held; null while pending. */
  verifiedAt: z.iso.datetime().nullable(),
  /** When the proof was last checked again; null while pending. */
  checkedAt: z.iso.datetime().nullable(),
  /** Daily checks missed in a row; at `maxMissedChecks` the domain is detached. */
  missedChecks: z.number().int().min(0),
  problem: CustomDomainProblem.nullable(),
});
export type CustomDomainView = z.infer<typeof CustomDomainView>;

/** The owner's domains (and pending claims), oldest first, with what the plan allows. */
export const CustomDomainList = z.object({
  /** Whether custom domains are switched on for this deployment. */
  available: z.boolean(),
  /** Whether the owner's plan includes custom domains now. */
  enabled: z.boolean(),
  /** How many domains the owner's plan allows. */
  limit: z.number().int().min(0),
  /** Domains that count toward the limit (proven and not being removed). */
  used: z.number().int().min(0),
  /** The hostname every CNAME points at. */
  cnameTarget: z.string(),
  domains: z.array(CustomDomainView),
});
export type CustomDomainList = z.infer<typeof CustomDomainList>;

/** Body of `POST /api/v1/artifacts/:id/domain`. */
export const CustomDomainAdd = z.strictObject({ hostname: HostnameInput });
export type CustomDomainAdd = z.infer<typeof CustomDomainAdd>;

export const CustomDomainRemoved = z.object({ hostname: z.string(), removed: z.literal(true) });
export type CustomDomainRemoved = z.infer<typeof CustomDomainRemoved>;

/** Query of `GET /api/v1/domains`. */
export const CustomDomainListQuery = z.strictObject({ artifactId: ArtifactId.optional() });

const artifactId = ArtifactId.describe(
  "The artifact ID, as list_artifacts or get_artifact return it.",
);
const hostname = HostnameInput.describe(
  "The hostname, for example docs.example.com: a subdomain the user controls, never an apex domain or a wildcard.",
);

/** Input of the MCP tool add_custom_domain. */
export const AddCustomDomainInput = z.object({
  artifactId,
  hostname,
  idempotencyKey: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "A unique key so a retried call adds the domain once, like the Idempotency-Key header.",
    ),
});
export type AddCustomDomainInput = z.infer<typeof AddCustomDomainInput>;

export const HostnameToolInput = z.object({ hostname });
export type HostnameToolInput = z.infer<typeof HostnameToolInput>;

export const ListCustomDomainsInput = z.object({
  artifactId: artifactId
    .optional()
    .describe("Only the domain of this artifact, with its owner's plan; omit it for every domain."),
});
export type ListCustomDomainsInput = z.infer<typeof ListCustomDomainsInput>;

export const RemoveCustomDomainInput = z.object({
  hostname,
  confirm: z
    .string()
    .describe("The hostname again, exactly, after the user confirmed removing the domain."),
});
export type RemoveCustomDomainInput = z.infer<typeof RemoveCustomDomainInput>;
