import { env } from "cloudflare:workers";

let next = 0;
export const id = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${(next++).toString(36)}`;

export async function seedArtifact(
  ownerId: string,
  versionId = id("v"),
): Promise<{ artifactId: string; versionId: string }> {
  const artifactId = id("a");
  await env.DB.prepare(
    "insert into artifacts (id, owner_id, state, current_version_id) values (?, ?, 'active', ?)",
  )
    .bind(artifactId, ownerId, versionId)
    .run();
  return { artifactId, versionId };
}

export async function count(sql: string, ...params: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...params)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** The database's size in bytes as D1 reports it after a statement (`meta.size_after`). */
export async function databaseSize(): Promise<number> {
  const result = await env.DB.prepare("select 1").run();
  return result.meta.size_after;
}

/** Deterministic pseudo-prose: a vocabulary of words, some with diacritics, in a stable order. */
export function prose(bytes: number, seed = 1): string {
  const words = [
    "plan",
    "report",
    "quarterly",
    "revenue",
    "canción",
    "über",
    "naïve",
    "déjà",
    "café",
    "año",
    "budget",
    "roadmap",
    "release",
    "migration",
    "security",
    "review",
    "design",
    "launch",
    "metric",
    "привет",
    "данные",
    "отчёт",
    "analysis",
    "pipeline",
    "customer",
    "support",
    "workspace",
    "token",
  ];
  let state = seed;
  let out = "";
  while (out.length < bytes) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out += `${words[(state >>> 16) % words.length]} `;
  }
  return out.slice(0, bytes);
}
