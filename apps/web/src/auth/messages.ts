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
  emailSuppressed:
    "We cannot send email to this address because earlier messages to it bounced or were reported as spam. Sign in with Google or GitHub, or write to privacy@portifact.com to have it reviewed.",
  emailCapacity:
    "Email codes are paused for now because Portifact reached its monthly email limit. Sign in with Google or GitHub, or try again later.",
  signedInAs: (email: string) => `Signed in as ${email}`,
  signedOut: "You are signed out.",
  methodConnected: "Connected",
  methodNotUsed: "Not used yet",
  redirecting: "Signing you in.",
  termsRequired: "Confirm you are 18 or older and accept the terms to continue.",
  termsUpdateFor: (email: string) => `Signed in as ${email}`,
  providerErrors: {
    human_verification_required:
      "New accounts need a quick check that you are human. Complete the check on this page, or reload it if the check does not appear, and try again.",
    terms_not_accepted:
      "Portifact needs you to confirm you are 18 or older and accept the terms before signing in. Check the box and try again.",
    account_not_linked:
      "Your provider has not verified this email address, so it cannot open the Portifact account that uses it. Verify it there, or sign in with an email code.",
    email_not_verified:
      "Your provider has not verified this email address. Verify it there, or sign in with an email code.",
    email_not_found: "Your provider did not share an email address. Sign in with an email code.",
    state_mismatch: "The sign-in took too long or was started in another tab. Try again.",
    artifact_unavailable:
      "This artifact does not exist, is no longer available or cannot be opened with this account. To use another account, sign out and open the link again.",
    read_rate_limited:
      "This account opened too many artifacts in a short time. Wait a few minutes and open the link again.",
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
