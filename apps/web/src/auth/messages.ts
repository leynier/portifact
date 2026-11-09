// The text the auth and report pages' scripts write, in the page's language. It starts as the
// English catalog; `localizeAuthPage` (i18n/i18n.ts) replaces it with the reader's language
// before a page sets up, so scripts read it when they write, never at import.
import { type AuthMessages, en } from "./i18n/en.ts";

export type { AuthMessages } from "./i18n/en.ts";

export const messages: AuthMessages = { ...en };
