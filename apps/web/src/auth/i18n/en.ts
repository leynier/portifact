// English text the auth and report pages' scripts write: the source every other catalog
// translates (es.ts and the ones after it). The pages' own text is in their HTML, marked for
// translation (src/i18n/markers.ts). Titles and buttons have no trailing period; no em dashes.

export const en = {
  network: "Portifact could not be reached. Check your connection and try again.",
  unexpected: "Something went wrong. Try again.",
  rateLimited: "Too many attempts. Wait a minute and try again.",
  emailRequired: "Enter your email address.",
  emailInvalid: "Enter a valid email address, like name@example.com.",
  codeRequired: "Enter the 6-digit code from the email.",
  codeInvalid: "That code is not valid or has expired. Check it or send a new code.",
  codeSent: (email: string) => `We sent a 6-digit code to ${email}.`,
  codeSentStatus: "Code sent. Enter the 6-digit code from the email.",
  codeResent: "A new code is on its way.",
  resendCode: "Send a new code",
  resendIn: (seconds: number) => `Send a new code in ${seconds}s`,
  humanCheckNeeded:
    "One more step: Cloudflare needs a quick check that you are human. Complete it below the sign-in options to continue.",
  emailSuppressed:
    "We cannot send email to this address because earlier messages to it bounced or were reported as spam. Sign in with Google or GitHub, or write to privacy@portifact.com to have it reviewed.",
  emailCapacity:
    "Email codes are paused for now because Portifact reached its monthly email limit. Sign in with Google or GitHub, or try again later.",
  signedInAs: (email: string) => `Signed in as ${email}`,
  signedOut: "You are signed out.",
  methodConnected: "Connected",
  methodNotUsed: "Not used yet",
  redirecting: "Signing you in.",
  termsUpdateFor: (email: string) => `Signed in as ${email}`,
  /** Why a sign-in came back with `?error=<code>`, by code; unknown codes get the fallback. */
  providerErrors: {
    human_verification_required:
      "New accounts need a quick check that you are human, and it did not finish. Try again; if a check appears below the sign-in options, complete it. If nothing appears, reload the page or allow challenges.cloudflare.com.",
    terms_not_accepted:
      "Your acceptance of the terms did not reach Portifact, or it expired after 30 minutes. Choose a sign-in option again to continue.",
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
  } as Readonly<Record<string, string>>,
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
  /** What each OAuth scope allows, for the consent and device pages (scopes.ts). */
  scopes: {
    "artifacts:read": "See your artifacts, their settings and their versions",
    "artifacts:write": "Publish and update artifacts",
    "artifacts:share": "Change who can open your artifacts",
    "artifacts:delete": "Archive and delete your artifacts",
    "annotations:read": "Read comments on your artifacts",
    "annotations:write": "Write and reply to comments as you",
    "annotations:moderate": "Resolve, hide and delete comments on your artifacts",
    "credentials:manage": "See the apps connected to your account and disconnect them",
    offline_access: "Stay connected until you revoke access",
  },
  /** A scope the page does not know, shown by name rather than hidden. */
  unknownScope: (name: string) => `Use the permission "${name}"`,
  /** The accessible name of the footer's language switcher. */
  languageLabel: "Language",
  /** The report page (src/report/report.ts). */
  report: {
    artifactRequired: "Enter the artifact's address or ID.",
    artifactInvalid:
      "Enter an address like https://abcdefghij.portifact.dev/ or a 10-character ID.",
    reasonRequired: "Choose what is wrong with the artifact.",
    detailsInvalid: "Remove control characters or shorten the details.",
    emailInvalid: "Enter a valid email address, or leave it empty.",
    rateLimited: "Too many reports from here. Try again later or write to abuse@portifact.com.",
    network: "Portifact could not be reached. Check your connection and try again.",
    failed: "The report could not be sent. Try again or write to abuse@portifact.com.",
    sent: "Report sent.",
  },
};

/** The script messages of the auth pages; every catalog provides all of them. */
export type AuthMessages = typeof en;
