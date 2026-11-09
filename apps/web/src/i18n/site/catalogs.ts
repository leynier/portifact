// Every language of the static pages. Typed by the locale list, so adding a language to
// @portifact/contracts/locales fails the typecheck until its catalog is here.
import type { LocaleCode } from "@portifact/contracts/locales";
import { de } from "./de.ts";
import { en } from "./en.ts";
import { es } from "./es.ts";
import { fr } from "./fr.ts";
import { ja } from "./ja.ts";
import { ptBR } from "./pt-br.ts";
import { ru } from "./ru.ts";
import type { SiteCatalog } from "./types.ts";
import { zhCN } from "./zh-cn.ts";

export const SITE_CATALOGS: Readonly<Record<LocaleCode, SiteCatalog>> = {
  en,
  es,
  "pt-BR": ptBR,
  fr,
  de,
  ru,
  ja,
  "zh-CN": zhCN,
};
