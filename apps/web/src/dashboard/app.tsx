import type { I18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { DashboardContext, type DashboardEnv } from "./context.tsx";
import { type LocaleOptions, LocaleProvider } from "./locale.tsx";
import type { createDashboardRouter } from "./router.tsx";

export interface DashboardAppProps {
  env: DashboardEnv;
  i18n: I18n;
  queryClient: QueryClient;
  router: ReturnType<typeof createDashboardRouter>;
  /** Where the language choice is kept and how catalogs load; the browser's by default. */
  locale?: LocaleOptions | undefined;
}

export function DashboardApp({ env, i18n, queryClient, router, locale }: DashboardAppProps) {
  return (
    <I18nProvider i18n={i18n}>
      <LocaleProvider i18n={i18n} options={locale}>
        <QueryClientProvider client={queryClient}>
          <DashboardContext.Provider value={env}>
            <RouterProvider router={router} />
          </DashboardContext.Provider>
        </QueryClientProvider>
      </LocaleProvider>
    </I18nProvider>
  );
}
