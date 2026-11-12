// Boundaries of the rules the other suggestion tests reach only through whole plans: the hash
// used for identity evidence, link context and identity, the edge rule of closure and carry, the
// plan's size limits and the confirmation's order of checks.
import { PLAN_LIMITS, type Proof } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import {
  bodyText,
  DOC_URL,
  edit,
  editAt,
  PAGE_URL,
  plan,
  planOne,
  RENDERER,
  sha256,
  TITLE,
} from "../testing/suggestions/harness.ts";
import { closure } from "./closure.ts";
import { sha256HexSync } from "./digest.ts";
import { find, type P5Element, parseHtml, textNodesOf } from "./html-dom.ts";
import { identityOf, linkContext, linksAroundAll, sameIdentity } from "./identity.ts";
import { confirmPlan } from "./plan.ts";
import { carryAll } from "./relocate.ts";
import { anchoredMatches, renderedPage } from "./rendered.ts";
import { newWork } from "./work.ts";

const parsed = (html: string) => parseHtml(html, newWork()).document;
const page = (kind: "markdown" | "text" | "html", source: string) =>
  renderedPage(kind, source, {
    title: TITLE,
    pageUrl: kind === "html" ? PAGE_URL : DOC_URL,
    renderer: RENDERER,
    work: newWork(),
  });

describe("the synchronous SHA-256 of identity evidence", () => {
  it("matches WebCrypto across block boundaries and Unicode", async () => {
    for (const text of [
      "",
      "abc",
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(64),
      "é😀".repeat(300),
    ]) {
      expect(sha256HexSync(text), String(text.length)).toBe(await sha256(text));
    }
  });
});

describe("link context and identity", () => {
  it("resolves against the first base with an href, and says when it cannot", () => {
    const context = (head: string) =>
      linkContext(
        parsed(`<!doctype html><html><head>${head}</head><body></body></html>`),
        PAGE_URL,
        "source",
      );
    expect(context("")).toEqual({ base: PAGE_URL, file: "source" });
    expect(context('<base target="_top"><base href="/sub/">').base).toBe(
      "https://k7d2qm4xab.portifact.dev/sub/",
    );
    expect(context('<base href="http://[">')).toEqual({ base: null, file: "source" });
  });

  it("reads HTML and SVG links and area destinations, each element once", () => {
    const document = parsed(
      '<!doctype html><body><a href="/a"><b>one</b> two</a><map><area href="/m"></map><svg><a xlink:href="/x"><text>s</text></a></svg></body>',
    );
    const context = linkContext(document, PAGE_URL, "source");
    const texts = textNodesOf(find(document, "body") as P5Element);
    expect(linksAroundAll(texts.slice(0, 2), context).map((link) => link.authored)).toEqual(["/a"]);
    expect(linksAroundAll(texts, context).map((link) => link.effective)).toEqual([
      "https://k7d2qm4xab.portifact.dev/a",
      "https://k7d2qm4xab.portifact.dev/x",
    ]);
    const area = find(document, "area") as P5Element;
    expect(linksAroundAll([area.childNodes[0] ?? area], context)).toEqual([]);
    const svgText = texts[2];
    expect(linksAroundAll(svgText ? [svgText] : [], context)[0]).toMatchObject({
      authored: "/x",
      at: { file: "source" },
    });
  });

  it("records the whole chain, long values by their hash, and ignores positional block numbers", () => {
    const of = (attrs: string) => {
      const document = parsed(`<!doctype html><body><p ${attrs}><a href="/go">x</a></p></body>`);
      const node = textNodesOf(find(document, "body") as P5Element)[0];
      return identityOf(node as never, linkContext(document, PAGE_URL, "source"));
    };
    const short = of(`title="${"a".repeat(64)}"`);
    const long = of(`title="${"a".repeat(65)}"`);
    expect(short[1]).toContain(`"${"a".repeat(64)}"`);
    expect(long[1]).toContain(`"sha256:${sha256HexSync("a".repeat(65))}"`);
    expect(short[0]).toBe('a[:href="/go",effective=https://k7d2qm4xab.portifact.dev/go]');
    expect(short.slice(-2)).toEqual(["body[]", "html[]"]);
    expect(of('data-pf-block="3"')).toEqual(of('data-pf-block="9"'));
    expect(sameIdentity(["a"], ["a", "b"])).toBe(false);
    expect(sameIdentity(["a", "b"], ["a", "c"])).toBe(false);
  });
});

describe("the edge rule of closure", () => {
  const nodePage = (data: string, anchored = true) => ({
    nodes: [{ data, identity: ["p[]"] }],
    anchored,
    points: [],
  });

  it("asks a short context to sit at the node's edge, and a full one anywhere", () => {
    expect(anchoredMatches(nodePage("left fell right"), "left ", "fell", " right")).toHaveLength(1);
    expect(anchoredMatches(nodePage("xx left fell right"), "left ", "fell", " right")).toEqual([]);
    expect(anchoredMatches(nodePage("left fell right xx"), "left ", "fell", " right")).toEqual([]);
    expect(
      anchoredMatches(nodePage("xx left fell right xx", false), "left ", "fell", " right"),
    ).toHaveLength(1);
    const full = "w".repeat(PLAN_LIMITS.proofContextUnits);
    expect(anchoredMatches(nodePage(`xx ${full}fell${full} xx`), full, "fell", full)).toHaveLength(
      1,
    );
    const less = "w".repeat(PLAN_LIMITS.proofContextUnits - 1);
    expect(anchoredMatches(nodePage(`xx ${less}fell${less}`), less, "fell", less)).toEqual([]);
    expect(anchoredMatches(nodePage(`${less}fell${less} xx`), less, "fell", less)).toEqual([]);
  });

  it("keeps an item open when its sentence is quoted inside a longer paragraph", async () => {
    const source = "The budget grew.";
    const proof = (
      await planOne("markdown", source, [await edit("markdown", source, "grew", "fell")])
    ).applied[0]?.proof as Proof;
    expect(closure(proof, page("markdown", "The budget fell.")).state).toBe("closed");
    expect(closure(proof, page("markdown", "He said: The budget fell.")).state).toBe("open");
    expect(closure(proof, page("markdown", "The budget fell. He said.")).state).toBe("open");
  });
});

