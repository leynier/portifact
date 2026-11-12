// Slack connection rules (decision 0025): the manifest, what an admin may paste, the events
// endpoint's path, the inbound request's timestamp and signature headers, and the envelope read
// after the signature verified.
import { SLACK_LIMITS, SLACK_MANIFEST_VERSION } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { checkIntegrationCall } from "./integrations.ts";
import {
  checkSlackBotToken,
  checkSlackSigningSecret,
  openSlackCredential,
  parseSlackEnvelope,
  parseSlackEventsPath,
  SLACK_PLAIN_TEXT_ESCAPES,
  SLACK_PREVIEW_NAMES_OUTSIDE_DEFAULT_REGION,
  SLACK_ROTATING_TOKEN,
  SLACK_UNNAMED_ARTIFACT,
  slackArtifactLink,
  slackBaseString,
  slackCreateUrl,
  slackCredential,
  slackEventsPath,
  slackManifest,
  slackManifestOutdated,
  slackPlainText,
  slackPreviewBlocks,
  slackPreviewLinks,
  slackPreviewTitle,
  slackSignatureBytes,
  slackTeamMatches,
  slackTimestamp,
  slackUnfurlBody,
} from "./slack.ts";

const ID = `ic_${"0a".repeat(16)}`;
// Built at run time: no committed literal looks like a real token.
const token = (prefix: string) => `${prefix}${"1".repeat(12)}-${"2".repeat(13)}-${"ab".repeat(12)}`;

describe("the manifest", () => {
  const manifest = slackManifest({
    requestUrl: `https://app.portifact.com${slackEventsPath("default", ID)}`,
    unfurlDomains: ["portifact.dev", "app.portifact.com"],
  });

  it("asks for the two link scopes and the three events, with rotation, sockets and org installs off", () => {
    expect(manifest.oauth_config.scopes.bot).toEqual(["links:read", "links:write"]);
    expect(manifest.settings.event_subscriptions.bot_events).toEqual([
      "link_shared",
      "app_uninstalled",
      "tokens_revoked",
    ]);
    expect(manifest.settings.event_subscriptions.request_url).toBe(
      `https://app.portifact.com/integrations/slack/events/default/${ID}`,
    );
    expect(manifest.features.unfurl_domains).toEqual(["portifact.dev", "app.portifact.com"]);
    expect(manifest.settings).toMatchObject({
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    });
    expect(manifest.display_information.name.length).toBeLessThanOrEqual(35);
  });

  it("is carried by Slack's prefilled creation link, URL-encoded", () => {
    const url = new URL(slackCreateUrl(manifest));
    expect(url.origin).toBe("https://api.slack.com");
    expect(url.searchParams.get("new_app")).toBe("1");
    expect(JSON.parse(url.searchParams.get("manifest_json") ?? "")).toEqual(manifest);
  });

  it("tells an older manifest from the current one", () => {
    expect(slackManifestOutdated(null)).toBe(false);
    expect(slackManifestOutdated(SLACK_MANIFEST_VERSION)).toBe(false);
    expect(slackManifestOutdated(SLACK_MANIFEST_VERSION - 1)).toBe(true);
  });
});

