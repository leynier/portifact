// Slack connection rules (decision 0025): the manifest, what an admin may paste, the events
// endpoint's path, the inbound request's timestamp and signature headers, and the envelope read
// after the signature verified.
import { SLACK_MANIFEST_VERSION } from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { checkIntegrationCall } from "./integrations.ts";
import {
  checkSlackBotToken,
  checkSlackSigningSecret,
  openSlackCredential,
  parseSlackEnvelope,
  parseSlackEventsPath,
  SLACK_ROTATING_TOKEN,
  slackBaseString,
  slackCreateUrl,
  slackCredential,
  slackEventsPath,
  slackManifest,
  slackManifestOutdated,
  slackSignatureBytes,
  slackTeamMatches,
  slackTimestamp,
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
