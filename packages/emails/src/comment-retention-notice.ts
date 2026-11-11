// The notices of a workspace's comment retention (decision 0023, "Comment retention"): `set` when
// an admin sets or shortens it, during its notice period, and `soon` a few days before its first
// deletion when that comes long after the save. Every admin of the workspace gets each once. It
// says how long, from when, by when, and how many threads and messages are deleted for good, and
// links the Policies page. Counts, days and dates only: never a workspace's or an artifact's name
// or a word of a comment, so it is the same in every region (decision 0005, `noticeDetail`).
import { DEFAULT_LOCALE, type LocaleCode } from "@portifact/contracts/locales";
import { formatExpiry, gap } from "./expiry-notice.ts";
import { type Block, renderEmail } from "./layout.ts";
import type { EmailContent } from "./message.ts";

export interface CommentRetentionNoticeInput {
  kind: "set" | "soon";
  /** The retention, in days after a thread's last activity. */
  days: number;
  /** When it takes effect. */
  from: number;
  /** When the first threads are deleted. */
  at: number;
  threads: number;
  messages: number;
  /** The workspace's Policies page. */
  policiesUrl: string;
  locale?: LocaleCode | undefined;
}

/** The notice in one language. Dates come in already formatted, with "UTC". */
export interface CommentRetentionNoticeText {
  subject: { set: string; soon: string };
  heading: { set: string; soon: string };
  preheader(date: string): string;
  rule(days: number, date: string): string;
  counts(threads: number, messages: number, date: string): string;
  kept: string;
  final: string;
  review: string;
  reviewLink: string;
  reviewEnd: string;
  reason: string;
}