describe("what an admin pastes", () => {
  it("takes a bot token and refuses rotating, user and malformed ones with their own messages", () => {
    const bot = token("xoxb-");
    expect(checkSlackBotToken(`  ${bot} `)).toEqual({ ok: true, value: bot });
    const rotating = checkSlackBotToken(token("xoxe.xoxb-"));
    expect(rotating.ok ? null : rotating.message).toBe(SLACK_ROTATING_TOKEN);
    expect(checkSlackBotToken(token("xoxe-")).ok).toBe(false);
    const user = checkSlackBotToken(token("xoxp-"));
    expect(user.ok ? null : user.message).toMatch(/starts with xoxb-/);
    expect(checkSlackBotToken("xoxb-short").ok).toBe(false);
    expect(checkSlackBotToken(`xoxb-${"a".repeat(30)} b`).ok).toBe(false);
    expect(checkSlackBotToken(`xoxb-${"a".repeat(300)}`).ok).toBe(false);
  });

  it("takes a hexadecimal signing secret in any case, and nothing else", () => {
    expect(checkSlackSigningSecret("ABCDEF0123456789abcdef0123456789")).toEqual({
      ok: true,
      value: "abcdef0123456789abcdef0123456789",
    });
    expect(checkSlackSigningSecret("abc").ok).toBe(false);
    expect(checkSlackSigningSecret(`${"g".repeat(32)}`).ok).toBe(false);
  });

  it("seals the pair as one value and opens only a complete pair", () => {
    const bot = token("xoxb-");
    expect(openSlackCredential(slackCredential(bot, "f".repeat(32)))).toEqual({
      botToken: bot,
      signingSecret: "f".repeat(32),
    });
    expect(openSlackCredential("")).toBeNull();
    expect(openSlackCredential("not json")).toBeNull();
    expect(openSlackCredential(JSON.stringify({ botToken: bot }))).toBeNull();
    expect(openSlackCredential(JSON.stringify({ botToken: "", signingSecret: "x" }))).toBeNull();
    expect(openSlackCredential("[1]")).toBeNull();
  });
});

describe("the events endpoint's path", () => {
  it("names a region this build knows and a connection ID, and nothing else", () => {
    expect(parseSlackEventsPath(slackEventsPath("eu", ID))).toEqual({
      region: "eu",
      connectionId: ID,
    });
    for (const path of [
      `/integrations/slack/events/mars/${ID}`,
      `/integrations/slack/events/default/${ID}/`,
      `/integrations/slack/events/default/${ID.toUpperCase()}`,
      "/integrations/slack/events/default/ic_123",
      `/integrations/slack/events/default/${ID}x`,
      "/integrations/slack/events/",
    ]) {
      expect(parseSlackEventsPath(path), path).toBeNull();
    }
  });
});

describe("Slack's calls", () => {
  it("go only to the three Web API methods on slack.com, without a query", () => {
    for (const method of ["auth.test", "auth.revoke", "chat.unfurl"]) {
      expect(checkIntegrationCall("slack", `https://slack.com/api/${method}`).ok).toBe(true);
    }
    for (const url of [
      "https://slack.com/api/chat.postMessage",
      "https://slack.com/api/auth.test?token=x",
      "https://evil.slack.com/api/auth.test",
      "https://hooks.slack.com/api/auth.test",
      "http://slack.com/api/auth.test",
    ]) {
      expect(checkIntegrationCall("slack", url).ok, url).toBe(false);
    }
  });
});

describe("the inbound request's headers", () => {
  const now = 1_762_000_000_000;

  it("takes a timestamp of decimal digits within five minutes, either way", () => {
    const seconds = now / 1000;
    expect(slackTimestamp(String(seconds), now)).toBe(String(seconds));
    expect(slackTimestamp(String(seconds - 300), now)).toBe(String(seconds - 300));
    expect(slackTimestamp(String(seconds + 300), now)).toBe(String(seconds + 300));
    for (const bad of [
      String(seconds - 301),
      String(seconds + 301),
      `${seconds}.5`,
      `+${seconds}`,
      ` ${seconds}`,
      "1e9",
      "0x10",
      "",
      "1".repeat(13),
    ]) {
      expect(slackTimestamp(bad, now), bad).toBeNull();
    }
    expect(slackTimestamp(null, now)).toBeNull();
  });

  it("takes a v0 signature of 64 lowercase hexadecimal characters as its 32 bytes", () => {
    const bytes = slackSignatureBytes(`v0=${"0f".repeat(32)}`);
    expect(bytes?.length).toBe(32);
    expect(bytes?.[0]).toBe(15);
    for (const bad of [
      `v1=${"0f".repeat(32)}`,
      `v0=${"0F".repeat(32)}`,
      `v0=${"0f".repeat(31)}`,
      `v0=${"0f".repeat(32)} `,
      `${"0f".repeat(32)}`,
    ]) {
      expect(slackSignatureBytes(bad), bad).toBeNull();
    }
    expect(slackSignatureBytes(null)).toBeNull();
  });

  it("signs the raw bytes after v0, the timestamp and colons", () => {
    const body = new Uint8Array([0x7b, 0xff, 0x7d]);
    expect([...slackBaseString("17", body)]).toEqual([
      ...new TextEncoder().encode("v0:17:"),
      0x7b,
      0xff,
      0x7d,
    ]);
  });
});

