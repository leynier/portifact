// User-facing text of the auth pages, kept in one place so it can move to the i18n layer
// with the dashboard. Titles and buttons have no trailing period; no em dashes.

export const messages = {
  network: "Portifact could not be reached. Check your connection and try again.",
  unexpected: "Something went wrong. Try again.",
  rateLimited: "Too many attempts. Wait a minute and try again.",
  emailRequired: "Enter your email address.",
  emailInvalid: "Enter a valid email address, like name@example.com.",
  codeRequired: "Enter the 6-digit code from the email.",
  codeInvalid: "That code is not valid or has expired. Check it or send a new code.",
  codeSent: (email: string) =>
    `We sent a 6-digit code to ${email}. It expires in 5 minutes and works once.`,
  codeResent: "A new code is on its way.",
  signedInAs: (email: string) => `Signed in as ${email}`,
  signedOut: "You are signed out.",
  redirecting: "Signing you in.",
  providerErrors: {
    account_not_linked:
      "This email already belongs to a Portifact account that signs in another way. Use that method, for example an email code.",
    email_not_verified:
      "Your provider has not verified this email address. Verify it there, or sign in with an email code.",
    email_not_found: "Your provider did not share an email address. Sign in with an email code.",
    state_mismatch: "The sign-in took too long or was started in another tab. Try again.",
  } as Record<string, string>,
  providerErrorFallback: "Sign-in did not finish. Try again.",
  deviceCodeRequired: "Enter the code shown in your terminal.",
  deviceCodeInvalid: "That code is not valid or has expired. Run the login command again.",
  deviceCodeTaken: "Another account is already reviewing this code.",
  deviceProcessed: "This code was already used. Run the login command again.",
  deviceApproved: "Device connected. You can return to your terminal.",
  deviceDenied: "Request denied. The device did not get access.",
  consentMissing:
    "This page needs an authorization request. Start again from the app that sent you here.",
  consentClientUnknown: "The app that sent you here is not registered or is disabled.",
  redirectHost: (host: string) => `After you decide, you return to ${host}.`,
} as const;
