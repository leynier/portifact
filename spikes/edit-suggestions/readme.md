# Edit suggestions spike

Spike for [decision 0027](../../docs/decisions/0027-edit-suggestions.md): can the server decide, from the stored files alone, that a reviewer's edit of a rendered page is exactly one change to one source file, write untrusted text into it without changing anything else, compose many edits within a budget, build previews that load nothing, carry suggestions and close change-list items with proofs on the rendered page, while the viewer keeps everything a person types away from the framed page?

It runs in Node with happy-dom, parse5 (the production parser for HTML) and the real `@portifact/render`, `@portifact/anchors`, `@portifact/contracts` and `@portifact/bridge`, plus a Playwright suite in Chromium and Firefox. No Cloudflare resource is used. It went through two design reviews of pull request #247; each review's counterexamples were committed as failing tests first and then fixed: `test/review-findings.test.ts` and `test/render-budget.test.ts` (first review, 12 of 13 failing), `test/review-findings-2.test.ts` (second review, 20 of 20 failing).

- `src/html-dom.ts`, `src/html-subset.ts`: parse5 with source locations and scripting enabled, an adapter giving `packages/anchors` its DOM surface, and the positive HTML subset.
- `src/html-resolver.ts`, `src/markdown-resolver.ts`, `src/text-resolver.ts`: the three planners: one parse and one anchor index per plan, base coordinates, exact source mapping (HTML through text node locations and whole character references), one combined patch, one verification, budgets.
- `src/locate.ts`, `src/page.ts`, `src/planned.ts`: locating through the anchors, the happy-dom comparison, persisted proof data, and the byte check outside approved ranges.
- `src/plan.ts`, `src/envelope.ts`, `src/display.ts`: the plan (verified renderer baseline, output hashes, content digest), the canonical envelope rendered into the confirmation, and the typed display.
- `src/preview.ts`: previews built from a parsed tree under one policy, and the preview origin's headers.
- `src/relocate.ts`, `src/closure.ts`, `src/rendered.ts`: carrying suggestions and closing items on the rendered page, with target identity.
- `src/acceptance.ts`: the acceptance claim as one SQLite transaction.
- `src/style.ts`, `src/operations.ts`, `src/edit-session.ts`: the style allowlist, the edit model and the viewer's edit session.
- `test/corpus.ts`: the seeded corpus of Markdown documents and edits.
- `browser/differential.spec.ts`: parse5 against Chromium and Firefox for the raw-text, template, foreign-content and recovery contexts, and built previews loading nothing.

Run from the repository root:

```bash
bun run spike:edit-suggestions                      # unit tests, also part of `bun run test`
bun run --cwd spikes/edit-suggestions browser       # the browser suite, not part of `bun run test`
```

This code is never deployed or imported by apps and packages.

## Results

Measured on 2026-11-12: 114 unit tests and 22 browser tests pass (the unit tests print these lines).

| Corpus                               | Probes                 | Certain       | Not certain, by reason                                                               |
| ------------------------------------ | ---------------------- | ------------- | ------------------------------------------------------------------------------------ |
| Markdown, random edits, plain text   | 1,500                  | 1,064 (70.9%) | 348 not in one text node, 38 not found once, 29 would change the page, 21 whitespace |
| Markdown, random edits, hostile text | 1,500                  | 1,095 (73.0%) | 330, 33, 26, 16                                                                      |
| Plain text, random edits             | 1,000                  | 827 (82.7%)   | 173 whitespace                                                                       |
| Typo fixes, Markdown                 | 399                    | 375 (94.0%)   | 17 would change the page, 7 not found once                                           |
| Typo fixes, plain text               | 400                    | 400           | none                                                                                 |
| Typo fixes, HTML subset pages        | 399                    | 399           | none                                                                                 |
| Style allowlist                      | 76 hostile, 17 allowed | 17 accepted   | 76 refused                                                                           |

Planning budgets (Node wall clock on one machine): Markdown 1.85 MB with 1, 20 and 100 operations 1.5, 1.5 and 2.1 s; HTML 1.0 MB 2.2, 2.2 and 2.7 s; plain text 1.84 MB with 100 operations 1.3 s; carrying 200 suggestions of a 1.85 MB Markdown file 2.3 s.

Every certain edit passed a checker written apart from the planners: unchanged bytes outside the approved range, text nodes at their DOM paths read by a second parser, IDs and references compared by a regular expression, markup with only text removed, and the raw text at the reviewer's location. Mutation tests show the checker refuses a wrong repeated occurrence, a hidden comment change and an offset mistake. The claim covers exactly these invariants on these corpora.

## What the spike does not prove

- WebKit, and malformed HTML beyond the tokenizer recovery the subset refuses.
- The preview host and its one-use codes in the content Worker; the viewer's UI.
- Workers CPU: the budgets are Node wall-clock times.
- D1 and R2: the publish path, pending objects and recovery; the acceptance claim ran on SQLite outside D1's batch API.
- Representative real documents: the corpora are synthetic.
- Visual safety of styles, and the live presentation of a page.
