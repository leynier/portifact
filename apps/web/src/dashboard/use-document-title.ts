import { useEffect } from "react";
import { useT } from "./context.tsx";

/** Names the browser tab after the current screen, so every page has a distinct title. */
export function useDocumentTitle(page: string | undefined): void {
  const t = useT();
  useEffect(() => {
    document.title = page ? t("app.pageTitle", { page }) : t("app.title");
  }, [page, t]);
}
