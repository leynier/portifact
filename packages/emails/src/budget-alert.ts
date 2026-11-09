// The budget alert the jobs Worker sends the operator (docs/operations.md): what was crossed,
// what protection applies and the command that shows more.
import { type Block, renderEmail } from "./layout.ts";
import type { EmailContent } from "./message.ts";

export interface BudgetAlertInput {
  alerts: { kind: string; projectedUsd: number; createdAt: number }[];
  projectedUsd: number;
  level: string;
  /** Protection steps in effect; empty when none. */
  actions: string[];
}

export const BUDGET_COMMAND = "bun run --cwd apps/jobs operator budget";

const usd = (value: number) => `US$${value.toFixed(2)}`;

export function budgetAlertEmail(input: BudgetAlertInput): EmailContent {
  const projected = usd(input.projectedUsd);
  const protection = input.actions.length > 0 ? input.actions.join(", ") : "none";
  const alerts = input.alerts.map(
    (alert) =>
      `${alert.kind} at ${usd(alert.projectedUsd)} (${new Date(alert.createdAt).toISOString()})`,
  );
  const subject = `Portifact budget: projected ${projected} this cycle (${input.level})`;

  const alertBlocks: Block[] =
    alerts.length > 0
      ? [
          { kind: "paragraph", content: [{ strong: "New alerts" }] },
          { kind: "list", items: alerts },
        ]
      : [];

  const html = renderEmail({
    title: subject,
    preheader: `Level ${input.level}. Protection in effect: ${protection}.`,
    heading: `Projected spend: ${projected}`,
    blocks: [
      { kind: "paragraph", content: ["The budget run recorded new alerts for this cycle."] },
      {
        kind: "facts",
        rows: [
          { label: "Projected this cycle", value: projected },
          { label: "Level", value: input.level },
          { label: "Protection in effect", value: protection },
        ],
      },
      ...alertBlocks,
      { kind: "paragraph", content: ["Details and the override:"] },
      { kind: "command", value: BUDGET_COMMAND },
    ],
    footer: "You receive budget alerts because this address is the jobs Worker's BUDGET_ALERT_TO.",
  });

  const text = [
    `Projected spend this cycle: ${projected}.`,
    `Level: ${input.level}.`,
    `Protection in effect: ${protection}.`,
    "",
    "New alerts:",
    ...alerts.map((line) => `- ${line}`),
    "",
    `Details and override: ${BUDGET_COMMAND}`,
  ].join("\n");

  return { subject, text, html };
}
