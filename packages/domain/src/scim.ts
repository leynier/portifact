// SCIM 2.0 for a workspace's directory (premium plan E2, decision 0017): the protocol's rules,
// pure. RFC 7643 (resources) and RFC 7644 (protocol), with the dialects Okta and Microsoft Entra
// ID send. The services read and write the rows; these functions parse what a directory sent,
// apply a PATCH to a user, and build what it reads back. Only `User` is served in this delivery.
import { Email, SCIM } from "@portifact/contracts";
import { emailDomainOf } from "./email-domains.ts";

export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
export const SCIM_PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCIM_CONFIG_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";
export const SCIM_RESOURCE_TYPE_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ResourceType";
export const SCIM_SCHEMA_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Schema";

/** RFC 7644, section 3.12: the `scimType` values this server answers with. */
export type ScimType =
  | "invalidFilter"
  | "invalidValue"
  | "invalidSyntax"
  | "invalidPath"
  | "noTarget"
  | "mutability"
  | "uniqueness"
  | "tooMany";

/** A refusal as RFC 7644, section 3.12 shapes it. */
export interface ScimError {
  status: number;
  scimType?: ScimType | undefined;
  detail: string;
}

export type ScimResult<T> = { ok: true; value: T } | { ok: false; error: ScimError };

const good = <T>(value: T): ScimResult<T> => ({ ok: true, value });
export const scimFail = <T = never>(
  status: number,
  detail: string,
  scimType?: ScimType,
): ScimResult<T> => ({ ok: false, error: { status, detail, ...(scimType ? { scimType } : {}) } });

/** The error body of RFC 7644, section 3.12; `status` is a string there. */
export function scimErrorBody(error: ScimError) {
  return {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(error.status),
    ...(error.scimType ? { scimType: error.scimType } : {}),
    detail: error.detail,
  };
}

/** The names the directory sent for a person, echoed back to it and never shown elsewhere. */
export interface ScimNames {
  displayName?: string;
  givenName?: string;
  familyName?: string;
  formatted?: string;
}

/** A user as the directory describes it, after parsing. */
export interface ScimUserInput {
  /** The lowercase email address the directory's `userName` holds. */
  userName: string;
  externalId: string | null;
  active: boolean;
  names: ScimNames;
}

const NAME_MAX = 256;
const EXTERNAL_ID_MAX = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Attribute names are case-insensitive and may carry the core schema's URN (RFC 7644, 3.10). */
function attributeKey(raw: string): string {
  const prefix = `${SCIM_USER_SCHEMA}:`.toLowerCase();
  const lower = raw.trim().toLowerCase();
  return lower.startsWith(prefix) ? lower.slice(prefix.length) : lower;
}

/**
 * `active` as a boolean. Microsoft Entra sends `"True"` and `"False"` as strings in PATCH
 * (learn.microsoft.com/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups,
 * "Update User [Single-valued properties]"), so both are accepted, without regard to case.
 */
function parseActive(value: unknown): ScimResult<boolean> {
  if (typeof value === "boolean") return good(value);
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true") return good(true);
    if (lower === "false") return good(false);
  }
  return scimFail(400, "active must be true or false.", "invalidValue");
}

/** `userName` must be an email address: it is what the person signs in with. */
function parseUserName(value: unknown): ScimResult<string> {
  if (typeof value !== "string") return scimFail(400, "userName is required.", "invalidValue");
  const parsed = Email.safeParse(value.trim());
  if (!parsed.success) {
    return scimFail(400, "userName must be the person's email address.", "invalidValue");
  }
  return good(parsed.data);
}

function parseExternalId(value: unknown): ScimResult<string | null> {
  if (value === null || value === undefined) return good(null);
  if (typeof value !== "string" || value.length > EXTERNAL_ID_MAX) {
    return scimFail(
      400,
      `externalId must be text of at most ${EXTERNAL_ID_MAX} characters.`,
      "invalidValue",
    );
  }
  return good(value);
}

function parseName(value: unknown, field: string): ScimResult<string | undefined> {
  if (value === null || value === undefined) return good(undefined);
  if (typeof value !== "string" || value.length > NAME_MAX) {
    return scimFail(
      400,
      `${field} must be text of at most ${NAME_MAX} characters.`,
      "invalidValue",
    );
  }
  return good(value === "" ? undefined : value);
}