export const COMMENT_RETENTION_NOTICE_TEXT: {
  readonly [code in LocaleCode]: CommentRetentionNoticeText;
} = {
  en: {
    subject: {
      set: "Your workspace will delete old comment threads",
      soon: "Old comment threads in your workspace are deleted in a few days",
    },
    heading: { set: "Comment retention was set", soon: "Comment threads will be deleted soon" },
    preheader: (date) => `The first threads are deleted on ${date}.`,
    rule: (days, date) =>
      `An admin of your workspace set its comment retention to ${days} days. From ${date}, a comment thread is deleted for good, with every message in it, once its last activity is ${days} days old. Open threads on an artifact's current version are kept; once a new version replaces it, each gets the whole period again from that moment.`,
    counts: (threads, messages, date) =>
      `Threads deleted on ${date}: ${threads}, with ${messages} messages.`,
    kept: "A reply or any other change to a thread restarts its time. An artifact moved into the workspace keeps its threads for at least 7 days.",
    final:
      "Deleted threads cannot be recovered by anyone, Portifact included. Export them first if they need to be kept.",
    review: "Review or change it on the Policies page:",
    reviewLink: "Policies",
    reviewEnd: ".",
    reason: "You received this email because you are an admin of a workspace on Portifact.",
  },
  es: {
    subject: {
      set: "Tu workspace eliminará los hilos de comentarios antiguos",
      soon: "Los hilos de comentarios antiguos de tu workspace se eliminan en unos días",
    },
    heading: {
      set: "Se fijó una retención de comentarios",
      soon: "Pronto se eliminarán hilos de comentarios",
    },
    preheader: (date) => `Los primeros hilos se eliminan el ${date}.`,
    rule: (days, date) =>
      `Un administrador de tu workspace fijó su retención de comentarios en ${days} días. Desde el ${date}, un hilo de comentarios se elimina definitivamente, con todos sus mensajes, cuando su última actividad tiene ${days} días. Los hilos abiertos en la versión actual de un artifact se conservan; cuando una nueva versión la reemplaza, cada uno vuelve a tener el periodo completo desde ese momento.`,
    counts: (threads, messages, date) =>
      `Hilos que se eliminan el ${date}: ${threads}, con ${messages} mensajes.`,
    kept: "Una respuesta o cualquier otro cambio en un hilo reinicia su plazo. Un artifact trasladado al workspace conserva sus hilos al menos 7 días.",
    final:
      "Nadie puede recuperar los hilos eliminados, tampoco Portifact. Expórtalos antes si hay que conservarlos.",
    review: "Revísala o cámbiala en la página Políticas:",
    reviewLink: "Políticas",
    reviewEnd: ".",
    reason: "Recibiste este correo porque administras un workspace en Portifact.",
  },
  "pt-BR": {
    subject: {
      set: "Seu workspace vai excluir threads de comentários antigas",
      soon: "Threads de comentários antigas do seu workspace serão excluídas em poucos dias",
    },
    heading: {
      set: "Uma retenção de comentários foi definida",
      soon: "Threads de comentários serão excluídas em breve",
    },
    preheader: (date) => `As primeiras threads são excluídas em ${date}.`,
    rule: (days, date) =>
      `Um administrador do seu workspace definiu a retenção de comentários em ${days} dias. A partir de ${date}, uma thread de comentários é excluída para sempre, com todas as mensagens, quando a última atividade tem ${days} dias. Threads abertas na versão atual de um artifact são mantidas; quando uma nova versão a substitui, cada uma recebe o período inteiro de novo a partir desse momento.`,
    counts: (threads, messages, date) =>
      `Threads excluídas em ${date}: ${threads}, com ${messages} mensagens.`,
    kept: "Uma resposta ou qualquer outra mudança na thread reinicia o prazo. Um artifact movido para o workspace mantém as threads por pelo menos 7 dias.",
    final:
      "Ninguém pode recuperar threads excluídas, nem o Portifact. Exporte-as antes se precisarem ser guardadas.",
    review: "Revise ou altere na página Políticas:",
    reviewLink: "Políticas",
    reviewEnd: ".",
    reason: "Você recebeu este e-mail porque administra um workspace no Portifact.",
  },
  fr: {
    subject: {
      set: "Votre workspace supprimera les anciens fils de commentaires",
      soon: "Les anciens fils de commentaires de votre workspace sont supprimés dans quelques jours",
    },
    heading: {
      set: "Une conservation des commentaires a été fixée",
      soon: "Des fils de commentaires seront bientôt supprimés",
    },
    preheader: (date) => `Les premiers fils sont supprimés le ${date}.`,
    rule: (days, date) =>
      `Un administrateur de votre workspace a fixé la conservation des commentaires à ${days} jours. À partir du ${date}, un fil de commentaires est supprimé définitivement, avec tous ses messages, quand sa dernière activité date de ${days} jours. Les fils ouverts sur la version actuelle d’un artifact sont conservés ; quand une nouvelle version la remplace, chacun retrouve la période entière à partir de ce moment.`,
    counts: (threads, messages, date) =>
      `Fils supprimés le ${date} : ${threads}, avec ${messages} messages.`,
    kept: "Une réponse ou toute autre modification d’un fil relance son délai. Un artifact déplacé dans le workspace garde ses fils au moins 7 jours.",
    final:
      "Personne ne peut récupérer les fils supprimés, pas même Portifact. Exportez-les avant s’il faut les garder.",
    review: "La consulter ou la modifier sur la page Règles :",
    reviewLink: "Règles",
    reviewEnd: ".",
    reason: "Vous avez reçu cet e-mail parce que vous administrez un workspace sur Portifact.",
  },
  de: {
    subject: {
      set: "Ihr Workspace löscht alte Kommentar-Threads",
      soon: "Alte Kommentar-Threads Ihres Workspace werden in wenigen Tagen gelöscht",
    },
    heading: {
      set: "Eine Aufbewahrung für Kommentare wurde festgelegt",
      soon: "Kommentar-Threads werden bald gelöscht",
    },
    preheader: (date) => `Die ersten Threads werden am ${date} gelöscht.`,
    rule: (days, date) =>
      `Eine Administratorin oder ein Administrator Ihres Workspace hat die Aufbewahrung von Kommentaren auf ${days} Tage festgelegt. Ab ${date} wird ein Kommentar-Thread mit allen Nachrichten endgültig gelöscht, sobald seine letzte Aktivität ${days} Tage zurückliegt. Offene Threads auf der aktuellen Version eines Artifacts bleiben erhalten; ersetzt eine neue Version diese, erhält jeder ab diesem Moment wieder den ganzen Zeitraum.`,
    counts: (threads, messages, date) =>
      `Am ${date} gelöschte Threads: ${threads}, mit ${messages} Nachrichten.`,
    kept: "Eine Antwort oder jede andere Änderung an einem Thread startet seine Frist neu. Ein in den Workspace verschobenes Artifact behält seine Threads mindestens 7 Tage.",
    final:
      "Gelöschte Threads kann niemand wiederherstellen, auch Portifact nicht. Exportieren Sie sie vorher, wenn sie aufbewahrt werden müssen.",
    review: "Prüfen oder ändern Sie sie auf der Seite Richtlinien:",
    reviewLink: "Richtlinien",
    reviewEnd: ".",
    reason: "Sie haben diese E-Mail erhalten, weil Sie einen Workspace auf Portifact verwalten.",
  },
  ru: {
    subject: {
      set: "Ваше рабочее пространство будет удалять старые обсуждения",
      soon: "Старые обсуждения вашего рабочего пространства будут удалены через несколько дней",
    },
    heading: {
      set: "Установлен срок хранения комментариев",
      soon: "Скоро будут удалены обсуждения",
    },
    preheader: (date) => `Первые обсуждения будут удалены ${date}.`,
    rule: (days, date) =>
      `Администратор вашего рабочего пространства установил срок хранения комментариев (дней: ${days}). С ${date} обсуждение удаляется навсегда вместе со всеми сообщениями, когда с последней активности прошло это число дней. Открытые обсуждения текущей версии artifact сохраняются; когда новая версия её заменяет, каждое снова получает весь срок с этого момента.`,
    counts: (threads, messages, date) =>
      `Обсуждений будет удалено ${date}: ${threads}, сообщений в них: ${messages}.`,
    kept: "Ответ или любое другое изменение обсуждения начинает срок заново. Artifact, перенесённый в пространство, сохраняет обсуждения не меньше 7 дней.",
    final:
      "Удалённые обсуждения не может восстановить никто, в том числе Portifact. Если их нужно сохранить, экспортируйте их заранее.",
    review: "Проверить или изменить правило можно на странице «Правила»:",
    reviewLink: "Правила",
    reviewEnd: ".",
    reason: "Вы получили это письмо, потому что администрируете рабочее пространство в Portifact.",
  },
  ja: {
    subject: {
      set: "ワークスペースの古いコメントスレッドが削除されます",
      soon: "ワークスペースの古いコメントスレッドが数日後に削除されます",
    },
    heading: {
      set: "コメントの保持期間が設定されました",
      soon: "コメントスレッドがまもなく削除されます",
    },
    preheader: (date) => `最初のスレッドは ${date} に削除されます。`,
    rule: (days, date) =>
      `ワークスペースの管理者がコメントの保持期間を ${days} 日に設定しました。${date} 以降、コメントスレッドは最後のアクティビティから ${days} 日経つと、すべてのメッセージとともに完全に削除されます。artifact の現在のバージョンで未解決のスレッドは保持されます。新しいバージョンがそれを置き換えると、各スレッドはその時点から再び期間全体を得ます。`,
    counts: (threads, messages, date) =>
      `${date} に削除されるスレッド: ${threads} 件 (メッセージ ${messages} 件)。`,
    kept: "返信やスレッドへのその他の変更で期間は最初から数え直されます。ワークスペースに移動した artifact のスレッドは少なくとも 7 日間保持されます。",
    final:
      "削除されたスレッドは Portifact を含め誰も復元できません。保管が必要な場合は事前にエクスポートしてください。",
    review: "ポリシーページで確認・変更できます:",
    reviewLink: "ポリシー",
    reviewEnd: "。",
    reason: "Portifact のワークスペースを管理しているため、このメールをお送りしました。",
  },
  "zh-CN": {
    subject: {
      set: "你的工作区将删除旧的评论线程",
      soon: "你的工作区中的旧评论线程将在几天后删除",
    },
    heading: { set: "已设置评论保留期限", soon: "评论线程即将被删除" },
    preheader: (date) => `第一批线程将于 ${date} 删除。`,
    rule: (days, date) =>
      `你的工作区管理员将评论保留期限设为 ${days} 天。从 ${date} 起,评论线程在最后一次活动 ${days} 天后会连同所有消息被永久删除。artifact 当前版本上未解决的线程会保留;当新版本替换该版本后,每个线程从那一刻起重新获得完整的期限。`,
    counts: (threads, messages, date) =>
      `${date} 删除的线程:${threads} 个,包含 ${messages} 条消息。`,
    kept: "回复或对线程的任何其他更改都会重新计时。移入工作区的 artifact 的线程至少保留 7 天。",
    final: "已删除的线程任何人都无法恢复,包括 Portifact。如需保留,请提前导出。",
    review: "在策略页面查看或更改:",
    reviewLink: "策略",
    reviewEnd: "。",
    reason: "你收到这封邮件,是因为你在 Portifact 上管理一个工作区。",
  },
};

export function commentRetentionNoticeEmail(input: CommentRetentionNoticeInput): EmailContent {
  const locale = input.locale ?? DEFAULT_LOCALE;
  const t = COMMENT_RETENTION_NOTICE_TEXT[locale];
  const from = formatExpiry(input.from, locale);
  const at = formatExpiry(input.at, locale);
  const subject = t.subject[input.kind];
  const heading = t.heading[input.kind];
  const rule = t.rule(input.days, from);
  const counts = t.counts(input.threads, input.messages, at);
  const blocks: Block[] = [
    { kind: "paragraph", content: [rule] },
    { kind: "paragraph", content: [{ strong: counts }] },
    { kind: "paragraph", content: [t.kept] },
    { kind: "paragraph", content: [t.final] },
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
    title: subject,
    preheader: t.preheader(at),
    heading,
    blocks,
    footer: t.reason,
    lang: locale,
  });
  const text = [
    heading,
    "",
    rule,
    "",
    counts,
    "",
    t.kept,
    t.final,
    `${t.review}${gap(t.review)}${input.policiesUrl}`,
    "",
    t.reason,
    "Portifact, https://portifact.com",
  ].join("\n");
  return { subject, text, html };
}
