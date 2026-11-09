// Shapes of the account endpoints under `/api/v1/account` (plan sections 5 and 6, "Cuenta").
// They answer only the dashboard's session cookie, never a bearer token, and show the signed-in
// user's own browser sessions and connected apps. Secrets (session tokens, OAuth tokens, IP
// addresses) never appear in them. The CLI's view of the same connected apps
// (`/api/v1/tokens`, bearer only with `credentials:manage`) is at the end.
import { z } from "zod";
import { AccessMode, CommentVisibility } from "./core.ts";

/** A signed-in browser on app.portifact.com. */
export const BrowserSession = z.object({
  /** True for the browser that made the request. */
  current: z.boolean(),
  /** The browser's own description, shown summarized; null when it sent none. */
  userAgent: z.string().nullable(),
  createdAt: z.iso.datetime(),
  lastActiveAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type BrowserSession = z.infer<typeof BrowserSession>;

export const BrowserSessionList = z.object({ items: z.array(BrowserSession) });
export type BrowserSessionList = z.infer<typeof BrowserSessionList>;

export const SignOutOthersResult = z.object({ signedOut: z.number().int().min(0) });
export type SignOutOthersResult = z.infer<typeof SignOutOthersResult>;

/** Which Portifact resource an app's tokens open: the publishing API or the MCP endpoint. */
export const AppResource = z.enum(["api", "mcp"]);
export type AppResource = z.infer<typeof AppResource>;

/** An OAuth client (the CLI or an MCP client) holding live tokens for the user. */
export const ConnectedApp = z.object({
  clientId: z.string(),
  /** The client's registered name. Untrusted text from the client: shown escaped, never as HTML. */
  name: z.string().nullable(),
  /** True for Portifact's own CLI. */
  firstParty: z.boolean(),
  resources: z.array(AppResource),
  scopes: z.array(z.string()),
  /** When the user approved the connection that the live tokens come from. */
  approvedAt: z.iso.datetime(),
  /** When the app last received a token, which it does while it is in use. */
  lastIssuedAt: z.iso.datetime(),
  /** When its last token expires unless the app renews it; null when a token never expires. */
  expiresAt: z.iso.datetime().nullable(),
});
export type ConnectedApp = z.infer<typeof ConnectedApp>;

export const ConnectedAppList = z.object({ items: z.array(ConnectedApp) });
export type ConnectedAppList = z.infer<typeof ConnectedAppList>;

export const DisconnectResult = z.object({ clientId: z.string(), disconnected: z.literal(true) });
export type DisconnectResult = z.infer<typeof DisconnectResult>;

/**
 * The OAuth scope that lets a bearer token list and revoke the account's own tokens
 * (`/api/v1/tokens`, decision 0003). It is not a product scope: only the first-party CLI client
 * may request it, so MCP and other registered clients can never manage credentials.
 */
export const CREDENTIALS_SCOPE = "credentials:manage";

/**
 * An app holding live tokens for the account, as `GET /api/v1/tokens` lists it for the CLI. Its
 * ID is the app's client ID; `current` marks the app whose token made the request.
 */
export const TokenGrant = ConnectedApp.extend({ current: z.boolean() });
export type TokenGrant = z.infer<typeof TokenGrant>;

export const TokenGrantList = z.object({ items: z.array(TokenGrant) });
export type TokenGrantList = z.infer<typeof TokenGrantList>;

/** `DELETE /api/v1/tokens/:clientId`: every token of that app for the account is revoked. */
export const TokenRevokeResult = z.object({
  clientId: z.string(),
  revoked: z.literal(true),
  /** True when the revoked app made the request, so its own token no longer works either. */
  current: z.boolean(),
});
export type TokenRevokeResult = z.infer<typeof TokenRevokeResult>;

/** Comments on a new artifact: closed, or open to everyone who can read it. */
export const DefaultAnnotations = z.enum(["off", "open"]);
export type DefaultAnnotations = z.infer<typeof DefaultAnnotations>;

/**
 * The owner's defaults for new artifacts (`GET /api/v1/account/settings`). They apply when a
 * publish creates an artifact, from any client; existing artifacts never change.
 */
export const AccountSettings = z.object({
  /** `restricted` (private to the owner until readers are added) unless the owner chose another. */
  defaultAccessMode: AccessMode,
  defaultAnnotations: DefaultAnnotations,
  defaultCommentVisibility: CommentVisibility,
  /** The Portifact bar on new artifacts. */
  defaultBar: z.boolean(),
  /** Email the owner before their artifacts expire (one email per account, grouped). */
  expiryNotices: z.boolean(),
});
export type AccountSettings = z.infer<typeof AccountSettings>;

/** A change to the defaults (`PATCH /api/v1/account/settings`): at least one of them. */
export const AccountSettingsUpdate = z
  .strictObject({
    defaultAccessMode: AccessMode.optional(),
    defaultAnnotations: DefaultAnnotations.optional(),
    defaultCommentVisibility: CommentVisibility.optional(),
    defaultBar: z.boolean().optional(),
    expiryNotices: z.boolean().optional(),
  })
  .refine((update) => Object.values(update).some((value) => value !== undefined), {
    message: "Send at least one change.",
  });
export type AccountSettingsUpdate = z.infer<typeof AccountSettingsUpdate>;
