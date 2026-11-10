// The comment notice the jobs Worker sends (docs/operations.md, "Comment notices"): one digest of
// new comment activity per recipient, at most every ten minutes, listing each artifact with how
// many threads are new, how many replies came in and how many threads were resolved, and a link
// to its comments in the viewer. It never holds what was written or who wrote it. Artifact names
// are the owner's own input: they are only ever escaped, never put in the subject, and left out
// entirely with `names: false` (decision 0005: a workspace whose data stays in the EU). It is
// written in the recipient's language, English when they chose none, and carries a one-click
// unsubscribe link besides the settings.
import { DEFAULT_LOCALE, type LocaleCode } from "@portifact/contracts/locales";
import { gap } from "./expiry-notice.ts";
import { type Block, type Inline, renderEmail } from "./layout.ts";
import type { EmailContent } from "./message.ts";
import { type PluralForms, pluralForm } from "./plural.ts";

export interface CommentNoticeArtifact {
  /** Left out when the notice is built without names. */
  name: string;
  /** The artifact's comments in the viewer, `https://app.portifact.com/view/<id>`. */
  url: string;
  newThreads: number;
  newReplies: number;
  resolvedThreads: number;
}

export interface CommentNoticeInput {
  /** The most active first; at least one. */
  artifacts: CommentNoticeArtifact[];
  /** Further artifacts with activity that the email only counts. */
  more: number;
  /** The dashboard's settings page, where the notices are turned off. */
  settingsUrl: string;
  /** The page that turns comment notices off with the signed link, without signing in. */
  unsubscribeUrl: string;
  /** Whether artifact names may appear; false writes "An artifact" instead. */
  names: boolean;
  /** The recipient's language; English when absent. */
  locale?: LocaleCode | undefined;
}

/** The text of the notice in one language. */
export interface CommentText {
  subject(count: number): string;
  heading(count: number): string;
  preheader: string;
  intro: string;
  newThreads: PluralForms;
  replies: PluralForms;
  resolved: PluralForms;
  /** Between two counts. */
  separator: string;
  /** After the name, before the counts. */
  nameEnd: string;
  /** After the counts, before the link. */
  countsEnd: string;
  /** Stands for the name when names are left out. */
  unnamed: string;
  /** The link to an artifact's comments. */
  open: string;
  more: PluralForms;
  /** Followed by the settings link (or its address in the text version), after `gap`. */
  optOut: string;
  settings: string;
  /** Ends the opt-out sentence after the link, such as "." */
  optOutEnd: string;
  /** Followed by the unsubscribe link. */
  unsubscribe: string;
  unsubscribeLink: string;
  reason: string;
}

/** `#` in a form is the count. */
const counted = (locale: LocaleCode, count: number, forms: PluralForms) =>
  pluralForm(locale, count, forms).replace("#", String(count));

