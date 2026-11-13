// The counterexamples of the second review of pull request #252 (at ad805440), one test each,
// written against the code as it stood so they fail first. Names are the review's findings.
import { DraftEdit, Envelope, PLAN_LIMITS } from "@portifact/contracts";
import { describe, expect, it, vi } from "vitest";
import { check } from "../testing/suggestions/checker.ts";
import {
  bodyText,
  edit,
  editAt,
  PAGE_URL,
  plan,
  planOne,
  RENDERER,
  textOperation,
} from "../testing/suggestions/harness.ts";
import { DELETED_ACCOUNT, presentEnvelope } from "./envelope.ts";
import { buildPlan, confirmPlan } from "./plan.ts";
import { buildPreview, withoutMotion } from "./preview.ts";
import { newWork } from "./work.ts";

describe("second review of #252", () => {
  it("R1: a Markdown candidate found only in a destination, a title or an image is not a location", async () => {
    for (const source of [
      "[ne&#101;dle](/needle)",
      '[ne&#101;dle](/x "needle")',
      "![ne&#101;dle](/needle.png) and ne&#101;dle",
    ]) {
      const built = await plan("markdown", source, [
        await edit("markdown", source, "needle", "fixed"),
      ]);
      const [item] = [...built.applied, ...built.listed];
      expect(item?.status, source).toBe("listed");
      expect(item?.location, source).toEqual({ unresolved: true });
      expect(item?.context, source).toBeNull();
    }
    // A heading is mapped through its rendered text, so it keeps its place though it is listed.
    const heading = "# Title\n\nBody.";
    const listed = (
      await plan("markdown", heading, [await edit("markdown", heading, "Title", "Name")])
    ).listed[0];
    expect(listed).toMatchObject({
      reason: "would_change_page",
      location: { unit: "utf16", start: 2, end: 6 },
    });
  });

  it("R2: a linked image inside the range is a destination, and only an HTML base counts", async () => {
    const image =
      '<!doctype html><p>Read <a href="/pay"><img src="/x" alt="picture"></a> terms</p>';
    const built = await plan("html", image, [editAt(bodyText(image), "Read terms", "Read rules")]);
    expect(built.listed[0]?.destinations.map((link) => link.authored)).toContain("/pay");
    const svgBase =
      '<!doctype html><svg><base href="https://evil.example/"></base></svg><p><a href="/pay">Pay now</a></p>';
    const based = await plan("html", svgBase, [editAt(bodyText(svgBase), "Pay", "Send")]);
    expect([...based.applied, ...based.listed][0]?.destinations[0]?.effective).toBe(
      new URL("/pay", PAGE_URL).href,
    );
  });

  it("R4: motion is removed whatever the escapes in its property name", () => {
    for (const [css, kept] of [
      [String.raw`\61 nimation:spin 1s infinite!important;color:red`, "color:red"],
      [String.raw`anim\61 tion-name:spin;color:red`, "color:red"],
      [String.raw`-webkit-\74 ransition:all 1s;color:red`, "color:red"],
      [String.raw`\2d webkit-animation:spin 1s;color:red`, "color:red"],
    ] as const) {
      expect(withoutMotion(css, "declarationList"), css).toBe(kept);
    }
    expect(
      withoutMotion(String.raw`@media all{p{\61 nimation-duration:1s;color:red}}`, "stylesheet"),
    ).toBe("@media all{p{color:red}}");
  });

  it("R5: an edit whose result passes the size limit is listed, never offered as applied", async () => {
    const source = `${"a".repeat(1_999_997)} x`;
    const built = await plan("text", source, [
      { start: 1_999_998, end: 1_999_999, before: "x", after: "longer" },
    ]);
    expect(built.applied).toEqual([]);
    expect(built.listed[0]?.reason).toBe("too_large");
    expect(built.newSource).toBeUndefined();
    expect(
      await confirmPlan({
        plan: built,
        confirmedDigest: built.digest,
        current: built.binding,
        newSource: built.newSource,
        renderer: RENDERER,
      }),
    ).toBe("confirmed");
    const html = `<!doctype html><p>${"a".repeat(1_048_552)} x</p>`;
    const page = await plan("html", html, [editAt(bodyText(html), "x", "longer")]);
    expect(page.listed[0]?.reason).toBe("too_large");
  });

  it("R6: the checker refuses an entity respelled outside the selected text", async () => {
    const source =
      "<!doctype html><html><head><title>t</title></head><body><p>cat &amp; mouse</p></body></html>";
    const next = source.replace("cat", "dog").replace("&amp;", "&#38;");
    expect(
      await check("html", source, next, await edit("html", source, "cat", "dog"), {
        start: source.indexOf("cat"),
        end: source.indexOf(";") + 1,
        replacement: "dog &#38;",
      }),
    ).not.toBeNull();
  });

  it("R7: an oversized plan is refused before either hash runs", async () => {
    const pad = "​".repeat(120);
    const text = Array.from({ length: 100 }, (_, i) => `${pad}w${i}x${pad}`).join(" ");
    const source = `<!doctype html><body data-note="${"a".repeat(17_000)}"><p>${text}</p></body>`;
    const operations = Array.from({ length: 100 }, (_, i) =>
      textOperation(editAt(bodyText(source), `w${i}x`, `${"​".repeat(300)}fixed`), "index.html"),
    );
    expect(DraftEdit.safeParse({ operations }).success).toBe(true);
    const digest = vi.spyOn(crypto.subtle, "digest");
    const work = newWork();
    try {
      await expect(
        buildPlan({
          kind: "html",
          source,
          operations,
          pageUrl: PAGE_URL,
          renderer: RENDERER,
          binding: {
            artifactId: "a",
            versionId: "v",
            path: "index.html",
            fileSha256: "0".repeat(64),
            renderer: RENDERER.label,
            subject: "s",
            revision: 1,
          },
          people: { submitter: true, acceptor: true },
          work,
        }),
      ).rejects.toThrow("over its limit");
      expect(digest).not.toHaveBeenCalled();
      expect(work.hashes).toBe(0);
    } finally {
      digest.mockRestore();
    }
    // Within the limits, identity evidence is hashed once per element and page.
    const small = `<!doctype html><body data-note="${"a".repeat(100)}"><p>one two three</p></body>`;
    const counted = newWork();
    await plan(
      "html",
      small,
      ["one", "three"].map((word) => editAt(bodyText(small), word, "x")),
      { work: counted },
    );
    expect(counted.hashes).toBe(1);
  });

  it("R8: deeply nested CSS gives an unavailable preview, never an error or the original CSS", () => {
    const css = `${"@media all{".repeat(1_000)}p{animation:spin 1s!important}${"}".repeat(1_000)}`;
    const preview = buildPreview(
      "html",
      `<html><head><style>${css}</style></head><body><p>x</p></body></html>`,
      RENDERER,
    );
    expect(preview).toEqual({ state: "unavailable", reason: "css_too_complex" });
    const inline = buildPreview("html", `<p style="${"x:(".repeat(1_000)}">x</p>`, RENDERER);
    expect(inline).toEqual({ state: "unavailable", reason: "css_too_complex" });
  });

  it("R9: a page over the node budget is refused with no index and no mapping", async () => {
    const source = `<!doctype html><p>needle</p>${"<b>x</b>".repeat(25_001)}`;
    const work = newWork();
    const planned = await planOne(
      "html",
      source,
      [{ start: 0, end: 6, before: "needle", after: "fixed" }],
      work,
    );
    expect(planned.listed[0]?.reason).toBe("too_large");
    expect(work).toMatchObject({ parses: 1, indexes: 0, maps: 0 });
  });

  it("N2: a shortened destination always shows its origin whole", async () => {
    const long = `https://${"a".repeat(9_000)}@evil.example/${"p".repeat(200)}`;
    const html = `<!doctype html><p><a href="${long}">go</a> now</p>`;
    const built = await plan("html", html, [editAt(bodyText(html), "go", "run")]);
    const [link] = built.applied[0]?.destinations ?? [];
    expect(link?.origin).toBe("https://evil.example");
    expect(link?.effectiveOmitted).toBeGreaterThan(0);
    expect(built.lines.join("\n")).toContain("https://evil.example");
    const broken = `<!doctype html><html><head></head><body><p><a href="http://[">go</a> now</p></body></html>`;
    const unresolved = await plan("html", broken, [editAt(bodyText(broken), "go", "run")]);
    expect([...unresolved.applied, ...unresolved.listed][0]?.destinations[0]?.origin).toBe(
      "could not be parsed",
    );
  });

  it("mutants: counted decoding, longhands, a known-gone person and the people flags in the digest", async () => {
    const work = newWork();
    const html = "<!doctype html><p>caf&#233; &amp; caf&#233; tea</p>";
    await planOne("html", html, [editAt(bodyText(html), "tea", "milk")], work);
    expect(work.decodes).toBe(2);
    for (const name of [
      "animation-name",
      "animation-duration",
      "transition-property",
      "transition-delay",
    ]) {
      expect(withoutMotion(`${name}:x;color:red`, "declarationList"), name).toBe("color:red");
    }
    const source = "One cat sat.";
    const built = await plan("markdown", source, [await edit("markdown", source, "cat", "dog")]);
    const core = Envelope.parse(built.applied[0]);
    const gone = presentEnvelope(
      { ...core, people: { submitter: false, acceptor: true } },
      {
        submittedBy: "Stale Name",
        acceptedBy: "Owner",
      },
    );
    expect(gone.provenance.submittedBy).toBe(DELETED_ACCOUNT);
    expect(PLAN_LIMITS.proofBytes).toBeGreaterThan(0);
  });
});

