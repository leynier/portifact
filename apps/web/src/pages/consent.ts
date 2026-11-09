import "../main.css";
import { browserApi } from "../auth/api.ts";
import { setupConsent } from "../auth/consent.ts";
import { localizeAuthPage } from "../auth/i18n/i18n.ts";
import { browserStorage } from "../i18n/preference.ts";

void localizeAuthPage(document, {
  url: location.href,
  storage: browserStorage,
  languages: navigator.languages,
}).then((locale) =>
  setupConsent(document, {
    api: browserApi((input, init) => fetch(input, init), { locale }),
    location: window.location,
    origin: window.location.origin,
  }),
);
