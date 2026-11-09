import type { PageMessages } from "../../i18n/markers.ts";
import type { AuthMessages } from "./en.ts";

/** One language of the auth and report pages: what their scripts write and their markers. */
export interface AuthCatalog {
  messages: AuthMessages;
  /** The text of every `data-i18n` marker of login.html, device.html, consent.html and report.html. */
  page: PageMessages;
}
