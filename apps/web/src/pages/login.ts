import "../main.css";
import { HUMAN_CHECK_ACTIONS } from "@portifact/contracts/human-check";
import { browserApi } from "../auth/api.ts";
import { localizeAuthPage } from "../auth/i18n/i18n.ts";
import { setupLogin } from "../auth/login.ts";
import { turnstileWidget } from "../human-check/turnstile.ts";
import { browserStorage } from "../i18n/preference.ts";

void localizeAuthPage(document, {
  url: location.href,
  storage: browserStorage,
  languages: navigator.languages,
}).then((locale) =>
  setupLogin(document, {
    // The page's language goes with every call, so the sign-in code email is written in it.
    api: browserApi((input, init) => fetch(input, init), { locale }),
    location: window.location,
    origin: window.location.origin,
    humanCheck: turnstileWidget(document, HUMAN_CHECK_ACTIONS.signUp),
  }),
);
