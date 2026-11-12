import "../main.css";
import { localizeAuthPage } from "../auth/i18n/i18n.ts";
import { browserStorage } from "../i18n/preference.ts";
import { reportSender, setupReport } from "../report/report.ts";

void localizeAuthPage(document, {
  url: location.href,
  storage: browserStorage,
  languages: navigator.languages,
}).then((locale) =>
  setupReport(document, {
    send: reportSender((input, init) => fetch(input, init)),
    location: window.location,
    locale,
  }),
);
