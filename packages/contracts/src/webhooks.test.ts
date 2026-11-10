import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TombstoneMarker } from "./jobs.ts";
import {
  ListWebhooksInput,
  UpdateWebhookInput,
  WEBHOOK_EVENTS,
  WEBHOOK_FORMAT_NAMES,
  WEBHOOK_LIMITS,
  WEBHOOK_TEST_EVENT,
  WebhookAttempt,
  WebhookCreate,
  WebhookCreated,
  WebhookDeliveries,
  WebhookDeliveryBody,
  WebhookDeliveryId,
  WebhookDisabledReason,
  WebhookId,
  WebhookJobPayload,
  WebhookList,
  WebhookRef,
  WebhookRemoved,
  WebhookState,
  WebhookTestQueued,
  WebhookUpdate,
  WebhookView,
} from "./webhooks.ts";

const ID = `wh_${"a".repeat(32)}`;
const DELIVERY = `whd_${"b".repeat(32)}`;
const at = "2026-11-10T09:00:00.000Z";

describe("webhook shapes", () => {
  it("defaults the format to generic and needs at least one distinct event", () => {
    expect(
      WebhookCreate.parse({ url: "https://hooks.example.com/", events: ["comment.created"] }),
    ).toEqual({
      url: "https://hooks.example.com/",
      format: "generic",
      events: ["comment.created"],
    });
    const empty = WebhookCreate.safeParse({ url: "https://x.example/", events: [] });
    expect(empty.success).toBe(false);
    expect(empty.error?.issues[0]?.message).toBe("Choose at least one event.");
    const twice = WebhookCreate.safeParse({
      url: "https://x.example/",
      events: ["comment.created", "comment.created"],
    });
    expect(twice.error?.issues[0]?.message).toBe("List each event once.");
    expect(
      WebhookCreate.safeParse({ url: "https://x.example/", events: ["webhook.test"] }).success,
    ).toBe(false);
    expect(
      WebhookCreate.safeParse({
        url: `https://x.example/${"a".repeat(WEBHOOK_LIMITS.urlMaxLength)}`,
        events: ["comment.created"],
      }).success,
    ).toBe(false);
    expect(
      WebhookCreate.safeParse({ url: "https://x.example/", events: ["comment.created"], x: 1 })
        .success,
    ).toBe(false);
  });

  it("takes enabled, events or both in an update, and nothing else", () => {
    expect(WebhookUpdate.parse({ enabled: false })).toEqual({ enabled: false });
    expect(WebhookUpdate.parse({ events: ["thread.resolved"] })).toEqual({
      events: ["thread.resolved"],
    });
    const none = WebhookUpdate.safeParse({});
    expect(none.error?.issues[0]?.message).toBe("Send enabled, events or both.");
    expect(WebhookUpdate.safeParse({ enabled: true, url: "https://x.example/" }).success).toBe(
      false,
    );
  });

  it("accepts only webhook IDs", () => {
    expect(WebhookId.safeParse(ID).success).toBe(true);
    for (const bad of ["wh_", `wh_${"A".repeat(32)}`, `wh_${"a".repeat(31)}`, `x${ID}`, `${ID}0`]) {
      expect(WebhookId.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("reads a fresh job and a claimed delivery, and nothing in between", () => {
    expect(WebhookJobPayload.parse({})).toEqual({});
    const delivery = {
      id: DELIVERY,
      webhookId: ID,
      createdAt: at,
      test: false,
      events: [
        {
          type: "artifact.published",
          artifact: {
            id: "abcdefghij",
            name: "Plan",
            url: "https://abcdefghij.portifact.dev/",
            viewUrl: "https://app.portifact.com/view/abcdefghij",
          },
          count: 2,
          firstAt: at,
          lastAt: at,
          actor: null,
          version: 3,
        },
      ],
    };
    expect(WebhookJobPayload.parse({ delivery, attempt: 2, startedAt: null })).toEqual({
      delivery,
      attempt: 2,
      startedAt: null,
    });
    expect(WebhookJobPayload.safeParse({ delivery, attempt: 0, startedAt: null }).success).toBe(
      false,
    );
    expect(WebhookJobPayload.safeParse({ attempt: 1 }).success).toBe(false);
    // A delivery never carries a field outside the documented shape, such as a comment body.
    const extra = { ...delivery, events: [{ ...delivery.events[0], body: "text" }] };
    expect(WebhookDeliveryBody.safeParse(extra).success).toBe(false);
    expect(WebhookDeliveryBody.safeParse({ ...delivery, events: [] }).success).toBe(false);
  });

  it("lets a tombstone name a removed webhook", () => {
    expect(TombstoneMarker.parse({ kind: "webhook", id: ID, deletedAt: 1 })).toEqual({
      kind: "webhook",
      id: ID,
      deletedAt: 1,
    });
  });
});

describe("webhook views and tool inputs", () => {
  const attempt = {
    deliveryId: DELIVERY,
    attempt: 1,
    at,
    outcome: "failed",
    status: null,
    error: "timeout",
  };
  const view = {
    id: ID,
    host: "hooks.example.com",
    format: "slack",
    events: ["comment.created"],
    state: "disabled",
    disabledReason: "gone",
    disabledAt: at,
    failures: 3,
    createdAt: at,
    lastAttempt: attempt,
  };

  it("names exactly the documented values", () => {
    expect(WEBHOOK_TEST_EVENT).toBe("webhook.test");
    expect(WEBHOOK_EVENTS).toEqual([
      "comment.created",
      "thread.resolved",
      "artifact.published",
      "artifact.expiring",
      "artifact.access_changed",
    ]);
    expect(WEBHOOK_FORMAT_NAMES).toEqual(["generic", "slack", "discord"]);
    expect(WebhookState.options).toEqual(["active", "disabled", "paused"]);
    expect(WebhookDisabledReason.options).toEqual(["manual", "failures", "gone", "invalid_url"]);
    expect(WEBHOOK_LIMITS).toMatchObject({
      perOwner: 10,
      eventsPerDelivery: 50,
      timeoutMs: 10_000,
      responseReadBytes: 4_096,
      disableAfterFailures: 15,
      attemptsPerOwnerPerDay: 1_000,
      logDays: 7,
    });
  });

  it("accepts only whole delivery IDs", () => {
    expect(WebhookDeliveryId.safeParse(DELIVERY).success).toBe(true);
    expect(WebhookDeliveryId.safeParse(`x${DELIVERY}`).success).toBe(false);
    expect(WebhookDeliveryId.safeParse(`${DELIVERY}x`).success).toBe(false);
  });

  it("validates every view the API and the tools return", () => {
    expect(WebhookAttempt.parse(attempt)).toEqual(attempt);
    expect(WebhookAttempt.safeParse({ ...attempt, outcome: "lost" }).success).toBe(false);
    expect(WebhookView.parse(view)).toEqual(view);
    for (const bad of [
      { ...view, state: "broken" },
      { ...view, disabledReason: "tired" },
      { ...view, failures: -1 },
      { ...view, format: "teams" },
      { ...view, id: "wh_1" },
    ]) {
      expect(WebhookView.safeParse(bad).success).toBe(false);
    }
    expect(WebhookList.parse({ webhooks: [view], available: false, limit: 10 })).toEqual({
      webhooks: [view],
      available: false,
      limit: 10,
    });
    expect(WebhookList.safeParse({ webhooks: [], available: true, limit: 0 }).success).toBe(false);
    expect(WebhookCreated.parse({ webhook: view, secret: null })).toEqual({
      webhook: view,
      secret: null,
    });
    expect(WebhookCreated.safeParse({ webhook: view }).success).toBe(false);
    expect(
      WebhookDeliveries.parse({ webhookId: ID, attempts: [attempt], retentionDays: 7 }),
    ).toEqual({ webhookId: ID, attempts: [attempt], retentionDays: 7 });
    expect(
      WebhookDeliveries.safeParse({ webhookId: ID, attempts: [], retentionDays: 0 }).success,
    ).toBe(false);
    expect(WebhookTestQueued.safeParse({ webhookId: ID, queued: false }).success).toBe(false);
    expect(WebhookRemoved.safeParse({ webhookId: ID, removed: false }).success).toBe(false);
    expect(WebhookTestQueued.parse({ webhookId: ID, queued: true })).toEqual({
      webhookId: ID,
      queued: true,
    });
    expect(WebhookRemoved.parse({ webhookId: ID, removed: true })).toEqual({
      webhookId: ID,
      removed: true,
    });
  });

  it("describes every tool input for agents", () => {
    const schema = (value: z.ZodType) =>
      z.toJSONSchema(value) as {
        properties?: Record<string, { description?: string }>;
      };
    expect(schema(ListWebhooksInput).properties ?? {}).toEqual({});
    expect(schema(WebhookRef).properties?.webhookId?.description).toBe(
      "The webhook ID, as list_webhooks returns it.",
    );
    const update = schema(UpdateWebhookInput).properties;
    expect(update?.webhookId?.description).toBe("The webhook ID, as list_webhooks returns it.");
    expect(update?.enabled?.description).toBe("true to enable it again, false to stop it.");
    expect(update?.events?.description).toBe("The event types to send from now on.");
    const create = schema(WebhookCreate).properties;
    expect(create?.url?.description).toBe("The HTTPS URL that receives the events.");
    expect(create?.format?.description).toContain("generic (signed JSON)");
    expect(create?.events?.description).toBe("The event types to send.");
    expect(WebhookRef.safeParse({ webhookId: "nope" }).success).toBe(false);
    expect(UpdateWebhookInput.parse({ webhookId: ID, enabled: true })).toEqual({
      webhookId: ID,
      enabled: true,
    });
  });

  it("refuses a delivery event with an unknown type or a bad count", () => {
    const event = {
      type: "webhook.test",
      artifact: null,
      count: 1,
      firstAt: at,
      lastAt: at,
      actor: { name: "Ada" },
    };
    expect(
      WebhookDeliveryBody.safeParse({
        id: DELIVERY,
        webhookId: ID,
        createdAt: at,
        test: true,
        events: [event],
      }).success,
    ).toBe(true);
    for (const bad of [
      { ...event, type: "nope" },
      { ...event, count: 0 },
      { ...event, actor: { name: "A", email: "a@b" } },
      { ...event, access: "everyone" },
    ]) {
      expect(
        WebhookDeliveryBody.safeParse({
          id: DELIVERY,
          webhookId: ID,
          createdAt: at,
          test: true,
          events: [bad],
        }).success,
      ).toBe(false);
    }
  });
});
