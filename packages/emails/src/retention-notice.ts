// The notice of a workspace's maximum life of artifacts (decision 0023): when an admin sets a
// maximum life or shortens it, every admin of the workspace gets this email once, during the
// notice period, before anything is archived by it. It says how long, from when, and how many
// artifacts the preview counted, and links the Policies page. Counts, a number of days and a date
// only: never a workspace's or an artifact's name, so it is the same in every region (decision
// 0005, `noticeDetail`). It is written in the recipient's language, English when they chose none.
import { DEFAULT_LOCALE, type LocaleCode } from "@portifact/contracts/locales";
import { formatExpiry, gap } from "./expiry-notice.ts";
import { type Block, renderEmail, textSignature } from "./layout.ts";
import type { EmailContent } from "./message.ts";

export interface RetentionNoticeInput {
  /** The maximum life, in days from an artifact's last publish or restore. */
  days: number;
  /** When it takes effect. */
  from: number;
  /** Active artifacts that reach it on that date, as the preview counted them. */
  atStart: number;
  /** Active artifacts that reach it within the 30 days after. */
  soon: number;
  /** The workspace's Policies page. */
  policiesUrl: string;
  locale?: LocaleCode | undefined;
}

/** The notice in one language. Dates come in already formatted, with "UTC". */
export interface RetentionNoticeText {
  subject: string;
  heading: string;
  preheader(date: string): string;
  intro(days: number, date: string): string;
  atStart(count: number): string;
  soon(count: number): string;
  keep: string;
  /** Followed by the Policies page's link (or its address in the text version), after `gap`. */
  review: string;
  reviewLink: string;
  reviewEnd: string;
  reason: string;
}

