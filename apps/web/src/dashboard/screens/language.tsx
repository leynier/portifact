// The language choice in the Settings page and the sidebar, and keeping the dashboard in the
// account's language. A choice applies at once in this browser and is saved in the account
// settings, so other devices and the emails Portifact sends follow it.
import type { LocaleCode } from "@portifact/contracts/locales";
import { LanguageSwitcher } from "@portifact/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Languages } from "lucide-react";
import { useEffect, useRef } from "react";
import { useAnnounce, useDashboard, useT } from "../context.tsx";
import { LANGUAGES, useLocale } from "../locale.tsx";

export const SETTINGS_QUERY = ["account", "settings"] as const;

/**
 * Follows the language saved in the account: when it differs from this browser's, the dashboard
 * switches to it once per saved value, so a choice made on another device arrives here.
 */
export function useAccountLocale(): void {
  const { api } = useDashboard();
  const { locale, setLocale } = useLocale();
  const settings = useQuery({ queryKey: SETTINGS_QUERY, queryFn: () => api.accountSettings() });
  const saved = settings.data?.locale ?? null;
  const applied = useRef<LocaleCode | null>(null);
  useEffect(() => {
    if (!saved || applied.current === saved) return;
    applied.current = saved;
    if (saved !== locale) setLocale(saved).catch(() => undefined);
  }, [saved, locale, setLocale]);
}

/**
 * The language choice: `field` on the settings page, `compact` as a chip, and `sidebar` as a
 * chip with an icon in place of the visible label, next to the quick theme switch.
 */
export function LanguageChoice({ variant }: { variant: "field" | "compact" | "sidebar" }) {
  const t = useT();
  const announce = useAnnounce();
  const { api } = useDashboard();
  const queryClient = useQueryClient();
  const { locale, setLocale } = useLocale();
  const save = useMutation({
    mutationFn: (code: LocaleCode) => api.updateAccountSettings({ locale: code }),
    onSuccess: (next) => queryClient.setQueryData(SETTINGS_QUERY, next),
    onError: () => announce(t("language.saveFailed")),
  });

  const choose = async (code: LocaleCode) => {
    if (code === locale) return;
    try {
      await setLocale(code);
    } catch {
      announce(t("language.loadFailed"));
      return;
    }
    // `t` reads the active catalog, which is the new language now.
    announce(t("language.changed"));
    save.mutate(code);
  };

  return (
    <LanguageSwitcher
      label={t("language.label")}
      description={variant === "field" ? t("language.description") : undefined}
      value={locale}
      languages={LANGUAGES}
      variant={variant === "field" ? "field" : "compact"}
      icon={variant === "sidebar" ? <Languages className="size-4" /> : undefined}
      onChange={(code) => void choose(code)}
    />
  );
}
