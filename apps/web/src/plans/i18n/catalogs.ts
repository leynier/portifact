// The plans' text in every language. Typed by the locale list, so adding a language fails the
// typecheck until its text is here.
import type { LocaleCode } from "@portifact/contracts/locales";
import { planTextDe } from "./de.ts";
import { type PlanText, planTextEn } from "./en.ts";
import { planTextEs } from "./es.ts";
import { planTextFr } from "./fr.ts";
import { planTextJa } from "./ja.ts";
import { planTextPtBR } from "./pt-br.ts";
import { planTextRu } from "./ru.ts";
import { planTextZhCN } from "./zh-cn.ts";

export const PLAN_TEXT: Readonly<Record<LocaleCode, PlanText>> = {
  en: planTextEn,
  es: planTextEs,
  "pt-BR": planTextPtBR,
  fr: planTextFr,
  de: planTextDe,
  ru: planTextRu,
  ja: planTextJa,
  "zh-CN": planTextZhCN,
};