export const RETENTION_NOTICE_TEXT: { readonly [code in LocaleCode]: RetentionNoticeText } = {
  en: {
    subject: "Your workspace will archive artifacts after a maximum life",
    heading: "A maximum life for artifacts was set",
    preheader: (date) => `It takes effect on ${date}. Nothing is archived by it before then.`,
    intro: (days, date) =>
      `An admin of your workspace set a maximum life of ${days} days for its artifacts. From ${date}, an artifact is archived ${days} days after its last publish or restore, and artifacts cannot be pinned.`,
    atStart: (count) =>
      `Artifacts that reach it on that date and will be archived then unless someone publishes them again: ${count}.`,
    soon: (count) => `Artifacts that reach it within the following 30 days: ${count}.`,
    keep: "Archived artifacts can be restored until their archive ends; this policy deletes nothing. Their owners also get the usual expiry notice a few days before.",
    review: "Review or change it on the Policies page:",
    reviewLink: "Policies",
    reviewEnd: ".",
    reason: "You received this email because you are an admin of a workspace on Portifact.",
  },
  es: {
    subject: "Tu workspace archivará artifacts tras una vida máxima",
    heading: "Se fijó una vida máxima para los artifacts",
    preheader: (date) => `Entra en vigor el ${date}. Hasta entonces no archiva nada.`,
    intro: (days, date) =>
      `Un administrador de tu workspace fijó una vida máxima de ${days} días para sus artifacts. Desde el ${date}, cada artifact se archiva ${days} días después de su última publicación o restauración, y los artifacts no se pueden fijar.`,
    atStart: (count) =>
      `Artifacts que la alcanzan en esa fecha y se archivarán entonces si nadie los vuelve a publicar: ${count}.`,
    soon: (count) => `Artifacts que la alcanzan en los 30 días siguientes: ${count}.`,
    keep: "Los artifacts archivados se pueden restaurar hasta que termine su archivo; esta política no elimina nada. Sus propietarios también reciben el aviso de vencimiento habitual unos días antes.",
    review: "Revísala o cámbiala en la página Políticas:",
    reviewLink: "Políticas",
    reviewEnd: ".",
    reason: "Recibiste este correo porque administras un workspace en Portifact.",
  },
  "pt-BR": {
    subject: "Seu workspace vai arquivar artifacts após uma vida máxima",
    heading: "Uma vida máxima para artifacts foi definida",
    preheader: (date) => `Entra em vigor em ${date}. Nada é arquivado por ela antes disso.`,
    intro: (days, date) =>
      `Um administrador do seu workspace definiu uma vida máxima de ${days} dias para os artifacts. A partir de ${date}, cada artifact é arquivado ${days} dias após a última publicação ou restauração, e artifacts não podem ser fixados.`,
    atStart: (count) =>
      `Artifacts que a atingem nessa data e serão arquivados então se ninguém publicá-los de novo: ${count}.`,
    soon: (count) => `Artifacts que a atingem nos 30 dias seguintes: ${count}.`,
    keep: "Artifacts arquivados podem ser restaurados até o fim do arquivo; esta política não exclui nada. Os donos também recebem o aviso de vencimento habitual alguns dias antes.",
    review: "Revise ou altere na página Políticas:",
    reviewLink: "Políticas",
    reviewEnd: ".",
    reason: "Você recebeu este e-mail porque administra um workspace no Portifact.",
  },
  fr: {
    subject: "Votre workspace archivera les artifacts après une durée de vie maximale",
    heading: "Une durée de vie maximale des artifacts a été fixée",
    preheader: (date) => `Elle s’applique à partir du ${date}. Rien n’est archivé avant.`,
    intro: (days, date) =>
      `Un administrateur de votre workspace a fixé une durée de vie maximale de ${days} jours pour ses artifacts. À partir du ${date}, un artifact est archivé ${days} jours après sa dernière publication ou restauration, et les artifacts ne peuvent plus être épinglés.`,
    atStart: (count) =>
      `Artifacts qui l’atteignent à cette date et seront alors archivés si personne ne les republie : ${count}.`,
    soon: (count) => `Artifacts qui l’atteignent dans les 30 jours suivants : ${count}.`,
    keep: "Les artifacts archivés peuvent être restaurés jusqu’à la fin de leur archive ; cette règle ne supprime rien. Leurs propriétaires reçoivent aussi l’avis d’expiration habituel quelques jours avant.",
    review: "La consulter ou la modifier sur la page Règles :",
    reviewLink: "Règles",
    reviewEnd: ".",
    reason: "Vous avez reçu cet e-mail parce que vous administrez un workspace sur Portifact.",
  },
  de: {
    subject: "Ihr Workspace archiviert Artifacts nach einer maximalen Lebensdauer",
    heading: "Eine maximale Lebensdauer für Artifacts wurde festgelegt",
    preheader: (date) => `Sie gilt ab ${date}. Vorher wird dadurch nichts archiviert.`,
    intro: (days, date) =>
      `Eine Administratorin oder ein Administrator Ihres Workspace hat eine maximale Lebensdauer von ${days} Tagen für seine Artifacts festgelegt. Ab ${date} wird ein Artifact ${days} Tage nach seiner letzten Veröffentlichung oder Wiederherstellung archiviert, und Artifacts können nicht angeheftet werden.`,
    atStart: (count) =>
      `Artifacts, die sie an diesem Tag erreichen und dann archiviert werden, wenn niemand sie erneut veröffentlicht: ${count}.`,
    soon: (count) => `Artifacts, die sie in den 30 Tagen danach erreichen: ${count}.`,
    keep: "Archivierte Artifacts lassen sich wiederherstellen, bis ihr Archiv endet; diese Richtlinie löscht nichts. Ihre Eigentümer erhalten außerdem wenige Tage vorher den üblichen Ablaufhinweis.",
    review: "Prüfen oder ändern Sie sie auf der Seite Richtlinien:",
    reviewLink: "Richtlinien",
    reviewEnd: ".",
    reason: "Sie haben diese E-Mail erhalten, weil Sie einen Workspace auf Portifact verwalten.",
  },
  ru: {
    subject: "Ваше рабочее пространство будет архивировать artifacts по истечении срока",
    heading: "Установлен максимальный срок жизни artifacts",
    preheader: (date) => `Он действует с ${date}. До этого по нему ничего не архивируется.`,
    intro: (days, date) =>
      `Администратор вашего рабочего пространства установил максимальный срок жизни artifacts (дней: ${days}). С ${date} artifact архивируется через это число дней после последней публикации или восстановления, а закреплять artifacts нельзя.`,
    atStart: (count) =>
      `Artifacts, которые достигнут срока в этот день и будут архивированы, если их не опубликуют снова: ${count}.`,
    soon: (count) => `Artifacts, которые достигнут срока в следующие 30 дней: ${count}.`,
    keep: "Архивированные artifacts можно восстановить, пока не закончится их архив; это правило ничего не удаляет. Владельцы также получат обычное уведомление об истечении срока за несколько дней.",
    review: "Проверить или изменить правило можно на странице «Правила»:",
    reviewLink: "Правила",
    reviewEnd: ".",
    reason: "Вы получили это письмо, потому что администрируете рабочее пространство в Portifact.",
  },
  ja: {
    subject: "ワークスペースの artifact は最長期間を過ぎるとアーカイブされます",
    heading: "artifact の最長期間が設定されました",
    preheader: (date) =>
      `${date} から適用されます。それまでこの設定でアーカイブされることはありません。`,
    intro: (days, date) =>
      `ワークスペースの管理者が artifact の最長期間を ${days} 日に設定しました。${date} 以降、artifact は最後の公開または復元から ${days} 日後にアーカイブされ、ピン留めはできません。`,
    atStart: (count) =>
      `その日に期限に達し、誰も再公開しなければアーカイブされる artifact: ${count} 件。`,
    soon: (count) => `その後 30 日以内に期限に達する artifact: ${count} 件。`,
    keep: "アーカイブされた artifact は、アーカイブ期間が終わるまで復元できます。このポリシーで削除されるものはありません。所有者には数日前に通常の期限通知も届きます。",
    review: "ポリシーページで確認・変更できます:",
    reviewLink: "ポリシー",
    reviewEnd: "。",
    reason: "Portifact のワークスペースを管理しているため、このメールをお送りしました。",
  },
  "zh-CN": {
    subject: "你的工作区将在最长期限后归档 artifact",
    heading: "已设置 artifact 的最长期限",
    preheader: (date) => `它将于 ${date} 生效。在此之前不会因此归档任何内容。`,
    intro: (days, date) =>
      `你的工作区管理员将 artifact 的最长期限设为 ${days} 天。从 ${date} 起,artifact 会在最后一次发布或恢复后 ${days} 天归档,并且不能固定。`,
    atStart: (count) => `在该日期达到期限、若无人重新发布就会归档的 artifact:${count} 个。`,
    soon: (count) => `在之后 30 天内达到期限的 artifact:${count} 个。`,
    keep: "已归档的 artifact 在归档期结束前都可以恢复;此策略不会删除任何内容。所有者也会在几天前收到通常的到期通知。",
    review: "在策略页面查看或更改:",
    reviewLink: "策略",
    reviewEnd: "。",
    reason: "你收到这封邮件,是因为你在 Portifact 上管理一个工作区。",
  },
};