export const COMMENT_TEXT: { readonly [code in LocaleCode]: CommentText } = {
  en: {
    subject: (count) =>
      count === 1
        ? "New comments on a Portifact artifact"
        : `New comments on ${count} Portifact artifacts`,
    heading: (count) =>
      count === 1 ? "New comment activity" : `New comment activity on ${count} artifacts`,
    preheader: "Open each artifact in Portifact to read the comments and reply.",
    intro:
      "Here is what changed since your last notice. This email never shows what was written: open an artifact to read the comments.",
    newThreads: { one: "# new thread", other: "# new threads" },
    replies: { one: "# reply", other: "# replies" },
    resolved: { one: "# thread resolved", other: "# threads resolved" },
    separator: ", ",
    nameEnd: ": ",
    countsEnd: ". ",
    unnamed: "An artifact",
    open: "Open comments",
    more: {
      one: "There is activity on # more artifact in Portifact.",
      other: "There is activity on # more artifacts in Portifact.",
    },
    optOut:
      "To stop these emails for one artifact, mute it in its comments. To stop them all, change your settings:",
    settings: "Settings",
    optOutEnd: ".",
    unsubscribe: "Or turn comment notices off with one click:",
    unsubscribeLink: "Unsubscribe",
    reason:
      "You received this email because you own these artifacts or take part in their comments on Portifact.",
  },
  es: {
    subject: (count) =>
      count === 1
        ? "Nuevos comentarios en un artifact de Portifact"
        : `Nuevos comentarios en ${count} artifacts de Portifact`,
    heading: (count) =>
      count === 1
        ? "Nueva actividad en los comentarios"
        : `Nueva actividad en los comentarios de ${count} artifacts`,
    preheader: "Abre cada artifact en Portifact para leer los comentarios y responder.",
    intro:
      "Esto es lo que cambió desde tu último aviso. Este correo nunca muestra lo que se escribió: abre un artifact para leer los comentarios.",
    newThreads: { one: "# hilo nuevo", other: "# hilos nuevos" },
    replies: { one: "# respuesta", other: "# respuestas" },
    resolved: { one: "# hilo resuelto", other: "# hilos resueltos" },
    separator: ", ",
    nameEnd: ": ",
    countsEnd: ". ",
    unnamed: "Un artifact",
    open: "Abrir comentarios",
    more: {
      one: "Hay actividad en # artifact más en Portifact.",
      other: "Hay actividad en # artifacts más en Portifact.",
    },
    optOut:
      "Para dejar de recibir estos correos de un artifact, siléncialo en sus comentarios. Para dejar de recibirlos todos, cambia tu configuración:",
    settings: "Configuración",
    optOutEnd: ".",
    unsubscribe: "O desactiva los avisos de comentarios con un clic:",
    unsubscribeLink: "Darme de baja",
    reason:
      "Recibiste este correo porque eres el propietario de estos artifacts o participas en sus comentarios en Portifact.",
  },
  "pt-BR": {
    subject: (count) =>
      count === 1
        ? "Novos comentários em um artifact do Portifact"
        : `Novos comentários em ${count} artifacts do Portifact`,
    heading: (count) =>
      count === 1
        ? "Nova atividade nos comentários"
        : `Nova atividade nos comentários de ${count} artifacts`,
    preheader: "Abra cada artifact no Portifact para ler os comentários e responder.",
    intro:
      "Veja o que mudou desde o seu último aviso. Este e-mail nunca mostra o que foi escrito: abra um artifact para ler os comentários.",
    newThreads: { one: "# nova conversa", other: "# novas conversas" },
    replies: { one: "# resposta", other: "# respostas" },
    resolved: { one: "# conversa resolvida", other: "# conversas resolvidas" },
    separator: ", ",
    nameEnd: ": ",
    countsEnd: ". ",
    unnamed: "Um artifact",
    open: "Abrir comentários",
    more: {
      one: "Há atividade em mais # artifact no Portifact.",
      other: "Há atividade em mais # artifacts no Portifact.",
    },
    optOut:
      "Para deixar de receber estes e-mails de um artifact, silencie-o nos comentários dele. Para deixar de receber todos, altere suas configurações:",
    settings: "Configurações",
    optOutEnd: ".",
    unsubscribe: "Ou desative os avisos de comentários com um clique:",
    unsubscribeLink: "Cancelar inscrição",
    reason:
      "Você recebeu este e-mail porque é o proprietário destes artifacts ou participa dos comentários deles no Portifact.",
  },
  fr: {
    subject: (count) =>
      count === 1
        ? "Nouveaux commentaires sur un artifact Portifact"
        : `Nouveaux commentaires sur ${count} artifacts Portifact`,
    heading: (count) =>
      count === 1
        ? "Nouvelle activité dans les commentaires"
        : `Nouvelle activité dans les commentaires de ${count} artifacts`,
    preheader: "Ouvrez chaque artifact dans Portifact pour lire les commentaires et répondre.",
    intro:
      "Voici ce qui a changé depuis votre dernier avis. Cet e-mail ne montre jamais ce qui a été écrit : ouvrez un artifact pour lire les commentaires.",
    newThreads: { one: "# nouveau fil", other: "# nouveaux fils" },
    replies: { one: "# réponse", other: "# réponses" },
    resolved: { one: "# fil résolu", other: "# fils résolus" },
    separator: ", ",
    nameEnd: " : ",
    countsEnd: ". ",
    unnamed: "Un artifact",
    open: "Ouvrir les commentaires",
    more: {
      one: "Il y a de l’activité sur # autre artifact dans Portifact.",
      other: "Il y a de l’activité sur # autres artifacts dans Portifact.",
    },
    optOut:
      "Pour ne plus recevoir ces e-mails pour un artifact, mettez-le en sourdine dans ses commentaires. Pour ne plus les recevoir du tout, modifiez vos paramètres :",
    settings: "Paramètres",
    optOutEnd: ".",
    unsubscribe: "Ou désactivez les avis de commentaires en un clic :",
    unsubscribeLink: "Se désabonner",
    reason:
      "Vous avez reçu cet e-mail parce que vous êtes propriétaire de ces artifacts ou que vous participez à leurs commentaires sur Portifact.",
  },
  de: {
    subject: (count) =>
      count === 1
        ? "Neue Kommentare zu einem Portifact-Artifact"
        : `Neue Kommentare zu ${count} Portifact-Artifacts`,
    heading: (count) =>
      count === 1 ? "Neue Kommentaraktivität" : `Neue Kommentaraktivität bei ${count} Artifacts`,
    preheader: "Öffne jedes Artifact in Portifact, um die Kommentare zu lesen und zu antworten.",
    intro:
      "Das hat sich seit deinem letzten Hinweis geändert. Diese E-Mail zeigt nie, was geschrieben wurde: Öffne ein Artifact, um die Kommentare zu lesen.",
    newThreads: { one: "# neuer Thread", other: "# neue Threads" },
    replies: { one: "# Antwort", other: "# Antworten" },
    resolved: { one: "# Thread erledigt", other: "# Threads erledigt" },
    separator: ", ",
    nameEnd: ": ",
    countsEnd: ". ",
    unnamed: "Ein Artifact",
    open: "Kommentare öffnen",
    more: {
      one: "Bei # weiteren Artifact gibt es Aktivität in Portifact.",
      other: "Bei # weiteren Artifacts gibt es Aktivität in Portifact.",
    },
    optOut:
      "Um diese E-Mails für ein Artifact abzustellen, schalte es in seinen Kommentaren stumm. Um sie ganz abzustellen, ändere deine Einstellungen:",
    settings: "Einstellungen",
    optOutEnd: ".",
    unsubscribe: "Oder schalte die Kommentarhinweise mit einem Klick ab:",
    unsubscribeLink: "Abmelden",
    reason:
      "Du hast diese E-Mail erhalten, weil dir diese Artifacts gehören oder du an ihren Kommentaren auf Portifact teilnimmst.",
  },
  ru: {
    subject: (count) =>
      count === 1
        ? "Новые комментарии к artifact в Portifact"
        : `Новые комментарии к artifacts в Portifact: ${count}`,
    heading: (count) =>
      count === 1 ? "Новые комментарии" : `Новые комментарии к artifacts: ${count}`,
    preheader: "Откройте каждый artifact в Portifact, чтобы прочитать комментарии и ответить.",
    intro:
      "Вот что изменилось с последнего уведомления. В этом письме никогда нет того, что было написано: откройте artifact, чтобы прочитать комментарии.",
    newThreads: {
      one: "# новая ветка",
      few: "# новые ветки",
      many: "# новых веток",
      other: "# новой ветки",
    },
    replies: { one: "# ответ", few: "# ответа", many: "# ответов", other: "# ответа" },
    resolved: {
      one: "# ветка закрыта",
      few: "# ветки закрыты",
      many: "# веток закрыто",
      other: "# ветки закрыто",
    },
    separator: ", ",
    nameEnd: ": ",
    countsEnd: ". ",
    unnamed: "Artifact",
    open: "Открыть комментарии",
    more: {
      one: "Есть активность ещё в # artifact в Portifact.",
      other: "Есть активность ещё в # artifacts в Portifact.",
    },
    optOut:
      "Чтобы не получать эти письма об одном artifact, отключите уведомления в его комментариях. Чтобы не получать их совсем, измените настройки:",
    settings: "Настройки",
    optOutEnd: ".",
    unsubscribe: "Или отключите уведомления о комментариях одним нажатием:",
    unsubscribeLink: "Отписаться",
    reason:
      "Вы получили это письмо, потому что вы владелец этих artifacts или участвуете в их комментариях в Portifact.",
  },
  ja: {
    subject: (count) =>
      count === 1
        ? "Portifactのartifactに新しいコメントがあります"
        : `Portifactのartifact${count}件に新しいコメントがあります`,
    heading: (count) =>
      count === 1
        ? "コメントの新しいアクティビティ"
        : `artifact${count}件のコメントの新しいアクティビティ`,
    preheader: "Portifactで各artifactを開いて、コメントを読んで返信できます。",
    intro:
      "前回の通知以降の変更です。このメールには書かれた内容は含まれません。コメントを読むにはartifactを開いてください。",
    newThreads: { other: "新しいスレッド#件" },
    replies: { other: "返信#件" },
    resolved: { other: "解決済みのスレッド#件" },
    separator: "、",
    nameEnd: "：",
    countsEnd: "。",
    unnamed: "artifact",
    open: "コメントを開く",
    more: { other: "ほかにartifact#件でアクティビティがあります。" },
    optOut:
      "artifactごとにこのメールを止めるには、そのコメント欄でミュートしてください。すべて止めるには、設定を変更してください：",
    settings: "設定",
    optOutEnd: "。",
    unsubscribe: "または、ワンクリックでコメント通知をオフにできます：",
    unsubscribeLink: "配信を停止",
    reason:
      "このメールは、あなたがこれらのartifactの所有者であるか、Portifactでそのコメントに参加しているため送信されました。",
  },
  "zh-CN": {
    subject: (count) =>
      count === 1 ? "你的 Portifact artifact 有新评论" : `${count} 个 Portifact artifact 有新评论`,
    heading: (count) => (count === 1 ? "评论有新动态" : `${count} 个 artifact 的评论有新动态`),
    preheader: "在 Portifact 中打开各个 artifact，阅读评论并回复。",
    intro: "以下是自上次通知以来的变化。这封邮件从不包含评论的内容：请打开 artifact 阅读评论。",
    newThreads: { other: "# 个新讨论串" },
    replies: { other: "# 条回复" },
    resolved: { other: "# 个讨论串已解决" },
    separator: "，",
    nameEnd: "：",
    countsEnd: "。",
    unnamed: "一个 artifact",
    open: "打开评论",
    more: { other: "另有 # 个 artifact 有新动态。" },
    optOut: "如需停止某个 artifact 的这类邮件，请在其评论中将其静音。如需全部停止，请更改设置：",
    settings: "设置",
    optOutEnd: "。",
    unsubscribe: "或者一键关闭评论通知：",
    unsubscribeLink: "退订",
    reason: "你收到这封邮件，是因为你拥有这些 artifact 或参与了它们在 Portifact 上的评论。",
  },
};

