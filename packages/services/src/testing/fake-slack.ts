// A fake Slack for tests and the e2e stack (decision 0025): never the real Slack. Its `fetch`
// answers the Web API methods Portifact calls (`auth.test`, `auth.revoke`) for the bot and user
// tokens a test registers, and `signedEvent` builds an inbound request signed the way Slack
// signs (`v0=` and the HMAC-SHA-256 of `v0:<timestamp>:<body>` with the app's signing secret).
// Tokens and secrets are made at run time, so no literal that looks like a real credential is
// ever committed. Never imported by a deployed Worker.

export interface FakeSlackRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

interface FakeSlackToken {
  team: string;
  teamId: string;
  /** Absent for a user token. */
  botId?: string;
}

type Scripted = Response | "network" | "hang";

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomDigits(length: number): string {
  return [...crypto.getRandomValues(new Uint8Array(length))].map((b) => String(b % 10)).join("");
}

export class FakeSlack {
  readonly requests: FakeSlackRequest[] = [];
  /** Tokens revoked with `auth.revoke`. */
  readonly revoked = new Set<string>();
  private readonly tokens = new Map<string, FakeSlackToken>();
  private readonly script: Scripted[] = [];

  /** A bot token in Slack's shape, made at run time (`xoxb-` and digits and letters). */
  static botToken(): string {
    return `xoxb-${randomDigits(12)}-${randomDigits(13)}-${randomHex(12)}`;
  }

  /** A rotating access token, which Portifact refuses (`xoxe.xoxb-`). */
  static rotatingToken(): string {
    return `xoxe.xoxb-1-${randomHex(24)}`;
  }

  /** A user token (`xoxp-`), which `auth.test` answers without a `bot_id`. */
  static userToken(): string {
    return `xoxp-${randomDigits(12)}-${randomDigits(12)}-${randomHex(12)}`;
  }

  /** A signing secret in Slack's shape: 32 hexadecimal characters. */
  static signingSecret(): string {
    return randomHex(16);
  }

  /** Registers a bot token of an app installed in a Slack workspace. */
  bot(token: string, team = "Acme", teamId = "T0ACME01") {
    // No random value here: the e2e stack registers its bot at module load, where workerd
    // refuses them.
    this.tokens.set(token, {
      team,
      teamId,
      botId: `B${String(this.tokens.size + 1).padStart(8, "0")}`,
    });
    return this;
  }

  /** Registers a user token: `auth.test` succeeds without a `bot_id`. */
  user(token: string, team = "Acme", teamId = "T0ACME01") {
    this.tokens.set(token, { team, teamId });
    return this;
  }

  /** The next answers, in order, before the fake's own. */
  next(...answers: Scripted[]) {
    this.script.push(...answers);
    return this;
  }

  /** The network the services take (`IntegrationFetch`). */
  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === "string" ? init.body : "";
    this.requests.push({ url, method: init.method ?? "GET", headers, body });
    const scripted = this.script.shift();
    if (scripted === "network") throw new TypeError("connection refused");
    if (scripted === "hang") {
      return new Promise<Response>((_, reject) => {
        const signal = init.signal;
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (scripted instanceof Response) return scripted;
    return this.answer(url, init.method ?? "GET", headers);
  };

  private answer(url: string, method: string, headers: Record<string, string>): Response {
    const parsed = new URL(url);
    if (parsed.origin !== "https://slack.com" || method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    const token = /^Bearer (.+)$/.exec(headers.authorization ?? "")?.[1];
    if (!token) return Response.json({ ok: false, error: "not_authed" });
    const known = this.tokens.get(token);
    if (!known) return Response.json({ ok: false, error: "invalid_auth" });
    if (this.revoked.has(token)) return Response.json({ ok: false, error: "token_revoked" });
    if (parsed.pathname === "/api/auth.test") {
      return Response.json({
        ok: true,
        url: "https://acme.slack.com/",
        team: known.team,
        user: "portifact",
        team_id: known.teamId,
        user_id: `U${randomDigits(8)}`,
        ...(known.botId ? { bot_id: known.botId } : {}),
      });
    }
    if (parsed.pathname === "/api/auth.revoke") {
      this.revoked.add(token);
      return Response.json({ ok: true, revoked: true });
    }
    return Response.json({ ok: false, error: "unknown_method" });
  }

  /** The `X-Slack-Signature` Slack sends for `body` at `timestamp` (seconds) with `secret`. */
  static async signature(secret: string, timestamp: string, body: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`v0:${timestamp}:${body}`),
    );
    return `v0=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  /** An inbound request as Slack sends one to the events endpoint, signed with `secret`. */
  static async signedEvent(
    secret: string,
    payload: unknown,
    options: { now?: number; timestamp?: string } = {},
  ): Promise<RequestInit> {
    const body = JSON.stringify(payload);
    const timestamp = options.timestamp ?? String(Math.floor((options.now ?? Date.now()) / 1000));
    return {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": await FakeSlack.signature(secret, timestamp, body),
      },
      body,
    };
  }

  /** The envelope of an event Slack sends for a Slack workspace. */
  static event(teamId: string, type: string, extra: Record<string, unknown> = {}) {
    return {
      token: "unused-verification-token",
      team_id: teamId,
      api_app_id: "A0PORTIFACT",
      event: { type, ...extra },
      type: "event_callback",
      event_id: `Ev${randomDigits(10)}`,
      event_time: 1_700_000_000,
      authorizations: [
        {
          enterprise_id: null,
          team_id: teamId,
          user_id: "U0BOT",
          is_bot: true,
          is_enterprise_install: false,
        },
      ],
      is_enterprise_install: false,
    };
  }
}
