// SCIM Group rules (decision 0017, "Groups and roles"). Shapes from RFC 7643 (section 4.2, 8.4)
// and RFC 7644 (section 3.5.2), and from what Okta
// (developer.okta.com/docs/api/openapi/okta-scim/guides/scim-20, "Create Groups", "Update a
// specific Group name", "Update a specific Group membership") and Microsoft Entra ID
// (learn.microsoft.com/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups,
// "Create Group", "Update Group [Add Members]", "Update Group [Remove Members]") document sending.
import { WORKSPACE_GROUPS } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { SCIM_GROUP_SCHEMA_URN, scimResourceTypes, scimSchemas } from "./scim.ts";
import {
  applyScimGroupPatch,
  excludesMembers,
  parseScimGroup,
  parseScimGroupFilter,
  SCIM_GROUP_SCHEMA,
  type ScimGroupInput,
  scimGroupResource,
} from "./scim-groups.ts";

const A = `su_${"a".repeat(32)}`;
const B = `su_${"b".repeat(32)}`;
const C = `su_${"c".repeat(32)}`;
const BASE = "https://app.portifact.com/scim/v2";
const GROUP: ScimGroupInput = { displayName: "Design", externalId: "e1", members: [A, B] };

const ok = <T>(result: { ok: true; value: T } | { ok: false }) => {
  if (!result.ok) throw new Error("expected ok");
  return result.value;
};

describe("parseScimGroup", () => {
  it.each([
    [
      // RFC 7643, section 8.4, with this server's user IDs.
      "the RFC's group",
      {
        schemas: [SCIM_GROUP_SCHEMA],
        displayName: "Tour Guides",
        members: [{ value: A, $ref: "x", display: "Babs" }],
      },
      { displayName: "Tour Guides", externalId: null, members: [A] },
    ],
    [
      // Okta's "Create Groups": no members at creation.
      "Okta's create",
      { schemas: [SCIM_GROUP_SCHEMA], displayName: "Test SCIMv2", members: [] },
      { displayName: "Test SCIMv2", externalId: null, members: [] },
    ],
    [
      // Entra's "Create Group", with externalId and an empty member list.
      "Entra's create",
      {
        schemas: [
          SCIM_GROUP_SCHEMA,
          "http://schemas.microsoft.com/2006/11/ResourceManagement/ADSCIM/2.0/Group",
        ],
        externalId: "8aa1a0c0",
        displayName: "displayName",
        meta: { resourceType: "Group" },
        members: [],
      },
      { displayName: "displayName", externalId: "8aa1a0c0", members: [] },
    ],
    [
      "names in other case, the URN, repeated members",
      { [`${SCIM_GROUP_SCHEMA}:DisplayName`]: " Ops ", MEMBERS: [{ value: A }, { value: A }] },
      { displayName: "Ops", externalId: null, members: [A] },
    ],
  ])("reads %s", (_, body, expected) => {
    expect(ok(parseScimGroup(body))).toEqual(expected);
  });

  it.each([
    ["not an object", [], "invalidSyntax"],
    ["no displayName", { members: [] }, "invalidValue"],
    ["a displayName with a control character", { displayName: "a\u0007" }, "invalidValue"],
    ["a long externalId", { displayName: "a", externalId: "x".repeat(257) }, "invalidValue"],
    ["members that are not a list", { displayName: "a", members: {} }, "invalidValue"],
    [
      "a member that is not this server's ID",
      { displayName: "a", members: [{ value: "ada@acme.com" }] },
      "invalidValue",
    ],
    ["a member without value", { displayName: "a", members: [{ display: "x" }] }, "invalidValue"],
    [
      "more members than a group holds",
      {
        displayName: "a",
        members: Array.from({ length: WORKSPACE_GROUPS.membersPerGroup + 1 }, () => ({ value: A })),
      },
      "invalidValue",
    ],
  ])("refuses %s", (_, body, scimType) => {
    expect(parseScimGroup(body)).toMatchObject({ ok: false, error: { status: 400, scimType } });
  });
});

