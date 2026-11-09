// Every language of the static pages. Typed by the locale list, so adding a language to
// @portifact/contracts/locales fails the typecheck until its catalog is here.
import type { LocaleCode } from "@portifact/contracts/locales";
import { en } from "./en.ts";
import { es } from "./es.ts";
import type { SiteCatalog } from "./types.ts";

export const SITE_CATALOGS: Readonly<Record<LocaleCode, SiteCatalog>> = { en, es };
