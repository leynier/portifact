// Comment attachments and screenshots in the viewer (decision 0028). Files go straight to
// storage through the presigned PUT the API returns; nothing is posted until the person posts the
// comment. A screenshot is one frame of the browser's own screen capture, taken in this page:
// no script ever reads the artifact's frame. Files on messages are untrusted: an image is shown
// only as a `blob:` URL of bytes this page fetched and checked (size and SHA-256), and every
// other file is only handed to the person as a download.
import {
  ATTACHMENT_IMAGE_TYPES,
  ATTACHMENT_LIMITS,
  type AttachmentView,
} from "@portifact/contracts";
import { Button, FilePicker, IconButton, LoadingState } from "@portifact/ui";
import { Camera, Download, FileText, Paperclip, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useAnnounce, useDashboard, useT } from "../context.tsx";
import { sha256OfBlob } from "../publish/hash.ts";

/** What the file picker offers; the server judges the bytes whatever the picker allowed. */
export const ATTACHMENT_ACCEPT = [
  ...ATTACHMENT_IMAGE_TYPES,
  "application/pdf",
  "text/plain",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".pdf",
  ".txt",
].join(",");

/** Whether people may add files here (the viewer's lookup, `attachments`). */
export const AttachmentsContext = createContext(false);

export function useAttachmentsEnabled(): boolean {
  return useContext(AttachmentsContext);
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
};

/** The name a file is saved under: its name, with the extension its type calls for appended. */
export function savedName(file: Pick<AttachmentView, "name" | "contentType">): string {
  const extension = EXTENSIONS[file.contentType] ?? "";
  const lower = file.name.toLowerCase();
  const fits =
    extension === "" ||
    lower.endsWith(extension) ||
    (extension === ".jpg" && lower.endsWith(".jpeg"));
  return fits ? file.name : `${file.name}${extension}`;
}

/** A name the API accepts: no control or path characters, at most the limit, never empty. */
export function attachmentName(raw: string, fallback: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029/\\]+/g, " ").trim();
  const points = [...(cleaned || fallback)];
  if (points.length <= ATTACHMENT_LIMITS.nameMaxCodePoints) return points.join("");
  // Keep the end, which holds the extension.
  return points.slice(points.length - ATTACHMENT_LIMITS.nameMaxCodePoints).join("");
}

export interface PendingFile {
  key: string;
  name: string;
  size: number;
  state: "uploading" | "ready" | "failed";
  /** The attachment's ID once its bytes are stored. */
  id?: string;
  /** A local preview of an image the person chose, as a `blob:` URL; never shown for others. */
  preview?: string;
}

type Problem = "tooMany" | "tooLarge" | "empty" | "captureFailed" | "wait" | null;

/**
 * The files of one comment being written: added, uploaded at once, removable until posted. `ids`
 * are the files ready to name; `busy` while any still uploads.
 */
export function useAttachmentUploads(artifactId: string) {
  const { api, storage } = useDashboard();
  const t = useT();
  const announce = useAnnounce();
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [problem, setProblem] = useState<{ kind: Problem; name?: string }>({ kind: null });
  const controllers = useRef(new Map<string, AbortController>());
  const previews = useRef(new Set<string>());

  useEffect(
    () => () => {
      for (const controller of controllers.current.values()) controller.abort();
      for (const url of previews.current) URL.revokeObjectURL(url);
    },
    [],
  );

  const update = useCallback((key: string, change: Partial<PendingFile>) => {
    setFiles((current) =>
      current.map((file) => (file.key === key ? { ...file, ...change } : file)),
    );
  }, []);

  const add = useCallback(
    async (blob: Blob, rawName: string) => {
      const name = attachmentName(rawName, t("review.attach.screenshotName"));
      if (files.length >= ATTACHMENT_LIMITS.perMessage) {
        setProblem({ kind: "tooMany" });
        return;
      }
      if (blob.size === 0) {
        setProblem({ kind: "empty", name });
        return;
      }
      if (blob.size > ATTACHMENT_LIMITS.fileMaxBytes) {
        setProblem({ kind: "tooLarge", name });
        return;
      }
      setProblem({ kind: null });
      const key = crypto.randomUUID();
      const preview = blob.type.startsWith("image/") ? URL.createObjectURL(blob) : undefined;
      if (preview) previews.current.add(preview);
      setFiles((current) => [
        ...current,
        { key, name, size: blob.size, state: "uploading", ...(preview ? { preview } : {}) },
      ]);
      const controller = new AbortController();
      controllers.current.set(key, controller);
      try {
        const sha256 = await sha256OfBlob(blob);
        const prepared = await api.prepareAttachment(artifactId, { name, size: blob.size, sha256 });
        const answer = await storage.put(
          {
            sha256,
            size: blob.size,
            method: "PUT",
            url: prepared.upload.url,
            headers: prepared.upload.headers,
            expiresAt: prepared.upload.expiresAt,
          },
          blob,
          () => {},
          controller.signal,
        );
        if (answer.status < 200 || answer.status >= 300) throw new Error("storage");
        update(key, { state: "ready", id: prepared.attachment.id });
        announce(t("review.attach.added", { name }));
      } catch {
        if (!controller.signal.aborted) update(key, { state: "failed" });
      } finally {
        controllers.current.delete(key);
      }
    },
    [api, storage, artifactId, files.length, t, announce, update],
  );

  const remove = useCallback((key: string) => {
    controllers.current.get(key)?.abort();
    setFiles((current) => {
      const gone = current.find((file) => file.key === key);
      if (gone?.preview) {
        URL.revokeObjectURL(gone.preview);
        previews.current.delete(gone.preview);
      }
      return current.filter((file) => file.key !== key);
    });
    setProblem({ kind: null });
  }, []);

  const busy = files.some((file) => file.state !== "ready");
  const ids = files.flatMap((file) => (file.state === "ready" && file.id ? [file.id] : []));
  /** The IDs to post, or null (with the reason shown) while some file is not ready. */
  const toPost = (): string[] | null => {
    if (busy) {
      setProblem({ kind: "wait" });
      return null;
    }
    return ids;
  };
  const clear = () => {
    for (const file of files) if (file.preview) URL.revokeObjectURL(file.preview);
    previews.current.clear();
    setFiles([]);
    setProblem({ kind: null });
  };
  return { files, problem, setProblem, add, remove, toPost, clear, busy };
}

