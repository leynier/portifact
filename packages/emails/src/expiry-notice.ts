// The expiry notice the jobs Worker sends an owner a few days before their artifacts expire
// (docs/operations.md, "Expiry notices"): one email per account listing every artifact about to
// expire, each with its link, its expiry and where to renew it, and how to turn the emails off.
// Names are the owner's own input and are only ever escaped, never put in the subject.
import { type Block, type Inline, renderEmail } from "./layout.ts";
import type { EmailContent } from "./message.ts";

export interface ExpiryNoticeArtifact {
  name: string;
  /** The artifact's public address, `https://<id>.portifact.dev/`. */
  url: string;
  /** Its page in the dashboard, where the owner renews it. */
  renewUrl: string;
  expiresAt: number;
}

export interface ExpiryNoticeInput {
  /** Soonest first; at least one. */
  artifacts: ExpiryNoticeArtifact[];
  /** The dashboard's settings page, where the notices are turned off. */
  settingsUrl: string;
  /** How long a renewal keeps an artifact online. */
  activeDays: number;
  /** How long an expired artifact can still be restored. */
  archiveMonths: number;
}

const DATE = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** An expiry as the email shows it, always in UTC: `Wed, Nov 11, 2026, 12:00 UTC`. */
export function formatExpiry(at: number): string {
  return `${DATE.format(new Date(at))} UTC`;
}

/** A name on one line, so a line break in it cannot fake another entry in the text version. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: replacing control characters is the point
const oneLine = (name: string) => name.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();

const display = (url: string) => url.replace(/^https:\/\//, "").replace(/\/$/, "");

export function expiryNoticeEmail(input: ExpiryNoticeInput): EmailContent {
  const count = input.artifacts.length;
  const one = count === 1;
  const subject = one
    ? "Your Portifact artifact expires soon"
    : `${count} of your Portifact artifacts expire soon`;
  const heading = one ? "An artifact expires soon" : `${count} artifacts expire soon`;
  const soonest = input.artifacts[0];
  const preheader = soonest
    ? `Renew before ${formatExpiry(soonest.expiresAt)} to keep ${one ? "it" : "them"} online.`
    : "";
  const intro = `When an artifact expires it stops being served and is archived. Renew it, or publish it again, to keep it online for another ${input.activeDays} days.`;
  const restore = `An artifact you let expire is not deleted: you can restore it from the dashboard for ${input.archiveMonths} months.`;
  const optOut = "Do not want these emails? Turn off expiry notices in your settings:";
  const reason = "You received this email because you own these artifacts on Portifact.";

  const items: Inline[][] = input.artifacts.map((artifact) => [
    { strong: oneLine(artifact.name) },
    ` expires ${formatExpiry(artifact.expiresAt)}. `,
    { href: artifact.url, text: display(artifact.url) },
    " | ",
    { href: artifact.renewUrl, text: "Renew" },
  ]);
  const blocks: Block[] = [
    { kind: "paragraph", content: [intro] },
    { kind: "list", items },
    { kind: "divider" },
    { kind: "paragraph", content: [restore], muted: true },
    {
      kind: "paragraph",
      content: [`${optOut} `, { href: input.settingsUrl, text: "Settings" }, "."],
      muted: true,
    },
  ];

  const html = renderEmail({ title: subject, preheader, heading, blocks, footer: reason });

  const text = [
    heading,
    "",
    intro,
    "",
    ...input.artifacts.flatMap((artifact) => [
      `- ${oneLine(artifact.name)}`,
      `  Expires ${formatExpiry(artifact.expiresAt)}`,
      `  ${artifact.url}`,
      `  Renew: ${artifact.renewUrl}`,
    ]),
    "",
    restore,
    `${optOut} ${input.settingsUrl}`,
    "",
    reason,
    "Portifact, https://portifact.com",
  ].join("\n");

  return { subject, text, html };
}
