// Publishing from the browser (plan section 6, "Crear o publicar" and "Carga"): choose a type and
// a source (files, a folder, a ZIP or a document), review the manifest and who can open the
// result before anything is uploaded, then upload with progress, cancel and resume. A new version
// of an existing artifact is published on its current version, so a concurrent publish elsewhere
// surfaces as a conflict instead of being overwritten.
import type {
  ArtifactSummary,
  ArtifactType,
  CommittedPublish,
  PreparedPublish,
  PublishRequest,
} from "@portifact/contracts";
import { DEFAULT_ENTRY } from "@portifact/domain";
import {
  Button,
  backLinkClasses,
  buttonClasses,
  Callout,
  CopyField,
  canPickFolders,
  DetailList,
  type DroppedItems,
  DropZone,
  FilePicker,
  LoadingState,
  PageHeader,
  ProgressBar,
  Steps,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@portifact/ui";
import { revalidateLogic, useAppForm } from "@portifact/ui/forms";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  CircleAlert,
  CircleCheck,
  FileArchive,
  Files,
  FileText,
  FolderOpen,
  MessageSquareText,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useAnnounce, useDashboard, useFormatBytes, useFormatDate, useT } from "../context.tsx";
import type { MessageId } from "../i18n/en.ts";
import { BuildCancelled } from "../publish/builder.ts";
import { canResume, publishFailureMessage } from "../publish/failures.ts";
import type { BrowserManifest, ManifestProgress, ManifestSource } from "../publish/manifest.ts";
import {
  type PublishPhase,
  preparedOf,
  runPublish,
  UploadCancelled,
  type UploadProgress,
} from "../publish/upload.ts";
import { useDocumentTitle } from "../use-document-title.ts";
import { artifactQuery } from "./artifact-detail.tsx";
import { ARTIFACTS_QUERY, errorMessage } from "./artifact-list.tsx";
import { USAGE_QUERY } from "./usage.tsx";

/** Where a pasted document is published, by type. */
export const PASTED_FILE: Record<Exclude<ArtifactType, "site">, string> = {
  markdown: "document.md",
  text: "document.txt",
};

const DOCUMENT_ACCEPT: Record<Exclude<ArtifactType, "site">, string> = {
  markdown: ".md,.markdown,text/markdown",
  text: ".txt,text/plain",
};

/** At most this often a progress bar re-renders while bytes stream. */
const PROGRESS_INTERVAL_MS = 100;

type Stage =
  | { step: "choose"; error?: unknown }
  | { step: "building"; progress?: ManifestProgress }
  | { step: "review"; manifest: BrowserManifest; name: string; key: string }
  | {
      step: "uploading";
      manifest: BrowserManifest;
      name: string;
      key: string;
      phase: PublishPhase;
      progress?: UploadProgress;
    }
  | {
      step: "failed";
      manifest: BrowserManifest;
      name: string;
      key: string;
      error: unknown;
      prepared?: PreparedPublish | undefined;
    }
  | { step: "done"; committed: CommittedPublish; name: string };

/** Calls `update` at most every interval, and always for the last value. */
function useThrottled<T>(update: (value: T) => void): (value: T, force?: boolean) => void {
  const last = useRef(0);
  return useCallback(
    (value: T, force = false) => {
      const now = Date.now();
      if (!force && now - last.current < PROGRESS_INTERVAL_MS) return;
      last.current = now;
      update(value);
    },
    [update],
  );
}

export function PublishScreen() {
  const t = useT();
  useDocumentTitle(t("publish.title"));
  return (
    <>
      <PageHeader title={t("publish.title")} description={t("publish.description")} />
      <PublishFlow />
    </>
  );
}

