import { LOCALE_CODES } from "@portifact/contracts/locales";
import { type DefaultTreeAdapterMap, parse } from "parse5";
import { describe, expect, it } from "vitest";
import {
  COMMENT_TEXT,
  type CommentNoticeArtifact,
  type CommentNoticeInput,
  commentNoticeEmail,
} from "./comment-notice.ts";

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

const SETTINGS = "https://app.portifact.com/settings";
const UNSUBSCRIBE = "https://app.portifact.com/unsubscribe?token=cn1.abc.1.sig";

const FIRST: CommentNoticeArtifact = {
  name: "Q3 plan",
  url: "https://app.portifact.com/view/k7d2qm4xab",
  newThreads: 2,
  newReplies: 5,
  resolvedThreads: 1,
};

function input(overrides: Partial<CommentNoticeInput> = {}): CommentNoticeInput {
  return {
    artifacts: [
      FIRST,
      {
        name: "Notes",
        url: "https://app.portifact.com/view/p4n8rt2vcd",
        newThreads: 0,
        newReplies: 1,
        resolvedThreads: 0,
      },
    ],
    more: 0,
    settingsUrl: SETTINGS,
    unsubscribeUrl: UNSUBSCRIBE,
    names: true,
    ...overrides,
  };
}

describe("comment notice email", () => {
  const email = commentNoticeEmail(input());

  it("counts the artifacts in the subject, never naming them there", () => {
    expect(email.subject).toBe("New comments on 2 Portifact artifacts");
    expect(commentNoticeEmail(input({ artifacts: input().artifacts.slice(0, 1) })).subject).toBe(
      "New comments on a Portifact artifact",
    );
    expect(commentNoticeEmail(input({ more: 3 })).subject).toBe(
      "New comments on 5 Portifact artifacts",
    );
  });

  it("lists each artifact with only the counts that are not zero and a link to its comments", () => {
    expect(email.text).toContain("- Q3 plan\n  2 new threads, 5 replies, 1 thread resolved\n");
    expect(email.text).toContain(
      "- Notes\n  1 reply\n  Open comments: https://app.portifact.com/view/p4n8rt2vcd",
    );
    expect(links(email.html)).toEqual(
      expect.arrayContaining([
        ["Open comments", "https://app.portifact.com/view/k7d2qm4xab"],
        ["Settings", SETTINGS],
        ["Unsubscribe", UNSUBSCRIBE],
      ]),
    );
    expect(email.text).toContain(SETTINGS);
    expect(email.text).toContain(UNSUBSCRIBE);
  });

  it("says that the email never shows what was written", () => {
    expect(email.text).toContain("This email never shows what was written");
  });

  it("counts the artifacts it does not list", () => {
    const more = commentNoticeEmail(input({ more: 1 }));
    expect(more.text).toContain("There is activity on 1 more artifact in Portifact.");
    expect(commentNoticeEmail(input({ more: 4 })).text).toContain("on 4 more artifacts");
    expect(email.text).not.toContain("more artifact");
  });

  it("escapes names and keeps each on one line", () => {
    const hostile = commentNoticeEmail(
      input({
        artifacts: [{ ...FIRST, name: '<img src=x onerror="alert(1)">\nSecond line' }],
      }),
    );
    expect(hostile.html).not.toContain("<img src=x");
    expect(hostile.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; Second line");
    expect(hostile.text).toContain('- <img src=x onerror="alert(1)"> Second line\n');
    expect(hostile.subject).not.toContain("img");
  });

  it("leaves every name out without names", () => {
    const anonymous = commentNoticeEmail(input({ names: false }));
    for (const part of [anonymous.subject, anonymous.html, anonymous.text]) {
      expect(part).not.toContain("Q3 plan");
      expect(part).not.toContain("Notes");
    }
    expect(anonymous.text).toContain("- An artifact\n");
  });

  it("names an artifact with an empty name like one without names", () => {
    const blank = commentNoticeEmail(input({ artifacts: [{ ...FIRST, name: "  " }] }));
    expect(blank.text).toContain("- An artifact\n");
  });
});

describe.each(LOCALE_CODES)("comment notice in %s", (locale) => {
  const email = commentNoticeEmail(input({ locale, more: 2 }));
  const t = COMMENT_TEXT[locale];

  it("marks the language and links the comments, the settings and the unsubscribe page", () => {
    expect(email.html).toContain(`<html lang="${locale}" dir="ltr">`);
    expect(links(email.html)).toEqual(
      expect.arrayContaining([
        [t.open, "https://app.portifact.com/view/k7d2qm4xab"],
        [t.settings, SETTINGS],
        [t.unsubscribeLink, UNSUBSCRIBE],
      ]),
    );
    expect(email.text).toContain(`${t.open}: https://app.portifact.com/view/p4n8rt2vcd`);
  });

  it("counts in the subject without names, and writes every count", () => {
    expect(email.subject).toContain("4");
    expect(email.subject).not.toContain("Q3 plan");
    for (const count of ["2", "5", "1"]) expect(email.text).toContain(count);
  });

  it("follows the writing style: no dashes, no markup in the text version", () => {
    expect(`${email.subject}${email.html}${email.text}`).not.toMatch(/[—–]/);
    expect(email.text).not.toMatch(/<[a-z]/i);
  });

  it("is translated, except in English", () => {
    if (locale === "en") return;
    const english = COMMENT_TEXT.en;
    expect(t.subject(2)).not.toBe(english.subject(2));
    expect(t.intro).not.toBe(english.intro);
    expect(t.open).not.toBe(english.open);
    expect(t.unsubscribeLink).not.toBe(english.unsubscribeLink);
  });
});

describe("comment notice plural forms", () => {
  it("says Russian replies with the right form for 1, 3 and 5", () => {
    const replies = (n: number) =>
      commentNoticeEmail(
        input({
          locale: "ru",
          artifacts: [{ ...FIRST, newThreads: 0, resolvedThreads: 0, newReplies: n }],
        }),
      ).text;
    expect(replies(1)).toContain("1 ответ\n");
    expect(replies(3)).toContain("3 ответа\n");
    expect(replies(5)).toContain("5 ответов\n");
  });

  it("leaves no space after full-width punctuation in Chinese and Japanese", () => {
    for (const locale of ["ja", "zh-CN"] as const) {
      const lines = elements(commentNoticeEmail(input({ locale })).html)
        .filter((e) => e.tagName === "li" || e.tagName === "p")
        .map(textOf);
      for (const line of lines) expect(line).not.toMatch(/[。：] /);
    }
  });
});
