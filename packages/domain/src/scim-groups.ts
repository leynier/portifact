// SCIM `Group` resources (premium plan E2, decision 0017, "Groups and roles"): parsing what a
// directory sends about a group, applying a PATCH in the dialects Okta and Microsoft Entra ID
// use, and building what it reads back. Pure: the services resolve members and write the rows.
import { WORKSPACE_GROUPS } from "@portifact/contracts";
import { normalizeGroupName } from "./groups.ts";
import { type ScimResult, scimFail } from "./scim.ts";

export const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";

/** A group as the directory describes it, after parsing: members are directory user IDs. */
export interface ScimGroupInput {
  displayName: string;
  externalId: string | null;
  members: string[];
}

const EXTERNAL_ID_MAX = 256;
const MEMBER_ID = /^su_[0-9a-f]{32}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Attribute names are case-insensitive and may carry the Group schema's URN (RFC 7644, 3.10). */
function attributeKey(raw: string): string {
  const prefix = `${SCIM_GROUP_SCHEMA}:`.toLowerCase();
  const lower = raw.trim().toLowerCase();
  return lower.startsWith(prefix) ? lower.slice(prefix.length) : lower;
}

function parseDisplayName(value: unknown): ScimResult<string> {
  if (typeof value !== "string") return scimFail(400, "displayName is required.", "invalidValue");
  const name = normalizeGroupName(value);
  if (!name.ok) return scimFail(400, name.message, "invalidValue");
  return { ok: true, value: name.value };
}

function parseExternalId(value: unknown): ScimResult<string | null> {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== "string" || value.length > EXTERNAL_ID_MAX) {
    return scimFail(
      400,
      `externalId must be text of at most ${EXTERNAL_ID_MAX} characters.`,
      "invalidValue",
    );
  }
  return { ok: true, value };
}

/**
 * Member references (`[{ "value": "<id>" }]`, RFC 7643, section 4.2). Only this server's user IDs
 * have the right shape; anything else is refused the same way whether or not it exists elsewhere.
 * The list is bounded by the group cap, so a request can never carry more than a group may hold.
 */
