# Accessibility

Portifact targets **WCAG 2.2 level AA** on every surface we build: the dashboard, the review viewer, the annotation flow, the Markdown and TXT viewers, the CLI and the documentation. Accessibility is a requirement for a feature to be done, not a later pass. We cannot make sites uploaded by users accessible, but nothing we inject or wrap around them may make them less accessible.

## Foundations

- **Semantic HTML first.** Use native elements (`button`, `a`, `label`, `table`, headings, landmarks) before ARIA. Add ARIA only when no native element fits, and never contradict native semantics.
- **Design system.** Accessible behavior lives in `packages/ui` components, built on Radix UI primitives, so screens inherit it. See [design.md](design.md). Do not rebuild a component in an app to change its behavior.
- **Contrast.** Semantic color tokens meet 4.5:1 for text and 3:1 for large text, icons, focus indicators and control borders, in both light and dark themes. A token change that breaks contrast fails the check.
- **Color is never the only signal.** Status, errors, access mode and annotation state also use text or an icon. The palette is monochromatic (see [design.md](design.md)), so this is required by construction: states differ by icon, label, weight and border, never by tone alone.
- **Motion.** Respect `prefers-reduced-motion`; no essential information is conveyed only through animation.
- **Zoom and reflow.** Content works at 200% zoom and at 320 CSS pixels wide without horizontal scrolling, except data tables, which scroll inside their own region.

## Keyboard and focus

- Everything that works with a pointer works with a keyboard, in a logical order.
- Focus is always visible, using the focus token, and never hidden behind sticky headers.
- Dialogs and menus trap focus while open, close with Escape and return focus to the control that opened them.
- Pages provide a skip link to the main content.
- Shortcuts never override browser or assistive technology keys and can be discovered from the UI.

## Forms and feedback

- Every control has a visible label. Placeholders are not labels.
- Errors appear next to the field and are linked with `aria-describedby`. On submit, a form with several fields in error summarizes them at the top and moves focus to the summary; a form with one validated field moves focus to that field instead, whose linked error is read with it (the `Form` of `@portifact/ui/forms` does this).
- Long operations (uploads, restores, exports) announce progress and completion through a polite live region and never rely on a spinner alone.
- Toasts are announced, stay long enough to read, and any action they offer is also available elsewhere.
- Time limits, such as OTP expiry, are stated in text, and the user can request a new code.

## Annotations

Annotation must be fully possible without a mouse:

- Text selected with the keyboard (Shift plus arrow keys) can be annotated through a visible "Comment" control or a documented shortcut.
- In `site` artifacts, a keyboard mode lets the user move through selectable elements and choose one; the highlighted target is announced.
- Annotation markers are focusable, have an accessible name that includes the quoted text, and open their thread on Enter.
- The threads panel is a landmark region, navigable with headings and lists, and new replies are announced politely.
- When an anchor cannot be placed, the thread says so in text, not only by changing a marker's color.

## Viewers

- The Markdown viewer outputs semantic HTML: real headings, lists, tables with header cells, code blocks and links with meaningful text. Images keep the author's alt text; missing alt text is flagged to the creator in the dashboard.
- The TXT viewer keeps line numbers out of the text read by screen readers and the copy buffer.
- The review viewer gives the artifact iframe an accessible title and does not trap focus inside it.
- The bridge injected into sites adds no focusable elements, landmarks or announcements unless review mode is active, and it never changes the site's own semantics.

## CLI

- Output does not depend on color: every colored state also has a word or symbol.
- Respect `NO_COLOR` and non-TTY output; disable spinners and animation when stdout is not a terminal.
- Interactive prompts have non-interactive flags, so the CLI works with screen readers and in scripts.
- `--json` output is stable for tools that present the results differently.

## Testing

Accessibility is tested like any other behavior. See [testing.md](testing.md).

- Component tests query by role and accessible name, which also verifies the accessible name exists.
- `vitest-axe` runs on every component story and state in `packages/ui`.
- `e2e/tests/design.spec.ts` runs axe-core with color contrast on the dashboard's main screens (list, artifact page, publish, history, account and the empty list) in both themes. Any violation fails the build. Accessible names of controls start with their visible label (WCAG 2.5.3), which this check enforces.
- End-to-end tests include keyboard-only paths: sign in, publish, change access, annotate text, annotate an element, reply and restore.
- Automated tools find only part of the problems. Before release, run a manual check with the keyboard alone, with VoiceOver or NVDA, at 200% zoom and with reduced motion.
