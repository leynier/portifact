// Types, deletes and cycles through phrases with a blinking caret, then settles on the first
// phrase and stops, so nothing on the page keeps moving on its own.
//
// Markup: a `[data-typewriter]` element holding a `[data-typewriter-text]` span that is
// rendered with the first phrase, a `[data-typewriter-caret]` and one `[data-typewriter-phrase]`
// per phrase. The phrase elements are invisible and stacked in the same place, so the line
// keeps the height of its tallest phrase and the page never shifts while typing. The animated
// part is `aria-hidden`; assistive technology reads a separate, stable sentence.

export interface TypewriterTiming {
  /** Pause before each character appears. */
  typeMs: number;
  /** Pause before each character is removed. */
  deleteMs: number;
  /** How long a complete phrase stays on screen. */
  holdMs: number;
  /** Pause on the empty line between deleting and typing. */
  betweenMs: number;
}

/** One frame of the effect: wait `delay` milliseconds, then show `text`. */
export interface TypewriterStep {
  delay: number;
  text: string;
}

export const DEFAULT_TIMING: TypewriterTiming = {
  typeMs: 55,
  deleteMs: 28,
  holdMs: 2200,
  betweenMs: 300,
};

/**
 * Every frame of one pass: from the first phrase through each other phrase and back to the
 * first. Returns no frames when there is nothing to cycle through.
 */
export function typewriterSteps(
  phrases: readonly string[],
  timing: TypewriterTiming = DEFAULT_TIMING,
): TypewriterStep[] {
  const [first, ...rest] = phrases;
  if (first === undefined || rest.length === 0) return [];
  const steps: TypewriterStep[] = [];
  let current = first;
  for (const next of [...rest, first]) {
    for (let length = current.length - 1; length >= 0; length -= 1) {
      const delay = length === current.length - 1 ? timing.holdMs : timing.deleteMs;
      steps.push({ delay, text: current.slice(0, length) });
    }
    for (let length = 1; length <= next.length; length += 1) {
      steps.push({
        delay: length === 1 ? timing.betweenMs : timing.typeMs,
        text: next.slice(0, length),
      });
    }
    current = next;
  }
  return steps;
}

export interface TypewriterOptions {
  /** True when the visitor prefers reduced motion; the first phrase then stays still. */
  reducedMotion: boolean;
  timing?: TypewriterTiming;
  wait?: (ms: number) => Promise<void>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Plays one pass of the effect on the first `[data-typewriter]` under `root`. Resolves to true
 * when it played, or false when it was skipped (reduced motion, missing markup or a single
 * phrase), leaving the first phrase in place.
 */
export async function setupTypewriter(
  root: ParentNode,
  { reducedMotion, timing = DEFAULT_TIMING, wait = sleep }: TypewriterOptions,
): Promise<boolean> {
  const host = root.querySelector<HTMLElement>("[data-typewriter]");
  const text = host?.querySelector<HTMLElement>("[data-typewriter-text]");
  if (!host || !text || reducedMotion) return false;

  const phrases = [...host.querySelectorAll<HTMLElement>("[data-typewriter-phrase]")]
    .map((phrase) => phrase.textContent?.trim() ?? "")
    .filter((phrase) => phrase.length > 0);
  const steps = typewriterSteps(phrases, timing);
  if (steps.length === 0) return false;

  for (const step of steps) {
    await wait(step.delay);
    text.textContent = step.text;
  }
  host.querySelector<HTMLElement>("[data-typewriter-caret]")?.setAttribute("data-settled", "");
  return true;
}
