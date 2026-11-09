import { type DragEvent, type ReactNode, useRef, useState } from "react";

/** A dropped file with its path inside what was dropped, such as `site/index.html`. */
export interface DroppedFile {
  path: string;
  file: File;
}

export interface DroppedItems {
  files: DroppedFile[];
  /** True when exactly one folder was dropped, so its paths start with the folder's name. */
  folder: boolean;
}

export interface DropZoneProps {
  /** What dropping does, such as "Drop files, a folder or a ZIP to publish". */
  label: string;
  /** Shown while something is dragged over the zone, such as "Drop to choose these files". */
  activeLabel: string;
  /** Turns dropping off, such as while a manifest is being built. */
  disabled?: boolean;
  /** Called with every file dropped, folders walked; never with an empty list. */
  onDrop(items: DroppedItems): void;
  /** The pickers that do the same with the keyboard; dropping is only a shortcut for pointers. */
  children: ReactNode;
}

function isFile(entry: FileSystemEntry): entry is FileSystemFileEntry {
  return entry.isFile;
}

function isDirectory(entry: FileSystemEntry): entry is FileSystemDirectoryEntry {
  return entry.isDirectory;
}

async function walk(entry: FileSystemEntry, into: DroppedFile[]): Promise<void> {
  if (isFile(entry)) {
    const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
    into.push({ path: entry.fullPath.replace(/^\/+/, ""), file });
    return;
  }
  if (isDirectory(entry)) {
    const reader = entry.createReader();
    // readEntries returns a batch at a time; an empty batch means the folder is done.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, into);
    }
  }
}

/** Reads what was dropped: folders through the entries API where the browser has it. */
export async function readDrop(transfer: DataTransfer): Promise<DroppedItems> {
  const entries = [...transfer.items]
    .map((item) => (typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => entry !== null);
  if (entries.length === 0) {
    return { files: [...transfer.files].map((file) => ({ path: file.name, file })), folder: false };
  }
  const files: DroppedFile[] = [];
  for (const entry of entries) await walk(entry, files);
  return { files, folder: entries.length === 1 && entries[0]?.isDirectory === true };
}

/**
 * A drop target around a screen's file pickers. Dragging files over it highlights it; dropping
 * hands over the files, with folders walked so their paths keep the structure. The pickers inside
 * stay the keyboard and screen reader path, so nothing depends on dragging.
 */
export function DropZone({
  label,
  activeLabel,
  disabled = false,
  onDrop,
  children,
}: DropZoneProps) {
  const [active, setActive] = useState(false);
  const depth = useRef(0);

  const carriesFiles = (event: DragEvent) =>
    !disabled && [...event.dataTransfer.types].includes("Files");

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dropping is a pointer shortcut; the pickers inside are the keyboard path
    <div
      onDragEnter={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth.current += 1;
        setActive(true);
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setActive(false);
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth.current = 0;
        setActive(false);
        void readDrop(event.dataTransfer).then((items) => {
          if (items.files.length > 0) onDrop(items);
        });
      }}
      className={`rounded-lg border-2 border-dashed p-5 transition-colors duration-150 sm:p-6 ${
        active ? "border-text selection-band" : "border-border-strong bg-canvas"
      }`}
    >
      <p className="mb-5 text-sm font-medium">{active ? activeLabel : label}</p>
      {children}
    </div>
  );
}
