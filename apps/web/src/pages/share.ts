import "../main.css";
import { HUMAN_CHECK_ACTIONS } from "@portifact/contracts/human-check";
import { localizeAuthPage } from "../auth/i18n/i18n.ts";
import { turnstileWidget } from "../human-check/turnstile.ts";
import { browserStorage } from "../i18n/preference.ts";
import { setupShare, shareSender, takeToken } from "../share/share.ts";

// First of all, before anything can read or rewrite the address: the token leaves the URL.
const token = takeToken(window.location, window.history);
// A link opened again in this tab only changes the fragment, which loads nothing: start over.
window.addEventListener("hashchange", () => window.location.reload());

void localizeAuthPage(document, {
  url: location.href,
  storage: browserStorage,
  languages: navigator.languages,
}).then(() =>
  setupShare(document, {
    token,
    send: shareSender((input, init) => fetch(input, init)),
    navigate: (url) => window.location.replace(url),
    humanCheck: turnstileWidget(document, HUMAN_CHECK_ACTIONS.shareLink),
  }),
);
