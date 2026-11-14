// What edit suggestions show (decision 0027, "What the person is shown" and "Previews"). A
// reviewer's text is untrusted: it is drawn only as text, each field in its own direction
// isolate, and characters a reader cannot see or could misread as distinct chips that literal
// text can never imitate. Built previews are framed with an empty sandbox and never receive
// credentials. Nothing here relies on color: changes carry signs and labels in text.
import type { ReactNode } from "react";

/** A field split for display: literal text, and characters shown as chips (`U+XXXX`). */
export type TypedToken = { kind: "text"; value: string } | { kind: "char"; codePoint: number };

/** The code point as the display writes it: `U+` and at least four hexadecimal digits. */
export const codePointName = (codePoint: number): string =>
  `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;

export interface TypedTextProps {
  tokens: readonly TypedToken[];
  /** What assistive technology hears before a chip, such as "character". */
  characterLabel: string;
  /** Shown when the field is empty, such as "(nothing)". */
  empty: string;
}

/**
 * One field of untrusted text in its own direction isolate. A character token is a bordered chip
 * with its code point, so a hidden or look-alike character is visible and a literal `U+202E`
 * typed as text reads differently from the real one.
 */
export function TypedText({ tokens, characterLabel, empty }: TypedTextProps) {
  if (tokens.length === 0) {
    return <span className="text-text-muted italic">{empty}</span>;
  }
  return (
    <bdi className="font-mono break-words whitespace-pre-wrap">
      {tokens.map((token, index) =>
        token.kind === "text" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: tokens have no identity but their place
          <span key={index}>{token.value}</span>
        ) : (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: tokens have no identity but their place
            key={index}
            className="mx-0.5 inline-flex items-center rounded-xs border border-border-strong bg-surface-hover px-1 text-xs not-italic"
          >
            <span className="sr-only">{`${characterLabel} `}</span>
            {codePointName(token.codePoint)}
          </span>
        ),
      )}
    </bdi>
  );
}

export interface EditDiffProps {
  before: readonly TypedToken[];
  after: readonly TypedToken[];
  labels: { removed: string; added: string; character: string; empty: string };
}

/** The before and after of a text edit, as labelled text with a sign each, never by color alone. */
export function EditDiff({ before, after, labels }: EditDiffProps) {
  const row = "flex flex-wrap items-baseline gap-x-2 rounded-xs px-2 py-1 text-sm";
  return (
    <dl className="flex flex-col gap-1">
      <div className={`${row} bg-hatch`}>
        <dt className="font-medium">
          <span aria-hidden="true">- </span>
          {labels.removed}
        </dt>
        <dd>
          <TypedText tokens={before} characterLabel={labels.character} empty={labels.empty} />
        </dd>
      </div>
      <div className={`${row} bg-selection`}>
        <dt className="font-medium">
          <span aria-hidden="true">+ </span>
          {labels.added}
        </dt>
        <dd>
          <TypedText tokens={after} characterLabel={labels.character} empty={labels.empty} />
        </dd>
      </div>
    </dl>
  );
}

export interface CodePointListProps {
  /** Accessible name, such as "Code points of the new text". */
  label: string;
  codePoints: readonly number[];
}

/** Every code point of a field, for the person who wants to inspect it ("Inspect"). */
export function CodePointList({ label, codePoints }: CodePointListProps) {
  return (
    <ol aria-label={label} className="flex flex-wrap gap-1 font-mono text-xs">
      {codePoints.map((codePoint, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: code points repeat; their place is the key
        <li key={index} className="rounded-xs border border-border px-1">
          {codePointName(codePoint)}
        </li>
      ))}
    </ol>
  );
}

export interface PlanLinesProps {
  /** Accessible name of the list, such as "What accepting does". */
  label: string;
  /** The plan's lines, rendered by the server from its envelopes; untrusted text. */
  lines: readonly string[];
}

/** The lines of a plan or an envelope, exactly as the server wrote them, one list item each. */
export function PlanLines({ label, lines }: PlanLinesProps) {
  return (
    <ol
      aria-label={label}
      className="flex max-h-80 flex-col gap-0.5 overflow-auto rounded-sm border border-border bg-canvas p-2 font-mono text-xs"
    >
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines repeat; their place is the key
        <li key={index} className="break-words whitespace-pre-wrap">
          <bdi>{line}</bdi>
        </li>
      ))}
    </ol>
  );
}

export interface SuggestionPreviewProps {
  /** Accessible name of the frame, such as "Preview of the suggested change". */
  title: string;
  /** The one-use URL on the preview origin. */
  url: string;
}

/**
 * The built preview of a suggestion (decision 0027, "Previews"), served from the cookieless
 * preview origin. The frame's empty `sandbox` gives it an opaque origin with no scripts, forms,
 * popups or navigation; it is a hint for the person, never the live page.
 */
export function SuggestionPreview({ title, url }: SuggestionPreviewProps) {
  return (
    <iframe
      title={title}
      src={url}
      sandbox=""
      referrerPolicy="no-referrer"
      className="h-96 w-full rounded-lg border border-border bg-canvas"
    />
  );
}

export interface ModeSwitchOption<T extends string> {
  value: T;
  label: string;
  /**
   * The button's accessible name when the visible label alone would repeat another control's,
   * such as "Comment mode" next to a "Comment" button. It must contain the visible label.
   */
  name?: string;
  icon?: ReactNode;
  /** Shown but not choosable yet, such as a mode that waits for the page to connect. */
  disabled?: boolean;
}

export interface ModeSwitchProps<T extends string> {
  /** Accessible name of the group, such as "Review mode". */
  label: string;
  options: readonly ModeSwitchOption<T>[];
  value: T;
  onChange(value: T): void;
}

/**
 * A toggle group of two or more modes, such as Comment and Suggest: each mode is a toggle button
 * whose pressed state is announced, at least 44 by 44 CSS pixels.
 */
export function ModeSwitch<T extends string>({
  label,
  options,
  value,
  onChange,
}: ModeSwitchProps<T>) {
  return (
    <fieldset
      aria-label={label}
      className="inline-flex rounded-sm border border-border-strong p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          aria-label={option.name}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
          className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-xs px-3 text-sm font-medium text-text hover:bg-surface-hover disabled:opacity-55 disabled:hover:bg-transparent aria-pressed:bg-surface-inverse aria-pressed:text-text-inverse"
        >
          {option.icon ? (
            <span aria-hidden="true" className="inline-flex">
              {option.icon}
            </span>
          ) : null}
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}