describe("the envelope of a verified request", () => {
  it("reads url_verification and keeps only a safe challenge", () => {
    expect(
      parseSlackEnvelope(JSON.stringify({ type: "url_verification", challenge: "abc_DEF-1" })),
    ).toEqual({
      kind: "url_verification",
      challenge: "abc_DEF-1",
    });
    for (const challenge of ["<script>", "a b", "", "x".repeat(101), 42]) {
      expect(parseSlackEnvelope(JSON.stringify({ type: "url_verification", challenge }))).toEqual({
        kind: "url_verification",
        challenge: null,
      });
    }
  });

  it("reads an event callback's team, its event type and whether its authorizations agree", () => {
    const envelope = {
      type: "event_callback",
      team_id: "T1",
      event: { type: "app_uninstalled" },
      authorizations: [{ team_id: "T1", is_enterprise_install: false }],
    };
    const read = parseSlackEnvelope(JSON.stringify(envelope));
    expect(read).toEqual({
      kind: "event",
      teamId: "T1",
      authorizationsAgree: true,
      eventType: "app_uninstalled",
      links: [],
      unfurlId: null,
      source: null,
    });
    if (read.kind !== "event") throw new Error("not an event");
    expect(slackTeamMatches(read, "T1")).toBe(true);
    expect(slackTeamMatches(read, "T2")).toBe(false);
    expect(slackTeamMatches(read, null)).toBe(false);
    const without = parseSlackEnvelope(JSON.stringify({ ...envelope, authorizations: undefined }));
    expect(without).toMatchObject({ authorizationsAgree: true });
    for (const changed of [
      { authorizations: [{ team_id: "T2", is_enterprise_install: false }] },
      { authorizations: [{ team_id: "T1", is_enterprise_install: true }] },
      { authorizations: [{ team_id: "T1" }] },
      { authorizations: "x" },
      { is_enterprise_install: true },
    ]) {
      const one = parseSlackEnvelope(JSON.stringify({ ...envelope, ...changed }));
      if (one.kind !== "event") throw new Error("not an event");
      expect(one.authorizationsAgree, JSON.stringify(changed)).toBe(false);
      expect(slackTeamMatches(one, "T1")).toBe(false);
    }
    const noTeam = parseSlackEnvelope(JSON.stringify({ type: "event_callback", event: 1 }));
    expect(noTeam).toMatchObject({ teamId: null, eventType: null });
  });

  it("calls anything else other", () => {
    for (const text of ["not json", "[]", "null", JSON.stringify({ type: "app_rate_limited" })]) {
      expect(parseSlackEnvelope(text)).toEqual({ kind: "other" });
    }
  });
});

