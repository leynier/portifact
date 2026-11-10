// The expiry notice the jobs Worker sends an owner a few days before their artifacts expire
// (docs/operations.md, "Expiry notices"): one email per account listing every artifact about to
// expire, each with its link, its expiry and where to renew it, and how to turn the emails off.
// Names are the owner's own input and are only ever escaped, never put in the subject, and left
// out with `names: false` (decision 0005: a workspace whose data stays in the EU), where each
// artifact is listed by its address instead. It is
// written in the owner's language (account settings), English when they chose none; the texts
// are typed by the locale list, so a new language fails the typecheck until it is here.
import { DEFAULT_LOCALE, type LocaleCode } from "@portifact/contracts/locales";
import { type Block, type Inline, renderEmail } from "./layout.ts";
import type { EmailContent } from "./message.ts";
import { pluralCategory, pluralForm } from "./plural.ts";

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
  /** Whether artifact names may appear; false lists each by its address. True when absent. */
  names?: boolean | undefined;
  /** The dashboard's settings page, where the notices are turned off. */
  settingsUrl: string;
  /** How long a renewal keeps an artifact online. */
  activeDays: number;
  /** How long an expired artifact can still be restored. */
  archiveMonths: number;
  /** The owner's language; English when absent. */
  locale?: LocaleCode | undefined;
}

/** The text of the notice in one language. Dates come in already formatted, with "UTC". */
export interface ExpiryText {
  subject(count: number): string;
  heading(count: number): string;
  /** The preview text, with the soonest expiry. */
  preheader(count: number, date: string): string;
  intro(activeDays: number): string;
  restore(archiveMonths: number): string;
  /**
   * Put right after an artifact's bold name in the list: its expiry, ending with the separator
   * before its link (a space, or nothing after full-width punctuation).
   */
  expires(date: string): string;
  /** The same in the text version, on its own line under the name. */
  expiresLine(date: string): string;
  /** The renew link's text; the text version writes it as "<renew>: <url>". */
  renew: string;
  /** Followed by the settings link (or its address in the text version), after `gap`. */
  optOut: string;
  /** The settings link's text. */
  settings: string;
  /** Ends the opt-out sentence after the link, such as "." */
  optOutEnd: string;
  reason: string;
}

const plural = (count: number, one: string, other: string) => (count === 1 ? one : other);

