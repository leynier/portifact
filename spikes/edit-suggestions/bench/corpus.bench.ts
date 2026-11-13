// The full corpora the record quotes: random Markdown edits (60 documents, 25 edits each) and typo
// probes (40 documents per kind). Run with `bun run --cwd spikes/edit-suggestions bench`.
import { describe, expect, it } from "vitest";
import { HOSTILE_AFTERS, PLAIN_AFTERS } from "../test/corpus.ts";
import { runCorpus } from "../test/markdown-corpus.ts";
import { measure } from "../test/usability-probes.ts";

describe("full corpora", () => {
  it("random Markdown edits", () => {
    const plain = runCorpus(60, 25, PLAIN_AFTERS, 7);
    const hostile = runCorpus(60, 25, HOSTILE_AFTERS, 11);
    console.log("markdown plain", JSON.stringify(plain));
    console.log("markdown hostile", JSON.stringify(hostile));
    expect(plain.edits).toBeGreaterThan(1_200);
  });

  it("typo probes", () => {
    const results = measure(40);
    console.log("usability", JSON.stringify(results));
    expect(results.text.probes).toBeGreaterThan(300);
  });
});
