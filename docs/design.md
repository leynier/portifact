# Design system

All Portifact UI comes from one design system in `packages/ui`. This covers the dashboard, the review viewer, the Markdown and TXT viewers served on artifact origins, and any visible part of the annotation bridge. The goal is a consistent product and a single place to change how it looks. Styles scattered across apps are not allowed.

## Layers

1. **Tokens.** Every visual value lives here: color, typography, spacing, sizing, radii, borders, shadows, z-index, motion and breakpoints. Tokens are CSS custom properties exposed through the Tailwind CSS v4 theme in `packages/ui/src/tokens`. Two levels:
   - Primitive tokens hold raw values, for example the color scale.
   - Semantic tokens describe intent, for example `--color-surface`, `--color-text-muted`, `--color-danger` and `--space-4`. Components and apps use semantic tokens only. Color tokens resolve to the neutral palette described below.
2. **Components.** Accessible building blocks built on Radix UI primitives, owned in `packages/ui/src/components`: button, input, dialog, menu, table, tabs, toast, badge, empty state and so on. Variants such as size, tone and state are part of the component API, defined with `class-variance-authority`.
3. **Patterns.** Compositions reused across screens, such as page layout, data table with filters, upload progress and annotation thread, in `packages/ui/src/patterns`.
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

Pattern utilities (`bg-dot-grid`, `bg-hatch`, `bg-highlight` for a selection-style text highlight on `mark`, `marker-none` for custom `summary` disclosures and `typing-caret`) and the `shadow-sm` and `shadow-float` elevations are defined there too. Tailwind's default shadows are removed.

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

## Forms

Forms use TanStack Form through a single form hook created with `createFormHook` in `packages/ui/src/forms`. It binds the design-system field components (text, select, checkbox, OTP and so on) once, so screens never wire inputs, labels, errors or ARIA attributes by hand. Validation uses the Zod schemas from `packages/contracts` directly, so the client and the API apply the same rules. Do not add another form library or build ad hoc field state with `useState`.

## Accessibility

Components carry the accessible behavior for the whole product. The requirements and how they are tested are in [accessibility.md](accessibility.md).

## Catalog and tests

- Every component and pattern has a Storybook story covering its variants and states, including loading, empty, error and disabled.
- Component tests verify behavior and accessibility (roles, labels, keyboard), not class names.
- Visual changes to tokens are reviewed in Storybook in both themes.

## Artifact-origin viewers

The Markdown and TXT viewers and the bridge run on `portifact.dev` and ship in their own small bundles. They import tokens and the few components they need from `packages/ui`, so they stay consistent with the dashboard without loading the full dashboard bundle. They must not depend on anything served from `portifact.com`.
