// Jira Cloud rules of issue integrations (decision 0018, "Jira"): the fixed gateway origin and its
// path, the site name and cloud ID, the link Portifact builds, JQL quoting, the sealed credential
// and the Atlassian document an issue's description is, with hostile text kept inert.
import { INTEGRATION_LIMITS, type IssueParts, type IssueSource } from "@portifact/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  adfPlainText,
  checkIntegrationCall,
  checkIntegrationTargets,
  checkIssueKey,
  checkIssueUrl,
  issueBody,
  issueDocument,
  issueDocumentText,
  issueSections,
  jiraApiUrl,
  jiraBaseUrlIsSite,
  jiraCloudId,
  jiraCredential,
  jiraFindJql,
  jiraIssueType,
  jiraIssueUrl,
  jiraSiteName,
  jiraTimestamp,
  jqlString,
  openJiraCredential,
} from "./integrations.ts";

const CLOUD = "11223344-5566-4778-899a-abbccddeeff0";

const SOURCE: IssueSource = {
  service: "jira",
  link: "https://app.portifact.test/view/abc?path=%2Findex.html&thread=t1",
  artifactName: "Plan",
  quote: "the quote",
  message: "the message",
  reference: "ti_0123",
};
const ALL: IssueParts = { link: true, artifactName: true, quote: true, message: true };

describe("Jira targets", () => {
  it("takes project keys, upper-casing them", () => {
    expect(checkIntegrationTargets("jira", ["eng", " OPS_2 "])).toEqual({
      ok: true,
      value: ["ENG", "OPS_2"],
    });
  });

  it.each([["E"], ["1ENG"], ["ENG-1"], ["ENGINEERING1"], ["acme/site"], ['EN"G']])(
    "refuses %s",
    (key) => {
      expect(checkIntegrationTargets("jira", [key])).toMatchObject({ ok: false });
    },
  );

  it("refuses the same key twice in another case", () => {
    expect(checkIntegrationTargets("jira", ["ENG", "eng"])).toMatchObject({ ok: false });
  });
});

describe("Jira calls", () => {
  it("go only to a site's REST API on the gateway", () => {
    expect(checkIntegrationCall("jira", jiraApiUrl(CLOUD, "myself")).ok).toBe(true);
    expect(checkIntegrationCall("jira", jiraApiUrl(CLOUD, "search/jql")).ok).toBe(true);
  });

  it.each([
    ["https://acme.atlassian.net/rest/api/3/myself"],
    [`https://api.atlassian.com/ex/confluence/${CLOUD}/rest/api/3/myself`],
    [`https://api.atlassian.com/ex/jira/not-a-cloud/rest/api/3/myself`],
    [`https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/2/myself`],
    [`https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/`],
    [`https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/..%2F..%2Fadmin`],
    ["https://api.atlassian.com/oauth/token/accessible-resources"],
    [`http://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/myself`],
    [`https://api.atlassian.com:8443/ex/jira/${CLOUD}/rest/api/3/myself`],
  ])("refuses %s", (url) => {
    expect(checkIntegrationCall("jira", url).ok).toBe(false);
  });

  it("encodes every path segment and the query", () => {
    expect(jiraApiUrl(CLOUD, "project/EN G", new URLSearchParams({ jql: 'a = "b"' }))).toBe(
      `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/project/EN%20G?jql=a+%3D+%22b%22`,
    );
  });
});

describe("Jira sites", () => {
  it.each([
    ["acme", "acme"],
    ["ACME.atlassian.net", "acme"],
    ["https://acme.atlassian.net", "acme"],
    ["https://acme-eu.atlassian.net/jira/your-work?x=1", "acme-eu"],
  ])("reads %s", (raw, name) => {
    expect(jiraSiteName(raw)).toEqual({ ok: true, value: name });
  });

  it.each([
    ["acme.jira.com"],
    ["a.b.atlassian.net"],
    ["http://acme.atlassian.net"],
    ["https://user@acme.atlassian.net"],
    ["https://acme.atlassian.net:444"],
    ["evil.com/acme.atlassian.net"],
    ["-acme"],
    [""],
    ["acme.atlassian.net.evil.com"],
  ])("refuses %s", (raw) => {
    expect(jiraSiteName(raw).ok).toBe(false);
  });

  it("reads a cloud ID in either case", () => {
    expect(jiraCloudId(CLOUD.toUpperCase())).toEqual({ ok: true, value: CLOUD });
    expect(jiraCloudId("acme").ok).toBe(false);
  });

  it("accepts serverInfo's baseUrl only when it is exactly the site", () => {
    expect(jiraBaseUrlIsSite("https://acme.atlassian.net", "acme")).toBe(true);
    expect(jiraBaseUrlIsSite("https://acme.atlassian.net/", "acme")).toBe(true);
    for (const other of [
      "https://other.atlassian.net",
      "https://acme.atlassian.net/jira",
      "http://acme.atlassian.net",
      "https://acme.atlassian.net:443x",
      "https://jira.acme.com",
      "https://acme.atlassian.net?x",
      42,
      null,
    ]) {
      expect(jiraBaseUrlIsSite(other, "acme")).toBe(false);
    }
  });
});