export function PublishVersionScreen() {
  const t = useT();
  const { artifactId } = useParams({ from: "/artifacts/$artifactId/publish" });
  const { api } = useDashboard();
  const artifact = useQuery({
    queryKey: artifactQuery(artifactId),
    queryFn: () => api.getArtifact(artifactId),
  });
  useDocumentTitle(
    artifact.data ? t("publish.versionTitle", { name: artifact.data.name }) : t("publish.title"),
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
        <LoadingState label={t("publish.loading")} />
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
  const base = artifact.data;
  return (
    <>
      {back}
      <PageHeader
        title={t("publish.versionTitle", { name: base.name })}
        description={t("publish.versionDescription")}
      />
      {base.state === "active" || base.state === "draft" ? (
        <PublishFlow base={base} />
      ) : (
        <Callout title={t("publish.unavailable")} icon={<CircleAlert className="size-5" />} />
      )}
    </>
  );
}

function defaultName(files: readonly File[], folder: boolean): string {
  const first = files[0];
  if (!first) return "";
  if (folder) return first.webkitRelativePath.split("/")[0] || first.name;
  return first.name.replace(/\.zip$/i, "");
}

const STEP_ORDER = ["choose", "review", "publish"] as const;
const STEP_LABELS: Record<(typeof STEP_ORDER)[number], MessageId> = {
  choose: "publish.steps.choose",
  review: "publish.steps.review",
  publish: "publish.steps.publish",
};

/** Where the flow stands, in the three steps people see. */
function FlowSteps({ stage }: { stage: Stage["step"] }) {
  const t = useT();
  const current =
    stage === "choose" || stage === "building"
      ? 0
      : stage === "review"
        ? 1
        : stage === "done"
          ? STEP_ORDER.length
          : 2;
  return (
    <div className="mb-8">
      <Steps
        label={t("publish.steps.label")}
        stateLabels={{ done: t("steps.done"), upcoming: t("steps.upcoming") }}
        steps={STEP_ORDER.map((step, index) => ({
          label: t(STEP_LABELS[step]),
          state: index < current ? "done" : index === current ? "current" : "upcoming",
        }))}
      />
    </div>
  );
}

function PublishFlow({ base }: { base?: ArtifactSummary }) {
  const t = useT();
  const formatBytes = useFormatBytes();
  const formatDate = useFormatDate();
  const announce = useAnnounce();
  const queryClient = useQueryClient();
  const { api, manifests, storage } = useDashboard();
  const [stage, setStage] = useState<Stage>({ step: "choose" });
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const form = useAppForm({
    defaultValues: {
      type: (base?.type ?? "site") as ArtifactType,
      name: "",
      entry: DEFAULT_ENTRY,
      text: "",
    },
    validationLogic: revalidateLogic(),
    validators: {
      onDynamic: ({ value }) =>
        value.type !== "site" && value.text.trim() === ""
          ? { fields: { text: t("publish.text.required") } }
          : undefined,
    },
    onSubmit: ({ value }) => {
      if (value.type === "site") return;
      void start(
        { kind: "text", text: value.text, fileName: PASTED_FILE[value.type] },
        t("publish.untitled"),
      );
    },
  });

  const showBuild = useThrottled(
    useCallback((progress: ManifestProgress) => setStage({ step: "building", progress }), []),
  );

  const start = async (source: ManifestSource, fallbackName: string) => {
    const { type, entry, name } = form.state.values;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setStage({ step: "building" });
    try {
      // The plan's per-artifact size, checked before hashing; the API checks the plan again.
      const usage = await queryClient
        .fetchQuery({ queryKey: USAGE_QUERY, queryFn: () => api.usage() })
        .catch(() => undefined);
      const maxBytes = usage?.plan.limits.artifactBytes;
      const manifest = await manifests.build(
        { source, options: { type, entry, maxBytes } },
        (progress) => showBuild(progress, progress.doneFiles === progress.totalFiles),
        abort.signal,
      );
      if (abort.signal.aborted) return;
      setStage({
        step: "review",
        manifest,
        name: base?.name ?? (name.trim() || fallbackName || t("publish.untitled")),
        key: crypto.randomUUID(),
      });
    } catch (error) {
      if (error instanceof BuildCancelled) {
        announce(t("publish.buildCancelled"));
        setStage({ step: "choose" });
        return;
      }
      setStage({ step: "choose", error });
    }
  };

  const pickFiles = (files: File[], folder: boolean) =>
    start(
      {
        kind: "files",
        folder,
        files: files.map((file) => ({ path: file.webkitRelativePath || file.name, blob: file })),
      },
      defaultName(files, folder),
    );
  /** Dropped files keep the paths inside what was dropped; one ZIP is read as an archive. */
  const pickDropped = ({ files, folder }: DroppedItems) => {
    const [only] = files;
    const type = form.state.values.type;
    if (type === "site" && files.length === 1 && only && /\.zip$/i.test(only.path)) {
      void start({ kind: "zip", blob: only.file }, defaultName([only.file], false));
      return;
    }
    const chosen = type === "site" ? files : files.slice(0, 1);
    void start(
      {
        kind: "files",
        folder: type === "site" && folder,
        files: chosen.map((entry) => ({ path: entry.path, blob: entry.file })),
      },
      folder
        ? (chosen[0]?.path.split("/")[0] ?? "")
        : defaultName(
            chosen.map((e) => e.file),
            false,
          ),
    );
  };

  const pickZip = (files: File[]) => {
    const [file] = files;
    if (file) void start({ kind: "zip", blob: file }, defaultName(files, false));
  };

  const showUpload = useThrottled(
    useCallback(
      (progress: UploadProgress) =>
        setStage((current) => (current.step === "uploading" ? { ...current, progress } : current)),
      [],
    ),
  );

  const publish = async (
    review: { manifest: BrowserManifest; name: string; key: string },
    resume?: PreparedPublish,
  ) => {
    const abort = new AbortController();
    controller.current = abort;
    const { manifest, name, key } = review;
    const kept = { manifest, name, key };
    const request: PublishRequest = {
      ...(base ? { artifactId: base.id } : {}),
      type: manifest.type,
      name,
      entrypoint: manifest.entrypoint,
      baseVersionId: base?.currentVersionId ?? null,
      files: manifest.files.map((file) => ({
        path: file.path,
        kind: "published",
        sha256: file.sha256,
        size: file.size,
        contentType: file.contentType,
      })),
    };
    setStage({ step: "uploading", ...kept, phase: "preparing" });
    announce(t("publish.phase.preparing"));
    try {
      const committed = await runPublish({
        api,
        transport: storage,
        request,
        idempotencyKey: key,
        objects: new Map(manifest.files.map((file) => [file.sha256, file])),
        resume,
        signal: abort.signal,
        onPhase: (phase, prepared) => {
          setStage((current) => (current.step === "uploading" ? { ...current, phase } : current));
          if (phase === "uploading") {
            announce(t("publish.uploadStarted", { count: prepared?.uploads.length ?? 0 }));
          } else if (phase === "committing") {
            announce(t("publish.phase.committing"));
          }
        },
        onProgress: (progress) =>
          showUpload(progress, progress.doneObjects === progress.totalObjects),
      });
      await queryClient.invalidateQueries({ queryKey: ARTIFACTS_QUERY });
      await queryClient.invalidateQueries({ queryKey: artifactQuery(committed.artifactId) });
      await queryClient.invalidateQueries({ queryKey: ["versions", committed.artifactId] });
      announce(t("publish.announce.done", { number: committed.versionNumber, name }));
      setStage({ step: "done", committed, name });
    } catch (error) {
      if (error instanceof UploadCancelled || abort.signal.aborted) {
        announce(t("publish.uploadCancelled"));
        setStage({ step: "review", manifest, name, key: crypto.randomUUID() });
        return;
      }
      setStage({ step: "failed", ...kept, error, prepared: preparedOf(error) });
    }
  };

  const cancel = () => controller.current?.abort();
  const startOver = () => {
    form.reset();
    setStage({ step: "choose" });
  };

  const content = renderStage();
  return (
    <>
      <FlowSteps stage={stage.step} />
      {content}
    </>
  );

  function renderStage() {
    if (stage.step === "building") {
      const progress = stage.progress;
      return (
        <section
          aria-labelledby="building-heading"
          className="flex flex-col gap-4 rounded-lg border border-border bg-canvas p-5 shadow-sm"
        >
          <h2 id="building-heading" className="text-lg font-semibold tracking-tight">
            {t("publish.building")}
          </h2>
          <ProgressBar
            label={t("publish.building")}
            value={progress?.doneBytes}
            max={Math.max(progress?.totalBytes ?? 1, 1)}
            valueText={
              progress
                ? t("publish.buildingProgress", {
                    done: formatBytes(progress.doneBytes),
                    total: formatBytes(progress.totalBytes),
                  })
                : t("publish.building")
            }
          />
          <div>
            <Button icon={<X className="size-4" />} onClick={cancel}>
              {t("publish.cancel")}
            </Button>
          </div>
        </section>
      );
    }

    if (stage.step === "review" || stage.step === "uploading" || stage.step === "failed") {
      return (
        <Review
          stage={stage}
          base={base}
          onPublish={() => void publish(stage)}
          onResume={() =>
            stage.step === "failed" ? void publish(stage, stage.prepared) : undefined
          }
          onCancel={cancel}
          onBack={startOver}
        />
      );
    }

    if (stage.step === "done") {
      const { committed } = stage;
      return (
        <div className="flex flex-col gap-6 rounded-lg border border-border bg-canvas p-5 shadow-sm sm:p-6">
          <Callout
            tone="success"
            title={t("publish.done.title", { number: committed.versionNumber })}
            icon={<CircleCheck className="size-5" />}
          >
            <p>
              {t("publish.done.body", {
                url: committed.url,
                date: formatDate(committed.expiresAt),
              })}
            </p>
          </Callout>
          <CopyField
            label={t("detail.link")}
            value={committed.url}
            href={committed.url}
            copyLabel={t("detail.copyLink")}
            copiedLabel={t("copy.copied")}
            onCopied={() => announce(t("detail.linkCopied"))}
            onCopyFailed={() => announce(t("copy.failed"))}
          />
          <div className="flex flex-wrap gap-2">
            <Link
              to="/artifacts/$artifactId"
              params={{ artifactId: committed.artifactId }}
              className={buttonClasses({ intent: "primary" })}
            >
              {t("publish.done.open")}
            </Link>
            {/* A full page load, so the viewer gets its own policy (frames of this artifact only). */}
            <a
              href={`/view/${encodeURIComponent(committed.artifactId)}`}
              className={buttonClasses()}
            >
              <MessageSquareText aria-hidden="true" className="size-4" />
              {t("publish.done.review")}
            </a>
            {base ? null : (
              <Button intent="ghost" onClick={startOver}>
                {t("publish.done.another")}
              </Button>
            )}
          </div>
        </div>
      );
    }

    return (
      <form.AppForm>
        <form.Form label={t("publish.step.choose")}>
          <div className="flex flex-col gap-6 rounded-lg border border-border bg-canvas p-5 shadow-sm sm:p-6">
            {stage.error ? (
              <Callout
                tone="error"
                title={t("publish.buildFailed.title")}
                icon={<CircleAlert className="size-5" />}
              >
                {publishFailureMessage(t, stage.error, formatBytes)}
              </Callout>
            ) : null}
            {base ? null : (
              <form.AppField name="type">
                {(field) => (
                  <field.RadioGroupField
                    layout="row"
                    legend={t("publish.type.legend")}
                    options={(["site", "markdown", "text"] as const).map((value) => ({
                      value,
                      label: t(`type.${value}`),
                      description: t(`publish.type.${value}`),
                    }))}
                  />
                )}
              </form.AppField>
            )}
            {base ? null : (
              <form.AppField name="name">
                {(field) => (
                  <field.TextField
                    label={t("publish.name.label")}
                    description={t("publish.name.hint")}
                    maxLength={200}
                  />
                )}
              </form.AppField>
            )}
            <form.Subscribe selector={(state) => state.values.type}>
              {(type) =>
                type === "site" ? (
                  <DropZone
                    label={t("publish.drop.site")}
                    activeLabel={t("publish.drop.active")}
                    onDrop={pickDropped}
                  >
                    <SiteSources
                      entryField={
                        <form.AppField name="entry">
                          {(field) => (
                            <field.TextField
                              label={t("publish.entry.label")}
                              description={t("publish.entry.hint")}
                            />
                          )}
                        </form.AppField>
                      }
                      onFiles={(files) => void pickFiles(files, false)}
                      onFolder={(files) => void pickFiles(files, true)}
                      onZip={pickZip}
                    />
                  </DropZone>
                ) : (
                  <div className="flex flex-col gap-6">
                    <DropZone
                      label={t("publish.drop.document")}
                      activeLabel={t("publish.drop.active")}
                      onDrop={pickDropped}
                    >
                      <FilePicker
                        label={t("publish.pick.document")}
                        description={t("publish.pick.documentHint")}
                        icon={<FileText className="size-4" />}
                        accept={DOCUMENT_ACCEPT[type]}
                        onPick={(files) => void pickFiles(files.slice(0, 1), false)}
                      />
                    </DropZone>
                    <form.AppField name="text">
                      {(field) => (
                        <field.TextAreaField
                          label={t("publish.text.label")}
                          description={t("publish.text.hint", { file: PASTED_FILE[type] })}
                          code
                        />
                      )}
                    </form.AppField>
                    <div>
                      <form.SubmitButton icon={<FileText className="size-4" />}>
                        {t("publish.text.use")}
                      </form.SubmitButton>
                    </div>
                  </div>
                )
              }
            </form.Subscribe>
          </div>
        </form.Form>
      </form.AppForm>
    );
  }
}

interface SiteSourcesProps {
  entryField: ReactNode;
  onFiles(files: File[]): void;
  onFolder(files: File[]): void;
  onZip(files: File[]): void;
}

function SiteSources({ entryField, onFiles, onFolder, onZip }: SiteSourcesProps) {
  const t = useT();
  const folders = canPickFolders();
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 sm:grid-cols-3">
        <FilePicker
          label={t("publish.pick.files")}
          description={t("publish.pick.filesHint")}
          icon={<Files className="size-4" />}
          multiple
          onPick={onFiles}
        />
        {folders ? (
          <FilePicker
            label={t("publish.pick.folder")}
            description={t("publish.pick.folderHint")}
            icon={<FolderOpen className="size-4" />}
            folder
            onPick={onFolder}
          />
        ) : null}
        <FilePicker
          label={t("publish.pick.zip")}
          description={folders ? t("publish.pick.zipHint") : t("publish.pick.zipOnly")}
          icon={<FileArchive className="size-4" />}
          accept=".zip,application/zip"
          onPick={onZip}
        />
      </div>
      <div className="border-t border-border pt-5">
        <div className="max-w-md">{entryField}</div>
      </div>
    </div>
  );
}