/** Sets or clears one name in a copy; `undefined` clears it. */
function withName(names: ScimNames, key: keyof ScimNames, value: string | undefined): ScimNames {
  const next = { ...names };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

const NAME_PARTS: Record<string, "givenName" | "familyName" | "formatted"> = {
  givenname: "givenName",
  familyname: "familyName",
  formatted: "formatted",
};

function parseNameObject(value: unknown, names: ScimNames): ScimResult<ScimNames> {
  if (value === null || value === undefined) {
    const { displayName } = names;
    return good(displayName === undefined ? {} : { displayName });
  }
  if (!isRecord(value)) return scimFail(400, "name must be an object.", "invalidValue");
  let next = names;
  for (const [raw, part] of Object.entries(value)) {
    const key = NAME_PARTS[raw.toLowerCase()];
    if (!key) continue;
    const parsed = parseName(part, `name.${key}`);
    if (!parsed.ok) return parsed;
    next = withName(next, key, parsed.value);
  }
  return good(next);
}

/**
 * A `User` resource from a POST or PUT body (RFC 7643, section 4.1). Only what Portifact keeps
 * is read: `userName` (required, an email address), `externalId`, `active` (true when absent)
 * and the display names. Everything else a directory sends (emails, phone numbers, Entra's
 * enterprise extension, `roles`) is accepted and not stored, so nothing about a person is kept
 * beyond what provisioning needs. `id` and `meta` in a body are ignored, as the RFC says.
 */
export function parseScimUser(body: unknown): ScimResult<ScimUserInput> {
  if (!isRecord(body)) return scimFail(400, "The body must be a User resource.", "invalidSyntax");
  const fields = new Map<string, unknown>();
  for (const [key, value] of Object.entries(body)) fields.set(attributeKey(key), value);
  const userName = parseUserName(fields.get("username"));
  if (!userName.ok) return userName;
  const externalId = parseExternalId(fields.get("externalid"));
  if (!externalId.ok) return externalId;
  const activeRaw = fields.get("active");
  const active =
    activeRaw === undefined || activeRaw === null ? good(true) : parseActive(activeRaw);
  if (!active.ok) return active;
  const display = parseName(fields.get("displayname"), "displayName");
  if (!display.ok) return display;
  const name = parseNameObject(fields.get("name"), withName({}, "displayName", display.value));
  if (!name.ok) return name;
  return good({
    userName: userName.value,
    externalId: externalId.value,
    active: active.value,
    names: name.value,
  });
}

/** One attribute a PATCH may change; anything else is accepted and ignored. */
type PatchTarget =
  | "username"
  | "externalid"
  | "active"
  | "displayname"
  | "name"
  | "name.givenname"
  | "name.familyname"
  | "name.formatted"
  | "ignored";

const PATCH_TARGETS = new Set<string>([
  "username",
  "externalid",
  "active",
  "displayname",
  "name",
  "name.givenname",
  "name.familyname",
  "name.formatted",
]);

/** A path is an attribute, maybe with a sub-attribute; a value filter (`emails[...]`) is ignored. */
function patchTarget(path: string): ScimResult<PatchTarget> {
  const key = attributeKey(path);
  if (key === "" || /\s/.test(key.replace(/\[.*\]/, ""))) {
    return scimFail(400, "The path is not valid.", "invalidPath");
  }
  if (key.includes("[")) return good("ignored");
  return good(PATCH_TARGETS.has(key) ? (key as PatchTarget) : "ignored");
}

/** A single value sent as `[{ "value": x }]`, as some directories do for simple attributes. */
function unwrap(value: unknown): unknown {
  if (Array.isArray(value) && value.length === 1 && isRecord(value[0]) && "value" in value[0]) {
    return value[0].value;
  }
  return value;
}

function setTarget(
  user: ScimUserInput,
  target: PatchTarget,
  raw: unknown,
  removing: boolean,
): ScimResult<ScimUserInput> {
  const value = removing ? undefined : unwrap(raw);
  switch (target) {
    case "ignored":
      return good(user);
    case "username": {
      if (removing) return scimFail(400, "userName cannot be removed.", "mutability");
      const parsed = parseUserName(value);
      return parsed.ok ? good({ ...user, userName: parsed.value }) : parsed;
    }
    case "externalid": {
      const parsed = parseExternalId(value);
      return parsed.ok ? good({ ...user, externalId: parsed.value }) : parsed;
    }
    case "active": {
      if (removing) return scimFail(400, "active cannot be removed.", "mutability");
      const parsed = parseActive(value);
      return parsed.ok ? good({ ...user, active: parsed.value }) : parsed;
    }
    case "displayname": {
      const parsed = parseName(value, "displayName");
      return parsed.ok
        ? good({ ...user, names: withName(user.names, "displayName", parsed.value) })
        : parsed;
    }
    case "name": {
      const parsed = parseNameObject(value, user.names);
      return parsed.ok ? good({ ...user, names: parsed.value }) : parsed;
    }
    default: {
      const key = NAME_PARTS[target.slice("name.".length)] ?? "formatted";
      const parsed = parseName(value, target);
      return parsed.ok ? good({ ...user, names: withName(user.names, key, parsed.value) }) : parsed;
    }
  }
}

/**
 * Applies a PATCH (RFC 7644, section 3.5.2) to a user. Accepts what Okta and Entra send:
 * - Okta deactivates with a path-less `replace` of `{ "active": false }`
 *   (developer.okta.com/docs/api/openapi/okta-scim/guides/scim-20, "Update a specific User
 *   (PATCH)");
 * - Entra sends `op` capitalized (`Replace`, `Add`), `active` as `"False"`, paths such as
 *   `name.givenName` and `emails[type eq "work"].value`, and path-less replaces whose value
 *   holds dotted keys (`{ "name.givenName": "x" }`) (Entra's SCIM guide, "Update User").
 * `add` and `replace` set single-valued attributes alike; `remove` clears one. Attributes
 * Portifact does not keep are ignored, so a directory can send its whole profile.
 */
export function applyScimPatch(user: ScimUserInput, body: unknown): ScimResult<ScimUserInput> {
  if (!isRecord(body)) {
    return scimFail(400, "The body must be a PatchOp message.", "invalidSyntax");
  }
  const operations = Object.entries(body).find(([key]) => key.toLowerCase() === "operations")?.[1];
  if (!Array.isArray(operations) || operations.length === 0) {
    return scimFail(400, "Operations must hold at least one operation.", "invalidSyntax");
  }
  if (operations.length > SCIM.maxOperations) {
    return scimFail(400, `At most ${SCIM.maxOperations} operations in one request.`, "tooMany");
  }
  let next = user;
  for (const operation of operations) {
    const applied = applyOperation(next, operation);
    if (!applied.ok) return applied;
    next = applied.value;
  }
  return good(next);
}

function applyOperation(user: ScimUserInput, operation: unknown): ScimResult<ScimUserInput> {
  if (!isRecord(operation)) {
    return scimFail(400, "An operation must be an object.", "invalidSyntax");
  }
  const fields = new Map(
    Object.entries(operation).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const rawOp = fields.get("op");
  const op = typeof rawOp === "string" ? rawOp.toLowerCase() : "";
  if (op !== "add" && op !== "replace" && op !== "remove") {
    return scimFail(400, "op must be add, replace or remove.", "invalidSyntax");
  }
  const path = fields.get("path");
  const value = fields.get("value");
  if (path === undefined || path === null || path === "") {
    if (op === "remove") return scimFail(400, "remove needs a path.", "noTarget");
    if (!isRecord(value)) {
      return scimFail(400, "A path-less operation needs an object value.", "invalidValue");
    }
    let next = user;
    for (const [key, attribute] of Object.entries(value)) {
      const target = patchTarget(key);
      if (!target.ok) return target;
      const applied = setTarget(next, target.value, attribute, false);
      if (!applied.ok) return applied;
      next = applied.value;
    }
    return good(next);
  }
  if (typeof path !== "string") return scimFail(400, "path must be text.", "invalidPath");
  const target = patchTarget(path);
  if (!target.ok) return target;
  return setTarget(user, target.value, value, op === "remove");
}

/** What a list filters on: only equality on `userName` or `externalId` (RFC 7644, 3.4.2.2). */
export interface ScimFilter {
  attribute: "userName" | "externalId";
  value: string;
}

const FILTER = /^\s*([A-Za-z0-9:._-]+)\s+eq\s+("(?:[^"\\]|\\.)*")\s*$/i;

/**
 * Parses `filter`. Okta and Entra look a user up before creating one with exactly
 * `userName eq "<address>"`, and Entra also with `externalId eq "<id>"`; nothing else is
 * supported, and anything else answers `invalidFilter` as the RFC says. `userName` compares
 * without case (its `caseExact` is false in RFC 7643, section 4.1.1).
 */
export function parseScimFilter(raw: string): ScimResult<ScimFilter> {
  const unsupported = scimFail<ScimFilter>(
    400,
    'Only filter=userName eq "..." or externalId eq "..." is supported.',
    "invalidFilter",
  );
  const match = FILTER.exec(raw);
  const attributeName = match?.[1];
  const literal = match?.[2];
  if (attributeName === undefined || literal === undefined) return unsupported;
  let value: unknown;
  try {
    value = JSON.parse(literal);
  } catch {
    return unsupported;
  }
  if (typeof value !== "string") return unsupported;
  const key = attributeKey(attributeName);
  if (key === "username") return good({ attribute: "userName", value: value.trim().toLowerCase() });
  if (key === "externalid") return good({ attribute: "externalId", value });
  return unsupported;
}

/**
 * Pagination (RFC 7644, section 3.4.2.4): `startIndex` is 1-based and below 1 means 1; `count`
 * below 0 means 0 and above the cap is the cap; absent `count` is the cap.
 */
export function scimPage(
  startIndex: string | undefined,
  count: string | undefined,
): ScimResult<{ startIndex: number; count: number }> {
  const integer = (raw: string | undefined, fallback: number) => {
    if (raw === undefined || raw === "") return fallback;
    return /^-?\d{1,9}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  };
  const start = integer(startIndex, 1);
  const size = integer(count, SCIM.maxPageSize);
  if (Number.isNaN(start) || Number.isNaN(size)) {
    return scimFail(400, "startIndex and count must be integers.", "invalidValue");
  }
  return good({
    startIndex: Math.max(1, start),
    count: Math.min(SCIM.maxPageSize, Math.max(0, size)),
  });
}

/** Whether a directory may provision this address: its domain is one the workspace proved. */
export function scimDomainAllowed(email: string, verifiedDomains: readonly string[]): boolean {
  const domain = emailDomainOf(email);
  return domain !== null && verifiedDomains.includes(domain);
}

/** A directory user as stored, for the resource the directory reads back. */
export interface ScimUserRecord {
  id: string;
  email: string;
  externalId: string | null;
  names: ScimNames;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Stored names, read defensively: only the four known text fields survive. */
export function scimNamesOf(stored: unknown): ScimNames {
  if (!isRecord(stored)) return {};
  let names: ScimNames = {};
  for (const key of ["displayName", "givenName", "familyName", "formatted"] as const) {
    const value = stored[key];
    if (typeof value === "string" && value !== "" && value.length <= NAME_MAX) {
      names = withName(names, key, value);
    }
  }
  return names;
}

/**
 * The `User` resource a directory reads back. Whether the address has a Portifact account, and
 * whether the person signed in yet, never shows: a pending person and a member look the same
 * except for what the directory itself set.
 */
export function scimUserResource(user: ScimUserRecord, baseUrl: string) {
  const name: Record<string, string> = {};
  if (user.names.givenName) name.givenName = user.names.givenName;
  if (user.names.familyName) name.familyName = user.names.familyName;
  if (user.names.formatted) name.formatted = user.names.formatted;
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: user.id,
    ...(user.externalId === null ? {} : { externalId: user.externalId }),
    userName: user.email,
    ...(Object.keys(name).length > 0 ? { name } : {}),
    ...(user.names.displayName ? { displayName: user.names.displayName } : {}),
    emails: [{ value: user.email, type: "work", primary: true }],
    active: user.active,
    meta: {
      resourceType: "User",
      created: new Date(user.createdAt).toISOString(),
      lastModified: new Date(user.updatedAt).toISOString(),
      location: `${baseUrl}/Users/${user.id}`,
    },
  };
}

/** A page of resources (RFC 7644, section 3.4.2). */
export function scimListResponse(resources: unknown[], total: number, startIndex: number) {
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: total,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

/** What this server supports (RFC 7643, section 5). */
export function scimServiceProviderConfig(baseUrl: string) {
  return {
    schemas: [SCIM_CONFIG_SCHEMA],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: SCIM.maxPageSize },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "Bearer token",
        description: "A workspace's SCIM token, created by its admins in the dashboard.",
        primary: true,
      },
    ],
    meta: { resourceType: "ServiceProviderConfig", location: `${baseUrl}/ServiceProviderConfig` },
  };
}

