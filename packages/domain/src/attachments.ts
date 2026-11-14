// Comment attachments (decision 0028): what a file is, judged only by its bytes, the name it is
// downloaded under, where it lives in R2 and the switch. Pure: the services read the bytes.
import { ATTACHMENT_LIMITS, ATTACHMENTS_SWITCH, type AttachmentType } from "@portifact/contracts";

export interface AttachmentsEnv {
  ATTACHMENTS_ENABLED?: string | undefined;
}

/** Whether attachments are reachable: exactly `"true"` on the app Worker. */
export function attachmentsEnabled(env: AttachmentsEnv): boolean {
  return env[ATTACHMENTS_SWITCH] === "true";
}

/** Bytes `sniffAttachment` needs from the start of a file that is not text. */
export const ATTACHMENT_SNIFF_BYTES = 16;

const PREFIX = "attachments/";

/** The R2 key of a file: derived from its artifact and ID, never taken from input. */
export function attachmentKey(artifactId: string, attachmentId: string): string {
  return `${PREFIX}${artifactId}/${attachmentId}`;
}

export function isAttachmentKey(key: string): boolean {
  return key.startsWith(PREFIX);
}

function startsWith(bytes: Uint8Array, signature: readonly number[], at = 0): boolean {
  if (bytes.length < at + signature.length) return false;
  return signature.every((value, index) => bytes[at + index] === value);
}

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

const SIGNATURES: readonly { type: AttachmentType; test(bytes: Uint8Array): boolean }[] = [
  {
    type: "image/png",
    test: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { type: "image/jpeg", test: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  {
    type: "image/gif",
    test: (b) => startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a")),
  },
  {
    type: "image/webp",
    test: (b) => startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8),
  },
  { type: "application/pdf", test: (b) => startsWith(b, ascii("%PDF-")) },
];

/**
 * A file's type from its bytes, or null when it is none of the allowed ones. `bytes` is the start
 * of the file (`ATTACHMENT_SNIFF_BYTES`), or the whole file when `whole` is set; plain text is
 * recognized only from the whole file: strict UTF-8 without NUL, at most `textMaxBytes`.
 */
export function sniffAttachment(
  bytes: Uint8Array,
  size: number,
  whole: boolean,
): AttachmentType | null {
  if (size <= 0) return null;
  for (const signature of SIGNATURES) if (signature.test(bytes)) return signature.type;
  if (!whole || size > ATTACHMENT_LIMITS.textMaxBytes || bytes.length !== size) return null;
  if (bytes.includes(0)) return null;
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
  return "text/plain";
}

/** Whether a file of this size could still be text, so the services read it whole. */
export function mayBeText(size: number): boolean {
  return size > 0 && size <= ATTACHMENT_LIMITS.textMaxBytes;
}

const EXTENSIONS: Readonly<Record<AttachmentType, readonly string[]>> = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
  "application/pdf": [".pdf"],
  "text/plain": [".txt"],
};

/**
 * The name a file is downloaded under: its name, with the extension its bytes call for appended
 * unless it already ends with one of the type's extensions, so `report.html` holding a PNG saves
 * as `report.html.png` and never opens as a page.
 */
export function downloadFileName(name: string, type: AttachmentType): string {
  const extensions = EXTENSIONS[type];
  const lower = name.toLowerCase();
  if (extensions.some((extension) => lower.endsWith(extension))) return name;
  return `${name}${extensions[0]}`;
}

/** `Content-Disposition` for a download, with the name in RFC 6266 `filename*` form only. */
export function attachmentDisposition(name: string, type: AttachmentType): string {
  const encoded = encodeURIComponent(downloadFileName(name, type)).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename*=UTF-8''${encoded}`;
}
