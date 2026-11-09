// The document editor (plan section 6, "Documento"): edit the source of a Markdown or text
// artifact, preview the page the server renders for it, and save, which publishes a new version
// on the current one. The preview is the server's own rendering of the unsaved text, shown in a
// fully sandboxed frame; the editor never renders user markup itself.
import {
  type ArtifactSummary,
  LIMITS,
  type PublishRequest,
  type VersionManifest,
} from "@portifact/contracts";
import {
  Button,
  backLinkClasses,
  Callout,
  LoadingState,
  PageHeader,
  PreviewFrame,
} from "@portifact/ui";
import { revalidateLogic, useAppForm } from "@portifact/ui/forms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, CircleAlert, Eye, RefreshCw, Save } from "lucide-react";
import { useState } from "react";
import { ApiFailure } from "../api.ts";
import { useAnnounce, useDashboard, useT } from "../context.tsx";
import { DownloadFailure } from "../publish/download.ts";
import { publishFailureMessage } from "../publish/failures.ts";
import { sha256OfBlob } from "../publish/hash.ts";
import { runPublish } from "../publish/upload.ts";
import { useDocumentTitle } from "../use-document-title.ts";
import { artifactQuery } from "./artifact-detail.tsx";
import { ARTIFACTS_QUERY, errorMessage } from "./artifact-list.tsx";
import { versionsQuery } from "./history.tsx";

interface LoadedDocument {
  manifest: VersionManifest;
  /** The text of the entrypoint as published. */
  source: string;
}

const documentQuery = (artifactId: string, versionId: string | null) =>
  ["document", artifactId, versionId] as const;

const encoder = new TextEncoder();

export function DocumentEditorScreen() {
  const t = useT();
  const { artifactId } = useParams({ from: "/artifacts/$artifactId/edit" });
  const { api } = useDashboard();
  const artifact = useQuery({
    queryKey: artifactQuery(artifactId),
    queryFn: () => api.getArtifact(artifactId),
  });
  useDocumentTitle(
    artifact.data ? t("editor.title", { name: artifact.data.name }) : t("content.edit"),
  );
  const back = (
    <p className="mb-4 text-sm">
      <Link to="/artifacts/$artifactId" params={{ artifactId }} className={backLinkClasses}>
        <ArrowLeft aria-hidden="true" className="size-4" />
        {artifact.data?.name ?? t("detail.back")}
      </Link>
    </p>
  );
  if (artifact.isPending) {
    return (
      <>
        {back}
        <LoadingState label={t("editor.loading")} />
      </>
    );
  }
  if (artifact.isError) {
    return (
      <>
        {back}
        <PageHeader title={t("detail.error.title")} />
        <Callout
          tone="error"
          title={t("detail.error.title")}
          icon={<CircleAlert className="size-5" />}
        >
          {errorMessage(t, artifact.error)}
        </Callout>
      </>
    );
  }
  const current = artifact.data;
  let blocked: string | null = null;
  if (current.type === "site") blocked = t("editor.notDocument");
  else if (current.state !== "active" || !current.currentVersionId) {
    blocked = t("editor.unavailable");
  }
  return (
    <>
      {back}
      <PageHeader
        title={t("editor.title", { name: current.name })}
        description={t("editor.description")}
      />
      {blocked ? (
        <Callout title={blocked} icon={<CircleAlert className="size-5" />} />
      ) : (
        <EditorLoader artifact={current} />
      )}
    </>
  );
}

