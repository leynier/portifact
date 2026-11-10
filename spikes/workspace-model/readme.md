# Workspace model spike (S1)

Harness for [decision 0004](../../docs/decisions/0004-workspace-model.md): can Portifact build workspaces, SSO and SCIM on Better Auth 1.7.18's organization, SSO and SCIM plugins, on D1 through Drizzle in workerd, behind the auth allowlist and the terms and human-check hooks?

Everything runs in workerd through `@cloudflare/vitest-plugin`, over the real migrations of `packages/db` plus `migrations/9001_workspace_plugins.sql`, with the real `termsHooks` and `humanHooks` imported from `apps/app/src/auth`.

- `src/auth.ts`: Better Auth configured like `apps/app`, plus the three plugins; options switch the transaction mode, SCIM, the SSO domain rule and the workspace model (`plugin` or `own`).
- `src/schema.ts`: Drizzle tables for the plugins in the repository's conventions, and the Portifact-owned `workspaces` and `workspace_members` of the alternative.
- `src/membership.ts`, `src/workspaces.ts`: how `packages/services` would resolve `Actor { userId, ownerId, role }` from either model, and change owned workspaces in D1 batches.
- `src/routes.ts`: every plugin endpoint classified as open or closed, with the reason.
- `src/*.test.ts`: the evidence. `organization`, `sso-oidc`, `sso-saml` (samlify plays the IdP and signs with a key made per run by `openssl` in `vitest.config.ts`), `scim`, `routes`, `schema` and `own-tables`.

Run from the repository root:

```bash
bun run spike:workspace-model
```

It also runs in `bun run test`. It needs `openssl` on the path. This code is never deployed or imported by apps and packages.
