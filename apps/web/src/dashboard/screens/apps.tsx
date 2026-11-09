// The apps page (`/apps`, plan section 6, "Cuenta"): the CLI and MCP clients that hold tokens
// for the account, with "Disconnect".
import { PageHeader } from "@portifact/ui";
import { useT } from "../context.tsx";
import { useDocumentTitle } from "../use-document-title.ts";
import { ConnectedApps } from "./account.tsx";

export function AppsScreen() {
  const t = useT();
  useDocumentTitle(t("apps.title"));
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader title={t("apps.title")} description={t("apps.description")} />
      <ConnectedApps />
    </div>
  );
}
