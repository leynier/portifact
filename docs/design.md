# Design system

All Portifact UI comes from one design system in `packages/ui`. This covers the dashboard, the review viewer, the Markdown and TXT viewers served on artifact origins, and any visible part of the annotation bridge. The goal is a consistent product and a single place to change how it looks. Styles scattered across apps are not allowed.

## Layers

1. **Tokens.** Every visual value lives here: color, typography, spacing, sizing, radii, borders, shadows, z-index, motion and breakpoints. Tokens are CSS custom properties exposed through the Tailwind CSS v4 theme in `packages/ui/src/tokens`. Two levels:
   - Primitive tokens hold raw values, for example the color scale.
   - Semantic tokens describe intent, for example `--color-surface`, `--color-text-muted`, `--color-danger` and `--space-4`. Components and apps use semantic tokens only.
2. **Components.** Accessible building blocks built on Radix UI primitives, owned in `packages/ui/src/components`: button, input, dialog, menu, table, tabs, toast, badge, empty state and so on. Variants such as size, tone and state are part of the component API, defined with `class-variance-authority`.
3. **Patterns.** Compositions reused across screens, such as page layout, data table with filters, upload progress and annotation thread, in `packages/ui/src/patterns`.
4. **Apps.** Screens compose components and patterns. They only arrange layout using tokens.

## Rules

- Apps never declare their own colors, font sizes, spacing values, radii or shadows. Use tokens through components or token-based utilities.
- No raw hex, `rgb()` or `hsl()` values, and no arbitrary Tailwind values such as `p-[13px]` or `text-[#333]`, outside `packages/ui/src/tokens`.
- No inline `style` props for visual styling. Dynamic geometry, such as annotation marker positions, is the only exception and must use token values for everything except coordinates.
- No per-screen CSS files. If a component needs custom CSS, it lives in `packages/ui` next to the component.
- Do not restyle a component from outside with overriding classes. Add or extend a variant in the design system.
- If something is missing, add the token, variant or component to `packages/ui` first, with its story and tests, then use it.
- Light and dark themes are both driven by semantic tokens, so a component never branches on the theme.

`bun run check` runs a design-system check that fails on these violations. Do not disable it; if a rule blocks a legitimate case, change the rule in a separate, explained change.

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