function EditorLoader({ artifact }: { artifact: ArtifactSummary }) {
  const t = useT();
  const { api, storage } = useDashboard();
  const loaded = useQuery({
    queryKey: documentQuery(artifact.id, artifact.currentVersionId),
    queryFn: async (): Promise<LoadedDocument> => {
      const versionId = artifact.currentVersionId as string;
      const manifest = await api.versionManifest(artifact.id, versionId);
      const download = await api.versionDownload(
        artifact.id,
        versionId,
        "published",
        manifest.entrypoint,
      );
      const file = download.files[0];
      if (!file) throw new ApiFailure("not_found", 404);
      let blob: Blob;
      try {
        blob = await storage.get(file.url);
      } catch {
        throw new DownloadFailure("network", file.path);
      }
      if (blob.size !== file.size || (await sha256OfBlob(blob)) !== file.sha256) {
        throw new DownloadFailure("integrity", file.path);
      }
      return { manifest, source: await blob.text() };
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  if (loaded.isPending) return <LoadingState label={t("editor.loading")} />;
  if (loaded.isError) {
    return (
      <Callout
        tone="error"
        title={t("editor.loadFailed.title")}
        icon={<CircleAlert className="size-5" />}
        action={
          <Button icon={<RefreshCw className="size-4" />} onClick={() => loaded.refetch()}>
            {t("action.retry")}
          </Button>
        }
      >
        {publishFailureMessage(t, loaded.error)}
      </Callout>
    );
  }
  // A new key per version restarts the editor from what was published.
  return <Editor key={loaded.data.manifest.id} artifact={artifact} loaded={loaded.data} />;
}

function Editor({ artifact, loaded }: { artifact: ArtifactSummary; loaded: LoadedDocument }) {
  const t = useT();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api, storage } = useDashboard();
  const type = artifact.type === "markdown" ? "markdown" : "text";
  const [preview, setPreview] = useState<{ html: string; source: string } | null>(null);

  const save = useMutation({
    mutationFn: async (source: string) => {
      const blob = new Blob([source], { type: "text/plain" });
      const sha256 = await sha256OfBlob(blob);
      const entry = loaded.manifest.entrypoint;
      const request: PublishRequest = {
        artifactId: artifact.id,
        type: artifact.type,
        name: artifact.name,
        entrypoint: entry,
        baseVersionId: loaded.manifest.id,
        // The other files (assets and sources) are already stored, so only the text is new.
        files: loaded.manifest.files.map((file) =>
          file.kind === "published" && file.path === entry
            ? { ...file, sha256, size: blob.size }
            : file,
        ),
      };
      return runPublish({
        api,
        transport: storage,
        request,
        idempotencyKey: crypto.randomUUID(),
        objects: new Map([[sha256, { blob, path: entry }]]),
        signal: new AbortController().signal,
        onPhase: () => {},
        onProgress: () => {},
      });
    },
    onMutate: () => announce(t("editor.saving")),
    onSuccess: async (committed) => {
      announce(t("editor.saved", { number: committed.versionNumber }));
      await queryClient.invalidateQueries({ queryKey: ARTIFACTS_QUERY });
      await queryClient.invalidateQueries({ queryKey: versionsQuery(artifact.id) });
      await queryClient.invalidateQueries({ queryKey: artifactQuery(artifact.id) });
    },
  });

  const render = useMutation({
    mutationFn: (source: string) => api.previewDocument({ type, name: artifact.name, source }),
    onSuccess: (result, source) => setPreview({ html: result.html, source }),
  });

  const form = useAppForm({
    defaultValues: { source: loaded.source },
    validationLogic: revalidateLogic(),
    validators: {
      onDynamic: ({ value }) =>
        encoder.encode(value.source).byteLength > LIMITS.documentBytes
          ? { fields: { source: t("editor.tooLarge") } }
          : undefined,
    },
    onSubmit: async ({ value }) => {
      if (value.source === loaded.source) {
        announce(t("editor.unchanged"));
        return;
      }
      await save.mutateAsync(value.source).catch(() => {});
    },
  });

  const conflict = save.error instanceof ApiFailure && save.error.code === "version_conflict";

  return (
    <div className="grid items-start gap-6 xl:grid-cols-2">
      <div className="min-w-0 rounded-lg border border-border bg-canvas p-5 shadow-sm">
        <form.AppForm>
          <form.Form label={t("editor.title", { name: artifact.name })}>
            <div className="flex flex-col gap-4">
              <form.AppField name="source">
                {(field) => (
                  <field.TextAreaField
                    label={t(`editor.source.${type}`)}
                    description={t("editor.source.hint", { path: loaded.manifest.entrypoint })}
                    code
                    rows={24}
                  />
                )}
              </form.AppField>
              {save.isError ? (
                <Callout
                  tone="error"
                  title={t("editor.saveFailed.title")}
                  icon={<CircleAlert className="size-5" />}
                  action={
                    conflict ? (
                      <Button
                        icon={<RefreshCw className="size-4" />}
                        onClick={() =>
                          queryClient.invalidateQueries({ queryKey: artifactQuery(artifact.id) })
                        }
                      >
                        {t("editor.reload")}
                      </Button>
                    ) : undefined
                  }
                >
                  {publishFailureMessage(t, save.error)}
                </Callout>
              ) : null}
              <div className="flex flex-wrap gap-3">
                <form.SubmitButton icon={<Save className="size-4" />} busy={save.isPending}>
                  {t("editor.save")}
                </form.SubmitButton>
                <form.Subscribe selector={(state) => state.values.source}>
                  {(source) => (
                    <Button
                      icon={<Eye className="size-4" />}
                      busy={render.isPending}
                      onClick={() => render.mutate(source)}
                    >
                      {t("editor.preview")}
                    </Button>
                  )}
                </form.Subscribe>
              </div>
            </div>
          </form.Form>
        </form.AppForm>
      </div>

      <section
        aria-labelledby="preview-heading"
        className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-canvas p-5 shadow-sm xl:sticky xl:top-10"
      >
        <h2 id="preview-heading" className="text-base font-semibold tracking-tight">
          {t("editor.previewHeading")}
        </h2>
        <p className="text-sm text-text-muted">{t("editor.previewHint")}</p>
        {render.isError ? (
          <Callout
            tone="error"
            title={t("editor.previewFailed.title")}
            icon={<CircleAlert className="size-5" />}
          >
            {errorMessage(t, render.error)}
          </Callout>
        ) : null}
        {preview ? (
          <>
            <form.Subscribe selector={(state) => state.values.source !== preview.source}>
              {(stale) =>
                stale ? <p className="text-sm font-medium">{t("editor.previewStale")}</p> : null
              }
            </form.Subscribe>
            <PreviewFrame
              title={t("editor.previewTitle", { name: artifact.name })}
              html={preview.html}
            />
          </>
        ) : (
          <p className="flex min-h-48 items-center justify-center rounded-md border border-dashed border-border-strong px-4 text-center text-sm text-text-muted">
            {t("editor.previewEmpty")}
          </p>
        )}
      </section>
    </div>
  );
}
