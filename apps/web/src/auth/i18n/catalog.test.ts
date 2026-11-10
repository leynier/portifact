// @vitest-environment happy-dom
// Every language of the auth and report pages is complete: each marker of the four pages has a
// translation that keeps the English markup and links, the catalogs have no stale keys, and every
// script message exists, interpolates its arguments and follows the writing style.
import { LOCALES } from "@portifact/contracts/locales";
import { describe, expect, it } from "vitest";
import { collectMessages, markupOf } from "../../i18n/markers.ts";
import { PAGE_NAMES, readPage } from "../test-page.ts";
import { en } from "./en.ts";
import { authCatalogLoaders } from "./i18n.ts";
import type { AuthCatalog } from "./types.ts";

const SAMPLE = "SAMPLE42";

/** A sentence's full stop: the Latin period, or the ideographic one of Chinese and Japanese. */
const FULL_STOP = /[.。]$/;

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

/** The English of every marker of the four pages; a key shared by pages has one text. */
function englishMarkers(): Map<string, string> {
  const all = new Map<string, string>();
  for (const name of PAGE_NAMES) {
    for (const [key, text] of collectMessages(parse(readPage(name)))) {
      const known = all.get(key);
      if (known !== undefined) expect(text, `${key} on ${name}.html`).toBe(known);
      all.set(key, text);
    }
  }
  return all;
}

const attributes = (html: string, name: string) =>
  [...html.matchAll(new RegExp(`\\b${name}="([^"]*)"`, "g"))].map((match) => match[1]).sort();

/** Every text a catalog's messages hold, with each function called on a sample argument. */
function texts(value: unknown, path: string, into: [string, string][] = []): [string, string][] {
  if (typeof value === "string") into.push([path, value]);
  else if (typeof value === "function") into.push([path, String(value(SAMPLE))]);
  else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) texts(item, `${path}.${key}`, into);
  }
  return into;
}

/** The shape of the messages: each leaf's path and kind, with the arity of functions. */
function shape(value: unknown, path = "messages"): string[] {
  if (typeof value === "function") return [`${path}: function/${value.length}`];
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => shape(item, `${path}.${key}`));
  }
  return [`${path}: ${typeof value}`];
}

const english = englishMarkers();
const languages = Object.entries(authCatalogLoaders) as [string, () => Promise<AuthCatalog>][];

describe("auth page markers", () => {
  it("are found on every page, so the catalogs have something to check", () => {
    expect(english.size).toBeGreaterThan(60);
    for (const key of ["login.termsNotice", "device.title", "consent.allow", "report.send"]) {
      expect(english.has(key)).toBe(true);
    }
  });

  it("have a loader for every language besides English", () => {
    expect(languages.map(([code]) => code).sort()).toEqual(
      LOCALES.map((locale) => locale.code)
        .filter((code) => code !== "en")
        .sort(),
    );
  });

  it("follow the writing style in English", () => {
    for (const text of [...english.values(), ...texts(en, "en").map(([, text]) => text)]) {
      expect(text).not.toMatch(/[—–]/);
    }
  });
});

describe.each(languages)("the %s catalog", (_code, load) => {
  it("translates every marker of the four pages and nothing else", async () => {
    const { page } = await load();
    expect(Object.keys(page).sort()).toEqual([...english.keys()].sort());
    for (const [key, text] of Object.entries(page)) {
      expect(text.trim(), key).not.toBe("");
    }
  });

  it("keeps the English markup, links and ids of each marker", async () => {
    const { page } = await load();
    for (const [key, source] of english) {
      const text = page[key] ?? "";
      expect(markupOf(text).sort(), key).toEqual(markupOf(source).sort());
      for (const attribute of ["href", "id", "target", "rel"]) {
        expect(attributes(text, attribute), `${key} ${attribute}`).toEqual(
          attributes(source, attribute),
        );
      }
    }
  });

  it("ends a text with a full stop (. or 。) only when the English does", async () => {
    const { page, messages } = await load();
    const translated = new Map(texts(messages, "messages"));
    const pairs: [string, string, string][] = [
      ...[...english].map(([key, source]): [string, string, string] => [
        key,
        source,
        page[key] ?? "",
      ]),
      ...texts(en, "messages").map(([path, source]): [string, string, string] => [
        path,
        source,
        translated.get(path) ?? "",
      ]),
    ];
    for (const [key, source, text] of pairs) {
      expect(FULL_STOP.test(text.trim()), key).toBe(source.trim().endsWith("."));
    }
  });

  it("keeps the conditions of the sign-in notices", async () => {
    const { page } = await load();
    for (const key of ["login.termsNotice", "login.termsNoticeSso", "login.termsUpdateNotice"]) {
      const notice = page[key] ?? "";
      expect(notice).toContain("18");
      expect(attributes(notice, "href")).toEqual([
        "https://portifact.com/acceptable-use",
        "https://portifact.com/privacy",
        "https://portifact.com/terms",
      ]);
      expect(attributes(notice, "target")).toEqual(["_blank", "_blank", "_blank"]);
    }
  });

  it("has every script message, with the same arguments, interpolated", async () => {
    const { messages } = await load();
    expect(shape(messages).sort()).toEqual(shape(en).sort());
    for (const [path, text] of texts(messages, "messages")) {
      expect(text.trim(), path).not.toBe("");
    }
    for (const [name, value] of Object.entries(messages)) {
      if (typeof value !== "function") continue;
      expect((value as (argument: string) => string)(SAMPLE), name).toContain(SAMPLE);
    }
  });

  it("uses no em dashes or en dashes", async () => {
    const { page, messages } = await load();
    for (const [path, text] of [...Object.entries(page), ...texts(messages, "messages")]) {
      expect(text, path).not.toMatch(/[—–]/);
    }
  });
});
