// The language choice of the dashboard: a select whose options are each language's own name,
// marked with its `lang` so screen readers pronounce it right. The static pages draw the same
// choice as links (`@portifact/ui/language-links`), because they have no script to run a select.
import { Select } from "./select.tsx";

export interface Language<T extends string = string> {
  code: T;
  /** The language's name in itself, such as "Español". */
  name: string;
}

export interface LanguageSwitcherProps<T extends string = string> {
  label: string;
  description?: string | undefined;
  value: T;
  languages: readonly Language<T>[];
  onChange(code: T): void;
  /** `field` with the label above (settings), or `compact` for a toolbar or a sidebar. */
  variant?: "field" | "compact" | undefined;
  disabled?: boolean | undefined;
}

export function LanguageSwitcher<T extends string>({
  label,
  description,
  value,
  languages,
  onChange,
  variant = "field",
  disabled,
}: LanguageSwitcherProps<T>) {
  return (
    <Select
      label={label}
      description={description}
      value={value}
      options={languages.map((language) => ({
        value: language.code,
        label: language.name,
        lang: language.code,
      }))}
      onChange={onChange}
      variant={variant}
      disabled={disabled}
    />
  );
}