describe("a link_shared event", () => {
  const envelope = (event: Record<string, unknown>) =>
    parseSlackEnvelope(
      JSON.stringify({
        type: "event_callback",
        team_id: "T1",
        event: { type: "link_shared", ...event },
      }),
    );

  it("keeps the links' URLs, the unfurl ID and the source in their expected shapes", () => {
    expect(
      envelope({
        unfurl_id: "C1.1700000000.000100.abc",
        source: "composer",
        links: [{ url: "https://a.example/" }, { url: 42 }, "x", { url: "y".repeat(2049) }],
      }),
    ).toMatchObject({
      links: ["https://a.example/"],
      unfurlId: "C1.1700000000.000100.abc",
      source: "composer",
    });
    for (const [unfurlId, source] of [
      ["", "composer"],
      ["a b", "composer"],
      ["x".repeat(256), "composer"],
      [1, "composer"],
      ["ok", "elsewhere"],
      ["ok", null],
    ]) {
      const read = envelope({ unfurl_id: unfurlId, source, links: "no" });
      expect(read, String(unfurlId)).toMatchObject({ links: [] });
      if (read.kind !== "event") throw new Error("not an event");
      expect(read.unfurlId === null || read.source === null).toBe(true);
    }
  });

  it("looks at no more than the scan limit of links", () => {
    const links = Array.from({ length: 80 }, (_, i) => ({ url: `https://x.example/${i}` }));
    const read = envelope({ links });
    if (read.kind !== "event") throw new Error("not an event");
    expect(read.links).toHaveLength(SLACK_LIMITS.linksScanned);
  });

  it("reads no links of another event type", () => {
    const read = parseSlackEnvelope(
      JSON.stringify({
        type: "event_callback",
        team_id: "T1",
        event: {
          type: "message",
          links: [{ url: "https://a.example/" }],
          unfurl_id: "u",
          source: "composer",
        },
      }),
    );
    expect(read).toMatchObject({ links: [], unfurlId: null, source: null });
  });
});

