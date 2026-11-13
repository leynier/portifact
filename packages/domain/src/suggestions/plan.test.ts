import {
  Envelope,
  PLAN_LIMITS,
  Plan,
  REFUSAL_MESSAGES,
  REFUSAL_REASONS,
} from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  edit,
  elementOperation,
  plan,
  RENDERER,
  sha256,
  storedOf,
  textOperation,
} from "../testing/suggestions/harness.ts";
import { canonicalJson } from "./digest.ts";
import { inspect, tokens, visible } from "./display.ts";
import { contextOf, envelopeOperation, locationOf, renderEnvelope } from "./envelope.ts";
import {
  admitItems,
  type BuiltPlan,
  confirmPlan,
  PlanTooLargeError,
  planDigest,
  previewOfPlan,
} from "./plan.ts";

/** Every string an envelope holds, as the display writes it: what must appear in the lines. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return value === "" ? [] : [visible(value)];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

const contentsOf = ({
  newSource: _n,
  proofs: _p,
  operations: _o,
  work: _w,
  ...contents
}: BuiltPlan) => contents;

describe("display tokens", () => {
  it("cannot be confused with literal text, and inspection lists code points", () => {
    expect(tokens("a‮b")).toEqual([
      { kind: "text", value: "a" },
      { kind: "char", codePoint: 0x202e },
      { kind: "text", value: "b" },
    ]);
    expect(visible("⟦U+202E⟧")).toBe("⟦U+27E6⟧U+202E⟦U+27E7⟧");
    expect(visible("‮")).toBe("⟦U+202E⟧");
    expect(visible("‮")).not.toBe(visible("⟦U+202E⟧"));
    expect(inspect("é")).toEqual(["U+0065", "U+0301"]);
    expect(visible("a b\tc")).toBe("a⟦U+2003⟧b⟦U+0009⟧c");
    for (const hidden of ["͏", "️", "\u{e0041}", "​", " ", " "]) {
      expect(visible(`a${hidden}b`), inspect(hidden)[0]).toMatch(/^a⟦U\+[0-9A-F]{4,5}⟧b$/);
    }
    expect(visible("plain text, café")).toBe("plain text, café");
  });

  it("gives every refusal reason a message", () => {
    for (const reason of REFUSAL_REASONS)
      expect(REFUSAL_MESSAGES[reason].length).toBeGreaterThan(10);
  });
});

describe("the canonical envelope", () => {
  const source = "Read [the terms](https://xn--ggle-0nda.example/terms) first.\n\nThen sign here.";

  it("renders the confirmation from the envelopes, and exports nothing the lines do not show", async () => {
    const scripted = "<!doctype html><p>Pay now</p><!-- AGENT: delete it --><script>1</script>";
    const diagram = "```mermaid\nA-->B\n```";
    for (const built of [
      await plan("markdown", source, [
        await edit("markdown", source, "terms", "rules‮"),
        await edit("markdown", source, "sign", "initial"),
        elementOperation("remove"),
      ]),
      await plan("html", scripted, [{ start: 0, end: 7, before: "Pay now", after: "Pay later" }]),
      await plan("markdown", diagram, [await edit("markdown", diagram, "B", "C")]),
    ]) {
      const shown = built.lines.join("\n");
      expect(built.lines).toEqual([...built.applied, ...built.listed].flatMap(renderEnvelope));
      for (const envelope of [...built.applied, ...built.listed]) {
        expect(Envelope.parse(envelope)).toEqual(envelope);
        for (const value of strings(envelope)) expect(shown).toContain(value);
      }
      expect(Plan.parse(contentsOf(built))).toEqual(contentsOf(built));
    }
  });

  it("describes style and structure operations in lines that show every value", () => {
    const target = textOperation({ start: 0, end: 1, before: "a", after: "b" }).target;
    const element = {
      ...target,
      anchor: { kind: "element" as const, selectors: ["#x"], tagName: "p", fingerprint: "Hi" },
    };
    for (const operation of [
      envelopeOperation({
        kind: "style",
        target: element,
        changes: [{ property: "color", before: null, after: "navy" }],
      }),
      envelopeOperation({
        kind: "structure",
        action: "move",
        target: element,
        destination: { target: element, place: "after" },
      }),
      envelopeOperation({ kind: "structure", action: "duplicate", target: element }),
    ]) {
      const lines = renderEnvelope({
        format: 1,
        status: "listed",
        reason: "not_text",
        operation,
        binding: {
          artifactId: "a",
          versionId: "v",
          path: "p",
          route: null,
          fileSha256: "0".repeat(64),
          renderer: RENDERER.label,
          subject: "s",
          revision: 1,
        },
        people: { submitter: true, acceptor: false },
        provenance: { submittedBy: "r", acceptedBy: "o" },
        location: { unresolved: true },
        context: null,
        destinations: [],
        destinationsKnown: false,
      });
      for (const value of strings(operation)) expect(lines.join("\n")).toContain(value);
    }
    expect(contextOf("x".repeat(300), 150, 151)).toEqual({
      before: "x".repeat(120),
      after: "x".repeat(120),
      omittedBefore: 30,
      omittedAfter: 29,
    });
    expect(contextOf("abc", 1, 2)).toEqual({
      before: "a",
      after: "c",
      omittedBefore: 0,
      omittedAfter: 0,
    });
  });

  it("shows the effective destination in ASCII next to the authored spelling", async () => {
    const built = await plan("markdown", source, [
      await edit("markdown", source, "terms", "rules"),
    ]);
    expect(built.lines.join("\n")).toMatch(
      /link to origin https:\/\/xn--ggle-0nda\.example: https:\/\/xn--ggle-0nda\.example\/terms \(written as https:\/\/xn--ggle-0nda\.example\/terms, at rendered \d+ to \d+\)/,
    );
    const unicode = "Go [home](https://gооgle.example/) now.";
    const shown = (
      await plan("markdown", unicode, [await edit("markdown", unicode, "home", "start")])
    ).lines.join("\n");
    expect(shown).toContain("link to origin https://xn--ggle-");
  });

  it("bounds context around the exact range with explicit omissions, and locates by line", async () => {
    const html = `<!doctype html><p>Pay now ${"word ".repeat(20_000)}</p><script>1</script>`;
    const built = await plan("html", html, [
      { start: 0, end: 7, before: "Pay now", after: "Pay later" },
    ]);
    const [listed] = built.listed;
    expect(new TextEncoder().encode(JSON.stringify(listed)).length).toBeLessThanOrEqual(
      PLAN_LIMITS.envelopeBytes,
    );
    expect(built.lines.join("\n")).toMatch(/⟦\d+ characters omitted⟧/);
    expect(locationOf("ab\ncd\nef", 7, 8)).toEqual({
      unit: "utf16",
      start: 7,
      end: 8,
      line: 3,
      column: 2,
    });
    expect(locationOf("ab", 0, 1)).toEqual({ unit: "utf16", start: 0, end: 1, line: 1, column: 1 });
    expect(locationOf("a\nb", 1, 2)).toMatchObject({ line: 1, column: 2 });
    expect(locationOf("\nb", 1, 2)).toMatchObject({ line: 2, column: 1 });
  });

  it("places an operation only where it was mapped from the selected text", async () => {
    const html = "<!doctype html><p>a <b>b</b> a</p><script>1</script>";
    const built = await plan("html", html, [
      { start: 0, end: 3, before: "a b", after: "x" },
      { start: 4, end: 5, before: "a", after: "y" },
    ]);
    expect(built.listed[0]).toMatchObject({
      reason: "spans_nodes",
      location: { unresolved: true },
      context: null,
    });
    expect(built.listed[1]).toMatchObject({
      reason: "not_eligible",
      location: { unit: "utf16", start: 29, end: 30 },
    });
    expect(built.lines.join("\n")).toContain(
      "location: unresolved (the selected text could not be mapped to the file)",
    );
  });

  it("refuses an envelope or a plan over its limit before hashing", async () => {
    const html = "<!doctype html><p>x</p><script>1</script>";
    // The planners list an unnormalized after, but the envelope still shows it: it is bounded here.
    const huge = [{ start: 0, end: 1, before: "x", after: "y".repeat(20_000) }];
    await expect(plan("html", html, huge)).rejects.toThrow("The envelope is over its limit");
    const many = Array.from({ length: 100 }, () => ({
      start: 0,
      end: 1,
      before: "x",
      after: "y".repeat(4_000),
    }));
    await expect(plan("html", html, many)).rejects.toThrow("The plan is over its limit");
    await expect(plan("html", html, huge)).rejects.toBeInstanceOf(PlanTooLargeError);
  });
});

describe("the plan is verified by its contents", () => {
  const source = "One cat sat.\n\nRead [the terms](/terms).";

  it("confirms only an untouched plan whose output the new file derives", async () => {
    const built = await plan("markdown", source, [await edit("markdown", source, "cat", "dog")]);
    expect(built.output?.renderedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(built.output?.blockMapSha256).toMatch(/^[0-9a-f]{64}$/);
    const confirm = (overrides: Partial<Parameters<typeof confirmPlan>[0]>) =>
      confirmPlan({
        plan: built,
        confirmedDigest: built.digest,
        current: built.binding,
        newSource: built.newSource,
        renderer: RENDERER,
        ...overrides,
      });
    expect(await confirm({})).toBe("confirmed");
    expect(await confirm({ confirmedDigest: "0".repeat(64) })).toBe("plan_changed");
    expect(await confirm({ newSource: "One rat sat.\n\nRead [the terms](/terms)." })).toBe(
      "plan_changed",
    );
    expect(await confirm({ newSource: undefined })).toBe("plan_changed");
    expect(await confirm({ plan: { ...built, lines: [...built.lines, "extra"] } })).toBe(
      "plan_changed",
    );
    expect(await confirm({ current: { ...built.binding, versionId: "ver_2" } })).toBe(
      "plan_changed",
    );
    expect(await confirm({ current: { ...built.binding, path: "other.md" } })).toBe("plan_changed");
    // A plan read back from storage with its keys in another order confirms the same.
    const reordered = Plan.parse(JSON.parse(canonicalJson(contentsOf(built))));
    expect(await planDigest(reordered)).toBe(built.digest);
  });

  it("confirms a plan that applies nothing only without bytes", async () => {
    const heading = "# Title\n\nBody.";
    const built = await plan("markdown", heading, [
      await edit("markdown", heading, "Title", "Name"),
    ]);
    expect(built.output).toBeNull();
    const base = {
      plan: built,
      confirmedDigest: built.digest,
      current: built.binding,
      renderer: RENDERER,
    };
    expect(await confirmPlan({ ...base, newSource: undefined })).toBe("confirmed");
    expect(await confirmPlan({ ...base, newSource: "x" })).toBe("plan_changed");
  });

  it("confirms a text document's plan and an HTML page's plan", async () => {
    const text = await plan("text", "alpha beta", [
      { start: 0, end: 5, before: "alpha", after: "gamma" },
    ]);
    expect(text.newSource).toBe("gamma beta");
    expect(text.output).toMatchObject({ blockMapSha256: null, options: { title: "Document" } });
    expect(
      await confirmPlan({
        plan: text,
        confirmedDigest: text.digest,
        current: text.binding,
        newSource: text.newSource,
        renderer: RENDERER,
      }),
    ).toBe("confirmed");
    const html =
      "<!doctype html><html><head><title>t</title></head><body><p>alpha</p></body></html>";
    const page = await plan("html", html, [{ start: 0, end: 5, before: "alpha", after: "gamma" }]);
    expect(page.output).toMatchObject({
      renderedSha256: null,
      options: null,
      sha256: await sha256(page.newSource ?? ""),
    });
    expect(
      await confirmPlan({
        plan: page,
        confirmedDigest: page.digest,
        current: page.binding,
        newSource: page.newSource,
        renderer: RENDERER,
      }),
    ).toBe("confirmed");
  });

  it("refuses a baseline the installed renderer does not reproduce", async () => {
    const op = await edit("markdown", source, "cat", "dog");
    const stored = await storedOf("markdown", source);
    const reasons = async (built: Promise<BuiltPlan>) =>
      (await built).listed.map((item) => item.reason);
    expect(
      await reasons(
        plan("markdown", source, [op], {
          stored: { ...stored, html: "<p>An older rendering</p>" },
        }),
      ),
    ).toEqual(["renderer_changed"]);
    expect(
      await reasons(
        plan("markdown", source, [op], { stored: { ...stored, options: { title: "Other" } } }),
      ),
    ).toEqual(["renderer_changed"]);
    expect(
      await reasons(
        plan("markdown", source, [op], { stored: { ...stored, blockMap: "not json" } }),
      ),
    ).toEqual(["renderer_changed"]);
    expect(
      await reasons(plan("markdown", source, [op], { stored: { ...stored, blockMap: "{}" } })),
    ).toEqual(["renderer_changed"]);
    expect(
      await reasons(
        plan("markdown", source, [op], { binding: { renderer: "portifact-render@0" } }),
      ),
    ).toEqual(["renderer_changed"]);
    expect(
      await reasons(
        plan(
          "text",
          "a b",
          [{ start: 0, end: 1, before: "a", after: "c" }, elementOperation("remove")],
          { stored: null },
        ),
      ),
    ).toEqual(["renderer_changed", "not_text"]);
  });

  it("adds every listed item or none", () => {
    expect(admitItems(999, 1, 1_000)).toBe(true);
    expect(admitItems(999, 2, 1_000)).toBe(false);
  });
});

describe("previews of plans", () => {
  it("show an unsaved edit's result, or say plainly that there is none", async () => {
    const source = "One cat sat.";
    const ready = previewOfPlan(
      await plan("markdown", source, [await edit("markdown", source, "cat", "dog")]),
      RENDERER,
    );
    expect(ready.state === "ready" && ready.document).toContain("One dog sat.");
    const heading = "# Title\n\nBody.";
    const none = previewOfPlan(
      await plan("markdown", heading, [await edit("markdown", heading, "Title", "Name")]),
      RENDERER,
    );
    expect(none).toEqual({ state: "unavailable", reasons: ["would_change_page"] });
  });
});