/** The resource types served (RFC 7643, section 6): `User` and `Group`. */
export function scimResourceTypes(baseUrl: string) {
  return [
    {
      schemas: [SCIM_RESOURCE_TYPE_SCHEMA],
      id: "Group",
      name: "Group",
      endpoint: "/Groups",
      description: "A workspace group the directory manages",
      schema: SCIM_GROUP_SCHEMA_URN,
      meta: { resourceType: "ResourceType", location: `${baseUrl}/ResourceTypes/Group` },
    },
    {
      schemas: [SCIM_RESOURCE_TYPE_SCHEMA],
      id: "User",
      name: "User",
      endpoint: "/Users",
      description: "A person the workspace's directory provisions",
      schema: SCIM_USER_SCHEMA,
      meta: { resourceType: "ResourceType", location: `${baseUrl}/ResourceTypes/User` },
    },
  ];
}

interface AttributeOptions {
  type: string;
  required: boolean;
  caseExact: boolean;
  mutability: string;
  uniqueness: string;
  multiValued: boolean;
  subAttributes: unknown[];
}

const attribute = (name: string, extra: Partial<AttributeOptions> = {}) => ({
  name,
  type: "string",
  multiValued: false,
  required: false,
  caseExact: false,
  mutability: "readWrite",
  returned: "default",
  uniqueness: "none",
  ...extra,
});

