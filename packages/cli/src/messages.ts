// User-facing text of the CLI, kept in one place so it can move to the i18n layer. Sentences
// end with a period; no em dashes. Never interpolate a token, cookie or code other than the
// device user code, which the user must see to approve the login.

export const messages = {
  notice: [
    "Portifact is in early development.",
    "Sign in with `portifact login`. Publishing arrives in a later release.",
    "Run `portifact --help` for the available commands.",
    "",
  ].join("\n"),
  serverOverride: (origin: string) => `Using the Portifact server at ${origin}.`,
  deviceInstructions: (url: string, userCode: string) =>
    [
      "To sign in, open this page in a browser:",
      "",
      `  ${url}`,
      "",
      `and confirm that it shows this code: ${userCode}`,
      "",
    ].join("\n"),
  browserOpened: "Opened the page in your browser.",
  waiting: (minutes: number) =>
    `Waiting for approval. The code expires in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
  fileStoreWarning: (path: string) =>
    `Warning: no system credential store is available, so your credentials are saved in ${path}, readable only by your user account.`,
  signedIn: (origin: string, userId: string) => `Signed in to ${origin} as user ${userId}.`,
  whoami: (origin: string, userId: string, clientId: string, scopes: readonly string[]) =>
    [
      `Signed in to ${origin}`,
      `User: ${userId}`,
      `Client: ${clientId}`,
      `Scopes: ${scopes.length > 0 ? scopes.join(", ") : "none"}`,
    ].join("\n"),
  signedOut: (origin: string) =>
    `Signed out of ${origin}. The tokens were revoked and removed from this device.`,
  notSignedInLogout: (origin: string) => `Not signed in to ${origin}. Nothing to do.`,
  errorPrefix: "Error:",
  errors: {
    notSignedIn: (origin: string) =>
      `Not signed in to ${origin}. Run \`portifact login\` to sign in.`,
    sessionEnded: (origin: string) =>
      `Your session on ${origin} has expired or was revoked. Run \`portifact login\` to sign in again.`,
    denied: "The login request was denied. Run `portifact login` to try again.",
    expired: "The login code expired before it was approved. Run `portifact login` to try again.",
    network: (origin: string) => `Could not reach ${origin}. Check your connection and try again.`,
    rateLimited: "Too many requests. Wait a minute and try again.",
    server: (origin: string) => `${origin} sent a response the CLI did not expect. Try again.`,
    revokeFailed: (origin: string) =>
      `Could not revoke your tokens on ${origin}, so they were kept on this device. Run \`portifact logout\` again.`,
    invalidOrigin:
      "PORTIFACT_APP_ORIGIN must be an https origin, or http on localhost, without a user name or password.",
  },
} as const;
