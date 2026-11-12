// The Audit page's words for the events of Slack connections (decision 0025), in every catalog:
// a connection with no targets states no count, an uninstalled app is never called a refusal, and
// every service select names Slack.
import type { AuditEventView } from "@portifact/contracts";
import { LOCALE_CODES } from "@portifact/contracts/locales";
import { describe, expect, it } from "vitest";
import { CATALOG_LOADERS, createI18n } from "./i18n/i18n.ts";
import { describeAuditEvent } from "./screens/audit.tsx";

const catalogs = await Promise.all(
  LOCALE_CODES.map(async (code) => [code, await CATALOG_LOADERS[code]()] as const),
);

const ev = (kind: string, detail: Record<string, unknown>) =>
  ({
    id: "e",
    at: "2026-11-12T09:00:00.000Z",
    kind,
    actor: { type: "system" },
    target: { type: "integration_connection", id: "ic_x" },
    artifact: null,
    detail,
  }) as unknown as AuditEventView;

function describeIn(
  code: (typeof LOCALE_CODES)[number],
  kind: string,
  detail: Record<string, unknown>,
) {
  const found = catalogs.find(([c]) => c === code);
  if (!found) throw new Error(code);
  const i18n = createI18n(code, found[1]);
  const t = (id: string, values?: Record<string, unknown>) => i18n._(id as never, values);
  return describeAuditEvent(t as never, ev(kind, detail), code, (s) => s);
}

describe("Slack in the audit log", () => {
  it("describes Slack audit events truthfully in English", () => {
    const connected = describeIn("en", "integration.connected", { service: "slack", targets: 0 });
    const failing = describeIn("en", "integration.failing", {
      service: "slack",
      reason: "app_uninstalled",
    });
    expect(connected).toBe("Connected Slack");
    expect(connected).not.toMatch(/repositor/);
    expect(failing).toBe("The Slack app behind a connection was uninstalled");
    expect(failing).not.toMatch(/refused/);
    expect(describeIn("en", "integration.removed", { service: "slack" })).toBe(
      "Removed a Slack connection",
    );
    expect(
      describeIn("en", "integration.failing", { service: "slack", reason: "credential_rejected" }),
    ).toBe("Slack refused a connection's credential");
    expect(
      describeIn("en", "integration.failing", { service: "slack", reason: "key_unavailable" }),
    ).toBe("A connection's credential can no longer be opened");
    expect(describeIn("en", "integration.changed", { credential: true })).toBe(
      "Replaced a connection's credential",
    );
    // A connection with targets keeps its count.
    expect(describeIn("en", "integration.connected", { service: "github", targets: 2 })).toBe(
      "Connected GitHub with 2 repositories or teams",
    );
  });

  it.each(LOCALE_CODES)("names Slack and states no count or refusal in %s", (code) => {
    const english = {
      connected: describeIn("en", "integration.connected", { service: "slack", targets: 0 }),
      failing: describeIn("en", "integration.failing", {
        service: "slack",
        reason: "app_uninstalled",
      }),
      refused: describeIn("en", "integration.failing", {
        service: "slack",
        reason: "credential_rejected",
      }),
    };
    const connected = describeIn(code, "integration.connected", { service: "slack", targets: 0 });
    expect(connected).toContain("Slack");
    expect(connected).not.toMatch(/\b0\b|\bslack\b/);
    expect(describeIn(code, "integration.removed", { service: "slack" })).toContain("Slack");
    const failing = describeIn(code, "integration.failing", {
      service: "slack",
      reason: "app_uninstalled",
    });
    const refused = describeIn(code, "integration.failing", {
      service: "slack",
      reason: "credential_rejected",
    });
    // The uninstall has its own sentence, never the refusal's.
    expect(failing).not.toBe(refused);
    expect(refused).toContain("Slack");
    if (code === "en") {
      expect([connected, failing, refused]).toEqual([
        english.connected,
        english.failing,
        english.refused,
      ]);
    }
  });
});
