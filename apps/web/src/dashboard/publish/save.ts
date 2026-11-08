// Hands a file built in the page to the user as a download, through a temporary object URL.
import type { SavedFile } from "./download.ts";

export function saveFile({ fileName, blob }: SavedFile): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
