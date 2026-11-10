// SCIM protocol rules (decision 0017). Request shapes come from RFC 7643 and 7644 and from what
// Okta (developer.okta.com/docs/api/openapi/okta-scim/guides/scim-20) and Microsoft Entra ID
// (learn.microsoft.com/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups)
// document sending.
import { SCIM } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  applyScimPatch,
  parseScimFilter,
  parseScimUser,
  SCIM_ERROR_SCHEMA,
  SCIM_LIST_SCHEMA,
  SCIM_USER_SCHEMA,
  type ScimUserInput,
  scimDomainAllowed,
  scimErrorBody,
  scimListResponse,
  scimNamesOf,
  scimPage,
  scimResourceTypes,
  scimSchemas,
  scimServiceProviderConfig,
  scimUserResource,
} from "./scim.ts";

const BASE = "https://app.portifact.com/scim/v2";

const USER: ScimUserInput = {
  userName: "ada@acme.com",
  externalId: "00u1",
  active: true,
  names: { givenName: "Ada", familyName: "Lovelace" },
};

const ok = <T>(result: { ok: true; value: T } | { ok: false }) => {
  if (!result.ok) throw new Error("expected ok");
  return result.value;
};

describe("parseScimUser", () => {
  it.each([
    [
      // RFC 7643, section 8.1 (minimal user), with an email userName.
      "RFC 7643 minimal",
      { schemas: [SCIM_USER_SCHEMA], userName: "Bjensen@Example.com" },
      { userName: "bjensen@example.com", externalId: null, active: true, names: {} },
    ],
    [
      // Okta's "Create the User" request.
      "Okta create",
      {
        schemas: [SCIM_USER_SCHEMA],
        userName: "test.user@okta.local",
        name: { givenName: "Test", familyName: "User" },
        emails: [{ primary: true, value: "test.user@okta.local", type: "work" }],
        displayName: "Test User",
        locale: "en-US",
        externalId: "00ujl29u0le5T6Aj10h7",
        groups: [],
        password: "1mz050nq",
        active: true,
      },
      {
        userName: "test.user@okta.local",
        externalId: "00ujl29u0le5T6Aj10h7",
        active: true,
        names: { displayName: "Test User", givenName: "Test", familyName: "User" },
      },
    ],
    [
      // Entra's "Create User" request, with the enterprise extension and active as a boolean.
      "Entra create",
      {
        schemas: [SCIM_USER_SCHEMA, "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"],
        externalId: "0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef",
        userName: "Test_User_ab6490ee-1e48-479e-a20b-2d77186b5dd1@contoso.com",
        active: true,
        emails: [{ primary: true, type: "work", value: "Test_User@contoso.com" }],
        meta: { resourceType: "User" },
        name: {
          formatted: "givenName familyName",
          familyName: "familyName",
          givenName: "givenName",
        },
        roles: [],
      },
      {
        userName: "test_user_ab6490ee-1e48-479e-a20b-2d77186b5dd1@contoso.com",
        externalId: "0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef",
        active: true,
        names: {
          formatted: "givenName familyName",
          familyName: "familyName",
          givenName: "givenName",
        },
      },
    ],
    [
      "attribute names with the core URN and other case",
      { [`${SCIM_USER_SCHEMA}:UserName`]: "x@acme.com", ACTIVE: "False", DisplayName: "" },
      { userName: "x@acme.com", externalId: null, active: false, names: {} },
    ],
  ])("reads %s", (_, body, expected) => {
    expect(ok(parseScimUser(body))).toEqual(expected);
  });

  it.each([
    ["not an object", [], "invalidSyntax"],
    ["no userName", { active: true }, "invalidValue"],
    ["a userName that is not an address", { userName: "bjensen" }, "invalidValue"],
    ["active of another type", { userName: "a@acme.com", active: "yes" }, "invalidValue"],
    ["a long externalId", { userName: "a@acme.com", externalId: "x".repeat(257) }, "invalidValue"],
    ["a numeric externalId", { userName: "a@acme.com", externalId: 7 }, "invalidValue"],
    ["a name that is not an object", { userName: "a@acme.com", name: "Ada" }, "invalidValue"],
    [
      "a long given name",
      { userName: "a@acme.com", name: { givenName: "x".repeat(257) } },
      "invalidValue",
    ],
    [
      "a long display name",
      { userName: "a@acme.com", displayName: "x".repeat(257) },
      "invalidValue",
    ],
  ])("refuses %s", (_, body, scimType) => {
    const result = parseScimUser(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ status: 400, scimType });
  });

  it("keeps an absent or null active as true and a null name as none", () => {
    expect(ok(parseScimUser({ userName: "a@acme.com", active: null, name: null }))).toMatchObject({
      active: true,
      names: {},
    });
  });
});

