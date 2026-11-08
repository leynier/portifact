import "../main.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { loginUrl } from "../auth/query.ts";
import { dashboardApi } from "./api.ts";
import { DashboardApp } from "./app.tsx";
import { createI18n } from "./i18n/i18n.ts";
import { createQueryClient } from "./query-client.ts";
import { createDashboardRouter } from "./router.tsx";

const leave = (url: string) => window.location.assign(url);
const env = {
  api: dashboardApi({
    fetch: (input, init) => fetch(input, init),
    onUnauthenticated: () =>
      leave(loginUrl(`${window.location.pathname}${window.location.search}`)),
  }),
  leave,
};

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <DashboardApp
        env={env}
        i18n={createI18n()}
        queryClient={createQueryClient()}
        router={createDashboardRouter()}
      />
    </StrictMode>,
  );
}
