import {
  WEBHOOK_EVENTS,
  WEBHOOK_LIMITS,
  type WebhookDeliveryBody,
  type WebhookFormat,
} from "@portifact/contracts";
import { describe, expect, it } from "vitest";
import { CLOUDFLARE_HOSTS, isCloudflareHost } from "./cloudflare-hosts.ts";
import {
  bitsToEvents,
  checkReenable,
  checkWebhookUrl,
  classifyAttempt,
  dailyCapReached,
  disablesAfter,
  disableThreshold,
  discordEscape,
  eventBit,
  eventsToBits,
  nextAttemptAt,
  renderDelivery,
  signedContent,
  slackEscape,
  utcDayStart,
} from "./webhooks.ts";

describe("event bits", () => {
  it("gives each event its own bit in the order of WEBHOOK_EVENTS", () => {
    expect(WEBHOOK_EVENTS.map(eventBit)).toEqual([1, 2, 4, 8, 16, 32, 64]);
  });

  it("keeps the meaning of subscriptions stored before the review events", () => {
    // Every value the column held before (1 to 31) decodes to the same five types as then.
    expect(bitsToEvents(31)).toEqual([
      "comment.created",
      "thread.resolved",
      "artifact.published",
      "artifact.expiring",
      "artifact.access_changed",
    ]);
    expect(bitsToEvents(16)).toEqual(["artifact.access_changed"]);
    expect(eventsToBits(["review.requested", "review.completed"])).toBe(96);
    expect(eventsToBits([...WEBHOOK_EVENTS])).toBe(127);
  });

  it("round-trips any subset", () => {
    expect(eventsToBits([])).toBe(0);
    expect(eventsToBits(["artifact.published", "comment.created"])).toBe(5);
    expect(bitsToEvents(5)).toEqual(["comment.created", "artifact.published"]);
    expect(bitsToEvents(127)).toEqual([...WEBHOOK_EVENTS]);
    expect(bitsToEvents(0)).toEqual([]);
  });
});

