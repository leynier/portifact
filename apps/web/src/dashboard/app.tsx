import type { I18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { DashboardContext, type DashboardEnv } from "./context.tsx";
import type { createDashboardRouter } from "./router.tsx";

export interface DashboardAppProps {
  env: DashboardEnv;
  i18n: I18n;
  queryClient: QueryClient;
  router: ReturnType<typeof createDashboardRouter>;
}

export function DashboardApp({ env, i18n, queryClient, router }: DashboardAppProps) {
  return (
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <DashboardContext.Provider value={env}>
          <RouterProvider router={router} />
        </DashboardContext.Provider>
      </QueryClientProvider>
    </I18nProvider>
  );
}
