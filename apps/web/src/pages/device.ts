import "../main.css";
import { browserApi } from "../auth/api.ts";
import { setupDevice } from "../auth/device.ts";
import { localizeAuthPage } from "../auth/i18n/i18n.ts";
import { browserStorage } from "../i18n/preference.ts";

void localizeAuthPage(document, {
  url: location.href,
  storage: browserStorage,
  languages: navigator.languages,
}).then((locale) =>
  setupDevice(document, {
    api: browserApi((input, init) => fetch(input, init), { locale }),
    location: window.location,
    origin: window.location.origin,
  }),
);
