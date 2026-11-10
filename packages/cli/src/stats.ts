// portifact stats: page views per UTC day of one of your artifacts and, for artifacts restricted
// to listed readers, distinct signed-in visitors, as GET /api/v1/artifacts/:id/stats reports
// them (premium plan P8). A paid feature: on a plan without it the API answers plan_required.
import { ANALYTICS, ArtifactStatsView } from "@portifact/contracts";
import { callApi } from "./api.ts";
import { parseArtifactId, table } from "./artifacts.ts";
import { type OutputOptions, openSession, writeJson } from "./commands.ts";
import { CliError } from "./errors.ts";
import { messages } from "./messages.ts";
import type { Io, Runtime } from "./runtime.ts";

const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface StatsOptions extends OutputOptions {
  days?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/**
 * The API's `from` and `to` from the options: `--days <n>` counts back from today (UTC), or
 * `--from`/`--to` name the days. The API checks the range against the plan and its cap.
 */
export function statsQuery(options: StatsOptions, now: number): URLSearchParams {
  const query = new URLSearchParams();
  if (options.days !== undefined) {
    if (options.from !== undefined || options.to !== undefined) {
      throw new CliError("invalid_input", messages.errors.statsDaysWithRange);
    }
    const days = Number(options.days);
    if (!/^\d{1,3}$/.test(options.days) || days < 1 || days > ANALYTICS.maxRangeDays) {
      throw new CliError("invalid_input", messages.errors.invalidDays(ANALYTICS.maxRangeDays));
    }
    const today = now - (now % DAY_MS);
    query.set("from", new Date(today - (days - 1) * DAY_MS).toISOString().slice(0, 10));
    return query;
  }
  for (const [name, value] of [
    ["from", options.from],
    ["to", options.to],
  ] as const) {
    if (value === undefined) continue;
    if (!DATE.test(value)) throw new CliError("invalid_input", messages.errors.invalidDay(value));
    query.set(name, value);
  }
  return query;
}

export async function stats(
  io: Io,
  runtime: Runtime,
  id: string,
  options: StatsOptions,
): Promise<void> {
  const artifactId = parseArtifactId(id);
  const query = statsQuery(options, runtime.now());
  const session = await openSession(io, runtime);
  const body = await callApi(session, {
    method: "GET",
    path: `/artifacts/${artifactId}/stats${query.size > 0 ? `?${query}` : ""}`,
    schema: ArtifactStatsView,
  });
  if (options.json) {
    writeJson(io, body);
    return;
  }
  const logged = body.totals.visitors !== null;
  const header = ["DAY", "VIEWS", "SIGNED IN", ...(logged ? ["VISITORS"] : [])];
  const row = (label: string, views: number, signedIn: number, visitors: number | null) => [
    label,
    String(views),
    String(signedIn),
    ...(logged ? [String(visitors ?? 0)] : []),
  ];
  io.stdout(
    table([
      header,
      ...body.days.map((day) => row(day.date, day.views, day.signedInViews, day.visitors)),
      row("TOTAL", body.totals.views, body.totals.signedInViews, body.totals.visitors),
    ]),
  );
  io.stdout(`${messages.statsNote(logged, body.retentionDays)}\n`);
}