export const EXPIRY_TEXT: { readonly [code in LocaleCode]: ExpiryText } = {
  en: {
    subject: (count) =>
      plural(
        count,
        "Your Portifact artifact expires soon",
        `${count} of your Portifact artifacts expire soon`,
      ),
    heading: (count) => plural(count, "An artifact expires soon", `${count} artifacts expire soon`),
    preheader: (count, date) =>
      `Renew before ${date} to keep ${plural(count, "it", "them")} online.`,
    intro: (days) =>
      `When an artifact expires it stops being served and is archived. Renew it, or publish it again, to keep it online for another ${days} days.`,
    restore: (months) =>
      `An artifact you let expire is not deleted: you can restore it from the dashboard for ${months} months.`,
    expires: (date) => ` expires ${date}. `,
    expiresLine: (date) => `Expires ${date}`,
    renew: "Renew",
    optOut: "Do not want these emails? Turn off expiry notices in your settings:",
    settings: "Settings",
    optOutEnd: ".",
    reason: "You received this email because you own these artifacts on Portifact.",
  },
  es: {
    subject: (count) =>
      plural(
        count,
        "Tu artifact de Portifact vence pronto",
        `${count} de tus artifacts de Portifact vencen pronto`,
      ),
    heading: (count) =>
      plural(count, "Un artifact vence pronto", `${count} artifacts vencen pronto`),
    preheader: (count, date) =>
      `Para mantener${plural(count, "lo", "los")} en línea, renuéva${plural(count, "lo", "los")} antes de ${date}.`,
    intro: (days) =>
      `Cuando un artifact vence, deja de servirse y se archiva. Renuévalo, o publícalo de nuevo, para mantenerlo en línea otros ${days} días.`,
    restore: (months) =>
      `Un artifact que dejas vencer no se elimina: puedes restaurarlo desde el panel durante ${months} meses.`,
    expires: (date) => ` vence el ${date}. `,
    expiresLine: (date) => `Vence el ${date}`,
    renew: "Renovar",
    optOut: "¿No quieres estos correos? Desactiva los avisos de vencimiento en tu configuración:",
    settings: "Configuración",
    optOutEnd: ".",
    reason: "Recibiste este correo porque eres el propietario de estos artifacts en Portifact.",
  },
  "pt-BR": {
    subject: (count) =>
      plural(
        count,
        "Seu artifact do Portifact expira em breve",
        `${count} dos seus artifacts do Portifact expiram em breve`,
      ),
    heading: (count) =>
      plural(count, "Um artifact expira em breve", `${count} artifacts expiram em breve`),
    preheader: (count, date) =>
      `Renove antes de ${date} para ${plural(count, "mantê-lo", "mantê-los")} no ar.`,
    intro: (days) =>
      `Quando um artifact expira, ele deixa de ser servido e é arquivado. Renove-o, ou publique-o de novo, para mantê-lo no ar por mais ${days} dias.`,
    restore: (months) =>
      `Um artifact que você deixa expirar não é excluído: você pode restaurá-lo pelo painel durante ${months} meses.`,
    expires: (date) => ` expira em ${date}. `,
    expiresLine: (date) => `Expira em ${date}`,
    renew: "Renovar",
    optOut:
      "Não quer receber estes e-mails? Desative os avisos de expiração nas suas configurações:",
    settings: "Configurações",
    optOutEnd: ".",
    reason: "Você recebeu este e-mail porque é o proprietário destes artifacts no Portifact.",
  },
  fr: {
    subject: (count) =>
      pluralCategory("fr", count) === "one"
        ? "Votre artifact Portifact expire bientôt"
        : `${count} de vos artifacts Portifact expirent bientôt`,
    heading: (count) =>
      pluralCategory("fr", count) === "one"
        ? "Un artifact expire bientôt"
        : `${count} artifacts expirent bientôt`,
    preheader: (count, date) =>
      pluralCategory("fr", count) === "one"
        ? `Renouvelez-le avant le ${date} pour le garder en ligne.`
        : `Renouvelez-les avant le ${date} pour les garder en ligne.`,
    intro: (days) =>
      `Lorsqu’un artifact expire, il cesse d’être servi et il est archivé. Renouvelez-le, ou publiez-le de nouveau, pour le garder en ligne ${days} jours de plus.`,
    restore: (months) =>
      `Un artifact que vous laissez expirer n’est pas supprimé : vous pouvez le restaurer depuis le tableau de bord pendant ${months} mois.`,
    expires: (date) => ` expire le ${date}. `,
    expiresLine: (date) => `Expire le ${date}`,
    renew: "Renouveler",
    optOut:
      "Vous ne souhaitez plus recevoir ces e-mails ? Désactivez les avis d’expiration dans vos paramètres :",
    settings: "Paramètres",
    optOutEnd: ".",
    reason: "Vous avez reçu cet e-mail, car vous êtes propriétaire de ces artifacts sur Portifact.",
  },
  de: {
    subject: (count) =>
      plural(
        count,
        "Dein Portifact-Artifact läuft bald ab",
        `${count} deiner Portifact-Artifacts laufen bald ab`,
      ),
    heading: (count) =>
      plural(count, "Ein Artifact läuft bald ab", `${count} Artifacts laufen bald ab`),
    preheader: (count, date) =>
      `Verlängere ${plural(count, "es", "sie")} bis ${date}, damit ${plural(count, "es", "sie")} online ${plural(count, "bleibt", "bleiben")}.`,
    intro: (days) =>
      `Wenn ein Artifact abläuft, wird es nicht mehr ausgeliefert und archiviert. Verlängere es oder veröffentliche es erneut, damit es weitere ${days} Tage online bleibt.`,
    restore: (months) =>
      `Ein Artifact, das du ablaufen lässt, wird nicht gelöscht: Du kannst es ${months} Monate lang im Dashboard wiederherstellen.`,
    expires: (date) => ` läuft am ${date} ab. `,
    expiresLine: (date) => `Läuft am ${date} ab`,
    renew: "Verlängern",
    optOut:
      "Du möchtest diese E-Mails nicht? Schalte die Ablaufhinweise in deinen Einstellungen aus:",
    settings: "Einstellungen",
    optOutEnd: ".",
    reason: "Du hast diese E-Mail erhalten, weil dir diese Artifacts auf Portifact gehören.",
  },
  ru: {
    subject: (count) =>
      count === 1
        ? "Скоро истекает срок действия вашего artifact в Portifact"
        : `Скоро истекает срок действия ${count} artifacts в Portifact`,
    heading: (count) =>
      count === 1
        ? "Скоро истекает срок действия artifact"
        : `Скоро истекает срок действия ${count} artifacts`,
    preheader: (count, date) =>
      count === 1
        ? `Продлите его до ${date}, чтобы он остался в сети.`
        : `Продлите их до ${date}, чтобы они остались в сети.`,
    // Accusative after "ещё": 1 день, 2 дня, 30 дней.
    intro: (days) =>
      `Когда срок действия artifact истекает, он перестаёт открываться и отправляется в архив. Продлите его или опубликуйте заново, чтобы он оставался в сети ещё ${days} ${pluralForm("ru", days, { one: "день", few: "дня", many: "дней", other: "дня" })}.`,
    // Genitive after "в течение": 1 месяца, 3 месяцев, 6 месяцев.
    restore: (months) =>
      `Artifact с истёкшим сроком не удаляется: его можно восстановить в кабинете в течение ${months} ${pluralForm("ru", months, { one: "месяца", few: "месяцев", many: "месяцев", other: "месяца" })}.`,
    expires: (date) => `: срок истекает ${date}. `,
    expiresLine: (date) => `Срок истекает ${date}`,
    renew: "Продлить",
    optOut:
      "Не хотите получать такие письма? Отключите напоминания об истечении срока в настройках:",
    settings: "Настройки",
    optOutEnd: ".",
    reason: "Вы получили это письмо, потому что являетесь владельцем этих artifacts в Portifact.",
  },
  ja: {
    subject: (count) =>
      count === 1
        ? "Portifactのartifactの有効期限が近づいています"
        : `Portifactのartifact${count}件の有効期限が近づいています`,
    heading: (count) =>
      count === 1
        ? "artifactの有効期限が近づいています"
        : `${count}件のartifactの有効期限が近づいています`,
    preheader: (_count, date) => `オンラインのままにするには、${date}までに延長してください。`,
    intro: (days) =>
      `artifactは有効期限が切れると配信が停止され、アーカイブされます。さらに${days}日間オンラインのままにするには、延長するか、もう一度公開してください。`,
    restore: (months) =>
      `期限切れになったartifactは削除されません。${months}か月間はダッシュボードから復元できます。`,
    expires: (date) => `：${date}に期限切れ。`,
    expiresLine: (date) => `${date}に期限切れ`,
    renew: "延長",
    optOut: "このメールが不要な場合は、設定で有効期限の通知をオフにしてください：",
    settings: "設定",
    optOutEnd: "",
    reason: "あなたがPortifactでこれらのartifactを所有しているため、このメールをお送りしています。",
  },
  "zh-CN": {
    subject: (count) =>
      count === 1
        ? "你的 Portifact artifact 即将到期"
        : `你有 ${count} 个 Portifact artifact 即将到期`,
    heading: (count) => (count === 1 ? "一个 artifact 即将到期" : `${count} 个 artifact 即将到期`),
    preheader: (_count, date) => `请在 ${date} 之前续期，以保持在线。`,
    intro: (days) =>
      `Artifact 到期后会停止提供访问并被归档。续期或重新发布即可让它再保持在线 ${days} 天。`,
    restore: (months) => `到期的 artifact 不会被删除：你可以在 ${months} 个月内从控制台恢复它。`,
    expires: (date) => ` 将于 ${date} 到期。`,
    expiresLine: (date) => `将于 ${date} 到期`,
    renew: "续期",
    optOut: "不想收到这些邮件？请在设置中关闭到期通知：",
    settings: "设置",
    optOutEnd: "。",
    reason: "你收到这封邮件，是因为你是这些 Portifact artifact 的所有者。",
  },
};

