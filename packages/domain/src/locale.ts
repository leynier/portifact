// Which language a page or an email uses. Imports only the locale list, so the landing and the
// auth pages can use it without bundling the schemas (`@portifact/domain/locale`).
import {
  DEFAULT_LOCALE,
  isLocale,
  LOCALE_CODES,
  type LocaleCode,
} from "@portifact/contracts/locales";

/** Tags of Traditional Chinese, which a Simplified Chinese catalog must not answer. */
const TRADITIONAL_CHINESE = /^zh-(hant|tw|hk|mo)(-|$)/;

/**
 * The supported locale for one language tag: the exact tag first (case-insensitive), then the
 * first locale of the same language, so `es-MX` gets `es` and `pt` gets `pt-BR`.
 */
export function matchLocale(
  tag: string,
  available: readonly LocaleCode[] = LOCALE_CODES,
): LocaleCode | undefined {
  const wanted = tag.trim().toLowerCase().replaceAll("_", "-");
  if (!wanted || wanted === "*") return undefined;
  const exact = available.find((code) => code.toLowerCase() === wanted);
  if (exact) return exact;
  const language = wanted.split("-")[0];
  return available.find((code) => {
    const candidate = code.toLowerCase();
    if (candidate.split("-")[0] !== language) return false;
    // A Simplified Chinese catalog is no answer for a Traditional Chinese reader.
    return !(TRADITIONAL_CHINESE.test(wanted) && !TRADITIONAL_CHINESE.test(candidate));
  });
}

/** The first supported locale among the reader's languages, in their order of preference. */
export function negotiateLocale(
  preferred: readonly string[],
  available: readonly LocaleCode[] = LOCALE_CODES,
): LocaleCode | undefined {
  for (const tag of preferred) {
    const match = matchLocale(tag, available);
    if (match) return match;
  }
  return undefined;
}

/**
 * The tags of an `Accept-Language` header, most preferred first. Entries with `q=0` are refused
 * by the reader, so they are dropped; equal weights keep their order.
 */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((entry, index) => {
      const [tag = "", ...params] = entry.trim().split(";");
      const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
      const weight = q === undefined ? 1 : Number(q.slice(2));
      return { tag: tag.trim(), weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((entry) => entry.tag && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .map((entry) => entry.tag);
}

export interface LocaleCandidates {
  /**
   * Choices the reader made, strongest first, such as the account's language and the one saved
   * in this browser. Unknown or missing values are skipped.
   */
  chosen: readonly (string | null | undefined)[];
  /** The browser's languages (`navigator.languages`, or a parsed `Accept-Language`). */
  browser: readonly string[];
}

/** The language to show: an explicit choice, else the browser's languages, else English. */
export function resolveLocale(candidates: LocaleCandidates): LocaleCode {
  const choice = candidates.chosen.find(isLocale);
  if (choice) return choice;
  return negotiateLocale(candidates.browser) ?? DEFAULT_LOCALE;
}
