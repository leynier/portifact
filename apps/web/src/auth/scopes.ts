// Plain-language descriptions of what each OAuth scope allows, for the consent and device
// pages. Unknown scopes are shown by name, never hidden.

const DESCRIPTIONS: Record<string, string> = {
  "artifacts:read": "See your artifacts, their settings and their versions",
  "artifacts:write": "Publish and update artifacts",
  "artifacts:share": "Change who can open your artifacts",
  "artifacts:delete": "Archive and delete your artifacts",
  "annotations:read": "Read comments on your artifacts",
  "annotations:write": "Write and reply to comments as you",
  "annotations:moderate": "Resolve, hide and delete comments on your artifacts",
  offline_access: "Stay connected until you revoke access",
};

export const DESCRIBED_SCOPES = Object.keys(DESCRIPTIONS);

/** One line per requested scope, in the order requested, without duplicates. */
export function describeScopes(scope: string): string[] {
  const names = [...new Set(scope.split(" ").filter(Boolean))];
  return names.map((name) => DESCRIPTIONS[name] ?? `Use the permission "${name}"`);
}

/** A readable name for a resource indicator. */
export function describeResource(resource: string, origin: string): string {
  if (resource === `${origin}/api/v1`) return "Portifact API";
  if (resource === `${origin}/mcp`) return "Portifact MCP";
  return resource;
}
