// Sample renderings of every email, for scripts/preview.ts and the tests. A new email adds its
// samples here, so `bun run --cwd packages/emails preview` always shows all of them.
import { budgetAlertEmail } from "./budget-alert.ts";
import type { EmailContent } from "./message.ts";
import { signInCodeEmail } from "./sign-in-code.ts";

export interface Preview {
  name: string;
  email: EmailContent;
}

const CREATED_AT = Date.UTC(2026, 10, 8, 12, 0, 0);

export function previews(): Preview[] {
  return [
    {
      name: "sign-in-code",
      email: signInCodeEmail({ email: "ada@example.com", code: "482913", expiresInMinutes: 5 }),
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
  ];
}