type ReviewStage = Extract<Stage, { step: "review" | "uploading" | "failed" }>;

function Review({
  stage,
  base,
  onPublish,
  onResume,
  onCancel,
  onBack,
}: {
  stage: ReviewStage;
  base: ArtifactSummary | undefined;
  onPublish(): void;
  onResume(): void;
  onCancel(): void;
  onBack(): void;
}) {
  const t = useT();
  const formatBytes = useFormatBytes();
  const { manifest, name } = stage;
  return (
    <section
      aria-labelledby="review-heading"
      className="flex flex-col gap-6 rounded-lg border border-border bg-canvas p-5 shadow-sm sm:p-6"
    >
      <h2 id="review-heading" className="text-lg font-semibold tracking-tight">
        {t("publish.step.review")}
      </h2>
      <DetailList
        items={[
          { term: t("publish.name.label"), detail: name },
          { term: t("detail.type"), detail: t(`type.${manifest.type}`) },
          {
            term: t("publish.review.entry"),
            detail: <code className="font-mono">{manifest.entrypoint}</code>,
          },
          {
            term: t("publish.review.files"),
            detail: t("publish.review.filesValue", {
              count: manifest.files.length,
              size: formatBytes(manifest.totalBytes),
            }),
          },
          {
            term: t("publish.review.access"),
            detail: base
              ? t("publish.review.accessVersion", { mode: t(`access.${base.accessMode}`) })
              : t("publish.review.accessNew"),
          },
        ]}
      />

      {stage.step === "uploading" ? (
        <div className="flex flex-col gap-4">
          <ProgressBar
            label={t(`publish.phase.${stage.phase}`)}
            value={stage.progress?.sentBytes}
            max={Math.max(stage.progress?.totalBytes ?? 1, 1)}
            valueText={
              stage.progress
                ? t("publish.uploadProgress", {
                    sent: formatBytes(stage.progress.sentBytes),
                    total: formatBytes(stage.progress.totalBytes),
                    done: stage.progress.doneObjects,
                    count: stage.progress.totalObjects,
                  })
                : t(`publish.phase.${stage.phase}`)
            }
          />
          <div>
            <Button icon={<X className="size-4" />} onClick={onCancel}>
              {t("publish.cancel")}
            </Button>
          </div>
        </div>
      ) : null}

      {stage.step === "failed" ? (
        <Callout
          tone="error"
          title={t("publish.failed.title")}
          icon={<CircleAlert className="size-5" />}
          action={
            <div className="flex flex-wrap gap-3">
              {stage.prepared && canResume(stage.error) ? (
                <Button intent="primary" icon={<RotateCcw className="size-4" />} onClick={onResume}>
                  {t("publish.resume")}
                </Button>
              ) : null}
              <Button onClick={onBack}>{t("publish.startOver")}</Button>
            </div>
          }
        >
          {publishFailureMessage(t, stage.error, formatBytes)}
        </Callout>
      ) : null}

      {stage.step === "review" ? (
        <div className="flex flex-wrap gap-3">
          <Button intent="primary" icon={<Upload className="size-4" />} onClick={onPublish}>
            {t("publish.review.publish")}
          </Button>
          <Button onClick={onBack}>{t("publish.review.back")}</Button>
        </div>
      ) : null}

      <Table caption={t("publish.review.caption")} captionVisible>
        <TableHead>
          <TableRow>
            <TableHeaderCell>{t("publish.review.column.path")}</TableHeaderCell>
            <TableHeaderCell>{t("publish.review.column.size")}</TableHeaderCell>
            <TableHeaderCell>{t("publish.review.column.type")}</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {manifest.files.map((file) => (
            <TableRow key={file.path}>
              <TableCell>
                <code className="font-mono break-all">{file.path}</code>
              </TableCell>
              <TableCell>{formatBytes(file.size)}</TableCell>
              <TableCell>{file.contentType}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {manifest.excluded.length > 0 ? (
        <section aria-labelledby="excluded-heading">
          <h3 id="excluded-heading" className="mb-1 font-semibold">
            {t("publish.review.excluded", { count: manifest.excluded.length })}
          </h3>
          <p className="mb-3 text-sm text-text-muted">{t("publish.review.excludedHint")}</p>
          <ul className="flex flex-col gap-1 text-sm">
            {manifest.excluded.map((entry) => (
              <li key={entry.path}>
                <code className="font-mono break-all">{entry.path}</code>
                {": "}
                {t(`publish.reason.${entry.reason}`)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