/** A name on one line, so an odd one cannot break the list or the text version. */
function oneLine(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

/** The counts of one artifact that are not zero, in the language. */
function counts(locale: LocaleCode, t: CommentText, artifact: CommentNoticeArtifact): string {
  return [
    [artifact.newThreads, t.newThreads],
    [artifact.newReplies, t.replies],
    [artifact.resolvedThreads, t.resolved],
  ]
    .filter(([count]) => (count as number) > 0)
    .map(([count, forms]) => counted(locale, count as number, forms as PluralForms))
    .join(t.separator);
}

export function commentNoticeEmail(input: CommentNoticeInput): EmailContent {
  const locale = input.locale ?? DEFAULT_LOCALE;
  const t = COMMENT_TEXT[locale];
  const total = input.artifacts.length + input.more;
  const subject = t.subject(total);
  const heading = t.heading(total);
  const name = (artifact: CommentNoticeArtifact) =>
    input.names ? oneLine(artifact.name) || t.unnamed : t.unnamed;
  const more = input.more > 0 ? counted(locale, input.more, t.more) : null;

  const items: Inline[][] = input.artifacts.map((artifact) => [
    { strong: name(artifact) },
    `${t.nameEnd}${counts(locale, t, artifact)}${t.countsEnd}`,
    { href: artifact.url, text: t.open },
  ]);
  const blocks: Block[] = [
    { kind: "paragraph", content: [t.intro] },
    { kind: "list", items },
    ...(more ? [{ kind: "paragraph", content: [more] } as Block] : []),
    { kind: "divider" },
    {
      kind: "paragraph",
      content: [
        t.optOut + gap(t.optOut),
        { href: input.settingsUrl, text: t.settings },
        t.optOutEnd,
      ],
      muted: true,
    },
    {
      kind: "paragraph",
      content: [
        t.unsubscribe + gap(t.unsubscribe),
        { href: input.unsubscribeUrl, text: t.unsubscribeLink },
        t.optOutEnd,
      ],
      muted: true,
    },
  ];

  const html = renderEmail({
    title: subject,
    preheader: t.preheader,
    heading,
    blocks,
    footer: t.reason,
    lang: locale,
  });

  const text = [
    heading,
    "",
    t.intro,
    "",
    ...input.artifacts.flatMap((artifact) => [
      `- ${name(artifact)}`,
      `  ${counts(locale, t, artifact)}`,
      `  ${t.open}: ${artifact.url}`,
    ]),
    ...(more ? ["", more] : []),
    "",
    `${t.optOut}${gap(t.optOut)}${input.settingsUrl}`,
    `${t.unsubscribe}${gap(t.unsubscribe)}${input.unsubscribeUrl}`,
    "",
    t.reason,
    "Portifact, https://portifact.com",
  ].join("\n");

  return { subject, text, html };
}