describe("Jira issue keys and links", () => {
  it("accepts a key only in the target project", () => {
    expect(checkIssueKey("jira", "ENG-42", "ENG")).toEqual({ ok: true, value: "ENG-42" });
    expect(checkIssueKey("jira", "OPS-42", "ENG").ok).toBe(false);
    expect(checkIssueKey("jira", "ENG-", "ENG").ok).toBe(false);
    expect(checkIssueKey("jira", 42, "ENG").ok).toBe(false);
  });

  it("builds the browse link and checks it", () => {
    const url = jiraIssueUrl("acme", "ENG-42");
    expect(url).toBe("https://acme.atlassian.net/browse/ENG-42");
    expect(checkIssueUrl("jira", url, { target: "ENG", key: "ENG-42", site: "acme" })).toEqual({
      ok: true,
      value: url,
    });
  });

  it.each([
    ["https://evil.atlassian.net/browse/ENG-42"],
    ["https://acme.atlassian.net/browse/ENG-43"],
    ["https://acme.atlassian.net/browse/OPS-42"],
    ["https://acme.atlassian.net/browse/ENG-42?x=1"],
    ["https://acme.atlassian.net/jira/browse/ENG-42"],
    ["http://acme.atlassian.net/browse/ENG-42"],
  ])("refuses %s", (url) => {
    expect(checkIssueUrl("jira", url, { target: "ENG", key: "ENG-42", site: "acme" }).ok).toBe(
      false,
    );
  });

  it("refuses a link without a valid site", () => {
    expect(
      checkIssueUrl("jira", "https://.atlassian.net/browse/ENG-1", { target: "ENG", site: "" }).ok,
    ).toBe(false);
  });
});

describe("JQL", () => {
  it("quotes and escapes a value", () => {
    expect(jqlString('a"b\\c')).toEqual({ ok: true, value: '"a\\"b\\\\c"' });
  });

  it("refuses control characters and long values", () => {
    expect(jqlString("a\nb").ok).toBe(false);
    expect(jqlString("x".repeat(201)).ok).toBe(false);
  });

  it("builds the lookup only for a project key", () => {
    expect(jiraFindJql("ENG")).toEqual({
      ok: true,
      value: 'project = "ENG" AND creator = currentUser() AND created >= -1d ORDER BY created DESC',
    });
    expect(jiraFindJql('ENG" OR project != "X').ok).toBe(false);
  });

  it("never lets a value escape its string literal", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (value) => {
        const quoted = jqlString(value);
        if (!quoted.ok) return;
        // Unescaping the literal gives the value back, and no unescaped quote is inside it.
        const inner = quoted.value.slice(1, -1);
        expect(inner.replace(/\\(.)/g, "$1")).toBe(value);
        expect(/(^|[^\\])(\\\\)*"/.test(inner)).toBe(false);
      }),
    );
  });
});

describe("Jira timestamps", () => {
  it.each([
    ["2026-11-08T12:00:00.000+0000", Date.UTC(2026, 10, 8, 12)],
    ["2026-11-08T14:00:00.000+0200", Date.UTC(2026, 10, 8, 12)],
    ["2026-11-08T07:30:00-04:30", Date.UTC(2026, 10, 8, 12)],
    ["2026-11-08T12:00:00Z", Date.UTC(2026, 10, 8, 12)],
  ])("reads %s", (raw, at) => {
    expect(jiraTimestamp(raw)).toBe(at);
  });

  it.each([["2026-11-08"], ["yesterday"], ["2026-13-08T12:00:00+0000"], [1], [null]])(
    "refuses %s",
    (raw) => {
      expect(jiraTimestamp(raw)).toBeNull();
    },
  );
});

describe("the sealed Jira credential", () => {
  it("round-trips the email and the token", () => {
    const sealed = jiraCredential("bot@acme.test", "ATATT-token");
    expect(openJiraCredential(sealed)).toEqual({ account: "bot@acme.test", token: "ATATT-token" });
  });

  it.each([["not json"], ["null"], ['{"account":1,"token":"x"}'], ['"x"']])(
    "reads %s as none",
    (raw) => {
      expect(openJiraCredential(raw)).toBeNull();
    },
  );
});

describe("the issue type", () => {
  it("prefers Task, else the first standard type, never a subtask", () => {
    expect(
      jiraIssueType([
        { id: "1", name: "Bug", subtask: false, hierarchyLevel: 0 },
        { id: "2", name: "Task", subtask: false, hierarchyLevel: 0 },
      ]),
    ).toBe("2");
    expect(
      jiraIssueType([
        { id: "3", name: "Sub-task", subtask: true, hierarchyLevel: -1 },
        { id: "4", name: "Epic", subtask: false, hierarchyLevel: 1 },
        { id: "5", name: "Story", subtask: false, hierarchyLevel: 0 },
      ]),
    ).toBe("5");
    expect(jiraIssueType([{ id: "3", name: "Sub-task", subtask: true }])).toBeNull();
    expect(jiraIssueType([{ id: "x", name: "Task" }])).toBeNull();
    expect(jiraIssueType("nope")).toBeNull();
  });
});