export function retentionNoticeEmail(input: RetentionNoticeInput): EmailContent {
  const locale = input.locale ?? DEFAULT_LOCALE;
  const t = RETENTION_NOTICE_TEXT[locale];
  const date = formatExpiry(input.from, locale);
  const intro = t.intro(input.days, date);
  const counts = [t.atStart(input.atStart), t.soon(input.soon)];
  const blocks: Block[] = [
    { kind: "paragraph", content: [intro] },
    { kind: "list", items: counts.map((line) => [line]) },
    { kind: "paragraph", content: [t.keep] },
    { kind: "divider" },
    {
      kind: "paragraph",
      content: [
        t.review + gap(t.review),
        { href: input.policiesUrl, text: t.reviewLink },
        t.reviewEnd,
      ],
      muted: true,
    },
  ];
  const html = renderEmail({
    title: t.subject,
    preheader: t.preheader(date),
    heading: t.heading,
    blocks,
    footer: t.reason,
    lang: locale,
  });
  const text = [
    t.heading,
    "",
    intro,
    "",
    ...counts.map((line) => `- ${line}`),
    "",
    t.keep,
    `${t.review}${gap(t.review)}${input.policiesUrl}`,
    "",
    t.reason,
    ...textSignature(locale),
  ].join("\n");
  return { subject: t.subject, text, html };
}