function parseMembers(value: unknown): ScimResult<string[]> {
  const list = value === null || value === undefined ? [] : value;
  if (!Array.isArray(list)) return scimFail(400, "members must be a list.", "invalidValue");
  if (list.length > WORKSPACE_GROUPS.membersPerGroup) {
    return scimFail(
      400,
      `A group has at most ${WORKSPACE_GROUPS.membersPerGroup} members.`,
      "invalidValue",
    );
  }
  const ids: string[] = [];
  for (const item of list) {
    const id = isRecord(item) ? item.value : undefined;
    if (typeof id !== "string" || !MEMBER_ID.test(id)) {
      return scimFail(400, "A member is not one of this directory's users.", "invalidValue");
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return { ok: true, value: ids };
}

/** A `Group` resource from a POST or PUT body (RFC 7643, section 4.2). */
export function parseScimGroup(body: unknown): ScimResult<ScimGroupInput> {
  if (!isRecord(body)) return scimFail(400, "The body must be a Group resource.", "invalidSyntax");
  const fields = new Map<string, unknown>();
  for (const [key, value] of Object.entries(body)) fields.set(attributeKey(key), value);
  const displayName = parseDisplayName(fields.get("displayname"));
  if (!displayName.ok) return displayName;
  const externalId = parseExternalId(fields.get("externalid"));
  if (!externalId.ok) return externalId;
  const members = parseMembers(fields.get("members"));
  if (!members.ok) return members;
  return {
    ok: true,
    value: { displayName: displayName.value, externalId: externalId.value, members: members.value },
  };
}

const capped = (members: string[]): ScimResult<string[]> =>
  members.length > WORKSPACE_GROUPS.membersPerGroup
    ? scimFail(
        400,
        `A group has at most ${WORKSPACE_GROUPS.membersPerGroup} members.`,
        "invalidValue",
      )
    : { ok: true, value: members };

const MEMBER_FILTER = /^members\[\s*value\s+eq\s+("(?:[^"\\]|\\.)*")\s*\]$/i;

/** The member a `members[value eq "<id>"]` path names, or null when the path is not that. */
function filteredMember(path: string): ScimResult<string> | null {
  const match = MEMBER_FILTER.exec(path.trim());
  if (!match?.[1]) return null;
  try {
    const value: unknown = JSON.parse(match[1]);
    if (typeof value === "string" && MEMBER_ID.test(value)) return { ok: true, value };
  } catch {
    // Falls through to the refusal below.
  }
  return scimFail(400, "A member is not one of this directory's users.", "invalidValue");
}

function applyGroupOperation(
  group: ScimGroupInput,
  operation: unknown,
): ScimResult<ScimGroupInput> {
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
  const rawPath = fields.get("path");
  const value = fields.get("value");
  if (rawPath === undefined || rawPath === null || rawPath === "") {
    if (op === "remove") return scimFail(400, "remove needs a path.", "noTarget");
    if (!isRecord(value)) {
      return scimFail(400, "A path-less operation needs an object value.", "invalidValue");
    }
    // Okta renames with `{ "op": "replace", "value": { "id": "...", "displayName": "..." } }`.
    let next = group;
    for (const [key, attribute] of Object.entries(value)) {
      const applied = setAttribute(next, attributeKey(key), op, attribute);
      if (!applied.ok) return applied;
      next = applied.value;
    }
    return { ok: true, value: next };
  }
  if (typeof rawPath !== "string") return scimFail(400, "path must be text.", "invalidPath");
  const filtered = filteredMember(rawPath);
  if (filtered) {
    // Okta and Entra remove one member with `members[value eq "<id>"]` (RFC 7644, 3.5.2.2).
    if (!filtered.ok) return filtered;
    if (op !== "remove") {
      return scimFail(400, "A filtered members path only removes.", "invalidPath");
    }
    return {
      ok: true,
      value: { ...group, members: group.members.filter((id) => id !== filtered.value) },
    };
  }
  const key = attributeKey(rawPath);
  if (key.includes("[") || /\s/.test(key)) {
    return scimFail(400, "The path is not valid.", "invalidPath");
  }
  return setAttribute(group, key, op, op === "remove" ? (value ?? null) : value);
}

function setAttribute(
  group: ScimGroupInput,
  key: string,
  op: "add" | "replace" | "remove",
  value: unknown,
): ScimResult<ScimGroupInput> {
  switch (key) {
    case "displayname": {
      if (op === "remove") return scimFail(400, "displayName cannot be removed.", "mutability");
      const name = parseDisplayName(value);
      return name.ok ? { ok: true, value: { ...group, displayName: name.value } } : name;
    }
    case "externalid": {
      const externalId = parseExternalId(op === "remove" ? null : value);
      return externalId.ok
        ? { ok: true, value: { ...group, externalId: externalId.value } }
        : externalId;
    }
    case "members": {
      if (op === "remove" && (value === null || value === undefined)) {
        return { ok: true, value: { ...group, members: [] } };
      }
      const listed = parseMembers(value);
      if (!listed.ok) return listed;
      if (op === "replace") return { ok: true, value: { ...group, members: listed.value } };
      if (op === "remove") {
        // Entra removes with `{ "op": "Remove", "path": "members", "value": [{ "value": "<id>" }] }`.
        return {
          ok: true,
          value: { ...group, members: group.members.filter((id) => !listed.value.includes(id)) },
        };
      }
      const merged = [...group.members];
      for (const id of listed.value) if (!merged.includes(id)) merged.push(id);
      const bounded = capped(merged);
      return bounded.ok ? { ok: true, value: { ...group, members: bounded.value } } : bounded;
    }
    default:
      // `id`, `meta` and anything Portifact does not keep are accepted and ignored.
      return { ok: true, value: group };
  }
}

/**
 * Applies a PATCH (RFC 7644, section 3.5.2) to a group. Accepts what Okta sends
 * (developer.okta.com/docs/api/openapi/okta-scim/guides/scim-20, "Update a specific Group name",
 * "Update a specific Group membership": `add` of `members` with a value list, `remove` with the
 * filtered path `members[value eq "..."]`, a path-less `replace` of `displayName`) and what Entra
 * sends (learn.microsoft.com/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups,
 * "Update Group [Add Members]", "[Remove Members]": capitalized ops, `remove` of `members` with a
 * value list, `replace` of `displayName`). The result is bounded by the group cap.
 */
export function applyScimGroupPatch(
  group: ScimGroupInput,
  body: unknown,
  maxOperations: number,
): ScimResult<ScimGroupInput> {
  if (!isRecord(body)) {
    return scimFail(400, "The body must be a PatchOp message.", "invalidSyntax");
  }
  const operations = Object.entries(body).find(([key]) => key.toLowerCase() === "operations")?.[1];
  if (!Array.isArray(operations) || operations.length === 0) {
    return scimFail(400, "Operations must hold at least one operation.", "invalidSyntax");
  }
  if (operations.length > maxOperations) {
    return scimFail(400, `At most ${maxOperations} operations in one request.`, "tooMany");
  }
  let next = group;
  for (const operation of operations) {
    const applied = applyGroupOperation(next, operation);
    if (!applied.ok) return applied;
    next = applied.value;
  }
  const bounded = capped(next.members);
  return bounded.ok ? { ok: true, value: next } : bounded;
}

/** What a group list filters on: equality on `displayName` (without case) or `externalId`. */
export interface ScimGroupFilter {
  attribute: "displayName" | "externalId";
  value: string;
}

const FILTER = /^\s*([A-Za-z0-9:._-]+)\s+eq\s+("(?:[^"\\]|\\.)*")\s*$/i;

/**
 * Parses a group list's `filter`: Okta and Entra look a group up by `displayName eq "..."`
 * before creating it, and Entra also by `externalId eq "..."`. Anything else is `invalidFilter`.
 */
export function parseScimGroupFilter(raw: string): ScimResult<ScimGroupFilter> {
  const unsupported = scimFail<ScimGroupFilter>(
    400,
    'Only filter=displayName eq "..." or externalId eq "..." is supported.',
    "invalidFilter",
  );
  const match = FILTER.exec(raw);
  if (!match?.[1] || !match[2]) return unsupported;
  let value: unknown;
  try {
    value = JSON.parse(match[2]);
  } catch {
    return unsupported;
  }
  if (typeof value !== "string") return unsupported;
  const key = attributeKey(match[1]);
  if (key === "displayname") return { ok: true, value: { attribute: "displayName", value } };
  if (key === "externalid") return { ok: true, value: { attribute: "externalId", value } };
  return unsupported;
}

/** A directory-managed group as stored, for the resource the directory reads back. */
export interface ScimGroupRecord {
  id: string;
  displayName: string;
  externalId: string | null;
  /** Directory user IDs with their addresses, pending people included. */
  members: { id: string; email: string }[];
  createdAt: number;
  updatedAt: number;
}

/** The `Group` resource; `members` is left out when the directory asked to exclude it. */
export function scimGroupResource(group: ScimGroupRecord, baseUrl: string, withMembers = true) {
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: group.id,
    displayName: group.displayName,
    ...(group.externalId === null ? {} : { externalId: group.externalId }),
    ...(withMembers
      ? {
          members: group.members.map((member) => ({
            value: member.id,
            $ref: `${baseUrl}/Users/${member.id}`,
            display: member.email,
          })),
        }
      : {}),
    meta: {
      resourceType: "Group",
      created: new Date(group.createdAt).toISOString(),
      lastModified: new Date(group.updatedAt).toISOString(),
      location: `${baseUrl}/Groups/${group.id}`,
    },
  };
}

/** Whether `excludedAttributes` asks to leave the members out (Entra and Okta do on reads). */
export function excludesMembers(excluded: string | undefined): boolean {
  if (!excluded) return false;
  return excluded
    .split(",")
    .map((name) => attributeKey(name))
    .includes("members");
}