describe("checkWebhookUrl", () => {
  const accepted: [string, string, string][] = [
    ["https://hooks.example.com/in", "https://hooks.example.com/in", "hooks.example.com"],
    ["https://HOOKS.Example.COM/in?a=1", "https://hooks.example.com/in?a=1", "hooks.example.com"],
    ["https://hooks.example.com:443/x", "https://hooks.example.com/x", "hooks.example.com"],
    ["  https://a.example.org/  ", "https://a.example.org/", "a.example.org"],
    [
      "https://bücher.example.de/h",
      "https://xn--bcher-kva.example.de/h",
      "xn--bcher-kva.example.de",
    ],
    ["https://a-b.c-d.io/h", "https://a-b.c-d.io/h", "a-b.c-d.io"],
    [
      "https://xn--80ak6aa92e.xn--p1ai/",
      "https://xn--80ak6aa92e.xn--p1ai/",
      "xn--80ak6aa92e.xn--p1ai",
    ],
    ["https://myportifact.com/h", "https://myportifact.com/h", "myportifact.com"],
    ["https://localhost.example.com/h", "https://localhost.example.com/h", "localhost.example.com"],
  ];
  it.each(accepted)("accepts %s", (raw, url, host) => {
    expect(checkWebhookUrl(raw, "generic")).toEqual({ ok: true, value: { url, host } });
  });

  const refused: [string, string][] = [
    // Schemes.
    ["http://hooks.example.com/", "https://"],
    ["ftp://hooks.example.com/", "https://"],
    ["javascript:alert(1)", "https://"],
    ["file:///etc/passwd", "https://"],
    ["//hooks.example.com/", "not valid"],
    ["hooks.example.com", "not valid"],
    ["", "not valid"],
    // Ports.
    ["https://hooks.example.com:8443/", "443"],
    ["https://hooks.example.com:80/", "443"],
    ["https://hooks.example.com:0/", "443"],
    // Userinfo.
    ["https://user@hooks.example.com/", "user name"],
    ["https://user:pass@hooks.example.com/", "user name"],
    ["https://:pass@hooks.example.com/", "user name"],
    ["https://example.org@127.0.0.1/", "user name"],
    // Fragments.
    ["https://hooks.example.com/#x", "fragment"],
    // IPv4 in every notation.
    ["https://127.0.0.1/", "IP address"],
    ["https://10.0.0.1/", "IP address"],
    ["https://169.254.169.254/latest/meta-data/", "IP address"],
    ["https://2130706433/", "IP address"],
    ["https://0x7f000001/", "IP address"],
    ["https://0x7f.0.0.1/", "IP address"],
    ["https://0177.0.0.1/", "IP address"],
    ["https://017700000001/", "IP address"],
    ["https://127.1/", "IP address"],
    ["https://0/", "IP address"],
    ["https://1.2.3.4./", "IP address"],
    // IPv6, IPv4-mapped included.
    ["https://[::1]/", "IP address"],
    ["https://[::ffff:127.0.0.1]/", "IP address"],
    ["https://[::ffff:7f00:1]/", "IP address"],
    ["https://[fd00::1]/", "IP address"],
    ["https://[fe80::1%25eth0]/", "not valid"],
    // Internal and reserved names.
    ["https://localhost/", "public DNS name"],
    ["https://localhost./", "end with a dot"],
    ["https://hooks.example.com./", "end with a dot"],
    ["https://a.localhost/", "local or reserved"],
    ["https://LOCALHOST/", "public DNS name"],
    ["https://ｌｏｃａｌｈｏｓｔ/", "public DNS name"],
    ["https://localhost。/", "end with a dot"],
    ["https://printer.local/", "local or reserved"],
    ["https://db.internal/", "local or reserved"],
    ["https://metadata.google.internal/", "local or reserved"],
    ["https://nas.lan/", "local or reserved"],
    ["https://router.home.arpa/", "local or reserved"],
    ["https://1.0.0.127.in-addr.arpa/", "local or reserved"],
    ["https://hooks.test/", "local or reserved"],
    ["https://hooks.example/", "local or reserved"],
    ["https://x.invalid/", "local or reserved"],
    ["https://abc.onion/", "local or reserved"],
    ["https://srv.corp/", "local or reserved"],
    ["https://box.localdomain/", "local or reserved"],
    ["https://intranet/", "public DNS name"],
    ["https://hooks/", "public DNS name"],
    // Portifact and Cloudflare hosts.
    ["https://portifact.com/api/v1/me", "Portifact or Cloudflare"],
    ["https://app.portifact.com/mcp", "Portifact or Cloudflare"],
    ["https://abcdefghij.portifact.dev/", "Portifact or Cloudflare"],
    ["https://APP.PORTIFACT.COM/", "Portifact or Cloudflare"],
    ["https://my-worker.someone.workers.dev/", "Portifact or Cloudflare"],
    ["https://site.pages.dev/", "Portifact or Cloudflare"],
    ["https://api.cloudflare.com/client/v4", "Portifact or Cloudflare"],
    ["https://bucket.r2.dev/", "Portifact or Cloudflare"],
    ["https://acct.r2.cloudflarestorage.com/", "Portifact or Cloudflare"],
    ["https://www.example.com.cdn.cloudflare.net/", "Portifact or Cloudflare"],
    ["https://cloudflare.net/", "Portifact or Cloudflare"],
    ["https://6ff42ae2-765d-4adf-8112-31c55c1551ef.cfargotunnel.com/", "Portifact or Cloudflare"],
    ["https://x.fed-cfargotunnel.com/", "Portifact or Cloudflare"],
    ["https://quiet-river.trycloudflare.com/", "Portifact or Cloudflare"],
    ["https://cloudflare-dns.com/dns-query", "Portifact or Cloudflare"],
    ["https://acct.cloudflare-gateway.com/", "Portifact or Cloudflare"],
    ["https://team.cloudflareaccess.com/", "Portifact or Cloudflare"],
    ["https://one.one.one.one/", "Portifact or Cloudflare"],
    ["https://customer-x.cloudflarestream.com/", "Portifact or Cloudflare"],
    // Malformed and long hosts.
    ["https://-bad.example.com/", "public DNS name"],
    ["https://bad-.example.com/", "public DNS name"],
    ["https://a..example.com/", "public DNS name"],
    ["https://under_score.example.com/", "public DNS name"],
    [`https://${"a".repeat(64)}.example.com/`, "public DNS name"],
    [`https://${Array.from({ length: 5 }, () => "a".repeat(60)).join(".")}.com/`, "too long"],
    [`https://hooks.example.com/${"a".repeat(WEBHOOK_LIMITS.urlMaxLength)}`, "at most"],
  ];
  it.each(refused)("refuses %s", (raw, message) => {
    const result = checkWebhookUrl(raw, "generic");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid_input");
      expect(result.message).toContain(message);
    }
  });

  const formats: [WebhookFormat, string, boolean][] = [
    ["slack", "https://hooks.slack.com/services/T0/B0/xyz", true],
    ["slack", "https://hooks.slack.com/workflows/T0/A0", false],
    ["slack", "https://hooks.example.com/services/T0", false],
    ["slack", "https://evilhooks.slack.com/services/T0", false],
    ["discord", "https://discord.com/api/webhooks/1/abc", true],
    ["discord", "https://discordapp.com/api/webhooks/1/abc", true],
    ["discord", "https://discord.com/api/v10/channels/1", false],
    ["discord", "https://canary.discord.com/api/webhooks/1/abc", false],
    ["generic", "https://hooks.slack.com/services/T0/B0/xyz", true],
  ];
  it.each(formats)("for %s, %s is accepted: %s", (format, raw, accepted) => {
    expect(checkWebhookUrl(raw, format).ok).toBe(accepted);
  });
});