/** The date options of an expiry: the weekday, the date and a 24-hour time, in UTC. */
const DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};

/**
 * The space between two sentences or before a link, which Chinese and Japanese leave out after
 * their full-width punctuation.
 */
export function gap(before: string): string {
  return /[\u3000-\u303f\uff01-\uff1f]$/.test(before) ? "" : " ";
}

/** English dates keep the US order the English email always had. */
const dateLocale = (locale: LocaleCode) => (locale === "en" ? "en-US" : locale);

/**
 * An expiry as the email shows it, always in UTC and saying so, in the email's language:
 * `Wed, Nov 11, 2026, 12:00 UTC`, `mié, 11 nov 2026, 12:00 UTC`.
 */
export function formatExpiry(at: number, locale: LocaleCode = DEFAULT_LOCALE): string {
  return `${new Intl.DateTimeFormat(dateLocale(locale), DATE_OPTIONS).format(new Date(at))} UTC`;
}

/** A name on one line, so a line break in it cannot fake another entry in the text version. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: replacing control characters is the point
const oneLine = (name: string) => name.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();

const display = (url: string) => url.replace(/^https:\/\//, "").replace(/\/$/, "");

export function expiryNoticeEmail(input: ExpiryNoticeInput): EmailContent {
  const locale = input.locale ?? DEFAULT_LOCALE;
  const t = EXPIRY_TEXT[locale];
  const date = (at: number) => formatExpiry(at, locale);
  const count = input.artifacts.length;
  const subject = t.subject(count);
  const heading = t.heading(count);
  const soonest = input.artifacts[0];
  const preheader = soonest ? t.preheader(count, date(soonest.expiresAt)) : "";
  const intro = t.intro(input.activeDays);
  const restore = t.restore(input.archiveMonths);

  // Without names, an artifact is its address: nothing the owner wrote leaves the region.
  const label = (artifact: ExpiryNoticeArtifact) =>
    input.names === false ? display(artifact.url) : oneLine(artifact.name);
  const items: Inline[][] = input.artifacts.map((artifact) => [
    { strong: label(artifact) },
    t.expires(date(artifact.expiresAt)),
    { href: artifact.url, text: display(artifact.url) },
    " | ",
    { href: artifact.renewUrl, text: t.renew },
  ]);
  const blocks: Block[] = [
    { kind: "paragraph", content: [intro] },
    { kind: "list", items },
    { kind: "divider" },
    { kind: "paragraph", content: [restore], muted: true },
    {
      kind: "paragraph",
      content: [
        t.optOut + gap(t.optOut),
        { href: input.settingsUrl, text: t.settings },
        t.optOutEnd,
      ],
      muted: true,
    },
  ];

  const html = renderEmail({
    title: subject,
    preheader,
    heading,
    blocks,
    footer: t.reason,
    lang: locale,
  });

  const text = [
    heading,
    "",
    intro,
    "",
    ...input.artifacts.flatMap((artifact) => [
      `- ${label(artifact)}`,
      `  ${t.expiresLine(date(artifact.expiresAt))}`,
      `  ${artifact.url}`,
      `  ${t.renew}: ${artifact.renewUrl}`,
    ]),
    "",
    restore,
    `${t.optOut}${gap(t.optOut)}${input.settingsUrl}`,
    "",
    t.reason,
    "Portifact, https://portifact.com",
  ].join("\n");

  return { subject, text, html };
}
