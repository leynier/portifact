// Issue integration rules (decision 0018): targets, the URLs Portifact calls and accepts back,
// the classification of answers, and the issue body with its neutralization of untrusted text,
// as table tests and property tests with hostile input.
import { INTEGRATION_LIMITS, type IssueParts, type IssueSource } from "@portifact/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  allowedTarget,
  anchorQuote,
  checkIntegrationCall,
  checkIntegrationTargets,
  checkIssueKey,
  checkIssueUrl,
  classifyIntegrationCall,
  credentialHint,
  inertBlock,
  inertSpan,
  isRemovedCodePoint,
  issueBody,
  issueTitle,
  nextIssueAttemptAt,
  plainLine,
  plainText,
  threadLink,
} from "./integrations.ts";

const cp = (code: number) => String.fromCodePoint(code);
const RLO = cp(0x202e);
const ZWSP = cp(0x200b);
const LS = cp(0x2028);
const BOM = cp(0xfeff);
const TAG = cp(0xe0041);

const SOURCE: IssueSource = {
  service: "github",
  link: "https://app.portifact.test/view/abc?path=%2Findex.html&thread=t1",
  artifactName: "Plan",
  quote: "the quote",
  message: "the message",
  reference: "ti_0123",
};
const ALL: IssueParts = { link: true, artifactName: true, quote: true, message: true };
const NONE: IssueParts = { link: false, artifactName: false, quote: false, message: false };