/** Every node type and mark of a document, to prove nothing else is ever written. */
function shapes(document: unknown) {
  const nodes = new Set<string>();
  const marks = new Set<string>();
  const walk = (node: unknown) => {
    if (typeof node !== "object" || node === null) return;
    const {
      type,
      content,
      marks: own,
    } = node as {
      type?: string;
      content?: unknown[];
      marks?: { type: string }[];
    };
    if (type) nodes.add(type);
    for (const mark of own ?? []) marks.add(mark.type);
    for (const child of content ?? []) walk(child);
  };
  walk(document);
  return { nodes, marks };
}

describe("issueDocument", () => {
  it("says what the Markdown body says, as an Atlassian document", () => {
    const document = issueDocument(SOURCE, ALL);
    expect(document).toEqual({
      version: 1,
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "A comment thread on Portifact." }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Artifact: " },
            { type: "text", text: "Plan", marks: [{ type: "code" }] },
          ],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Thread: " },
            {
              type: "text",
              text: SOURCE.link,
              marks: [{ type: "link", attrs: { href: SOURCE.link } }],
            },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "Quoted text:" }] },
        {
          type: "codeBlock",
          attrs: { language: "text" },
          content: [{ type: "text", text: "the quote" }],
        },
        { type: "paragraph", content: [{ type: "text", text: "First message:" }] },
        {
          type: "codeBlock",
          attrs: { language: "text" },
          content: [{ type: "text", text: "the message" }],
        },
        { type: "rule" },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Sent from Portifact. Reference: ti_0123" }],
        },
      ],
    });
    expect(issueSections(SOURCE, ALL).map((section) => section.kind)).toEqual([
      "intro",
      "artifact",
      "link",
      "quote",
      "message",
      "reference",
    ]);
  });

  it("leaves out what the person turned off, and keeps the reference", () => {
    const none = { link: false, artifactName: false, quote: false, message: false };
    expect(issueDocumentText(issueDocument(SOURCE, none))).toBe(
      "A comment thread on Portifact.\n\n---\n\nSent from Portifact. Reference: ti_0123",
    );
    expect(issueBody(SOURCE, none)).toBe(
      "A comment thread on Portifact.\n\n---\nSent from Portifact. Reference: ti_0123",
    );
  });

  it("previews code blocks between backticks", () => {
    expect(issueDocumentText(issueDocument(SOURCE, ALL))).toContain(
      "Quoted text:\n\n```\nthe quote\n```",
    );
  });

  it("keeps hostile text as the only text of code blocks, with no other node or mark", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 4_000 }), fc.string({ maxLength: 300 }), (text, name) => {
        const document = issueDocument(
          { ...SOURCE, quote: text, message: text, artifactName: name },
          ALL,
        );
        const { nodes, marks } = shapes(document);
        for (const node of nodes) {
          expect(["doc", "paragraph", "text", "codeBlock", "rule"]).toContain(node);
        }
        for (const mark of marks) expect(["code", "link"]).toContain(mark);
        // The one link is Portifact's own; comment text never carries a mark.
        const links = JSON.stringify(document).match(/"href":"[^"]*"/g) ?? [];
        expect(links).toEqual([`"href":"${SOURCE.link}"`]);
        for (const block of document.content) {
          if (block.type === "codeBlock") {
            expect(block.content).toHaveLength(1);
            expect(block.content[0].marks).toBeUndefined();
            expect(block.content[0].text.length).toBeGreaterThan(0);
            expect([...block.content[0].text].length).toBeLessThanOrEqual(
              INTEGRATION_LIMITS.messageMax,
            );
          }
          if (block.type === "paragraph") {
            for (const node of block.content) expect(node.text.length).toBeGreaterThan(0);
          }
        }
      }),
    );
  });

  it.each([
    ["@[Admin] [~accountid:123] mention"],
    ["[link|https://evil.test] https://evil.test !image.png! {code}x{code} {panel}"],
    ['{"type":"inlineCard","attrs":{"url":"https://evil.test"}}'],
    ["<script>alert(1)</script> ```"],
  ])("keeps %j inert", (hostile) => {
    const document = issueDocument(
      { ...SOURCE, quote: hostile, message: hostile, artifactName: hostile },
      ALL,
    );
    const { nodes, marks } = shapes(document);
    expect([...nodes].sort()).toEqual(["codeBlock", "doc", "paragraph", "rule", "text"]);
    expect([...marks].sort()).toEqual(["code", "link"]);
  });

  it("reads all the text of a document, bounded", () => {
    expect(adfPlainText(issueDocument(SOURCE, ALL))).toContain("Reference: ti_0123");
    expect(adfPlainText(null)).toBe("");
    expect(adfPlainText({ text: "x".repeat(10) }, 4)).toBe("xxxx");
    let deep: unknown = { text: "bottom" };
    for (let i = 0; i < 40; i += 1) deep = { content: [deep] };
    expect(adfPlainText(deep)).toBe("");
  });
});