describe("which links a preview considers", () => {
  const domains = { contentDomain: "portifact.dev", appHost: "app.portifact.com" };
  const ID = "abcdefgh23";

  it.each([
    [`https://${ID}.portifact.dev`, ID],
    [`https://${ID}.portifact.dev/`, ID],
    [`https://${ID}.portifact.dev/docs/a.html?x=1#y`, ID],
    [`https://${ID}.portifact.dev:443/`, ID],
    [`https://${ID}.portifact.dev?q`, ID],
    [`https://${ID}.portifact.dev#frag`, ID],
    [`https://app.portifact.com/view/${ID}`, ID],
    [`https://app.portifact.com/view/${ID}/`, ID],
    [`https://app.portifact.com/view/${ID}?path=/a.html`, ID],
    [`https://app.portifact.com/view/${ID}/docs#x`, ID],
    [`https://app.portifact.com:443/view/${ID}`, ID],
  ])("accepts %s", (url, id) => {
    expect(slackArtifactLink(url, domains)).toBe(id);
  });

  it.each([
    // Not HTTPS, other ports, userinfo.
    `http://${ID}.portifact.dev/`,
    `HTTPS://${ID}.portifact.dev/`,
    `https://${ID}.portifact.dev:8443/`,
    `https://app.portifact.com:8443/view/${ID}`,
    `https://${ID}.portifact.dev:443@evil.example/`,
    `https://user@${ID}.portifact.dev/`,
    `https://user:pw@app.portifact.com/view/${ID}`,
    // Look-alike hosts, a trailing dot, nested labels, case, punycode, encoding.
    `https://${ID}.portifact.dev.evil.example/`,
    `https://${ID}.portifact.dev./`,
    `https://${ID}.portifact.devx/`,
    `https://x.${ID}.portifact.dev/`,
    `https://${ID}xportifact.dev/`,
    `https://${ID.toUpperCase()}.portifact.dev/`,
    `https://${ID}.PORTIFACT.dev/`,
    `https://xn--${ID}.portifact.dev/`,
    `https://${ID}%2eportifact.dev/`,
    `https://%61bcdefgh23.portifact.dev/`,
    `https://${ID}.portifact.dev\\@evil.example/`,
    `https://app.portifact.com.evil.example/view/${ID}`,
    `https://app.portifact.com./view/${ID}`,
    `https://APP.portifact.com/view/${ID}`,
    // Not an artifact ID.
    "https://abcdefgh1.portifact.dev/",
    "https://abcdefgh01.portifact.dev/",
    "https://abcdefgh234.portifact.dev/",
    "https://portifact.dev/",
    "https://app.portifact.dev/",
    // Other app paths: share links, the protected entry, the dashboard, encoded IDs.
    `https://app.portifact.com/s#token`,
    `https://app.portifact.com/read/${ID}`,
    `https://app.portifact.com/`,
    `https://app.portifact.com/?workspace=x`,
    `https://app.portifact.com/view/`,
    `https://app.portifact.com/view/${ID}x`,
    `https://app.portifact.com/View/${ID}`,
    `https://app.portifact.com/view/%61bcdefgh23`,
    `https://app.portifact.com//view/${ID}`,
    `https://app.portifact.com/x/view/${ID}`,
    // Custom domains and other hosts.
    "https://docs.example.com/",
    `https://portifact.com/view/${ID}`,
    // Whitespace, controls and non-ASCII anywhere.
    ` https://${ID}.portifact.dev/`,
    `https://${ID}.portifact.dev/ a`,
    `https://${ID}.portifact.dev/\u0000`,
    `https://${ID}.portifact.dev/é`,
    `https://${ID}.portifact.dev/${"a".repeat(SLACK_LIMITS.urlMax)}`,
    "",
  ])("ignores %s", (url) => {
    expect(slackArtifactLink(url, domains)).toBeNull();
  });

  it("takes its hosts from configuration, escaping them", () => {
    const staging = {
      contentDomain: "staging.portifact.dev",
      appHost: "app.staging.portifact.com",
    };
    expect(slackArtifactLink(`https://${ID}.staging.portifact.dev/`, staging)).toBe(ID);
    expect(slackArtifactLink(`https://${ID}.portifact.dev/`, staging)).toBeNull();
    expect(slackArtifactLink(`https://${ID}.stagingxportifact.dev/`, staging)).toBeNull();
    expect(slackArtifactLink(`https://app.stagingxportifact.com/view/${ID}`, staging)).toBeNull();
    const local = { contentDomain: "localhost", appHost: "localhost:8787" };
    expect(slackArtifactLink(`https://localhost:8787/view/${ID}`, local)).toBe(ID);
  });

  it("keeps the first five distinct artifacts, every URL of those, and each URL once", () => {
    const ids = [
      "aaaaaaaaaa",
      "bbbbbbbbbb",
      "cccccccccc",
      "dddddddddd",
      "eeeeeeeeee",
      "ffffffffff",
    ];
    const urls = [
      "https://app.portifact.com/s#secret",
      ...ids.map((id) => `https://${id}.portifact.dev/`),
      "https://app.portifact.com/view/aaaaaaaaaa",
      "https://aaaaaaaaaa.portifact.dev/",
    ];
    expect(slackPreviewLinks(urls, domains)).toEqual([
      ...ids.slice(0, 5).map((id) => ({ url: `https://${id}.portifact.dev/`, artifactId: id })),
      { url: "https://app.portifact.com/view/aaaaaaaaaa", artifactId: "aaaaaaaaaa" },
    ]);
    expect(slackPreviewLinks(["https://x.example/"], domains)).toEqual([]);
  });
});

