import "../main.css";
import { HUMAN_CHECK_ACTIONS } from "@portifact/contracts/human-check";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { loginUrl } from "../auth/query.ts";
import { turnstileWidget } from "../human-check/turnstile.ts";
import {
  applyDocumentLocale,
  browserStorage,
  localeParam,
  pageLocale,
  withoutLocaleParam,
} from "../i18n/preference.ts";
import { dashboardApi } from "./api.ts";
import { DashboardApp } from "./app.tsx";
import { CATALOG_LOADERS, createI18n } from "./i18n/i18n.ts";
import { workerBuilder } from "./publish/builder.ts";
import { saveFile } from "./publish/save.ts";
import { xhrTransport } from "./publish/transport.ts";
import { createQueryClient } from "./query-client.ts";
import { createDashboardRouter } from "./router.tsx";
import { stashInvitationToken } from "./screens/invitations.tsx";

const leave = (url: string) => window.location.assign(url);
const env = {
  api: dashboardApi({
    fetch: (input, init) => fetch(input, init),
    onUnauthenticated: () =>
      leave(loginUrl(`${window.location.pathname}${window.location.search}`)),
  }),
  leave,
  manifests: workerBuilder(),
  storage: xhrTransport,
  save: saveFile,
  humanCheck: turnstileWidget(document, HUMAN_CHECK_ACTIONS.comment),
};

/**
 * The i18n instance in the reader's language (`?lang=`, their choice in this browser, their
 * browser's languages, English), with its catalog loaded before the first render so nothing
 * shows in the wrong language. A catalog that cannot load leaves English.
 */
async function startI18n() {
  const url = window.location.href;
  const locale = pageLocale({ url, storage: browserStorage, languages: navigator.languages });
  if (localeParam(url)) window.history.replaceState(null, "", withoutLocaleParam(url));
  const i18n = await CATALOG_LOADERS[locale]()
    .then((messages) => createI18n(locale, messages))
    .catch(() => createI18n());
  applyDocumentLocale(document, i18n.locale === locale ? locale : "en");
  return i18n;
}

const root = document.getElementById("root");
if (root) {
  // An invitation link's token leaves the address bar before anything reads the location.
  stashInvitationToken(window);
  const i18n = await startI18n();
  createRoot(root).render(
    <StrictMode>
      <DashboardApp
        env={env}
        i18n={i18n}
        queryClient={createQueryClient()}
        router={createDashboardRouter()}
      />
    </StrictMode>,
  );
}