describe("applyScimPatch", () => {
  const patch = (Operations: unknown[], user = USER) =>
    applyScimPatch(user, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations,
    });

  it.each([
    [
      // Okta deactivates with a path-less replace.
      "Okta deactivation",
      [{ op: "replace", value: { active: false } }],
      { ...USER, active: false },
    ],
    [
      // Okta's profile update with a path-less replace of several attributes.
      "Okta profile replace",
      [{ op: "replace", value: { name: { givenName: "Augusta" }, userName: "augusta@acme.com" } }],
      { ...USER, userName: "augusta@acme.com", names: { ...USER.names, givenName: "Augusta" } },
    ],
    [
      // Entra's single-valued updates: capitalized op, "False" as a string.
      "Entra deactivation",
      [{ op: "Replace", path: "active", value: "False" }],
      { ...USER, active: false },
    ],
    ["Entra reactivation", [{ op: "Replace", path: "active", value: "True" }], USER],
    [
      // Entra's "Update User [Multi-valued properties]" and name paths.
      "Entra multi-valued and name paths",
      [
        {
          op: "Replace",
          path: 'emails[type eq "work"].value',
          value: "updatedEmail@microsoft.com",
        },
        { op: "Replace", path: "name.familyName", value: "updatedFamilyName" },
        { op: "Add", path: "displayName", value: "Ada L" },
        {
          op: "Add",
          path: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:employeeNumber",
          value: "7",
        },
      ],
      { ...USER, names: { ...USER.names, familyName: "updatedFamilyName", displayName: "Ada L" } },
    ],
    [
      // Entra's path-less replace with dotted keys.
      "Entra path-less dotted keys",
      [{ op: "Replace", value: { "name.givenName": "Grace", externalId: "e2", title: "Admiral" } }],
      { ...USER, externalId: "e2", names: { ...USER.names, givenName: "Grace" } },
    ],
    [
      "a userName path with the URN, a single value in an array",
      [{ op: "replace", path: `${SCIM_USER_SCHEMA}:userName`, value: [{ value: "B@ACME.com" }] }],
      { ...USER, userName: "b@acme.com" },
    ],
    [
      "remove of optional attributes",
      [
        { op: "remove", path: "externalId" },
        { op: "remove", path: "name.givenName" },
        { op: "remove", path: "name" },
        { op: "remove", path: "displayName" },
      ],
      { ...USER, externalId: null, names: {} },
    ],
    [
      "replace of the whole name and its formatted part",
      [
        { op: "replace", path: "name", value: { givenName: "G", Unknown: "x" } },
        { op: "replace", path: "name.formatted", value: "G H" },
      ],
      { ...USER, names: { givenName: "G", familyName: "Lovelace", formatted: "G H" } },
    ],
    [
      "an operations key in another case",
      [{ op: "replace", path: "externalId", value: null }],
      { ...USER, externalId: null },
    ],
  ])("applies %s", (_, operations, expected) => {
    expect(ok(patch(operations))).toEqual(expected);
  });

  it("reads operations under any case of the key", () => {
    expect(
      ok(applyScimPatch(USER, { operations: [{ op: "replace", value: { active: false } }] })),
    ).toMatchObject({ active: false });
  });

  it.each([
    ["a body that is not an object", null, "invalidSyntax"],
    ["no operations", { Operations: [] }, "invalidSyntax"],
    [
      "too many operations",
      { Operations: Array(SCIM.maxOperations + 1).fill({ op: "add", value: {} }) },
      "tooMany",
    ],
    ["an operation that is not an object", { Operations: ["x"] }, "invalidSyntax"],
    ["an unknown op", { Operations: [{ op: "move", path: "active" }] }, "invalidSyntax"],
    ["a path-less remove", { Operations: [{ op: "remove" }] }, "noTarget"],
    [
      "a path-less value that is not an object",
      { Operations: [{ op: "add", value: 3 }] },
      "invalidValue",
    ],
    ["a path that is not text", { Operations: [{ op: "add", path: 3, value: 1 }] }, "invalidPath"],
    [
      "a path with spaces",
      { Operations: [{ op: "add", path: "user name", value: 1 }] },
      "invalidPath",
    ],
    [
      "a path-less key with spaces",
      { Operations: [{ op: "add", value: { "a b": 1 } }] },
      "invalidPath",
    ],
    ["removing userName", { Operations: [{ op: "remove", path: "userName" }] }, "mutability"],
    ["removing active", { Operations: [{ op: "remove", path: "active" }] }, "mutability"],
    ["a bad active", { Operations: [{ op: "replace", path: "active", value: 1 }] }, "invalidValue"],
    [
      "a bad userName",
      { Operations: [{ op: "replace", path: "userName", value: "x" }] },
      "invalidValue",
    ],
    [
      "a bad externalId",
      { Operations: [{ op: "replace", path: "externalId", value: 1 }] },
      "invalidValue",
    ],
    [
      "a bad display name",
      { Operations: [{ op: "replace", path: "displayName", value: 1 }] },
      "invalidValue",
    ],
    ["a bad name", { Operations: [{ op: "replace", path: "name", value: 1 }] }, "invalidValue"],
    [
      "a bad name part",
      { Operations: [{ op: "replace", path: "name.givenName", value: 1 }] },
      "invalidValue",
    ],
    [
      "a bad path-less value",
      { Operations: [{ op: "replace", value: { active: "maybe" } }] },
      "invalidValue",
    ],
  ])("refuses %s", (_, body, scimType) => {
    const result = applyScimPatch(USER, body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ status: 400, scimType });
  });
});