describe("what a preview shows", () => {
  it("cleans and bounds the name, Untitled when empty", () => {
    expect(slackPreviewTitle("  Q3\nplan\u202e\u200b ", "default")).toBe("Q3 plan");
    expect(slackPreviewTitle("\u200b\u2066 \n", "default")).toBe("Untitled");
    // Half a surrogate pair is dropped, a whole pair is kept.
    expect(slackPreviewTitle("a\ud800b\udc00c", "default")).toBe("abc");
    expect(slackPreviewTitle("\ud800", "default")).toBe("Untitled");
    expect(slackPreviewTitle("a\ud83d\ude00b", "default")).toBe("a\ud83d\ude00b");
    const long = slackPreviewTitle("n".repeat(400), "default");
    expect([...long]).toHaveLength(SLACK_LIMITS.nameMax);
    expect(long.endsWith("\u2026")).toBe(true);
  });

  it("names an EU owner's artifact as decided, and only the type when names stay home", () => {
    expect(SLACK_PREVIEW_NAMES_OUTSIDE_DEFAULT_REGION).toBe(true);
    expect(slackPreviewTitle("Q3 plan", "eu")).toBe("Q3 plan");
    expect(slackPreviewTitle("Q3 plan", "eu", false)).toBe(SLACK_UNNAMED_ARTIFACT);
    expect(slackPreviewTitle("Q3 plan", "default", false)).toBe("Q3 plan");
    const blocks = slackPreviewBlocks({ name: "Q3 plan", type: "site" }, "eu", {
      namesOutsideDefault: false,
    });
    expect(JSON.stringify(blocks)).not.toContain("Q3");
    expect(blocks[1]).toEqual({
      type: "context",
      elements: [{ type: "plain_text", text: "Website on Portifact", emoji: false }],
    });
  });

  it("escapes &, < and > in plain_text as decided, or leaves them for release check 7", () => {
    expect(SLACK_PLAIN_TEXT_ESCAPES).toBe(true);
    expect(slackPlainText("<!channel> & <@U1>")).toBe("&lt;!channel&gt; &amp; &lt;@U1&gt;");
    expect(slackPlainText("<!channel> & <@U1>", false)).toBe("<!channel> & <@U1>");
  });

  it.each([
    "<!channel>",
    "<!here|here>",
    "<@U123>",
    "*bold* _it_ ~s~ `c`",
    "<https://example.com|x>",
    ":smile:",
    "a\u202eb\u2066c\u200bd\u200de\ufeff",
    '"},{"type":"section"',
  ])("keeps a hostile name inert: %s", (name) => {
    for (const escapes of [true, false]) {
      const blocks = slackPreviewBlocks({ name, type: "markdown" }, "default", { escapes });
      expect(blocks).toHaveLength(2);
      const section = blocks[0] as {
        type: string;
        text: { type: string; text: string; emoji: boolean };
      };
      expect(section.type).toBe("section");
      expect(section.text.type).toBe("plain_text");
      expect(section.text.emoji).toBe(false);
      expect(section.text.text).not.toMatch(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/);
      if (escapes) expect(section.text.text).not.toMatch(/[<>]/);
      // Round trip: the name is one string value, never structure.
      expect(JSON.parse(JSON.stringify(blocks))).toEqual(blocks);
    }
  });

  it("labels each type in English", () => {
    const label = (type: "site" | "markdown" | "text") =>
      (slackPreviewBlocks({ name: "x", type }, "default")[1] as { elements: { text: string }[] })
        .elements[0]?.text;
    expect([label("site"), label("markdown"), label("text")]).toEqual([
      "Website on Portifact",
      "Markdown document on Portifact",
      "Text document on Portifact",
    ]);
  });

  it("builds the unfurl body keyed by the URLs exactly as sent, with nothing else", () => {
    const url = "https://abcdefgh23.portifact.dev/a?b=1&c=2";
    const body = slackUnfurlBody(
      { unfurlId: "C1.1.abc", source: "conversations_history" },
      [{ url, name: "Q3 plan", type: "markdown" }],
      "default",
    );
    expect(body).toEqual({
      unfurl_id: "C1.1.abc",
      source: "conversations_history",
      unfurls: {
        [url]: {
          blocks: [
            { type: "section", text: { type: "plain_text", text: "Q3 plan", emoji: false } },
            {
              type: "context",
              elements: [
                { type: "plain_text", text: "Markdown document on Portifact", emoji: false },
              ],
            },
          ],
        },
      },
    });
    expect(Object.keys(JSON.parse(JSON.stringify(body)).unfurls)).toEqual([url]);
  });
});
