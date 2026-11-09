// The apps page (`/apps`, plan section 6, "Cuenta"): the CLI and MCP clients that hold tokens
// for the account, as cards with "Disconnect", and how to connect another one.
import { CopyField, PageHeader, Panel } from "@portifact/ui";
import { useAnnounce, useT } from "../context.tsx";
import { useDocumentTitle } from "../use-document-title.ts";
import { ConnectedApps } from "./account.tsx";

export function AppsScreen() {
  const t = useT();
  useDocumentTitle(t("apps.title"));
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("apps.title")} description={t("apps.description")} />
      {/* The apps take the room; how to connect another sits beside them on wide screens. */}
      <div className="grid items-start gap-6 xl:grid-cols-3">
        <div className="min-w-0 xl:col-span-2">
          <ConnectedApps />
        </div>
        <ConnectApp />
      </div>
    </div>
  );
}

function ConnectApp() {
  const t = useT();
  const announce = useAnnounce();
  const copy = {
    copiedLabel: t("copy.copied"),
    onCopied: () => announce(t("copy.done")),
    onCopyFailed: () => announce(t("copy.failed")),
  };
  return (
    <Panel id="connect" title={t("apps.connect.title")} description={t("apps.connect.hint")}>
      <div className="flex flex-col gap-4">
        <CopyField
          kind="command"
          label={t("apps.connect.cli")}
          value="portifact login"
          copyLabel={t("apps.connect.copyCommand")}
          {...copy}
        />
        <CopyField
          label={t("apps.connect.mcp")}
          value={`${window.location.origin}/mcp`}
          copyLabel={t("apps.connect.copyUrl")}
          {...copy}
        />
      </div>
    </Panel>
  );
}
