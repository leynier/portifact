// The counterexamples of the independent code review of pull request #252 (at 57de7d59), one test
// each, written against the code as it stood so they fail first. Numbers are the review's findings.
import { PLAN_LIMITS } from "@portifact/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  bodyText,
  DOC_URL,
  edit,
  editAt,
  PAGE_URL,
  plan,
  planOne,
  RENDERER,
  storedOf,
  TITLE,
  textOperation,
} from "../testing/suggestions/harness.ts";
import { closure } from "./closure.ts";
import { DELETED_ACCOUNT, presentEnvelope, renderEnvelope } from "./envelope.ts";
import { buildPlan, confirmPlan, planDigest } from "./plan.ts";
import { buildPreview } from "./preview.ts";
import { carryAll } from "./relocate.ts";
import { renderedPage } from "./rendered.ts";
import { newWork } from "./work.ts";

const htmlPage = (body: string) =>
  `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

async function proofOf(
  kind: "markdown" | "text" | "html",
  source: string,
  change: Parameters<typeof planOne>[2][number],
) {
  const planned = await planOne(kind, source, [change]);
  const proof = planned.applied[0]?.proof ?? planned.listed[0]?.proof;
  if (!proof) throw new Error("not located");
  return proof;
}

const pageOf = (kind: "markdown" | "text" | "html", source: string) =>
  renderedPage(kind, source, {
    title: TITLE,
    pageUrl: kind === "html" ? PAGE_URL : DOC_URL,
    renderer: RENDERER,
    work: newWork(),
  });

describe("review of #252", () => {
  it("1: a listed edit never names an unproven place in the file", async () => {
    const html =
      '<!doctype html><a href="/pay">ne&#101;dle</a><p title="needle">other</p><script>1</script>';
    const built = await plan("html", html, [editAt(bodyText(html), "needle", "fixed")]);
    const [listed] = built.listed;
    expect(listed?.reason).toBe("not_eligible");
    // Mapped through the selected text node: the link's text, never the paragraph's title.
    expect(listed?.location).toMatchObject({ unit: "utf16", start: 30, end: 41 });
    expect(built.lines.join("\n")).not.toContain('title="⟦change here⟧');
    // When nothing maps, no coordinates and no context are given as the place to change.
    const across = htmlPage('<p>a <b>needle</b> b</p><p title="needle b">x</p>');
    const spanning = await plan("html", across, [editAt(bodyText(across), "a needle", "x")]);
    expect(spanning.listed[0]?.location).toEqual({ unresolved: true });
    expect(spanning.listed[0]?.context).toBeNull();
  });

  it("2: every link around or inside the selection is shown, listed or applied, untruncated", async () => {
    const html = htmlPage('<p>Read <a href="/pay">terms</a> first.</p>');
    const htmlPlan = await plan("html", html, [editAt(bodyText(html), "Read terms", "Read rules")]);
    expect(htmlPlan.listed[0]?.reason).toBe("spans_nodes");
    expect(htmlPlan.listed[0]?.destinations).toMatchObject([
      { authored: "/pay", effective: "https://k7d2qm4xab.portifact.dev/pay" },
    ]);
    const md = "Read [terms](/pay) first.";
    const mdPlan = await plan("markdown", md, [
      await edit("markdown", md, "Read terms", "Read rules"),
    ]);
    expect(mdPlan.listed[0]?.destinations).toMatchObject([{ authored: "/pay" }]);
    const scripted =
      '<!doctype html><p><a href="https://evil.example/pay">Pay now</a></p><script>1</script>';
    const scriptedPlan = await plan("html", scripted, [
      editAt(bodyText(scripted), "Pay now", "Pay later"),
    ]);
    expect(scriptedPlan.listed[0]?.destinations).toMatchObject([
      { effective: "https://evil.example/pay" },
    ]);
    expect(scriptedPlan.lines.join("\n")).toContain("link to: https://evil.example/pay");
    // A base element changes where a link goes.
    const based =
      '<!doctype html><html><head><title>t</title><base href="https://elsewhere.example/"></head><body><p><a href="/pay">Pay</a> here</p></body></html>';
    const basedPlan = await plan("html", based, [editAt(bodyText(based), "Pay", "Send")]);
    expect(basedPlan.listed[0]?.destinations).toMatchObject([
      { authored: "/pay", effective: "https://elsewhere.example/pay" },
    ]);
    // A long destination is kept whole.
    const long = `https://example.com/${"a".repeat(1_000)}`;
    const longPage = htmlPage(`<p><a href="${long}">go</a> now</p>`);
    const longPlan = await plan("html", longPage, [editAt(bodyText(longPage), "go", "run")]);
    expect(longPlan.applied[0]?.destinations[0]?.authored).toBe(long);
  });

  it("3: provenance names are rendered from erasable references, never stored in the envelope", async () => {
    const source = "One cat sat.";
    const built = await plan("markdown", source, [await edit("markdown", source, "cat", "dog")]);
    const [core] = built.applied;
    expect(JSON.stringify(core)).not.toContain("Reviewer");
    if (!core) throw new Error("not applied");
    const shown = presentEnvelope(core, { submittedBy: "Actual Reviewer", acceptedBy: null });
    expect(shown.provenance).toEqual({
      submittedBy: "Actual Reviewer",
      acceptedBy: DELETED_ACCOUNT,
    });
    expect(renderEnvelope(shown).join("\n")).toContain(`accepted by ${DELETED_ACCOUNT}`);
    // The digest covers whether each person is known, not their names.
    expect(core.people).toEqual({ submitter: true, acceptor: true });
  });

  it("4: text a hidden body or ancestor holds is not shown", async () => {
    const page = htmlPage("<p>The budget grew in March.</p>");
    const proof = await proofOf("html", page, editAt(bodyText(page), "grew", "fell"));
    for (const hidden of [
      "<!doctype html><html><head><title>t</title></head><body hidden><p>The budget fell in March.</p></body></html>",
      htmlPage("<div hidden><p>The budget fell in March.</p></div>"),
      '<!doctype html><html lang="fr"><head><title>t</title></head><body><p>The budget fell in March.</p></body></html>',
    ]) {
      expect((await closure(proof, await pageOf("html", hidden))).state, hidden).toBe("open");
    }
  });

  it("5: a page that gained active content, or whose companion files are not known unchanged, is outdated", async () => {
    const old = "<!doctype html><p>The budget grew in March.</p>";
    const change = editAt(bodyText(old), "grew", "fell");
    const proof = await proofOf("html", old, change);
    const options = { title: TITLE, pageUrl: PAGE_URL, renderer: RENDERER };
    const scripted = `${old}<script>document.querySelector("p").textContent="other"</script>`;
    expect(
      (
        await carryAll("html", old, scripted, [{ edit: change, proof }], {
          ...options,
          otherFilesUnchanged: true,
        })
      )[0],
    ).toEqual({ status: "outdated", reason: "not_eligible" });
    const outside = `${old}<script src="app.js"></script>`;
    const outsideProof = await proofOf("html", outside, change);
    expect(
      (
        await carryAll("html", outside, outside, [{ edit: change, proof: outsideProof }], {
          ...options,
          otherFilesUnchanged: false,
        })
      )[0],
    ).toEqual({ status: "outdated", reason: "not_eligible" });
    expect(
      (
        await carryAll("html", outside, outside, [{ edit: change, proof: outsideProof }], {
          ...options,
          otherFilesUnchanged: true,
        })
      )[0]?.status,
    ).toBe("carried");
  });

  it("6: the 2 MB document limit is in UTF-8 bytes and refuses before any rendering", async () => {
    const throwing = {
      ...RENDERER,
      stored: () => {
        throw new Error("rendered an oversized file");
      },
    };
    for (const kind of ["markdown", "text"] as const) {
      const source = `${"文".repeat(700_000)} needle`;
      const work = newWork();
      const built = await buildPlan({
        binding: {
          artifactId: "a",
          versionId: "v",
          path: "p",
          fileSha256: "0".repeat(64),
          renderer: RENDERER.label,
          subject: "s",
          revision: 1,
        },
        people: { submitter: true, acceptor: true },
        kind,
        source,
        operations: [
          textOperation({ start: 700_001, end: 700_007, before: "needle", after: "fixed" }),
        ],
        stored: { html: "", blockMap: null, options: { title: TITLE } },
        pageUrl: DOC_URL,
        renderer: throwing,
        work,
      });
      expect(built.listed[0]?.reason, kind).toBe("too_large");
      expect(work).toMatchObject({ parses: 0, renders: 0, indexes: 0, maps: 0 });
    }
  });

  it("7: one large text node is mapped once per plan, and its work is counted", async () => {
    const words = Array.from({ length: 100 }, (_, i) => `w${i}x`).join(" ");
    const html = htmlPage(`<p>${words} ${"z".repeat(200_000)}</p>`);
    const text = bodyText(html);
    for (const count of [1, 20, 100]) {
      const work = newWork();
      const edits = Array.from({ length: count }, (_, i) => editAt(text, `w${i}x`, `v${i}y`));
      expect((await planOne("html", html, edits, work)).applied).toHaveLength(count);
      expect(work.maps, String(count)).toBe(1);
    }
  });

  it("8: every proof a plan produces fits its column, or is left out for manual closure", async () => {
    const html = `<!doctype html><p data-note="${"a".repeat(17_000)}">needle</p>`;
    const built = await plan("html", html, [editAt(bodyText(html), "needle", "")]);
    for (const proof of built.proofs) {
      if (proof)
        expect(new TextEncoder().encode(JSON.stringify(proof)).length).toBeLessThanOrEqual(
          PLAN_LIMITS.proofBytes,
        );
    }
    const deep = htmlPage(`${"<div>".repeat(5_000)}needle${"</div>".repeat(5_000)}`);
    const deepPlan = await plan("html", deep, [editAt(bodyText(deep), "needle", "pin")]);
    for (const proof of deepPlan.proofs) {
      if (proof)
        expect(new TextEncoder().encode(JSON.stringify(proof)).length).toBeLessThanOrEqual(
          PLAN_LIMITS.proofBytes,
        );
    }
  });

  it("9: the route is bound, shown and hashed", async () => {
    const source = "One cat sat.";
    const change = await edit("markdown", source, "cat", "dog");
    const routed = (route: string) => ({
      ...textOperation(change),
      target: { ...textOperation(change).target, route },
    });
    const a = await plan("markdown", source, [routed("/a") as never]);
    const b = await plan("markdown", source, [routed("/b") as never]);
    expect(a.binding.route).toBe("/a");
    expect(a.digest).not.toBe(b.digest);
    expect(a.lines.join("\n")).toContain("route /a");
  });

  it("10: sizes are checked before any hashing, on building and on confirming", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");
    try {
      const html = "<!doctype html><p>x</p><script>1</script>";
      const many = Array.from({ length: 100 }, () => ({
        start: 0,
        end: 1,
        before: "x",
        after: "y".repeat(4_000),
      }));
      digest.mockClear();
      await expect(
        plan("html", html, many, { binding: { fileSha256: "0".repeat(64) } }),
      ).rejects.toThrow("over its limit");
      expect(digest).not.toHaveBeenCalled();
      const small = await plan("html", htmlPage("<p>x</p>"), [
        { start: 0, end: 1, before: "x", after: "y" },
      ]);
      digest.mockClear();
      const bloated = { ...small, lines: [...small.lines, "z".repeat(PLAN_LIMITS.planBytes)] };
      expect(
        await confirmPlan({
          plan: bloated,
          confirmedDigest: small.digest,
          current: small.binding,
          newSource: small.newSource,
          renderer: RENDERER,
        }),
      ).toBe("plan_changed");
      expect(digest).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
    }
  });

  it("12: plain text proofs carry the rendered node's line feeds", async () => {
    for (const source of ["abc\r\nneedle here", "abc\rneedle here"]) {
      const change = { start: 4, end: 10, before: "needle", after: "fixed" };
      const planned = await planOne("text", source, [change]);
      const proof = planned.applied[0]?.proof;
      if (!proof || planned.source === undefined) throw new Error("not applied");
      expect(proof.nodeLeft, JSON.stringify(source)).toBe("abc\n");
      expect((await closure(proof, await pageOf("text", planned.source))).state).toBe("closed");
      const [carried] = await carryAll(
        "text",
        source,
        `intro\r\n${source}`,
        [{ edit: change, proof }],
        {
          title: TITLE,
          pageUrl: DOC_URL,
          renderer: RENDERER,
          otherFilesUnchanged: false,
        },
      );
      expect(carried?.status, JSON.stringify(source)).toBe("carried");
    }
  });

  it("13: author CSS cannot animate a preview", () => {
    const html = buildPreview(
      "html",
      '<html><head><style>* { animation:spin 1s infinite!important; -webkit-transition: all 1s } @keyframes spin {to {opacity:0}}</style></head><body><p style="animation:spin 1s infinite!important; color: red">needle</p></body></html>',
      RENDERER,
    );
    const author = html.slice(html.indexOf("</style>") + "</style>".length);
    expect(author).not.toMatch(/animation\s*:|transition\s*:/i);
    expect(html).toContain("color:red");
  });

  it("14: the digest covers every field of the plan", async () => {
    const source = "One cat sat.";
    const built = await plan("markdown", source, [await edit("markdown", source, "cat", "dog")]);
    const output = built.output;
    if (!output) throw new Error("no output");
    const base = await planDigest(built);
    const changed = [
      { ...built, output: { ...output, sha256: "1".repeat(64) } },
      { ...built, output: { ...output, size: output.size + 1 } },
      { ...built, output: { ...output, renderedSha256: "1".repeat(64) } },
      { ...built, output: { ...output, blockMapSha256: null } },
      { ...built, output: { ...output, options: { title: "Other" } } },
      { ...built, binding: { ...built.binding, path: "x.md" } },
      { ...built, binding: { ...built.binding, route: "/x" } },
      { ...built, binding: { ...built.binding, revision: 2 } },
      { ...built, kind: "text" as const },
      { ...built, applied: [] },
      { ...built, listed: [...built.applied] },
      { ...built, lines: [...built.lines, "x"] },
    ];
    for (const each of changed) expect(await planDigest(each)).not.toBe(base);
    // A storable plan read back stays equal.
    expect(await planDigest(JSON.parse(JSON.stringify(built)))).toBe(base);
    expect((await storedOf("markdown", source)).html.length).toBeGreaterThan(0);
  });
});
