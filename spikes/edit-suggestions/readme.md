# Edit suggestions spike

Spike for [decision 0027](../../docs/decisions/0027-edit-suggestions.md): can Portifact turn a reviewer's edit of a rendered page into an edit of one source file with certainty, write untrusted text into that file without adding markup, keep style changes inert, and keep a hostile page from making a reviewer save a suggestion they did not write?

It runs in Node with happy-dom and the real `@portifact/render`, `@portifact/anchors`, `@portifact/contracts` and `@portifact/bridge`. No Cloudflare resource is used.

- `src/page.ts`: parsing without scripts, the page text (`AnchorDocument`, as the bridge builds it) and the markup skeleton (every element and attribute, the content of scripts and styles, but no text).
- `src/edit.ts`: the text edit the resolvers receive and the part of it that really changes.
- `src/markdown-resolver.ts`: Markdown through the block map: the changed text with its rendered context must occur once in the block's source; the new text is escaped; the candidate is certain only when re-rendering it gives the expected page text and an identical skeleton.
- `src/text-resolver.ts`: plain text through the normalization map.
- `src/html-resolver.ts`: static HTML: the live page text must hash to the text of the file parsed without scripts, the changed text with its context must occur once in the whole file, it is written HTML-escaped and verified by parsing again.
- `src/style.ts`: the style allowlist, whole-string grammars per property.
- `src/operations.ts`: the edit model as strict schemas: text, style and structure operations over the existing anchor targets, with caps.
- `src/edit-session.ts`: the viewer's edit mode as a state machine over the real bridge channel checks (`readBridgeMessage`).
- `test/corpus.ts`: a seeded corpus of Markdown documents (headings, lists, nested lists, task lists, tables, fenced code, inline code, emphasis, strikethrough, links, autolinks, entities, repeated sentences, footnotes, soft line breaks, CJK and emoji) and of edits (whole-word selections, mostly short, some long enough to cross formatting and blocks), with plain and hostile replacement text.

Run from the repository root:

```bash
bun run spike:edit-suggestions
```

It is also part of `bun run test`. This code is never deployed or imported by apps and packages.

## Results

Measured on 2026-11-12 (the tests print these lines):

| Corpus                             | Edits | Certain       | Not certain, by reason                                                                                                                                         | Wrong edits applied |
| ---------------------------------- | ----- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Markdown, plain replacement text   | 1,499 | 1,185 (79.1%) | 151 across blocks, 140 not found once, 23 would change the page                                                                                                | 0                   |
| Markdown, hostile replacement text | 1,500 | 1,207 (80.5%) | 143 across blocks, 129 not found once, 21 would change the page                                                                                                | 0                   |
| Plain text, plain and hostile text | 1,000 | 1,000 (100%)  | none                                                                                                                                                           | 0                   |
| Static HTML, 11 pages              | 44    | 34            | 2 written or changed by a script, 4 with a copy in an attribute, a script, a comment or a repeated paragraph, 2 across markup or an entity, 2 stale or invalid | 0                   |
| Style allowlist, hostile values    | 57    | 0 accepted    | 57 refused                                                                                                                                                     |                     |

Within one block (leaving out the edits that cross blocks), 88% of Markdown edits are certain. Every certain Markdown edit was checked by an oracle written apart from the resolver: the new source rendered as a whole published document, its page text compared by hash with the expected page, its HTML compared with every text run removed, and the change confined to one block of the old block map. A 318 KB document (2,000 blocks) resolves in about 0.6 seconds, three renders of the whole document.

Every hostile replacement that resolved was written as text: `**bold**` becomes `\*\*bold\*\*`, a bare URL is escaped so linkify does not see it, `|` in a table cell becomes `\|`. In static HTML all 29 hostile texts applied and none added an element or attribute.

## What the spike does not prove

- Real browsers. The live page text in the HTML tests is computed by running each page's script as a function on the parsed DOM, not by a browser running it; happy-dom never runs the scripts here. The production bridge sends the page text's hash, which the e2e suite must cover.
- The production HTML parser. The spike parses with happy-dom; the design uses parse5 with source locations in the Worker. Its behavior on malformed HTML must be tested again.
- Documents of 5 MB. Resolution time is measured at 318 KB and grows with the number of renders; the design bounds renders per acceptance and runs them in the jobs Worker.
- Carrying suggestions to a new version and closing change items by themselves. Both reuse the anchors' resolution, which `packages/anchors` already tests, but the spike does not test them end to end.
- D1, R2 and the publish path. The new version is produced by the existing services (as a rollback is); the spike stops at the new source.
- The viewer's UI, focus, announcements and touch behavior, and the bridge's preview. The edit session proves only the state machine and the message checks.
