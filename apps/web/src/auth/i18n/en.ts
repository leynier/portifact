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
  ssoFor: (email: string) => `${email} signs in through your organization's identity provider.`,
  ssoShown:
    "Your organization uses single sign-on. Continue with it, or get an email code instead.",
  termsUpdateFor: (email: string) => `Signed in as ${email}`,
  leaveCodeSent: (email: string) => `We sent a 6-digit deletion code to ${email}.`,
  leaveDeleted: "Your account was deleted.",
  leaveSoleAdmin:
    "You are the only admin of a workspace, and its members cannot be changed without accepting the terms. Either accept the terms, make another member its admin and then delete your account from Settings, or write to privacy@portifact.com and we will handle it.",
  leaveEmailSuppressed:
    "We cannot send email to your account's address because earlier messages to it bounced or were reported as spam. Write to privacy@portifact.com to delete your account.",
  leaveEmailCapacity:
    "Codes cannot be emailed right now because Portifact reached its monthly email limit. Try again later, or write to privacy@portifact.com to delete your account.",
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
    sso_unavailable:
      "Single sign-on is not available for this address right now. Sign in another way, or ask your workspace's admin.",
    sso_email_outside_domain:
      "Your organization's identity provider signed you in with an address outside its verified domains, so Portifact cannot use it. Ask your workspace's admin.",
    sso_failed:
      "Single sign-on did not finish. Try again; if it keeps failing, sign in with an email code and tell your workspace's admin.",
    sso_workspace_full:
      "Your organization's workspace has no free seat, so you could not join it. Ask its admin for a seat, then sign in again.",
    artifact_unavailable:
      "This artifact does not exist, is no longer available or cannot be opened with this account. To use another account, sign out and open the link again.",
    sso_required:
      "This workspace requires signing in through your organization's single sign-on. Continue with your work address below; your current sign-in stays as it is and you will come back where you were.",
    session_age:
      "This workspace asks for a new sign-in after a while, and yours is older than it allows. Sign in again to continue; you will come back where you were.",
    network_refused:
      "This workspace only allows access from its approved networks, and you are not on one of them now. Connect from an approved network and open the link again, or ask a workspace admin.",
    read_rate_limited:
      "This account opened too many artifacts in a short time. Wait a few minutes and open the link again.",
    sso_email_unverified:
      "Your organization's identity provider has not verified this address, so Portifact cannot use it. Ask your workspace's admin.",
    sso_link_required:
      "This address already has a Portifact account. Sign in once with an email code or the way you usually do, then choose Link single sign-on on this page.",
    sso_removed:
      "An admin of the workspace removed you, so you cannot join it again through single sign-on. Ask an admin to invite you again.",
  } as Readonly<Record<string, string>>,
  providerErrorFallback: "Sign-in did not finish. Try again.",
  /** The read entry's confirmation before a code goes to an artifact's custom host. */
  readConfirm: {
    heading: "Open on its own address",
    body: (host: string) =>
      `This artifact is on ${host}, an address its owner manages. Continue only if you meant to open it there.`,
    continue: "Continue",
    missing: "The link to open was not complete. Open it again from where you found it.",
  },
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
    "data:read": "Read and export the data saved in your artifacts",
    "data:write": "Change the data saved in your artifacts",
    "credentials:manage": "See the apps connected to your account and disconnect them",
    offline_access: "Stay connected until you revoke access",
  },
  /** A scope the page does not know, shown by name rather than hidden. */
  unknownScope: (name: string) => `Use the permission "${name}"`,
  /** The accessible name of the footer's language switcher. */
  languageLabel: "Language",
  /** The report page (src/report/report.ts). */
  report: {
    artifactRequired: "Enter the exact address or the artifact's ID.",
    artifactInvalid:
      "Enter an address like https://abcdefghij.portifact.dev/ or a 10-character ID.",
    reasonRequired: "Choose what is wrong with the artifact.",
    detailsInvalid: "Remove control characters or shorten the details.",
    emailInvalid: "Enter a valid email address, or leave it empty.",
    nameInvalid: "Enter your name on one line, up to 200 characters, or leave it empty.",
    confirmRequired:
      "Confirm that the information is accurate and complete and that you send it in good faith.",
    rateLimited: "Too many reports from here. Try again later or write to abuse@portifact.com.",
    network: "Portifact could not be reached. Check your connection and try again.",
    failed: "The report could not be sent. Try again or write to abuse@portifact.com.",
    sent: "Report sent.",
  },
  /** The share link entry page (src/share/share.ts). */
  share: {
    checking: "Checking the link.",
    opening: "Opening the artifact.",
    passwordRequired: "Enter the password.",
    refused: "The password is wrong, or the link expired or was revoked.",
    humanCheckShown:
      "Confirm below that you are human. The password is tried again when you finish.",
    humanCheckUnavailable:
      "The human check could not load. Allow challenges.cloudflare.com, or try again later.",
    rateLimited: "Too many attempts. Wait a few minutes and try again.",
    network: "Portifact could not be reached. Check your connection and try again.",
    failed: "The link could not be opened. Try again.",
  },
  /** The comment notice unsubscribe page (src/unsubscribe/unsubscribe.ts). */
  unsubscribe: {
    missing:
      "This link is incomplete. Open the link from the email again, or turn comment notices off in your settings.",
    invalid: "This link does not work any more. Turn comment notices off in your settings instead.",
    rateLimited: "Too many tries from here. Try again in a few minutes.",
    network: "Portifact could not be reached. Check your connection and try again.",
    failed:
      "Comment notices could not be turned off. Try again, or turn them off in your settings.",
    done: "Comment and review notices turned off.",
  },
};

/** The script messages of the auth pages; every catalog provides all of them. */
export type AuthMessages = typeof en;