describe("classifyAttempt", () => {
  it("delivers on any 2xx", () => {
    for (const status of [200, 201, 202, 204, 299]) {
      expect(classifyAttempt({ kind: "status", status })).toEqual({
        outcome: "delivered",
        status,
        error: null,
        retryable: false,
        gone: false,
      });
    }
  });

  it("fails a redirect without retrying it", () => {
    for (const status of [300, 301, 302, 307, 308, 399]) {
      expect(classifyAttempt({ kind: "status", status })).toEqual({
        outcome: "failed",
        status,
        error: "redirect",
        retryable: false,
        gone: false,
      });
    }
  });

  it("retries timeouts, network errors, 408, 429 and 5xx, and nothing else", () => {
    const retryable = (status: number) => classifyAttempt({ kind: "status", status }).retryable;
    expect([408, 429, 500, 502, 503, 504, 599].every(retryable)).toBe(true);
    expect([400, 401, 403, 404, 405, 409, 410, 413, 422, 499, 199, 100].some(retryable)).toBe(
      false,
    );
    expect(classifyAttempt({ kind: "timeout" })).toEqual({
      outcome: "failed",
      status: null,
      error: "timeout",
      retryable: true,
      gone: false,
    });
    expect(classifyAttempt({ kind: "network" })).toEqual({
      outcome: "failed",
      status: null,
      error: "network",
      retryable: true,
      gone: false,
    });
  });

  it("marks only a 410 as gone", () => {
    expect(classifyAttempt({ kind: "status", status: 410 })).toEqual({
      outcome: "failed",
      status: 410,
      error: null,
      retryable: false,
      gone: true,
    });
    expect(classifyAttempt({ kind: "status", status: 404 }).gone).toBe(false);
  });
});

