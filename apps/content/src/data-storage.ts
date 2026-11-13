// The documents objects' storage reports (decision 0026, "Storage accounting"), kept per isolate:
// every page command's answer carries `{ generation, seq, bytes }`, and the newest per artifact is
// written into `artifact_data` once per window through `waitUntil`, like traffic, so the page's
// requests never wait for or pay a D1 write each.
import type { StorageReport } from "@portifact/contracts/artifact-data";
import { logEvent } from "@portifact/domain";
import { newerReport } from "@portifact/domain/artifact-data";

export const STORAGE_FLUSH_MS = 5_000;

export type WriteReports = (reports: Map<string, StorageReport>) => Promise<void>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class StorageReports {
  readonly #pending = new Map<string, StorageReport>();
  #scheduled = false;

  constructor(
    private readonly write: WriteReports,
    private readonly delayMs: number = STORAGE_FLUSH_MS,
  ) {}

  /** Keeps the newer of this report and the pending one; the first of a window schedules the write. */
  keep(
    artifactId: string,
    report: StorageReport,
    waitUntil: (promise: Promise<unknown>) => void,
  ): void {
    this.#add(artifactId, report);
    if (this.#scheduled) return;
    this.#scheduled = true;
    waitUntil(sleep(this.delayMs).then(() => this.flush()));
  }

  /** Writes what is pending. A failed write keeps the reports for the next window. */
  async flush(): Promise<void> {
    this.#scheduled = false;
    const reports = new Map(this.#pending);
    this.#pending.clear();
    if (reports.size === 0) return;
    try {
      await this.write(reports);
    } catch {
      for (const [id, report] of reports) this.#add(id, report);
      logEvent("error", "data_storage_write_failed");
    }
  }

  pending(): Map<string, StorageReport> {
    return new Map(this.#pending);
  }

  #add(artifactId: string, report: StorageReport): void {
    const current = this.#pending.get(artifactId);
    if (current === undefined || newerReport(current, report)) {
      this.#pending.set(artifactId, report);
    }
  }
}
