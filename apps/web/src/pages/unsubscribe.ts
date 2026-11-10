import "../main.css";
import { localizeAuthPage } from "../auth/i18n/i18n.ts";
import { browserStorage } from "../i18n/preference.ts";
import { setupUnsubscribe, unsubscribeSender } from "../unsubscribe/unsubscribe.ts";

void localizeAuthPage(document, {
  url: location.href,
  storage: browserStorage,
  languages: navigator.languages,
}).then(() =>
  setupUnsubscribe(document, {
    send: unsubscribeSender((input, init) => fetch(input, init)),
    location: window.location,
  }),
);