describe("retries and caps", () => {
  it("backs off 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours, then stops", () => {
    const now = 1_000;
    expect([1, 2, 3, 4, 5, 6].map((attempt) => nextAttemptAt(attempt, now))).toEqual([
      now + 60_000,
      now + 300_000,
      now + 1_800_000,
      now + 7_200_000,
      now + 21_600_000,
      null,
    ]);
  });

  it("disables on probation after fewer failures", () => {
    expect(disableThreshold(false)).toBe(WEBHOOK_LIMITS.disableAfterFailures);
    expect(disableThreshold(true)).toBe(WEBHOOK_LIMITS.probationFailures);
    expect(disablesAfter(WEBHOOK_LIMITS.probationFailures, true)).toBe(true);
    expect(disablesAfter(WEBHOOK_LIMITS.probationFailures - 1, true)).toBe(false);
    expect(disablesAfter(WEBHOOK_LIMITS.probationFailures, false)).toBe(false);
  });

  it("keeps an automatically disabled webhook off for a cooldown, and caps re-enables a day", () => {
    const at = 1_000_000;
    const cooldown = WEBHOOK_LIMITS.reenableCooldownMs;
    for (const reason of ["failures", "gone"]) {
      const early = checkReenable({
        disabledReason: reason,
        disabledAt: at,
        reenablesToday: 0,
        now: at + cooldown - 1,
      });
      expect(early).toMatchObject({ ok: false, code: "rate_limited" });
      expect(!early.ok && early.message).toContain(new Date(at + cooldown).toISOString());
      expect(
        checkReenable({
          disabledReason: reason,
          disabledAt: at,
          reenablesToday: 0,
          now: at + cooldown,
        }),
      ).toEqual({ ok: true, value: true });
    }
    for (const reason of ["manual", "invalid_url", "key_unavailable", "unavailable", null]) {
      expect(
        checkReenable({ disabledReason: reason, disabledAt: at, reenablesToday: 0, now: at }).ok,
      ).toBe(true);
    }
    expect(
      checkReenable({
        disabledReason: "manual",
        disabledAt: at,
        reenablesToday: WEBHOOK_LIMITS.reenablesPerDay - 1,
        now: at,
      }).ok,
    ).toBe(true);
    expect(
      checkReenable({
        disabledReason: "manual",
        disabledAt: at,
        reenablesToday: WEBHOOK_LIMITS.reenablesPerDay,
        now: at,
      }),
    ).toMatchObject({ ok: false, code: "rate_limited" });
    expect(
      checkReenable({ disabledReason: "failures", disabledAt: null, reenablesToday: 0, now: at })
        .ok,
    ).toBe(true);
  });

  it("disables at the limit of failures in a row, not before", () => {
    expect(disablesAfter(WEBHOOK_LIMITS.disableAfterFailures - 1)).toBe(false);
    expect(disablesAfter(WEBHOOK_LIMITS.disableAfterFailures)).toBe(true);
    expect(disablesAfter(WEBHOOK_LIMITS.disableAfterFailures + 1)).toBe(true);
  });

  it("caps attempts per owner and UTC day at the boundary", () => {
    expect(dailyCapReached(WEBHOOK_LIMITS.attemptsPerOwnerPerDay - 1)).toBe(false);
    expect(dailyCapReached(WEBHOOK_LIMITS.attemptsPerOwnerPerDay)).toBe(true);
    const at = Date.parse("2026-11-10T23:59:59.999Z");
    expect(utcDayStart(at)).toBe(Date.parse("2026-11-10T00:00:00Z"));
    expect(utcDayStart(Date.parse("2026-11-11T00:00:00Z"))).toBe(
      Date.parse("2026-11-11T00:00:00Z"),
    );
  });

  it("signs the Standard Webhooks content", () => {
    expect(signedContent("whd_1", 1_700_000_000, '{"a":1}')).toBe('whd_1.1700000000.{"a":1}');
  });
});

const ID = `whd_${"a".repeat(32)}`;
const HOOK = `wh_${"b".repeat(32)}`;
const artifact = {
  id: "abcdefghij",
  name: "Q3 <plan> & @everyone",
  url: "https://abcdefghij.portifact.dev/",
  viewUrl: "https://app.portifact.com/view/abcdefghij",
};
const at = "2026-11-10T09:00:00.000Z";

function delivery(events: WebhookDeliveryBody["events"], test = false): WebhookDeliveryBody {
  return { id: ID, webhookId: HOOK, createdAt: at, test, events };
}