describe("parseScimFilter", () => {
  it.each([
    // What Okta and Entra send before creating a user.
    [
      'userName eq "Test.User@okta.local"',
      { attribute: "userName", value: "test.user@okta.local" },
    ],
    [
      'userName eq "Test_User_00aa00aa@contoso.com"',
      { attribute: "userName", value: "test_user_00aa00aa@contoso.com" },
    ],
    ['externalId eq "0a21f0f2-8d2a"', { attribute: "externalId", value: "0a21f0f2-8d2a" }],
    [`${SCIM_USER_SCHEMA}:userName EQ "a@b.co"`, { attribute: "userName", value: "a@b.co" }],
    [
      '  externalid   eq   "with \\"quote\\""  ',
      { attribute: "externalId", value: 'with "quote"' },
    ],
  ])("reads %s", (raw, expected) => {
    expect(ok(parseScimFilter(raw))).toEqual(expected);
  });

  it.each([
    'userName co "a"',
    'displayName eq "Ada"',
    'userName eq "a" and active eq true',
    "userName eq a",
    'userName eq "unterminated',
    'userName eq "\\x"',
    "",
  ])("refuses %s as invalidFilter", (raw) => {
    const result = parseScimFilter(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ status: 400, scimType: "invalidFilter" });
  });
});

describe("scimPage", () => {
  it.each([
    [undefined, undefined, { startIndex: 1, count: SCIM.maxPageSize }],
    ["", "", { startIndex: 1, count: SCIM.maxPageSize }],
    ["0", "10", { startIndex: 1, count: 10 }],
    ["-5", "-1", { startIndex: 1, count: 0 }],
    ["3", "1000", { startIndex: 3, count: SCIM.maxPageSize }],
  ])("reads startIndex %s and count %s", (start, count, expected) => {
    expect(ok(scimPage(start, count))).toEqual(expected);
  });

  it.each([
    ["x", "1"],
    ["1", "1.5"],
    ["1", "9999999999"],
  ])("refuses %s and %s", (start, count) => {
    expect(scimPage(start, count)).toMatchObject({
      ok: false,
      error: { scimType: "invalidValue" },
    });
  });
});

