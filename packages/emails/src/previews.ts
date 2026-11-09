// Sample renderings of every email, for scripts/preview.ts and the tests. A new email adds its
// samples here, so `bun run --cwd packages/emails preview` always shows all of them.
import { budgetAlertEmail } from "./budget-alert.ts";
import { expiryNoticeEmail } from "./expiry-notice.ts";
import type { EmailContent } from "./message.ts";
import { signInCodeEmail } from "./sign-in-code.ts";

export interface Preview {
  name: string;
  email: EmailContent;
}

const CREATED_AT = Date.UTC(2026, 10, 8, 12, 0, 0);
const HOUR = 3_600_000;

const noticeArtifact = (id: string, name: string, hoursLeft: number) => ({
  name,
  url: `https://${id}.portifact.dev/`,
  renewUrl: `https://app.portifact.com/artifacts/${id}`,
  expiresAt: CREATED_AT + hoursLeft * HOUR,
});
const notice = {
  settingsUrl: "https://app.portifact.com/settings",
  activeDays: 30,
  archiveMonths: 6,
};

export function previews(): Preview[] {
  return [
    {
      name: "sign-in-code",
      email: signInCodeEmail({ email: "ada@example.com", code: "482913", expiresInMinutes: 5 }),
    },
    {
      name: "sign-in-code-es",
      email: signInCodeEmail({
        email: "ada@example.com",
        code: "482913",
        expiresInMinutes: 5,
        locale: "es",
      }),
    },
    {
      name: "budget-alert",
      email: budgetAlertEmail({
        alerts: [
          { kind: "spend_75", projectedUsd: 111.4, createdAt: CREATED_AT },
          { kind: "spend_100", projectedUsd: 111.4, createdAt: CREATED_AT },
        ],
        projectedUsd: 111.4,
        level: "protect100",
        actions: ["stop_new_artifacts", "block_uploads", "pause_annotation_writes"],
      }),
    },
    {
      name: "budget-alert-no-protection",
      email: budgetAlertEmail({
        alerts: [{ kind: "spend_25", projectedUsd: 25, createdAt: CREATED_AT }],
        projectedUsd: 25,
        level: "alert25",
        actions: [],
      }),
    },
    {
      name: "expiry-notice",
      email: expiryNoticeEmail({
        ...notice,
        artifacts: [
          noticeArtifact("k7d2qm4xab", "Q3 launch plan", 50),
          noticeArtifact("p4n8rt2vcd", "Design review notes", 66),
          noticeArtifact("z9w3hj6mef", "API prototype", 71),
        ],
      }),
    },
    {
      name: "expiry-notice-one",
      email: expiryNoticeEmail({
        ...notice,
        artifacts: [noticeArtifact("k7d2qm4xab", "Q3 launch plan", 70)],
      }),
    },
  ];
}
