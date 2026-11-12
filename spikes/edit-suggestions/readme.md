# Edit suggestions spike

Spike for [decision 0027](../../docs/decisions/0027-edit-suggestions.md): can the server decide, from the stored files alone, that a reviewer's edit of a rendered page is exactly one change to one source file, write untrusted text into it without changing anything else, compose several edits, carry suggestions across versions and close change-list items with a proof, while the viewer keeps everything a person types away from the framed page?

It runs in Node with happy-dom and the real `@portifact/render`, `@portifact/anchors`, `@portifact/contracts` and `@portifact/bridge`. No Cloudflare resource is used. It was revised after the design review of pull request #247: the review's counterexamples are `test/review-findings.test.ts` and `test/render-budget.test.ts`, committed failing first (12 of 13) and then fixed.

- `src/page.ts`: parsing without scripts, the page text (`AnchorDocument`, as the bridge builds it), the markup skeleton (every element with all its attributes, IDs and highlight spans included, and the content of scripts and styles) and the text nodes.
- `src/locate.ts`: where an edit lands (one text node, the node's raw data equal to the selection, whitespace included) and the check that a rebuilt page differs from the old one only in the changed text nodes.
- `src/markdown-resolver.ts`: the Markdown planner: base coordinates, mapping through the block map by exact raw context, escaping, one combined patch, one verification, a budget of three renders.
- `src/text-resolver.ts`, `src/html-resolver.ts`: the same for plain text and for inert HTML pages (`isInert` on the parsed file and `rawInert` on its bytes).
- `src/plan.ts`: the plan bound to artifact, version, path, file hash, renderer and suggestion revision, its digest and confirmation, visible invisible characters, link destinations, change-list envelopes, all-or-nothing capacity and inert previews.
- `src/relocate.ts`: carrying a suggestion to a new version by verified relocation.
- `src/closure.ts`: closing a change-list item by a proof, for replacements, insertions and deletions.
- `src/style.ts`: the narrower style syntax allowlist.
- `src/operations.ts`: the edit model as strict schemas: one page and route, no overlapping text operations.
- `src/edit-session.ts`: the viewer's edit mode: no typed text to the frame, frame geometry ignored while editing, a separate destination pick.
- `test/corpus.ts`: a seeded corpus of Markdown documents and edits: replacements, insertions and deletions, plain and hostile text.

Run from the repository root:

```bash
bun run spike:edit-suggestions
```

It is also part of `bun run test`. This code is never deployed or imported by apps and packages.

## Results

Measured on 2026-11-12 (the tests print these lines), 65 tests:

| Corpus                       | Edits                  | Certain                                                                               | Not certain, by reason                                                               |
| ---------------------------- | ---------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Markdown, plain text         | 1,500                  | 1,064 (70.9%): 766 of 1,089 replacements, 188 of 247 insertions, 110 of 164 deletions | 348 not in one text node, 38 not found once, 29 would change the page, 21 whitespace |
| Markdown, hostile text       | 1,500                  | 1,095 (73.0%)                                                                         | 330 not in one text node, 33 not found once, 26 would change the page, 16 whitespace |
| Plain text                   | 1,000                  | 827 (82.7%)                                                                           | 173 whitespace                                                                       |
| Inert HTML, 29 hostile texts | 29                     | 29                                                                                    | none                                                                                 |
| Style allowlist              | 76 hostile, 17 allowed | 17 accepted                                                                           | 76 refused                                                                           |

On the same Markdown corpus the first version's resolver applied 1,211 and 1,230 edits (80.7% and 82.0%); 12 and 10 of them changed a heading ID or a link target and 14 and 13 dropped a line break, tab or run of spaces. The stricter rules cost about 10 points.

Every certain Markdown edit passed an oracle written apart from the resolver: IDs and `href` values compared by a regular expression over the HTML, the HTML compared with only text runs removed, the raw text of every text node compared with the old raw text changed exactly at the reviewer's location, and the change inside one block of the old block map. The claim is only that: on this corpus no applied edit changed an ID, a reference, an element, an attribute or a character outside the edited text node.

## What the spike does not prove

- Real browsers: inert previews loading nothing, a hostile page observing the DOM during an edit, the editor's placement and accessibility.
- The production HTML parser (parse5) and parser differentials beyond the SVG script case happy-dom drops.
- Documents of 2 MB; time is measured at 318 KB.
- D1 and R2: the publish path, pending objects, recovery, capacity in one batch, the carry and closure jobs.
- Representative real documents: the corpus is synthetic.
- Visual safety of styles: the allowlist is syntax only.
