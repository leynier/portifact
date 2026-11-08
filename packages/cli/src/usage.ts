// portifact usage: the account's quotas, counters, 24-hour windows, this month's traffic and what
// blocks it now, as
// GET /api/v1/usage reports them. The server computes everything; this only presents it.
import { AccountUsageView, type UsageMeter } from "@portifact/contracts";
import { callApi } from "./api.ts";
import { type OutputOptions, openSession, writeJson } from "./commands.ts";
import { formatBytes, formatDate, messages } from "./messages.ts";
import type { Io, Runtime } from "./runtime.ts";

export async function usage(io: Io, runtime: Runtime, options: OutputOptions): Promise<void> {
  const session = await openSession(io, runtime);
  const view = await callApi(session, { method: "GET", path: "/usage", schema: AccountUsageView });
  if (options.json) {
    writeJson(io, view);
    return;
  }
  const count = (meter: UsageMeter) => messages.usageMeter(String(meter.used), String(meter.limit));
  const bytes = (meter: UsageMeter) =>
    messages.usageMeter(formatBytes(meter.used), formatBytes(meter.limit));
  const lines: [string, string][] = [
    ["Active artifacts", count(view.activeArtifacts)],
    [
      "Storage",
      `${bytes(view.storage)}${view.storage.reserved > 0 ? ` (+${formatBytes(view.storage.reserved)} reserved by uploads)` : ""}`,
    ],
    ["Publishes, last 24 hours", count(view.publishesLast24h)],
    ["New files, last 24 hours", count(view.newFilesLast24h)],
    ["New bytes, last 24 hours", bytes(view.newBytesLast24h)],
    [
      "New files this month",
      `${count(view.newObjectsThisMonth)} (resets ${formatDate(view.newObjectsThisMonth.resetsAt)})`,
    ],
    ["Open uploads", count(view.openUploads)],
    [
      "Traffic this month",
      `${count(view.trafficThisMonth.requests)} requests, ${bytes(view.trafficThisMonth.bytes)} (resets ${formatDate(view.trafficThisMonth.resetsAt)})`,
    ],
    [
      "Per version",
      `${formatBytes(view.versionLimits.publishedBytes)} published, ${view.versionLimits.files} files, ${formatBytes(view.versionLimits.documentBytes)} per document`,
    ],
    ["Public access allowed from", formatDate(view.publicAccessFrom)],
  ];
  io.stdout(`${messages.usage(lines)}\n`);
  if (view.blocks.length === 0) {
    io.stdout(`${messages.usageNoBlocks}\n`);
    return;
  }
  io.stdout(`${messages.usageBlocksHeader}\n`);
  for (const block of view.blocks)
    io.stdout(`${messages.usageBlock(block.message, block.until)}\n`);
}
