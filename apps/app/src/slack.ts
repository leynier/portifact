// The Slack events endpoint (decision 0025): `POST /integrations/slack/events/<region>/<id>`,
// where a workspace's own Slack app sends its events. Unauthenticated by nature, so nothing in a
// request is trusted, parsed or acted on before its signature verifies with that connection's own
// signing secret, and every refusal after the path matched is the same `401` with an empty body.
// A verified request is always `200`: Slack never retries what Portifact chose to ignore.
//
// Checks, in order (decision 0025, "Order of checks"): method, path, `Content-Type`,
// `Content-Length` and a body read capped at 64 KiB, the timestamp (decimal digits within five
// minutes) and the signature header's shape, all without D1; then one read by primary key and the
// HMAC (`verifySlackRequest`); only then the body is parsed. It reads no cookie, sends no CORS
// header and exists only while Slack is switched on (the app's ordinary 404 otherwise).
//
// D1 calls, pinned in test/slack-cost.test.ts: none before the read; one for every request that
// reaches it (refused, `url_verification`, an ignored event, a `link_shared` with no link worth
// looking up); two for the first request of a connection whose key the Worker lost (read and the
// guarded mark) and for `app_uninstalled` or `tokens_revoked` (read and the guarded mark), whether
// or not the regional database is the global one. A `link_shared` with links worth looking up
// adds the artifacts' read, and with a separate regional database the owner's plan read first
// (with one database the plan comes joined in the connection's read); a token Slack refuses adds
// the guarded mark. A preview writes nothing and calls Slack at most once, after the answer.
import { SLACK_LIMITS } from "@portifact/contracts";
import {
  logEvent,
  parseSlackEnvelope,
  parseSlackEventsPath,
  SLACK_EVENTS_PREFIX,
  type SlackEnvelope,
  slackSignatureBytes,
  slackTeamMatches,
  slackTimestamp,
} from "@portifact/domain";
import { applySlackEvent, type IntegrationFetch, verifySlackRequest } from "@portifact/services";
import { Hono } from "hono";
import { appIntegrationKeys, integrationSwitch } from "./api/integrations.ts";
import { authUrls } from "./auth/config.ts";
import type { Env } from "./env.ts";
import { regionsOf } from "./regions.ts";

export interface SlackEventDeps {
  now(): number;
  /** The network `chat.unfurl` goes through; absent, previews are never sent. */
  fetch?: ((env: Env) => IntegrationFetch) | undefined;
}

const NO_STORE = { "cache-control": "no-store" };

function refused(): Response {
  return new Response(null, { status: 401, headers: NO_STORE });
}

function acknowledged(): Response {
  return new Response(null, { status: 200, headers: NO_STORE });
}

/** The request's own bytes, read without decoding, at most `limit`. */
async function rawBytes(request: Request, limit: number): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let read = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      read += chunk.value.byteLength;
      if (read > limit) return null;
      chunks.push(chunk.value);
    }
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(read);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function slackEventRoutes(deps: SlackEventDeps) {
  const routes = new Hono<{ Bindings: Env }>();

  routes.all(`${SLACK_EVENTS_PREFIX}*`, async (c) => {
    if (!integrationSwitch(c.env).slack) return c.notFound();
    const request = c.req.raw;
    const now = deps.now();
    const target = parseSlackEventsPath(new URL(request.url).pathname);
    const connectionId = target?.connectionId ?? null;
    const refuse = () => {
      logEvent("warn", "slack_event", { connectionId, outcome: "refused" });
      return refused();
    };
    if (request.method !== "POST" || !target) return refuse();
    const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") return refuse();
    const length = request.headers.get("content-length");
    if (
      length !== null &&
      (!/^[0-9]{1,9}$/.test(length) || Number(length) > SLACK_LIMITS.bodyBytes)
    ) {
      return refuse();
    }
    const timestamp = slackTimestamp(request.headers.get("x-slack-request-timestamp"), now);
    const signature = slackSignatureBytes(request.headers.get("x-slack-signature"));
    if (timestamp === null || signature === null) return refuse();
    const regions = regionsOf(c.env);
    // A region this deployment does not hold is refused like any other path.
    if (!regions.all().some((one) => one.region === target.region)) {
      return refuse();
    }
    const body = await rawBytes(request, SLACK_LIMITS.bodyBytes);
    if (body === null) return refuse();
    const db = regions.get(target.region).db;
    const keys = await appIntegrationKeys(c.env);
    const connection = await verifySlackRequest(db, {
      connectionId: target.connectionId,
      timestamp,
      signature,
      body,
      keys,
      now,
    });
    if (!connection) return refuse();

    // Verified: from here on every answer is 200.
    let envelope: SlackEnvelope;
    try {
      envelope = parseSlackEnvelope(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
      );
    } catch {
      envelope = { kind: "other" };
    }
    if (envelope.kind === "url_verification") {
      logEvent("log", "slack_event", { connectionId: connection.id, outcome: "verified" });
      if (envelope.challenge === null) return acknowledged();
      return new Response(JSON.stringify({ challenge: envelope.challenge }), {
        status: 200,
        headers: { ...NO_STORE, "content-type": "application/json" },
      });
    }
    if (envelope.kind === "other") {
      logEvent("log", "slack_event", { connectionId: connection.id, outcome: "ignored" });
      return acknowledged();
    }
    const event = envelope;
    const fetch = deps.fetch?.(c.env);
    // Answered at once; the work goes on after the answer, and nothing it does changes the answer.
    c.executionCtx.waitUntil(
      applySlackEvent(db, {
        connection,
        teamMatches: slackTeamMatches(event, connection.externalId),
        eventType: event.eventType,
        now,
        shared: event,
        preview: fetch && {
          enabled: integrationSwitch(c.env).slack,
          region: target.region,
          domains: {
            contentDomain: c.env.CONTENT_DOMAIN,
            appHost: new URL(authUrls(c.env.APP_ORIGIN).origin).host,
          },
          keys,
          fetch,
        },
      }).then(
        (done) => {
          const { outcome } = done;
          logEvent("log", "slack_event", {
            connectionId: connection.id,
            outcome,
            candidates: done.candidates,
            unfurled: done.unfurled,
          });
        },
        () => {
          logEvent("error", "slack_event", { connectionId: connection.id, outcome: "failed" });
        },
      ),
    );
    return acknowledged();
  });

  return routes;
}