/** The text between the fences of every inert block in a body. */
function blocks(body: string): string[] {
  const out: string[] = [];
  const pattern = /^(`{3,})text\n([\s\S]*?)\n\1$/gm;
  for (const match of body.matchAll(pattern)) out.push(match[2] ?? "");
  return out;
}

describe("checkIntegrationTargets", () => {
  it.each([
    ["github", ["acme/site"], ["acme/site"]],
    ["github", [" acme/site.js "], ["acme/site.js"]],
    ["linear", ["6F1D4C3A-1B2C-4D5E-8F90-0A1B2C3D4E5F"], ["6f1d4c3a-1b2c-4d5e-8f90-0a1b2c3d4e5f"]],
  ] as const)("accepts %s targets %j", (service, raw, expected) => {
    expect(checkIntegrationTargets(service, raw)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ["github", []],
    ["github", ["acme"]],
    ["github", ["acme/.."]],
    ["github", ["acme/."]],
    ["github", ["-acme/site"]],
    ["github", ["acme/site/extra"]],
    ["github", ["https://github.com/acme/site"]],
    ["github", ["acme/site", "ACME/SITE"]],
    ["linear", ["engineering"]],
    [
      "github",
      Array.from({ length: INTEGRATION_LIMITS.targetsPerConnection + 1 }, (_, i) => `a/r${i}`),
    ],
  ] as const)("refuses %s targets %j", (service, raw) => {
    expect(checkIntegrationTargets(service, raw)).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });

  it("finds an allowed target in any case", () => {
    const targets = [{ id: "Acme/Site", name: "Acme/Site" }];
    expect(allowedTarget(targets, " acme/site ")).toEqual(targets[0]);
    expect(allowedTarget(targets, "acme/other")).toBeUndefined();
  });
});

describe("checkIntegrationCall", () => {
  it.each([
    ["github", "https://api.github.com/user", true],
    ["github", "https://api.github.com/repos/a/b/issues", true],
    ["linear", "https://api.linear.app/graphql", true],
    ["github", "https://api.linear.app/graphql", false],
    ["github", "https://github.example.com/api/v3/user", false],
    ["github", "http://api.github.com/user", false],
    ["github", "https://api.github.com:8443/user", false],
    ["github", "https://user:pass@api.github.com/user", false],
    ["linear", "https://127.0.0.1/graphql", false],
  ] as const)("%s %s is allowed: %s", (service, url, allowed) => {
    expect(checkIntegrationCall(service, url).ok).toBe(allowed);
  });
});

describe("checkIssueUrl and checkIssueKey", () => {
  it.each([
    ["github", "https://github.com/acme/site/issues/12", { target: "acme/site", number: 12 }, true],
    ["github", "https://github.com/ACME/Site/issues/12", { target: "acme/site", number: 12 }, true],
    [
      "github",
      "https://github.com/acme/site/issues/13",
      { target: "acme/site", number: 12 },
      false,
    ],
    ["github", "https://github.com/acme/other/issues/12", { target: "acme/site" }, false],
    ["github", "https://github.com/acme/site/pull/12", { target: "acme/site" }, false],
    ["github", "https://evil.test/acme/site/issues/12", { target: "acme/site" }, false],
    ["github", "https://github.com.evil.test/acme/site/issues/12", { target: "acme/site" }, false],
    ["github", "https://github.com/acme/site/issues/12?x=1", { target: "acme/site" }, false],
    ["github", "javascript:alert(1)", { target: "acme/site" }, false],
    ["github", 12, { target: "acme/site" }, false],
    ["linear", "https://linear.app/acme/issue/ENG-1/a-title", { target: "" }, true],
    ["linear", "https://linear.app/acme/issue/ENG-1", { target: "" }, true],
    ["linear", "https://linear.app/acme/project/x", { target: "" }, false],
    ["linear", "https://evil.test/acme/issue/ENG-1", { target: "" }, false],
  ] as const)("%s %s is accepted: %s", (service, raw, expect_, accepted) => {
    expect(checkIssueUrl(service, raw, expect_).ok).toBe(accepted);
  });

  it.each([
    ["github", 7, "#7"],
    ["linear", "ENG-42", "ENG-42"],
  ] as const)("keys %s %j as %s", (service, raw, key) => {
    expect(checkIssueKey(service, raw)).toEqual({ ok: true, value: key });
  });

  it.each([
    ["github", "7"],
    ["github", 0],
    ["github", 1.5],
    ["linear", "eng-42"],
    ["linear", "ENG-42; rm"],
    ["linear", 42],
  ] as const)("refuses %s key %j", (service, raw) => {
    expect(checkIssueKey(service, raw).ok).toBe(false);
  });
});

describe("classifyIntegrationCall", () => {
  it.each([
    [{ kind: "status", status: 201 }, "ok", false, null],
    [{ kind: "status", status: 401 }, "failed", false, "credential_rejected"],
    [{ kind: "status", status: 403 }, "failed", false, "target_unreachable"],
    [{ kind: "status", status: 403, rateLimited: true }, "failed", true, "service_unavailable"],
    [{ kind: "status", status: 404 }, "failed", false, "target_unreachable"],
    [{ kind: "status", status: 410 }, "failed", false, "target_unreachable"],
    [{ kind: "status", status: 422 }, "failed", false, "rejected"],
    [{ kind: "status", status: 429 }, "failed", true, "service_unavailable"],
    [{ kind: "status", status: 408 }, "failed", true, "service_unavailable"],
    [{ kind: "status", status: 502 }, "failed", true, "service_unavailable"],
    [{ kind: "graphql", type: "authentication" }, "failed", false, "credential_rejected"],
    [{ kind: "graphql", type: "forbidden" }, "failed", false, "target_unreachable"],
    [{ kind: "graphql", type: "rate_limited" }, "failed", true, "service_unavailable"],
    [{ kind: "graphql", type: "invalid_input" }, "failed", false, "rejected"],
    [{ kind: "graphql", type: "other" }, "failed", false, "rejected"],
    [{ kind: "timeout" }, "failed", true, "service_unavailable"],
    [{ kind: "network" }, "failed", true, "service_unavailable"],
    [{ kind: "redirect" }, "failed", false, "invalid_response"],
    [{ kind: "too_large" }, "failed", false, "invalid_response"],
    [{ kind: "invalid_response" }, "failed", false, "invalid_response"],
  ] as const)("%j is %s (retry %s, %s)", (result, outcome, retryable, failure) => {
    expect(classifyIntegrationCall(result)).toEqual({ outcome, retryable, failure });
  });

  it("spaces the attempts and stops after the last", () => {
    const delays = INTEGRATION_LIMITS.retryDelaysMs;
    delays.forEach((delay, i) => {
      expect(nextIssueAttemptAt(i + 1, 1_000)).toBe(1_000 + delay);
    });
    expect(nextIssueAttemptAt(delays.length + 1, 1_000)).toBeNull();
  });
});

describe("plain text", () => {
  it.each([
    [`a${RLO}b${ZWSP}c${BOM}d${TAG}e`, "abcde"],
    ["one\r\ntwo\rthree", "one\ntwo\nthree"],
    [`one${LS}two`, "one\ntwo"],
    ["a\tb", "a  b"],
    [`a${cp(0)}b${cp(0x1b)}[31mc${cp(0x7f)}d${cp(0x9b)}e`, "ab[31mcde"],
    ["a\n\n\n\nb", "a\n\nb"],
    ["  padded  ", "padded"],
  ])("cleans %j", (raw, clean) => {
    expect(plainText(raw, 100)).toBe(clean);
  });

  it("is null for whitespace or invisible-only text", () => {
    expect(plainText(` \n${ZWSP}${RLO} `, 100)).toBeNull();
    expect(plainLine("\n\n", 100)).toBeNull();
  });

  it("cuts at the limit by code point with an ellipsis", () => {
    expect(plainText("😀".repeat(10), 5)).toBe(`${"😀".repeat(4)}${cp(0x2026)}`);
    expect([
      ...(plainText("x".repeat(INTEGRATION_LIMITS.messageMax * 3), INTEGRATION_LIMITS.messageMax) ??
        ""),
    ]).toHaveLength(INTEGRATION_LIMITS.messageMax);
  });

  it("keeps a line on one line", () => {
    expect(plainLine(`a\nb${LS}c\r\nd`, 100)).toBe("a b c d");
  });

  it("removes every listed code point and nothing printable", () => {
    for (const code of [
      0x00, 0x08, 0x0b, 0x7f, 0x85, 0x9f, 0x200b, 0x200f, 0x202a, 0x2066, 0xfeff, 0xe0001,
    ]) {
      expect(isRemovedCodePoint(code)).toBe(true);
    }
    for (const code of [0x0a, 0x20, 0x41, 0xe9, 0x4e2d, 0x1f600])
      expect(isRemovedCodePoint(code)).toBe(false);
  });
});

describe("inert blocks and spans", () => {
  it.each([
    ["plain", "```text\nplain\n```"],
    ["has ``` fences", "````text\nhas ``` fences\n````"],
    ["`````", "``````text\n`````\n``````"],
  ])("fences %j longer than its backticks", (text, block) => {
    expect(inertBlock(text)).toBe(block);
  });

  it.each([
    ["Plan", "`Plan`"],
    ["a `b` c", "``a `b` c``"],
    ["`edge`", "`` `edge` ``"],
  ])("spans %j", (text, span) => {
    expect(inertSpan(text)).toBe(span);
  });

  it("never lets text close its fence (property)", () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom("`", "a", "\n", " ", "~") }), (text) => {
        const block = inertBlock(text);
        const fence = block.slice(0, block.indexOf("text\n"));
        const inner = block.slice(fence.length + 5, block.length - fence.length - 1);
        expect(inner).toBe(text);
        // No line inside is a fence that long or longer.
        for (const line of inner.split("\n")) {
          expect(line.trim().startsWith(fence)).toBe(false);
        }
      }),
    );
  });
});

