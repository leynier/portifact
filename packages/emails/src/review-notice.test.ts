import { LOCALE_CODES } from "@portifact/contracts/locales";
import { type DefaultTreeAdapterMap, parse } from "parse5";
import { describe, expect, it } from "vitest";
import { REVIEW_TEXT, type ReviewNoticeInput, reviewNoticeEmail } from "./review-notice.ts";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

function elements(html: string): Element[] {
  const found: Element[] = [];
  const stack: Node[] = [parse(html)];
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    if ("tagName" in node) found.push(node);
    if ("childNodes" in node) stack.push(...[...node.childNodes].reverse());
    if ("content" in node) stack.push(node.content as Node);
  }
  return found;
}

function textOf(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  return "childNodes" in node ? node.childNodes.map(textOf).join("") : "";
}

const links = (html: string) =>
  elements(html)
    .filter((e) => e.tagName === "a")
    .map((e) => [textOf(e), e.attrs.find((a) => a.name === "href")?.value]);

const VIEW = "https://app.portifact.com/view/k7d2qm4xab";
const SETTINGS = "https://app.portifact.com/settings";
const UNSUBSCRIBE = "https://app.portifact.com/unsubscribe?token=cn1.abc.1.sig";

function input(overrides: Partial<ReviewNoticeInput> = {}): ReviewNoticeInput {
  return {
    kind: "requested",
    name: "Q3 plan",
    version: 4,
    url: VIEW,
    settingsUrl: SETTINGS,
    unsubscribeUrl: UNSUBSCRIBE,
    names: true,
    ...overrides,
  };
}

describe("review notice email", () => {
  it("asks for a review with the artifact, its version and a link to the viewer", () => {
    const email = reviewNoticeEmail(input());
    expect(email.subject).toBe("Your review is requested on Portifact");
    expect(email.text).toContain(
      "You were asked to review Q3 plan (version 4). Open it to read it, then approve it or request changes.",
    );
    expect(email.text).toContain(`Review it: ${VIEW}`);
    expect(links(email.html).slice(0, 3)).toEqual([
      ["Review it", VIEW],
      ["Settings", SETTINGS],
      ["Unsubscribe", UNSUBSCRIBE],
    ]);
    expect(email.text).toContain("someone asked for your review");
  });

  it("tells the owner side the final status, once per kind", () => {
    const approved = reviewNoticeEmail(input({ kind: "approved" }));
    expect(approved.subject).toBe("A version was approved on Portifact");
    expect(approved.text).toContain("The reviewers approved Q3 plan (version 4).");
    expect(approved.text).toContain("because you manage this artifact");
    const changes = reviewNoticeEmail(input({ kind: "changes_requested", version: null }));
    expect(changes.subject).toBe("Changes were requested on Portifact");
    expect(changes.text).toContain("A reviewer requested changes on Q3 plan.");
  });

  it("says the opt-out is the comment notices setting and never names reviewers", () => {
    const email = reviewNoticeEmail(input());
    expect(email.text).toContain("Review emails follow your comment notices setting.");
    expect(email.text).toContain("never includes notes or the names of other reviewers");
  });

  it("escapes the name, keeps it on one line and out of the subject", () => {
    const hostile = reviewNoticeEmail(
      input({ name: '<img src=x onerror="alert(1)">\nSecond line' }),
    );
    expect(hostile.html).not.toContain("<img src=x");
    expect(hostile.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; Second line");
    expect(hostile.subject).not.toContain("img");
  });

  it("leaves the name out without names, and names an empty one the same way", () => {
    for (const email of [
      reviewNoticeEmail(input({ names: false })),
      reviewNoticeEmail(input({ name: "  " })),
    ]) {
      expect(email.text).not.toContain("Q3 plan");
      expect(email.text).toContain("You were asked to review An artifact (version 4).");
    }
  });
});

describe.each(LOCALE_CODES)("review notice in %s", (locale) => {
  const t = REVIEW_TEXT[locale];

  it.each(["requested", "approved", "changes_requested"] as const)(
    "writes the %s email with the name, the version and every link",
    (kind) => {
      const email = reviewNoticeEmail(input({ locale, kind }));
      expect(email.html).toContain(`<html lang="${locale}" dir="ltr">`);
      expect(email.subject).toBe(t.subject[kind]);
      expect(email.subject).not.toContain("Q3 plan");
      expect(email.text).toContain("Q3 plan");
      expect(email.text).toContain("4");
      expect(links(email.html).slice(0, 3)).toEqual([
        [t.open[kind], VIEW],
        [t.settings, SETTINGS],
        [t.unsubscribeLink, UNSUBSCRIBE],
      ]);
      expect(`${email.subject}${email.html}${email.text}`).not.toMatch(/[—–]/);
      expect(email.text).not.toMatch(/<[a-z]/i);
      expect(email.text).not.toContain("{name}");
    },
  );

  it("is translated, except in English", () => {
    if (locale === "en") return;
    const english = REVIEW_TEXT.en;
    for (const kind of ["requested", "approved", "changes_requested"] as const) {
      expect(t.subject[kind]).not.toBe(english.subject[kind]);
      expect(t.sentence[kind]).not.toBe(english.sentence[kind]);
    }
    expect(t.privacy).not.toBe(english.privacy);
    expect(t.unsubscribeLink).not.toBe(english.unsubscribeLink);
  });
});