/** The attributes of `User` this server keeps (RFC 7643, section 7). */
export function scimSchemas(baseUrl: string) {
  return [
    {
      schemas: [SCIM_SCHEMA_SCHEMA],
      id: SCIM_USER_SCHEMA,
      name: "User",
      description: "A person the workspace's directory provisions",
      attributes: [
        attribute("userName", { required: true, uniqueness: "server" }),
        attribute("externalId", { caseExact: true }),
        attribute("displayName"),
        attribute("name", {
          type: "complex",
          subAttributes: [attribute("givenName"), attribute("familyName"), attribute("formatted")],
        }),
        attribute("emails", {
          type: "complex",
          multiValued: true,
          mutability: "readOnly",
          subAttributes: [
            attribute("value"),
            attribute("type"),
            attribute("primary", { type: "boolean" }),
          ],
        }),
        attribute("active", { type: "boolean" }),
      ],
      meta: { resourceType: "Schema", location: `${baseUrl}/Schemas/${SCIM_USER_SCHEMA}` },
    },
    {
      schemas: [SCIM_SCHEMA_SCHEMA],
      id: SCIM_GROUP_SCHEMA_URN,
      name: "Group",
      description: "A workspace group the directory manages",
      attributes: [
        attribute("displayName", { required: true, uniqueness: "server" }),
        attribute("externalId", { caseExact: true }),
        attribute("members", {
          type: "complex",
          multiValued: true,
          subAttributes: [
            attribute("value", { mutability: "immutable" }),
            attribute("$ref", { type: "reference", mutability: "immutable" }),
            attribute("display", { mutability: "readOnly" }),
          ],
        }),
      ],
      meta: { resourceType: "Schema", location: `${baseUrl}/Schemas/${SCIM_GROUP_SCHEMA_URN}` },
    },
  ];
}

/** The core `Group` schema's URN (RFC 7643, section 4.2). */
export const SCIM_GROUP_SCHEMA_URN = "urn:ietf:params:scim:schemas:core:2.0:Group";