const sample = delivery([
  { type: "comment.created", artifact, count: 3, firstAt: at, lastAt: at, actor: null },
  { type: "comment.created", artifact, count: 1, firstAt: at, lastAt: at, actor: { name: "Ada" } },
  { type: "thread.resolved", artifact, count: 2, firstAt: at, lastAt: at, actor: null },
  { type: "thread.resolved", artifact, count: 1, firstAt: at, lastAt: at, actor: null },
  {
    type: "artifact.published",
    artifact,
    count: 1,
    firstAt: at,
    lastAt: at,
    actor: null,
    version: 4,
  },
  {
    type: "artifact.expiring",
    artifact,
    count: 1,
    firstAt: at,
    lastAt: at,
    actor: null,
    expiresAt: "2026-11-17T09:00:00.000Z",
  },
  {
    type: "artifact.access_changed",
    artifact,
    count: 1,
    firstAt: at,
    lastAt: at,
    actor: null,
    access: "restricted",
  },
]);

describe("renderDelivery", () => {
  it("sends the generic body as it is", () => {
    expect(JSON.parse(renderDelivery("generic", sample))).toEqual(sample);
  });

  it("writes one escaped Slack line per event, without actors or IDs", () => {
    const body = JSON.parse(renderDelivery("slack", sample)) as { text: string };
    const link = "<https://app.portifact.com/view/abcdefghij|Q3 &lt;plan&gt; &amp; @everyone>";
    expect(body).toEqual({
      text: [
        `3 new comments on ${link}`,
        `1 new comment on ${link}`,
        `2 threads resolved on ${link}`,
        `1 thread resolved on ${link}`,
        `New version 4 of ${link}`,
        `${link} expires 2026-11-17`,
        `Access to ${link} changed (now restricted)`,
      ].join("\n"),
    });
    expect(body.text).not.toContain("Ada");
    expect(body.text).not.toContain(ID);
  });

  it("writes escaped Discord lines with mentions turned off", () => {
    const body = JSON.parse(renderDelivery("discord", sample)) as {
      content: string;
      allowed_mentions: unknown;
    };
    expect(body.allowed_mentions).toEqual({ parse: [] });
    const name = "Q3 \\<plan\\> & \\@everyone";
    expect(body.content.split("\n")[0]).toBe(
      `3 new comments on ${name} (<https://app.portifact.com/view/abcdefghij>)`,
    );
    expect(body.content).not.toMatch(/(^|[^\\])@everyone/);
    expect(body.content).not.toContain("Ada");
  });

  it("says what a test event is", () => {
    const test = delivery(
      [{ type: "webhook.test", artifact: null, count: 1, firstAt: at, lastAt: at, actor: null }],
      true,
    );
    expect(JSON.parse(renderDelivery("slack", test))).toEqual({
      text: "Test event from Portifact: this webhook works.",
    });
  });

  it("caps a chat message and says how many lines were left out", () => {
    const many = delivery(
      Array.from({ length: 50 }, () => ({
        type: "comment.created" as const,
        artifact: { ...artifact, name: "n".repeat(300) },
        count: 1,
        firstAt: at,
        lastAt: at,
        actor: null,
      })),
    );
    const discord = JSON.parse(renderDelivery("discord", many)) as { content: string };
    expect(discord.content.length).toBeLessThanOrEqual(2_000);
    expect(discord.content).toMatch(/\nand \d+ more$/);
    // Names are capped at 100 characters in chat lines.
    expect(discord.content).toContain(`${"n".repeat(99)}…`);
    const slack = JSON.parse(renderDelivery("slack", many)) as { text: string };
    expect(slack.text.length).toBeLessThanOrEqual(3_100);
  });

  it("removes control characters from names and names an empty one", () => {
    const odd = delivery([
      {
        type: "artifact.published",
        artifact: { ...artifact, name: "a\nb\u0000c" },
        count: 1,
        firstAt: at,
        lastAt: at,
        actor: null,
      },
      {
        type: "artifact.published",
        artifact: { ...artifact, name: "\n" },
        count: 1,
        firstAt: at,
        lastAt: at,
        actor: null,
      },
    ]);
    const { text } = JSON.parse(renderDelivery("slack", odd)) as { text: string };
    expect(text.split("\n")).toEqual([
      "New version of <https://app.portifact.com/view/abcdefghij|a b c>",
      "New version of <https://app.portifact.com/view/abcdefghij|Untitled>",
    ]);
  });
});

