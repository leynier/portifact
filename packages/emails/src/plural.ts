// Counts in the emails follow each language's plural rules (`Intl.PluralRules`), so a language
// with more forms than English, such as Russian, needs no rules of its own.
import type { LocaleCode } from "@portifact/contracts/locales";

/** The plural category of a count in a language: `one`, `few`, `many`, `other` and so on. */
export function pluralCategory(locale: LocaleCode, count: number): Intl.LDMLPluralRule {
  return new Intl.PluralRules(locale).select(count);
}

export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };

/** The form of a word for a count in a language, `other` when the language's category is missing. */
export function pluralForm(locale: LocaleCode, count: number, forms: PluralForms): string {
  return forms[pluralCategory(locale, count)] ?? forms.other;
}