describe("issueBody", () => {
  it("holds only the parts left on, with the reference line always last", () => {
    expect(issueBody(SOURCE, NONE)).toBe(
      "A comment thread on Portifact.\n\n---\nSent from Portifact. Reference: ti_0123",
    );
    expect(issueBody(SOURCE, { ...NONE, link: true, artifactName: true })).toBe(
      [
        "A comment thread on Portifact.",
        "Artifact: `Plan`\nThread: <https://app.portifact.test/view/abc?path=%2Findex.html&thread=t1>",
        "---\nSent from Portifact. Reference: ti_0123",
      ].join("\n\n"),
    );
    const full = issueBody(SOURCE, ALL);
    expect(blocks(full)).toEqual(["the quote", "the message"]);
    expect(full.endsWith("Reference: ti_0123")).toBe(true);
  });

  it("leaves out a missing or empty quote and message", () => {
    const body = issueBody({ ...SOURCE, quote: null, message: `  ${ZWSP} ` }, ALL);
    expect(blocks(body)).toEqual([]);
    expect(body).not.toContain("Quoted text");
    expect(body).not.toContain("First message");
  });

  it.each([
    "@octocat please look",
    "Fixes #12 and acme/site#3",
    "![tracker](https://evil.test/pixel.png)",
    "[innocent](https://evil.test/phish)",
    "<img src=x onerror=alert(1)><script>alert(1)</script>",
    "```\n# Heading\n```\n> quote",
    "<!-- hidden --> <details><summary>x</summary></details>",
    `right${RLO}to-left and ${ZWSP}zero width`,
    `${cp(0x1b)}[2J clear screen`,
  ])("keeps hostile text inert: %j", (hostile) => {
    const body = issueBody(
      { ...SOURCE, artifactName: hostile, quote: hostile, message: hostile },
      ALL,
    );
    const inside = blocks(body);
    expect(inside).toHaveLength(2);
    // Outside the blocks and the name's span, nothing of the text appears.
    const outside = body
      .replace(/^(`{3,})text\n[\s\S]*?\n\1$/gm, "")
      .replace(/^Artifact: .*$/m, "");
    for (const word of [
      "octocat",
      "evil.test",
      "onerror",
      "Heading",
      "hidden",
      "zero width",
      "clear",
    ]) {
      expect(outside).not.toContain(word);
    }
    expect(body).not.toContain(RLO);
    expect(body).not.toContain(ZWSP);
    expect(body).not.toContain(cp(0x1b));
    // The name stays on one line inside a code span.
    expect(body).toMatch(/^Artifact: `+ ?[^\n]*`+$/m);
  });

  it("bounds the text it sends (property)", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 20_000 }),
        fc.string({ maxLength: 5_000 }),
        (message, quote) => {
          const body = issueBody({ ...SOURCE, message, quote, artifactName: message }, ALL);
          const [q, m] = [
            plainText(quote, INTEGRATION_LIMITS.quoteMax),
            plainText(message, INTEGRATION_LIMITS.messageMax),
          ];
          expect(body.length).toBeLessThan(
            400 + (q ? [...q].length * 2 : 0) + (m ? [...m].length * 2 : 0) + 400,
          );
          for (const block of blocks(body)) {
            for (const ch of block) expect(isRemovedCodePoint(ch.codePointAt(0) ?? 0)).toBe(false);
          }
        },
      ),
    );
  });
});

describe("helpers", () => {
  it("builds the thread link from IDs and a validated path", () => {
    expect(threadLink("https://app.portifact.test", "abc", "docs/a b.html", "t1")).toBe(
      "https://app.portifact.test/view/abc?path=%2Fdocs%2Fa%2520b.html&thread=t1",
    );
    // A path that is not a page of the artifact falls back to its root.
    expect(threadLink("https://app.portifact.test", "abc", "__portifact/callback", "t1")).toBe(
      "https://app.portifact.test/view/abc?path=%2F&thread=t1",
    );
  });

  it.each([
    [{ anchor: { kind: "text", quote: { exact: "q" } } }, "q"],
    [{ anchor: { kind: "element", fingerprint: "f" } }, null],
    [{ anchor: { kind: "document" } }, null],
    [{ anchor: null }, null],
    [null, null],
    ["text", null],
  ])("reads the quote of %j", (target, quote) => {
    expect(anchorQuote(target)).toBe(quote);
  });

  it("checks a title and shows only a credential's last four characters", () => {
    expect(issueTitle(`  Fix${LS}the header${RLO} `)).toEqual({
      ok: true,
      value: "Fix the header",
    });
    expect(issueTitle(`${ZWSP} `)).toMatchObject({ ok: false });
    expect(credentialHint("github_pat_abcdWXYZ")).toBe(`${cp(0x2026)}WXYZ`);
  });
});