describe("review events", () => {
  const counts = { reviewers: 3, required: 2, approvals: 2, changesRequested: 0 };
  const reviews = delivery([
    {
      type: "review.requested",
      artifact,
      count: 1,
      firstAt: at,
      lastAt: at,
      actor: { name: "Ada" },
      version: 3,
      review: { ...counts, status: "pending", approvals: 0 },
    },
    {
      type: "review.completed",
      artifact,
      count: 1,
      firstAt: at,
      lastAt: at,
      actor: null,
      version: 3,
      review: { ...counts, status: "approved" },
    },
    {
      type: "review.completed",
      artifact,
      count: 2,
      firstAt: at,
      lastAt: at,
      actor: null,
      version: 4,
      review: { ...counts, status: "changes_requested", approvals: 1, changesRequested: 1 },
    },
    {
      type: "review.completed",
      artifact,
      count: 1,
      firstAt: at,
      lastAt: at,
      actor: null,
      review: { ...counts, status: "changes_requested", approvals: 0, changesRequested: 2 },
    },
    { type: "review.requested", artifact, count: 1, firstAt: at, lastAt: at, actor: null },
  ]);

  it("sends the status and counts in the generic body", () => {
    expect(JSON.parse(renderDelivery("generic", reviews))).toEqual(reviews);
  });

  it("writes Slack and Discord lines with the version and counts, never a name", () => {
    const slack = JSON.parse(renderDelivery("slack", reviews)) as { text: string };
    const link = "<https://app.portifact.com/view/abcdefghij|Q3 &lt;plan&gt; &amp; @everyone>";
    expect(slack.text.split("\n")).toEqual([
      `Review requested on ${link} (version 3, 0 of 2 approvals)`,
      `Approved: ${link} (version 3, 2 of 2 approvals)`,
      `Changes requested on ${link} (version 4, 1 of 2 approvals, 1 asked for changes)`,
      `Changes requested on ${link} (0 of 2 approvals, 2 asked for changes)`,
      `Review requested on ${link}`,
    ]);
    expect(slack.text).not.toContain("Ada");
    const discord = JSON.parse(renderDelivery("discord", reviews)) as { content: string };
    expect(discord.content.split("\n")[1]).toBe(
      "Approved: Q3 \\<plan\\> & \\@everyone (<https://app.portifact.com/view/abcdefghij>) (version 3, 2 of 2 approvals)",
    );
    expect(discord.content).not.toContain("Ada");
  });
});

describe("escaping", () => {
  it("escapes Slack's three control characters only", () => {
    expect(slackEscape("<!channel> & <http://x|y>")).toBe(
      "&lt;!channel&gt; &amp; &lt;http://x|y&gt;",
    );
    expect(slackEscape("*bold* _it_")).toBe("*bold* _it_");
  });

  it("escapes every Discord formatting, link and mention character", () => {
    expect(discordEscape("[a](http://x) **b** @here <#1> `c` ~d~ |e| > -f #g :h: !i")).toBe(
      "\\[a\\]\\(http\\://x\\) \\*\\*b\\*\\* \\@here \\<\\#1\\> \\`c\\` \\~d\\~ \\|e\\| \\> \\-f \\#g \\:h\\: \\!i",
    );
  });
});

describe("Cloudflare hosts", () => {
  it("refuses each listed domain and its subdomains, and nothing that only ends like one", () => {
    for (const { domain, source } of CLOUDFLARE_HOSTS) {
      expect(isCloudflareHost(domain), domain).toBe(true);
      expect(isCloudflareHost(`a.b.${domain}`), domain).toBe(true);
      expect(isCloudflareHost(`not${domain}`), domain).toBe(false);
      expect(source.startsWith("developers.cloudflare.com/"), domain).toBe(true);
    }
    expect(isCloudflareHost("hooks.example.com")).toBe(false);
  });
});