describe("the edge rule and ranges of carry", () => {
  const options = {
    title: TITLE,
    pageUrl: DOC_URL,
    renderer: RENDERER,
    otherFilesUnchanged: false,
  };

  it("carries only a target outside the changed region, still at its node's edges", async () => {
    const old = "First.\n\nSecond words.\n\nThird.";
    const change = await edit("markdown", old, "Second", "Next");
    const proof = (await planOne("markdown", old, [change])).applied[0]?.proof as Proof;
    const carry = (next: string) =>
      carryAll("markdown", old, next, [{ edit: change, proof }], options)[0];
    expect(carry(`${old}\n\nFourth.`)?.status).toBe("carried");
    expect(carry(old.replace("First.", "First, longer."))?.status).toBe("carried");
    // The paragraph grows before or after the target: it is no longer at its node's edges.
    expect(carry(old.replace("Second", "Now Second"))).toEqual({
      status: "outdated",
      reason: "changed",
    });
    expect(carry(old.replace("Second words.", "Second words. More."))).toEqual({
      status: "outdated",
      reason: "target_changed",
    });
    expect(carry(old.replace("\n\nSecond", " Second"))?.status).toBe("outdated");
  });

  it("finds each marker's place among several in one node", async () => {
    const old = "Alpha beta gamma delta.\n\nEnd.";
    const first = await edit("markdown", old, "Alpha", "A");
    const last = await edit("markdown", old, "delta", "D");
    const planned = await planOne("markdown", old, [first, last]);
    const items = planned.applied.map((patch) => ({
      edit: [first, last][patch.operation] as typeof first,
      proof: patch.proof,
    }));
    const results = carryAll("markdown", old, `${old}\n\nMore.`, items, options);
    expect(results.map((result) => result.status)).toEqual(["carried", "carried"]);
  });
});

describe("plan limits and confirmation", () => {
  it("applies the HTML limit to HTML and the document limit to documents", async () => {
    const big = "x".repeat(1_500_000);
    const html = await plan("html", `<!doctype html><p>${big} needle</p>`, [
      editAt(`${big} needle`, "needle", "pin"),
    ]);
    expect(html.listed[0]?.reason).toBe("too_large");
    const text = await plan("text", `${big} needle`, [editAt(`${big} needle`, "needle", "pin")]);
    expect(text.applied).toHaveLength(1);
  });

  it("refuses at confirmation an oversized new file and a digest that is not the plan's", async () => {
    const source = "One cat sat.";
    const built = await plan("text", source, [{ start: 4, end: 7, before: "cat", after: "dog" }]);
    const base = {
      plan: built,
      confirmedDigest: built.digest,
      current: built.binding,
      newSource: built.newSource,
      renderer: RENDERER,
    };
    expect(await confirmPlan(base)).toBe("confirmed");
    expect(await confirmPlan({ ...base, newSource: "x".repeat(2_000_001) })).toBe("plan_changed");
    expect(await confirmPlan({ ...base, plan: { ...built, digest: "1".repeat(64) } })).toBe(
      "plan_changed",
    );
    expect(
      await confirmPlan({ ...base, plan: { ...built, output: null }, newSource: undefined }),
    ).toBe("plan_changed");
  });

  it("shortens long destinations only when the envelope would be over its limit", async () => {
    const long = `https://example.com/${"a".repeat(9_000)}`;
    const html = `<!doctype html><p><a href="${long}">go</a> now</p>`;
    const built = await plan("html", html, [editAt(bodyText(html), "go", "run")]);
    const [link] = built.applied[0]?.destinations ?? [];
    expect(link?.authored).toHaveLength(PLAN_LIMITS.destinationUnits);
    expect(link?.authoredOmitted).toBe(long.length - PLAN_LIMITS.destinationUnits);
    expect(link?.at).toMatchObject({ file: "source" });
    const fits = `https://example.com/${"a".repeat(3_000)}`;
    const fitting = `<!doctype html><p><a href="${fits}">go</a> now</p>`;
    const whole = await plan("html", fitting, [editAt(bodyText(fitting), "go", "run")]);
    expect(whole.applied[0]?.destinations[0]?.authored).toBe(fits);
  });

  it("stores a proof within its limit and leaves out a deeper one for manual closure", async () => {
    const proofAt = async (depth: number) => {
      const html = `<!doctype html>${"<div>".repeat(depth)}needle${"</div>".repeat(depth)}`;
      const built = await plan("html", html, [editAt(bodyText(html), "needle", "pin")]);
      return { proof: built.proofs[0], location: built.applied[0]?.location };
    };
    const shallow = await proofAt(10);
    expect(shallow.proof).not.toBeNull();
    const deep = await proofAt(3_000);
    expect(deep.proof).toBeNull();
    // The place in the file is still proven: only the stored proof is left out.
    expect(deep.location).toMatchObject({ unit: "utf16" });
  });

  it("binds the route of the operations, and none when they have none", async () => {
    const built = await plan("text", "One cat sat.", [
      { start: 4, end: 7, before: "cat", after: "dog" },
    ]);
    expect(built.binding.route).toBeNull();
    expect(built.lines.join("\n")).toContain("(no route)");
  });
});