describe("resources", () => {
  it("builds a user without telling whether the person has an account", () => {
    const resource = scimUserResource(
      {
        id: `su_${"1".repeat(32)}`,
        email: "ada@acme.com",
        externalId: "00u1",
        names: { displayName: "Ada", givenName: "Ada", familyName: "Lovelace", formatted: "Ada L" },
        active: true,
        createdAt: Date.UTC(2026, 10, 10),
        updatedAt: Date.UTC(2026, 10, 11),
      },
      BASE,
    );
    expect(resource).toEqual({
      schemas: [SCIM_USER_SCHEMA],
      id: `su_${"1".repeat(32)}`,
      externalId: "00u1",
      userName: "ada@acme.com",
      name: { givenName: "Ada", familyName: "Lovelace", formatted: "Ada L" },
      displayName: "Ada",
      emails: [{ value: "ada@acme.com", type: "work", primary: true }],
      active: true,
      meta: {
        resourceType: "User",
        created: "2026-11-10T00:00:00.000Z",
        lastModified: "2026-11-11T00:00:00.000Z",
        location: `${BASE}/Users/su_${"1".repeat(32)}`,
      },
    });
    const bare = scimUserResource(
      {
        id: "su_x",
        email: "a@acme.com",
        externalId: null,
        names: {},
        active: false,
        createdAt: 0,
        updatedAt: 0,
      },
      BASE,
    );
    expect(bare).not.toHaveProperty("externalId");
    expect(bare).not.toHaveProperty("name");
    expect(bare).not.toHaveProperty("displayName");
  });

  it("lists, refuses and describes itself as the RFC shapes them", () => {
    expect(scimListResponse([1, 2], 7, 3)).toEqual({
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: 7,
      startIndex: 3,
      itemsPerPage: 2,
      Resources: [1, 2],
    });
    expect(scimErrorBody({ status: 409, scimType: "uniqueness", detail: "taken" })).toEqual({
      schemas: [SCIM_ERROR_SCHEMA],
      status: "409",
      scimType: "uniqueness",
      detail: "taken",
    });
    expect(scimErrorBody({ status: 404, detail: "gone" })).not.toHaveProperty("scimType");
    const config = scimServiceProviderConfig(BASE);
    expect(config).toMatchObject({
      patch: { supported: true },
      bulk: { supported: false },
      filter: { supported: true, maxResults: SCIM.maxPageSize },
      etag: { supported: false },
      authenticationSchemes: [{ type: "oauthbearertoken" }],
    });
    expect(scimResourceTypes(BASE).map((type) => type.id)).toEqual(["User"]);
    const [schema] = scimSchemas(BASE);
    expect(schema?.id).toBe(SCIM_USER_SCHEMA);
    expect(schema?.attributes.map((a) => a.name)).toEqual([
      "userName",
      "externalId",
      "displayName",
      "name",
      "emails",
      "active",
    ]);
  });

  it("reads stored names defensively", () => {
    expect(scimNamesOf(null)).toEqual({});
    expect(
      scimNamesOf({
        displayName: "A",
        givenName: 3,
        familyName: "",
        formatted: "x".repeat(300),
        extra: "y",
      }),
    ).toEqual({
      displayName: "A",
    });
  });
});

describe("scimDomainAllowed", () => {
  it("allows only addresses in a verified domain, exactly", () => {
    expect(scimDomainAllowed("a@acme.com", ["acme.com"])).toBe(true);
    expect(scimDomainAllowed("a@eu.acme.com", ["acme.com"])).toBe(false);
    expect(scimDomainAllowed("a@other.com", ["acme.com"])).toBe(false);
    expect(scimDomainAllowed("not-an-address", ["acme.com"])).toBe(false);
  });
});
