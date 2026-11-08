# Design system

All Portifact UI comes from one design system in `packages/ui`. This covers the dashboard, the review viewer, the Markdown and TXT viewers served on artifact origins, and any visible part of the annotation bridge. The goal is a consistent product and a single place to change how it looks. Styles scattered across apps are not allowed.

## Layers

1. **Tokens.** Every visual value lives here: color, typography, spacing, sizing, radii, borders, shadows, z-index, motion and breakpoints. Tokens are CSS custom properties exposed through the Tailwind CSS v4 theme in `packages/ui/src/tokens`. Two levels:
   - Primitive tokens hold raw values, for example the color scale.
   - Semantic tokens describe intent, for example `--color-surface`, `--color-text-muted`, `--color-danger` and `--space-4`. Components and apps use semantic tokens only. Color tokens resolve to the neutral palette described below.
2. **Components.** Accessible React building blocks owned in `packages/ui/src/components` and exported from `@portifact/ui`: button, badge, callout, confirm dialog, detail list, empty state, loading state, live region, table, text input, text area, checkbox, radio group, file picker (with `canPickFolders`), progress bar and preview frame today; menu, tabs, toast and so on as screens need them. Prefer a native element when it gives the behavior (the confirm dialog is a native `dialog` with `showModal()`), and use Radix UI primitives where none does, but not ones that inject inline `<style>` elements (such as Radix's scroll lock), which the strict page CSP refuses. Variants such as size, tone and state are part of the component API, defined with `class-variance-authority`. Icons are Lucide, decorative and `aria-hidden`; the label carries the meaning.
3. **Patterns.** Compositions reused across screens, such as page layout, data table with filters, upload progress and annotation thread, in `packages/ui/src/patterns`. `AppShell` (skip link, header, labelled navigation, account and the focusable `main`) and `PageHeader` (the screen's single `h1`) exist today.
4. **Apps.** Screens compose components and patterns. They only arrange layout using tokens.

## Palette

Portifact is monochromatic. The whole product, including the logo, dashboard, review viewer, Markdown and TXT viewers, CLI output, documentation and emails, uses only black, white and a neutral gray scale with zero saturation. No hue appears anywhere, including accents, links, focus rings, charts and status states.

- The primitive scale is a single neutral ramp from white to black, defined once in `packages/ui/src/tokens`. Semantic tokens map onto it for light and dark themes.
- Hierarchy comes from contrast, weight, size and spacing, not from color.
- Links are distinguished by an underline, not by color.
- States (danger, warning, success, info) are semantic tokens like any other, but they map to neutral values. They are always conveyed by an icon, a text label and, where useful, weight or border style. A state is never shown through tone alone; see [accessibility.md](accessibility.md).
- Annotation highlights and selection in the review viewer use neutral tints that keep the underlying text at the required contrast.
- Content published by users keeps its own colors. The rule applies to everything Portifact draws around it, such as the bridge markers and viewer chrome.

Exception: third-party status badges in the readme (release, license, CI, coverage) keep their conventional colors, because their color carries meaning readers already know.

Adding any other hue requires changing this section first, in a separate change with a reason.

The `terminal`, `terminal-text`, `terminal-muted` and `terminal-border` tokens draw terminal and agent-session mocks, and dark bands such as the landing page's security section. They stay dark in both themes, so use them only where a dark surface is the point.

## Motion and patterns

Motion tokens and utilities live in `packages/ui/src/tokens/theme.css`: `animate-rise`, `animate-fade`, `animate-type`, `animate-sweep` and `animate-blink`, staggered with `animate-delay-<n>`. Always apply them through the `motion-safe:` variant, so nothing moves under `prefers-reduced-motion` and every element rests in its final state. Motion is decorative only; it never carries information.

The landing hero types its second line with `apps/web/src/typewriter.ts`: one pass through the phrases, then it settles on the first and the caret fades, so nothing keeps moving. The `h1` keeps a visually hidden, complete sentence for assistive technology and marks the animated part `aria-hidden`; invisible copies of every phrase share one grid cell so the line never changes height. Under reduced motion the script does nothing and the caret (`typing-caret`, a block sized in `em` and colored with a token utility such as `bg-text`) is hidden.

The `current:` variant styles the link to the page being shown (`aria-current="page"`), such as the active navigation item, and `current-item:` the item a list points at (`aria-current="true"`), such as the selected thread in the review viewer; use them instead of an arbitrary `aria-[...]` variant.

Pattern utilities (`bg-dot-grid`, `bg-hatch`, `bg-highlight` for a selection-style text highlight on `mark`, `marker-none` for custom `summary` disclosures, `progress-bar` for the native `progress` element and `typing-caret`) and the `shadow-sm` and `shadow-float` elevations are defined there too. Tailwind's default shadows are removed.

The base layer gives every enabled `button`, `[role="button"]`, `[role="tab"]`, `summary` and `label[for]` the pointer cursor, which Tailwind v4 preflight no longer sets. Do not add `cursor-pointer` to those elements in apps.

Brand and client icons, such as the supported-agents strip on the landing page, are inline SVG with `fill="currentColor"`, so they take a token text color and never show brand colors.

## Writing style

- Titles and headings (page titles, headings, buttons, labels, taglines) never end with a period.
- Never use em dashes (the long dash). Use a comma, a colon, parentheses or two sentences instead. The design-system check rejects em dashes in UI code.

## Brand assets

The logo is the "selection" wordmark: the name `portifact` held between two text-selection handles over a light band. Source files live in `assets/brand/`:

- `wordmark.svg` for light backgrounds and `wordmark-dark.svg` for dark ones, with PNG renders.
- `symbol.svg` and `symbol-dark.svg`: the lowercase p between the handles, for app icons and avatars.
- `favicon-16.svg` and `favicon-32.svg` are redrawn by hand for those sizes and switch to dark colors with `prefers-color-scheme`. Serve the SVG favicon first and `favicon.ico` (16, 32 and 48 px) as the fallback.

Use the files as they are: do not recolor, stretch, add effects or rebuild the logo from a font. Pick the light or dark variant by background, and keep clear space around the logo of at least the height of the band. The only colors are `#000000`, `#FFFFFF`, `#DEDEDE` (band on light) and `#3A3A3A` (band on dark).

## Rules

- Apps never declare their own colors, font sizes, spacing values, radii or shadows. Use tokens through components or token-based utilities.
- No raw hex, `rgb()` or `hsl()` values, and no arbitrary Tailwind values such as `p-[13px]` or `text-[#333]`, outside `packages/ui/src/tokens`.
- No inline `style` props for visual styling. Dynamic geometry, such as annotation marker positions, is the only exception and must use token values for everything except coordinates.
- No per-screen CSS files. If a component needs custom CSS, it lives in `packages/ui` next to the component.
- Do not restyle a component from outside with overriding classes. Add or extend a variant in the design system.
- If something is missing, add the token, variant or component to `packages/ui` first, with its story and tests, then use it.
- Light and dark themes are both driven by semantic tokens, so a component never branches on the theme.

`bun run check` runs `scripts/check-design-system.ts` (rules in `packages/ui/src/design-check.ts`), which fails on arbitrary Tailwind values, inline `style` attributes, Tailwind's default palette and raw color values outside `packages/ui/src/tokens`. The Tailwind theme in `packages/ui/src/tokens/theme.css` removes the default palette, so only token colors exist as utilities. Do not disable it; if a rule blocks a legitimate case, change the rule in a separate, explained change.

## Dashboard

The dashboard is a React 19 single-page app in `apps/web/src/dashboard`, built by Vite as `dashboard.html` and served by the `portifact-app` Worker at its client routes on `app.portifact.com`. TanStack Router defines the routes in `router.tsx` (keep them in sync with `DASHBOARD_ROUTES` in `apps/app/src/app-host.ts`; the Worker serves the dashboard with `dashboardCsp`, which adds the storage endpoint to `connect-src` and the rendered documents' stylesheet hash to `style-src`) and TanStack Query loads data through `api.ts`, which validates every response with `packages/contracts`. Screens read the API client and navigation out of the app through `DashboardContext`, so tests pass fakes.

- Every user-facing string goes through Lingui: add it to `i18n/en.ts` (ICU MessageFormat) and read it with `useT()`. Message IDs are typed, so a missing key fails the typecheck. Dates go through `useFormatDate()`.
- Lists and details refresh at most every 30 seconds while the tab is visible, pause in the background and back off after errors (`refresh.ts`, plan section 2). A failed refresh keeps the last data and says so.
- After a client-side navigation, focus moves to `main`, and each screen sets the document title with `useDocumentTitle`. Results of actions are announced through the shell's live region with `useAnnounce()`; errors use an alert callout.
- Destructive actions, such as deleting an artifact, open a `ConfirmDialog` first. So do actions that end something elsewhere: signing out other sessions and disconnecting an app.
- The artifact page has an access section (`screens/access-settings.tsx`): the three modes as a radio group, each with who it lets in, indexing and embedding, and the reader list with add and remove. It states that republishing never widens access. It explains the API's refusals in the terms of the rule (account too new for public, with the date from the session's `createdAt`; the 500-reader cap; a `version_conflict`, after which it reloads the policy). Public is disabled while the account is in its first 7 days, unless the artifact is already public, so narrowing stays possible. The access query does not refresh on a timer, so a refresh never discards unsaved choices; the form restarts from the server's values only when they change.
- Publishing (`/publish` for a new artifact, `/artifacts/<id>/publish` for a new version, `screens/publish.tsx`) runs in steps: choose the type and a source (files, a folder where the browser can pick one, a ZIP, which is the only option where it cannot, or a Markdown or text file or pasted text), review the manifest, what was left out and who will be able to open the result, then upload with a progress bar, cancel and resume. Nothing reaches the API before the review. The manifest is built by `publish/manifest.ts` inside a Web Worker (`publish/worker.ts`, wrapped by `publish/builder.ts`); hashing and ZIP expansion are incremental, and the API revalidates everything. Uploads (`publish/upload.ts`) go straight to storage through `publish/transport.ts`; errors are explained in the terms of the rule that refused them (`publish/failures.ts`), and resume is offered only when a retry can help. A new version is published on the artifact's current version, so a publish made elsewhere meanwhile is a conflict, never an overwrite.
- The document editor (`/artifacts/<id>/edit`, `screens/document-editor.tsx`) loads the current source through a download link, checks it against the manifest, and saves by publishing a new version on that one in which only the text changes; assets and sources keep their stored objects. Its preview is the server's rendering (`POST /api/v1/documents/preview`) shown in `PreviewFrame`; never render user markup in the dashboard's own document.
- The history (`/artifacts/<id>/history`, `screens/history.tsx`) lists the retained versions, downloads published files or sources (checked against the manifest and packaged as a ZIP in the page when there are several, `publish/download.ts`), and rolls back after a confirmation. While the artifact is archived it shows the purge date with restore and delete.
- `DashboardEnv` also carries the manifest builder, the storage transport and `save` (hands a file to the user), so tests pass in-process and fake versions.
- The review viewer (`/review/<id>`, `screens/review.tsx`, opened from the artifact page) shows the pinned version in a sandboxed iframe next to the comments panel: general comments, "Comment on the selection" after the reader selects text, element mode for sites (a toggle button with `aria-pressed`), replies, resolve and reopen, and the owner's moderation. Threads are numbered by creation and keep a visible state badge; a thread the page cannot locate shows "Without location", and one on another file shows its path. Activating a marker in the page moves focus to its thread. When review cannot run in the frame (cookie dropped, page silent, session ended, a review session the viewer did not start, the frame no longer answering from the artifact, newer version), a callout says why and what still works. Refreshes are incremental with the API's cursor (`review/use-threads.ts`).
- The account screen (`/account`, `screens/account.tsx`) shows the email, the sign-in methods (`/api/auth/list-accounts`), the browser sessions with "Sign out other sessions" and the connected apps with "Disconnect" (`/api/v1/account/*`). App names come from OAuth clients, so they are untrusted text and only ever rendered as text.

## Forms

Forms use TanStack Form through a single form hook created with `createFormHook` in `packages/ui/src/forms`, imported as `@portifact/ui/forms`. `useAppForm` binds the design-system fields once (`TextField`, `TextAreaField`, `CheckboxField` and `RadioGroupField` today; select and OTP as screens need them), plus `Form` and `SubmitButton`, so screens never wire inputs, labels, errors or ARIA attributes by hand. `Form` submits through TanStack Form and, when validation fails, focuses the first invalid control; `SubmitButton` is busy while the submit runs. Do not add another form library or build ad hoc field state with `useState`.

Validation applies the schemas from `packages/contracts` (for example `Email.safeParse`), so the client and the API apply the same rules, but the message comes from the screen's i18n catalog, because Zod's messages are not translated. Use `validationLogic: revalidateLogic()` with an `onDynamic` validator: nothing is flagged while the user types the first time, errors appear on submit and then clear as soon as the value is fixed.

## Accessibility

Components carry the accessible behavior for the whole product. The requirements and how they are tested are in [accessibility.md](accessibility.md).

## Catalog and tests

- Every component and pattern has a Storybook story covering its variants and states, including loading, empty, error and disabled. Storybook is not set up yet; until it is, each component's tests render every variant and state and check them with `axeViolations` from `@portifact/ui/testing`.
- Component tests verify behavior and accessibility (roles, labels, keyboard), not class names.
- Visual changes to tokens are reviewed in Storybook in both themes.

## Artifact-origin viewers

The Markdown and TXT viewers and the bridge run on `portifact.dev` and ship in their own small bundles. They import tokens and the few components they need from `packages/ui`, so they stay consistent with the dashboard without loading the full dashboard bundle. They must not depend on anything served from `portifact.com`.

The bridge's overlay (markers, highlights, the element-mode outline and its hint) lives in a closed shadow root and is styled by a constructed stylesheet built from `TOKENS_CSS` with `:root` rewritten to `:host`, so a page's CSP does not block it and the page's styles do not reach it. Positions are set through CSSOM properties, the dynamic-geometry exception above. Its visible text comes from the viewer's i18n catalog through the bridge messages.

The Markdown and TXT documents rendered by `packages/render` load no bundle at all: they inline `TOKENS_CSS` (`@portifact/ui/tokens-css`) and `DOCUMENT_CSS` (`@portifact/ui/document-css`) in one `<style>`. `DOCUMENT_CSS` uses only `var(--pf-*)` tokens, including the type scale, spacing, measure and border widths in `tokens.css` that exist for surfaces styled without Tailwind. `tokens-css.ts` is generated from `tokens.css`: after editing the tokens, run `bun run --cwd packages/ui sync-tokens`, or the drift test fails.
