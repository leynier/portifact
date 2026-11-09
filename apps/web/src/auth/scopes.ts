// Plain-language descriptions of what each OAuth scope allows, for the consent and device
// pages, in the page's language. Unknown scopes are shown by name, never hidden.
import { en } from "./i18n/en.ts";
import { messages } from "./messages.ts";

export const DESCRIBED_SCOPES = Object.keys(en.scopes);

/** One line per requested scope, in the order requested, without duplicates. */
export function describeScopes(scope: string): string[] {
  const names = [...new Set(scope.split(" ").filter(Boolean))];
  const descriptions: Readonly<Record<string, string>> = messages.scopes;
  return names.map((name) =>
    Object.hasOwn(descriptions, name)
      ? (descriptions[name] as string)
      : messages.unknownScope(name),
  );
}

/** A readable name for a resource indicator. */
export function describeResource(resource: string, origin: string): string {
  if (resource === `${origin}/api/v1`) return "Portifact API";
  if (resource === `${origin}/mcp`) return "Portifact MCP";
  return resource;
}
