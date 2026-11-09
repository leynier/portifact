import { Monitor, Moon, Sun } from "lucide-react";
import { type ReactNode, useCallback, useId, useSyncExternalStore } from "react";
import {
  currentThemePreference,
  darkSourceMedia,
  setThemePreference,
  subscribeThemePreference,
  THEME_PREFERENCES,
  type ThemePreference,
} from "../theme/theme.ts";
import { Tooltip } from "./tooltip.tsx";

/**
 * The theme the page shows now and a function that changes it for this browser. Every caller
 * re-renders on a change, here or in another tab, so pictures can follow it (`darkSourceMedia`).
 */
export function useThemePreference(): [ThemePreference, (preference: ThemePreference) => void] {
  const preference = useSyncExternalStore(
    subscribeThemePreference,
    () => currentThemePreference(),
    (): ThemePreference => "system",
  );
  const change = useCallback((next: ThemePreference) => {
    setThemePreference(next);
  }, []);
  return [preference, change];
}

const ICONS: Record<ThemePreference, ReactNode> = {
  system: <Monitor className="size-4 shrink-0" aria-hidden="true" />,
  light: <Sun className="size-4 shrink-0" aria-hidden="true" />,
  dark: <Moon className="size-4 shrink-0" aria-hidden="true" />,
};

/**
 * Classes of the switcher's parts, shared with the static copy on the landing page
 * (apps/web/index.html), which `setupThemeSwitchers` wires without React.
 */
export const themeSwitcherClasses = {
  group: "inline-flex gap-1 rounded-sm border border-border bg-canvas p-1",
  option:
    "relative inline-flex h-7 items-center justify-center gap-1.5 rounded-xs px-2 text-sm text-text-muted transition-colors duration-150 hover:bg-surface-hover hover:text-text has-checked:selection-band has-checked:font-medium has-checked:hover:bg-selection input-focus:outline-2 input-focus:outline-offset-2 input-focus:outline-focus",
  compactOption: "w-7 px-0",
} as const;

export interface ThemeSwitcherProps {
  /** Names the group, such as "Theme"; visible unless `compact`. */
  legend: string;
  /** The name of each choice, such as "System", "Light" and "Dark". */
  labels: Record<ThemePreference, string>;
  /** Icons only, with each name in a tooltip and for assistive technology, for tight spaces. */
  compact?: boolean;
  /** Stacks the choices, such as in the collapsed sidebar rail. */
  orientation?: "horizontal" | "vertical";
}

/**
 * The System, Light or Dark choice: a native radio group, so arrow keys move between the
 * choices, screen readers announce the group, the choice and its state, and the chosen one
 * carries the selection band. It applies and remembers the choice for this browser.
 */
export function ThemeSwitcher({
  legend,
  labels,
  compact = false,
  orientation = "horizontal",
}: ThemeSwitcherProps) {
  const [preference, change] = useThemePreference();
  const name = useId();
  const vertical = orientation === "vertical";
  return (
    <fieldset className="min-w-0">
      <legend className={compact ? "sr-only" : "mb-3 text-sm font-semibold"}>{legend}</legend>
      <div className={`${themeSwitcherClasses.group} ${vertical ? "flex-col" : ""}`}>
        {THEME_PREFERENCES.map((option) => {
          const choice = (
            <label
              key={option}
              className={`${themeSwitcherClasses.option} ${compact ? themeSwitcherClasses.compactOption : ""}`}
            >
              <input
                type="radio"
                name={name}
                value={option}
                checked={preference === option}
                onChange={() => change(option)}
                className="sr-only"
              />
              {ICONS[option]}
              <span className={compact ? "sr-only" : ""}>{labels[option]}</span>
            </label>
          );
          return compact ? (
            <Tooltip key={option} label={labels[option]} side={vertical ? "right" : "top"}>
              {choice}
            </Tooltip>
          ) : (
            choice
          );
        })}
      </div>
    </fieldset>
  );
}

export interface ThemedImageProps {
  /** The image for light backgrounds, also the fallback. */
  src: string;
  /** The image for dark backgrounds. */
  darkSrc: string;
  alt: string;
  width: number;
  height: number;
  className?: string;
}

/**
 * An image with a light and a dark version, such as the logo, that follows the chosen theme
 * rather than only the operating system's.
 */
export function ThemedImage({ src, darkSrc, alt, width, height, className }: ThemedImageProps) {
  const [preference] = useThemePreference();
  return (
    <picture>
      <source media={darkSourceMedia(preference)} srcSet={darkSrc} />
      <img src={src} alt={alt} width={width} height={height} className={className} />
    </picture>
  );
}