export type AttachmentUploads = ReturnType<typeof useAttachmentUploads>;

/** Whether this browser can capture the screen (most phones cannot). */
export function canCaptureScreen(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function"
  );
}

/**
 * One frame of what the person chooses to share, as PNG (JPEG when a PNG would be too large),
 * taken in this page; every track stops at once. Null when the person cancels.
 */
export async function captureScreenshot(): Promise<Blob | null> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
      // Chromium offers this tab first; other browsers ignore it and show their own chooser.
      preferCurrentTab: true,
    } as DisplayMediaStreamOptions);
  } catch {
    return null;
  }
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    if (video.videoWidth === 0) {
      await new Promise<void>((resolve) => {
        video.addEventListener("loadeddata", () => resolve(), { once: true });
        setTimeout(resolve, 2_000);
      });
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context || canvas.width === 0 || canvas.height === 0) return null;
    context.drawImage(video, 0, 0);
    const encode = (type: string, quality?: number) =>
      new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
    const png = await encode("image/png");
    if (png && png.size <= ATTACHMENT_LIMITS.fileMaxBytes) return png;
    return encode("image/jpeg", 0.85);
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The composer's file controls: attach a file, take a screenshot, and the files so far. */
export function AttachmentControls({
  uploads,
  compact = false,
}: {
  uploads: AttachmentUploads;
  compact?: boolean;
}) {
  const t = useT();
  const [capturing, setCapturing] = useState(false);
  const size = compact ? "sm" : undefined;
  const full = uploads.files.length >= ATTACHMENT_LIMITS.perMessage;
  const onFiles = async (chosen: File[]) => {
    for (const file of chosen) await uploads.add(file, file.name);
  };
  // Capture uploads the moment it completes (decision 0028), so the person is warned first and
  // the browser's prompt opens only from the Continue below.
  const [confirming, setConfirming] = useState(false);
  const screenshot = async () => {
    setConfirming(false);
    setCapturing(true);
    try {
      const shot = await captureScreenshot();
      if (shot) {
        const extension = shot.type === "image/jpeg" ? ".jpg" : ".png";
        await uploads.add(shot, `${t("review.attach.screenshotName")}${extension}`);
      } else {
        uploads.setProblem({ kind: "captureFailed" });
      }
    } finally {
      setCapturing(false);
    }
  };
  const { problem } = uploads;
  const message =
    problem.kind === null
      ? null
      : t(`review.attach.problem.${problem.kind}`, { name: problem.name ?? "" });
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-start gap-2">
        <FilePicker
          label={t("review.attach.file")}
          description={compact ? undefined : t("review.attach.hint")}
          icon={<Paperclip className="size-4" />}
          accept={ATTACHMENT_ACCEPT}
          multiple
          disabled={full}
          onPick={(chosen) => void onFiles(chosen)}
        />
        {canCaptureScreen() ? (
          <Button
            size={size}
            icon={<Camera className="size-4" />}
            busy={capturing}
            onClick={() => setConfirming(true)}
            disabled={full || confirming}
          >
            {t("review.attach.screenshot")}
          </Button>
        ) : null}
      </div>
      {confirming ? (
        <fieldset className="flex flex-col gap-2 rounded-md border border-border-strong p-3 text-sm">
          <legend className="sr-only">{t("review.attach.screenshot")}</legend>
          <p>{t("review.attach.captureWarning")}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" intent="primary" autoFocus onClick={() => void screenshot()}>
              {t("review.attach.captureContinue")}
            </Button>
            <Button size="sm" onClick={() => setConfirming(false)}>
              {t("review.composer.cancel")}
            </Button>
          </div>
        </fieldset>
      ) : null}
      {message ? (
        <p role="alert" className="text-sm font-medium">
          {message}
        </p>
      ) : null}
      {uploads.files.length > 0 ? (
        <ul aria-label={t("review.attach.list")} className="flex flex-col gap-2">
          {uploads.files.map((file) => (
            <li
              key={file.key}
              className="flex items-center gap-2 rounded-md border border-border p-2 text-sm"
            >
              {file.preview ? (
                <img
                  src={file.preview}
                  alt={t("review.attach.preview", { name: file.name })}
                  className="size-10 shrink-0 rounded-sm object-cover"
                />
              ) : (
                <FileText aria-hidden="true" className="size-5 shrink-0 text-text-muted" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{file.name}</span>
                <span className="text-xs text-text-muted">
                  {formatSize(file.size)} · {t(`review.attach.state.${file.state}`)}
                </span>
              </span>
              <IconButton
                size="xs"
                icon={<X className="size-4" />}
                label={t("review.attach.remove", { name: file.name })}
                onClick={() => uploads.remove(file.key)}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Fetches a file through its short link and checks it against what the message lists. */
function useCheckedFile(artifactId: string) {
  const { api, storage } = useDashboard();
  return useCallback(
    async (file: AttachmentView): Promise<Blob> => {
      const link = await api.attachmentLink(artifactId, file.id);
      const blob = await storage.get(link.url);
      if (blob.size !== file.size || (await sha256OfBlob(blob)) !== file.sha256) {
        throw new Error("integrity");
      }
      return new Blob([blob], { type: file.contentType });
    },
    [api, storage, artifactId],
  );
}

/** An attached image, shown once its bytes are fetched and checked. */
function AttachmentImage({
  artifactId,
  file,
  onSave,
}: {
  artifactId: string;
  file: AttachmentView;
  onSave(): void;
}) {
  const t = useT();
  const fetchChecked = useCheckedFile(artifactId);
  const [state, setState] = useState<{ url: string } | "loading" | "failed">("loading");
  useEffect(() => {
    let live = true;
    let url: string | null = null;
    fetchChecked(file).then(
      (blob) => {
        if (!live) return;
        url = URL.createObjectURL(blob);
        setState({ url });
      },
      () => {
        if (live) setState("failed");
      },
    );
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [fetchChecked, file]);
  if (state === "loading") {
    return <LoadingState label={t("review.attachments.loading", { name: file.name })} />;
  }
  if (state === "failed") {
    return (
      <p className="text-sm text-text-muted">
        {t("review.attachments.unavailable", { name: file.name })}
      </p>
    );
  }
  return (
    <button
      type="button"
      onClick={onSave}
      className="block max-w-full rounded-sm focus-visible:outline-2 focus-visible:outline-focus"
      aria-label={t("review.attachments.download", { name: file.name })}
    >
      <img
        src={state.url}
        alt={file.name}
        className="max-h-60 max-w-full rounded-sm border border-border"
      />
    </button>
  );
}

/** The files on one message: images shown (when allowed here), everything downloadable. */
export function MessageAttachments({
  artifactId,
  files,
}: {
  artifactId: string;
  files: readonly AttachmentView[];
}) {
  const t = useT();
  const { save } = useDashboard();
  const showImages = useAttachmentsEnabled();
  const fetchChecked = useCheckedFile(artifactId);
  const [failed, setFailed] = useState<string | null>(null);
  const download = async (file: AttachmentView) => {
    setFailed(null);
    try {
      save({ fileName: savedName(file), blob: await fetchChecked(file) });
    } catch {
      setFailed(file.id);
    }
  };
  return (
    <ul aria-label={t("review.attachments.label")} className="flex flex-col gap-2">
      {files.map((file) => (
        <li key={file.id} className="flex flex-col gap-1">
          {showImages &&
          (ATTACHMENT_IMAGE_TYPES as readonly string[]).includes(file.contentType) ? (
            <AttachmentImage
              artifactId={artifactId}
              file={file}
              onSave={() => void download(file)}
            />
          ) : null}
          <div>
            <Button
              size="sm"
              intent="ghost"
              icon={<Download className="size-4" />}
              onClick={() => void download(file)}
            >
              {t("review.attachments.download", { name: file.name })}
            </Button>
            <span className="ml-2 text-xs text-text-muted">{formatSize(file.size)}</span>
          </div>
          {failed === file.id ? (
            <p role="alert" className="text-sm font-medium">
              {t("review.attachments.unavailable", { name: file.name })}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
