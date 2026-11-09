// A reviewed rendering of every construct. If this snapshot changes, annotation anchors made on
// older renderings may no longer match: bump RENDERER_VERSION in the same change.
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown.ts";
import { renderText } from "./text.ts";
import { RENDERER_VERSION } from "./version.ts";

const SAMPLE = `# Release notes

Intro with *emphasis*, **strong**, ~~strike~~, \`code\`, a [link](https://example.com "Example"),
a [relative link](guide.md#setup), www.example.com and an <b>inline tag</b>.

## Checklist

- [x] Ship the renderer
- [ ] Wire delivery
  1. nested
  2. ordered

> A quote with a footnote[^1].

| Name | Size |
|:-----|-----:|
| a.md | 12 |

![Diagram](diagram.png) ![Remote](https://cdn.example/r.png)

\`\`\`ts
// The answer
const answer: number = 42;
\`\`\`

\`\`\`mermaid
flowchart LR
  A[Write] --> B{Review}
\`\`\`

---

[^1]: The footnote.
`;

describe("golden output", () => {
  it(`is stable for renderer version ${RENDERER_VERSION}`, () => {
    const { html, blocks, headings, diagrams } = renderMarkdown(SAMPLE);
    expect(headings.map((h) => h.id)).toEqual(["release-notes", "checklist"]);
    expect(blocks).toHaveLength(18);
    expect(diagrams).toBe(1);
    expect({ html, blocks }).toMatchSnapshot();
    expect(renderText("\n<b>&</b>\n").html).toMatchSnapshot();
  });
});