describe("applyScimGroupPatch", () => {
  const patch = (Operations: unknown[], group = GROUP) =>
    applyScimGroupPatch(
      group,
      { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations },
      50,
    );

  it.each([
    [
      "Okta's rename",
      [{ op: "replace", value: { id: "wg_x", displayName: "Renamed" } }],
      { ...GROUP, displayName: "Renamed" },
    ],
    [
      "Okta's member add",
      [{ op: "add", path: "members", value: [{ value: C, display: "c@x" }] }],
      { ...GROUP, members: [A, B, C] },
    ],
    [
      "Okta's member remove",
      [{ op: "remove", path: `members[value eq "${A}"]` }],
      { ...GROUP, members: [B] },
    ],
    [
      "Entra's add",
      [{ op: "Add", path: "members", value: [{ value: C }] }],
      { ...GROUP, members: [A, B, C] },
    ],
    [
      "Entra's remove",
      [{ op: "Remove", path: "members", value: [{ value: B }] }],
      { ...GROUP, members: [A] },
    ],
    [
      "Entra's displayName replace",
      [{ op: "Replace", path: "displayName", value: "1879db59" }],
      { ...GROUP, displayName: "1879db59" },
    ],
    [
      "a whole list replaced",
      [{ op: "replace", path: "members", value: [{ value: C }] }],
      { ...GROUP, members: [C] },
    ],
    ["every member removed", [{ op: "remove", path: "members" }], { ...GROUP, members: [] }],
    [
      "externalId set and removed",
      [
        { op: "replace", path: "externalId", value: "e2" },
        { op: "remove", path: "externalId" },
      ],
      { ...GROUP, externalId: null },
    ],
    ["an attribute it does not keep", [{ op: "add", path: "description", value: "x" }], GROUP],
    [
      "an add of someone already in",
      [{ op: "add", path: "members", value: [{ value: A }] }],
      GROUP,
    ],
  ])("applies %s", (_, operations, expected) => {
    expect(ok(patch(operations))).toEqual(expected);
  });

  it.each([
    ["a body that is not an object", null, "invalidSyntax"],
    ["no operations", { Operations: [] }, "invalidSyntax"],
    [
      "too many operations",
      { Operations: Array(51).fill({ op: "add", path: "description", value: 1 }) },
      "tooMany",
    ],
    ["an operation that is not an object", { Operations: [1] }, "invalidSyntax"],
    ["an unknown op", { Operations: [{ op: "copy", path: "members" }] }, "invalidSyntax"],
    ["a path-less remove", { Operations: [{ op: "remove" }] }, "noTarget"],
    [
      "a path-less value that is not an object",
      { Operations: [{ op: "replace", value: 1 }] },
      "invalidValue",
    ],
    ["a path that is not text", { Operations: [{ op: "replace", path: 1 }] }, "invalidPath"],
    [
      "a filtered add",
      { Operations: [{ op: "add", path: `members[value eq "${C}"]`, value: [] }] },
      "invalidPath",
    ],
    [
      "a filter on a foreign ID",
      { Operations: [{ op: "remove", path: 'members[value eq "x"]' }] },
      "invalidValue",
    ],
    [
      "a filter that is not JSON",
      { Operations: [{ op: "remove", path: 'members[value eq "\\x"]' }] },
      "invalidValue",
    ],
    [
      "another filtered path",
      { Operations: [{ op: "remove", path: 'emails[type eq "work"]' }] },
      "invalidPath",
    ],
    ["removing displayName", { Operations: [{ op: "remove", path: "displayName" }] }, "mutability"],
    [
      "a bad displayName",
      { Operations: [{ op: "replace", path: "displayName", value: "" }] },
      "invalidValue",
    ],
    [
      "a bad externalId",
      { Operations: [{ op: "replace", path: "externalId", value: 3 }] },
      "invalidValue",
    ],
    [
      "a bad member list",
      { Operations: [{ op: "add", path: "members", value: "x" }] },
      "invalidValue",
    ],
    [
      "a bad path-less member list",
      { Operations: [{ op: "replace", value: { members: [{ value: "nope" }] } }] },
      "invalidValue",
    ],
  ])("refuses %s", (_, body, scimType) => {
    expect(applyScimGroupPatch(GROUP, body, 50)).toMatchObject({
      ok: false,
      error: { status: 400, scimType },
    });
  });

  it("refuses an add past the group cap, and reads operations under any case of the key", () => {
    const full = {
      ...GROUP,
      members: Array.from({ length: 500 }, (_, i) => `su_${i.toString(16).padStart(32, "0")}`),
    };
    expect(
      applyScimGroupPatch(
        full,
        { Operations: [{ op: "add", path: "members", value: [{ value: A.replace("a", "f") }] }] },
        50,
      ),
    ).toMatchObject({
      ok: false,
      error: { scimType: "invalidValue" },
    });
    expect(
      ok(applyScimGroupPatch(GROUP, { operations: [{ op: "remove", path: "members" }] }, 50))
        .members,
    ).toEqual([]);
  });
});

describe("filters, resources and discovery", () => {
  it("parses the filters Okta and Entra send, and nothing else", () => {
    expect(ok(parseScimGroupFilter('displayName eq "Test SCIMv2"'))).toEqual({
      attribute: "displayName",
      value: "Test SCIMv2",
    });
    expect(ok(parseScimGroupFilter('externalId eq "8aa1a0c0"'))).toEqual({
      attribute: "externalId",
      value: "8aa1a0c0",
    });
    for (const raw of [
      'displayName co "x"',
      'members eq "x"',
      "displayName eq x",
      'displayName eq "\\x"',
      "displayName eq 3",
    ]) {
      expect(parseScimGroupFilter(raw)).toMatchObject({
        ok: false,
        error: { scimType: "invalidFilter" },
      });
    }
  });

  it("builds the resource, with or without members", () => {
    const record = {
      id: "wg_1",
      displayName: "Design",
      externalId: null,
      members: [{ id: A, email: "a@acme.com" }],
      createdAt: Date.UTC(2026, 10, 10),
      updatedAt: Date.UTC(2026, 10, 11),
    };
    expect(scimGroupResource(record, BASE)).toEqual({
      schemas: [SCIM_GROUP_SCHEMA],
      id: "wg_1",
      displayName: "Design",
      members: [{ value: A, $ref: `${BASE}/Users/${A}`, display: "a@acme.com" }],
      meta: {
        resourceType: "Group",
        created: "2026-11-10T00:00:00.000Z",
        lastModified: "2026-11-11T00:00:00.000Z",
        location: `${BASE}/Groups/wg_1`,
      },
    });
    expect(scimGroupResource({ ...record, externalId: "e" }, BASE, false)).not.toHaveProperty(
      "members",
    );
    expect(excludesMembers("members")).toBe(true);
    expect(excludesMembers("displayName, Members")).toBe(true);
    expect(excludesMembers(`${SCIM_GROUP_SCHEMA}:members`)).toBe(true);
    expect(excludesMembers("displayName")).toBe(false);
    expect(excludesMembers(undefined)).toBe(false);
  });

  it("serves Group in the resource types and schemas", () => {
    expect(scimResourceTypes(BASE).map((type) => type.id)).toEqual(["Group", "User"]);
    expect(scimSchemas(BASE).map((schema) => schema.id)).toContain(SCIM_GROUP_SCHEMA_URN);
    expect(SCIM_GROUP_SCHEMA).toBe(SCIM_GROUP_SCHEMA_URN);
  });
});