/** Every leaf of a value, with a copy of the value where only that leaf changed. */
function leafChanges(value: unknown, path: string[] = []): { path: string; changed: unknown }[] {
  const set = (target: unknown, at: string[], leaf: unknown): unknown => {
    if (at.length === 0) return leaf;
    const [head, ...rest] = at as [string, ...string[]];
    if (Array.isArray(target)) {
      const copy = [...target];
      copy[Number(head)] = set(copy[Number(head)], rest, leaf);
      return copy;
    }
    const record = target as Record<string, unknown>;
    return { ...record, [head]: set(record[head], rest, leaf) };
  };
  const walk = (current: unknown, at: string[]): { at: string[]; leaf: unknown }[] => {
    if (current !== null && typeof current === "object") {
      return Object.entries(current).flatMap(([key, inner]) => walk(inner, [...at, key]));
    }
    const leaf =
      typeof current === "string"
        ? `${current}x`
        : typeof current === "number"
          ? current + 1
          : typeof current === "boolean"
            ? !current
            : "x";
    return [{ at, leaf }];
  };
  return walk(value, path).map(({ at, leaf }) => ({
    path: at.join("."),
    changed: set(value, at, leaf),
  }));
}

describe("the digest covers every field (second review, mutant 16)", () => {
  it("changes when any leaf of the contents changes, people flags included", async () => {
    const { planDigest } = await import("./plan.ts");
    const html = '<!doctype html><p><a href="/pay">Pay now</a> and <b>later</b> today</p><p>ok</p>';
    const built = await plan("html", html, [
      {
        ...textOperation(editAt(bodyText(html), "ok", "fine"), "index.html"),
        target: {
          ...textOperation(editAt(bodyText(html), "ok", "fine"), "index.html").target,
          route: "/r",
        },
      },
      {
        ...textOperation(editAt(bodyText(html), "now and", "x"), "index.html"),
        target: {
          ...textOperation(editAt(bodyText(html), "now and", "x"), "index.html").target,
          route: "/r",
        },
      },
    ] as never);
    const {
      digest: _digest,
      newSource: _source,
      proofs: _proofs,
      operations: _operations,
      work: _work,
      ...contents
    } = built;
    expect(built.applied.length).toBeGreaterThan(0);
    expect(built.listed.length).toBeGreaterThan(0);
    const base = await planDigest(contents);
    const changes = leafChanges(contents);
    const paths = changes.map((change) => change.path);
    for (const field of [
      "people.submitter",
      "people.acceptor",
      "binding.route",
      "destinationsKnown",
      "origin",
    ]) {
      expect(
        paths.some((path) => path.endsWith(field)),
        field,
      ).toBe(true);
    }
    for (const { path, changed } of changes) {
      expect(await planDigest(changed as typeof contents), path).not.toBe(base);
    }
  });
});
