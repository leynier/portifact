# Annotation anchors

A thread points at an immutable version, a file path and a target. The target shapes live in `packages/contracts/src/anchors.ts` (`AnnotationTarget`); creating and resolving them lives in `packages/anchors`, which is pure TypeScript with no I/O. The review bridge, the viewers, the API and MCP all use the same code, so they agree on quotes and positions.

## Target schema

`AnnotationTarget` is versioned (`schema: 1`) and holds `path`, an optional SPA `route` (`location.pathname` plus `location.hash`), an optional `contentHash` and `renderer`, and one `anchor`:

| Kind       | Data                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `document` | Nothing more: a general comment on the path.                                                                                                                                                            |
| `text`     | `quote` (W3C TextQuoteSelector: `exact`, `prefix`, `suffix`), `position` (TextPositionSelector), optional `domHint` selector and optional `source` (Markdown block and source offsets, or TXT offsets). |
| `element`  | Up to four `selectors` (primary first), `tagName`, a text `fingerprint` and an optional `rect` as a visual hint.                                                                                        |

The bridge polls the route every 500 ms to tell the viewer, and also reads it whenever it creates a target or resolves markers, so a selection made right after a client-side router moves records the route the page is on, not the one the last poll saw.

`contentHash` is `contentHash()` from `packages/anchors`: SHA-256 of the UTF-8 normalized text. The bridge sets it from the page's text when it creates a target, sets `renderer` (`portifact-render@<version>`) only on pages Portifact rendered, and does not fill `source` yet.

## Normalization and offsets

Quotes, context, fingerprints and positions refer to normalized text:

- Every run of whitespace or control characters is one U+0020 space, with no leading or trailing space. CRLF, CR and LF are equal.
- Each base character with its combining marks (and Hangul jamo) is normalized to NFC; lone surrogates become U+FFFD. NFC can turn one UTF-16 unit into up to three code points.
- Offsets count Unicode code points, never UTF-16 units. `NormalizedText` and `AnchorDocument` convert from DOM offsets.

In a DOM, the text is that of the root (normally `document.body`) in document order, skipping `script`, `style`, `noscript`, `template`, form controls, embedded content, `[hidden]` and `[data-portifact-ignore]` (the review UI marks its own elements with it). Block elements and `br` separate text as a space. Form values, cookies, storage and computed styles are never read.

## Confidence

| Result     | Text                                                                                                                                                                     | Element                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `exact`    | The quote is at the recorded position with its full context.                                                                                                             | A selector finds one element with the recorded tag and fingerprint.                               |
| `fuzzy`    | The quote elsewhere with the best context, or an approximate match (up to 20% edits, quotes of 8 or more code points) within 2,048 code points of the recorded position. | Only one element has the tag and fingerprint, or a selector finds one element whose text changed. |
| `orphaned` | `not_found`, or `ambiguous` when a tie remains after the recorded position and the DOM hint.                                                                             | `not_found` or `ambiguous`. Selectors that find several elements are never trusted.               |

A target recorded on another SPA route resolves as `orphaned` with `route_mismatch`. An orphaned thread keeps its quote and shows as "without location". Automatic re-anchoring across versions is out of scope for now: resolution only reports where the anchor is in the document it is given.

## Untrusted input

Targets arrive from the bridge and from API, CLI and MCP clients. `AnnotationTarget` refuses unknown keys, caps every field (1,024-code-point quotes, 32-code-point context, 128-code-point fingerprints, 8 KiB serialized) and requires normalized text. Selectors follow a restricted grammar (`isSafeSelector`): type, `#id`, `.class`, a few stable test attributes with quoted values and `:nth-of-type(n)`, joined by descendant or child combinators, at most 512 characters and 32 compounds. It cannot hold escapes, functions, braces, at-rules or markup. Routes are same-origin paths. Quotes are plain data and are always rendered escaped. When a thread is created, the server also checks that `path` is a published file of the version.

## Testing

`packages/anchors` runs its DOM tests against happy-dom, and `type-tests/dom.ts` compiles against the browser's DOM types (`tsconfig.dom.json`, part of the package's `typecheck`) to prove real nodes and `Selection` ranges satisfy the structural types without casts. Property-based tests cover normalization (idempotent, NFC, mapping back to raw offsets), create-then-resolve round trips over random text and random HTML, and safe, unique element selectors. In real browsers, `e2e/tests/spa-selection.spec.ts` reviews a client-rendered app with a hash router and no dependencies: it selects text and picks an element the script created, checks the stored targets and their route, sees both threads become "without location" on another route and found again once the home view is rendered from new nodes with shifted offsets.
