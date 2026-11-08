// What to tell the user when building a manifest, uploading or committing fails, and whether the
// same upload can be resumed.

import { ApiFailure } from "../api.ts";
import type { MessageId } from "../i18n/en.ts";
import { DownloadFailure } from "./download.ts";
import { ManifestError } from "./manifest.ts";
import { UploadFailure } from "./upload.ts";

type Translate = (id: MessageId, values?: Record<string, string | number>) => string;

const PUBLISH_CODES = ["quota_exceeded", "version_conflict", "upload_incomplete", "invalid_input"];

/** The message for a failed publish, in the terms of the rule that refused it. */
export function publishFailureMessage(t: Translate, error: unknown): string {
  if (error instanceof ManifestError) {
    return t(`manifest.${error.reason}`, { detail: error.detail ?? "" });
  }
  if (error instanceof UploadFailure)
    return t(`upload.${error.reason}`, { path: error.path ?? "" });
  if (error instanceof DownloadFailure) return t(`download.${error.reason}`, { path: error.path });
  if (error instanceof ApiFailure) {
    if (PUBLISH_CODES.includes(error.code)) {
      return t(`publish.error.${error.code as "quota_exceeded"}`);
    }
    return t(`error.${error.code}`);
  }
  return t("error.unexpected");
}

/**
 * Whether resuming the same upload can succeed: after lost connections, storage hiccups and
 * objects that did not arrive, but not after a refusal that a retry would only repeat.
 */
export function canResume(error: unknown): boolean {
  if (error instanceof UploadFailure)
    return error.reason === "network" || error.reason === "storage";
  if (error instanceof ApiFailure) {
    return [
      "network",
      "unexpected",
      "upload_incomplete",
      "rate_limited",
      "capacity_unavailable",
    ].includes(error.code);
  }
  return false;
}
