// The review notice the jobs Worker sends (decision 0013, "Emails"; docs/operations.md, "Review
// notices"): one email when someone is asked to review an artifact, and one to the owner side when
// the version under review is approved or changes are requested. It names the artifact and the
// version and links the viewer, and never holds a note, a reviewer's name or anything the
// reviewers wrote. The artifact name is the owner's own input: it is only ever escaped, never put
// in the subject, and left out entirely with `names: false` (decision 0005). It is written in the
// recipient's language, English when they chose none. Review emails follow the comment notices
// setting, so the footer says so and carries the same one-click unsubscribe link.
import { DEFAULT_LOCALE, type LocaleCode } from "@portifact/contracts/locales";
import { gap } from "./expiry-notice.ts";
import { type Block, type Inline, renderEmail } from "./layout.ts";
import type { EmailContent } from "./message.ts";

export type ReviewNoticeKind = "requested" | "approved" | "changes_requested";

export interface ReviewNoticeInput {
  kind: ReviewNoticeKind;
  /** Left out when the notice is built without names. */
  name: string;
  /** The version under review, when it is known. */
  version: number | null;
  /** The artifact in the viewer, `https://app.portifact.com/view/<id>`. */
  url: string;
  /** The dashboard's settings page, where the notices are turned off. */
  settingsUrl: string;
  /** The page that turns comment and review notices off with the signed link. */
  unsubscribeUrl: string;
  /** Whether the artifact name may appear; false writes "An artifact" instead. */
  names: boolean;
  /** The recipient's language; English when absent. */
  locale?: LocaleCode | undefined;
}

/** The text of the notice in one language. `{name}` in a sentence stands for the artifact. */
export interface ReviewText {
  subject: Record<ReviewNoticeKind, string>;
  heading: Record<ReviewNoticeKind, string>;
  preheader: Record<ReviewNoticeKind, string>;
  sentence: Record<ReviewNoticeKind, string>;
  /** After the name; `#` is the version number. */
  version: string;
  /** The link to the artifact in the viewer. */
  open: Record<ReviewNoticeKind, string>;
  privacy: string;
  /** Stands for the name when names are left out. */
  unnamed: string;
  /** Followed by the settings link, after `gap`. */
  optOut: string;
  settings: string;
  optOutEnd: string;
  /** Followed by the unsubscribe link. */
  unsubscribe: string;
  unsubscribeLink: string;
  reason: Record<"requested" | "completed", string>;
}

export const REVIEW_TEXT: { readonly [code in LocaleCode]: ReviewText } = {
  en: {
    subject: {
      requested: "Your review is requested on Portifact",
      approved: "A version was approved on Portifact",
      changes_requested: "Changes were requested on Portifact",
    },
    heading: {
      requested: "Your review was requested",
      approved: "Version approved",
      changes_requested: "Changes requested",
    },
    preheader: {
      requested: "Open the artifact in Portifact to review it and give your verdict.",
      approved: "The reviewers approved the version under review.",
      changes_requested: "A reviewer asked for changes to the version under review.",
    },
    sentence: {
      requested:
        "You were asked to review {name}. Open it to read it, then approve it or request changes.",
      approved: "The reviewers approved {name}.",
      changes_requested: "A reviewer requested changes on {name}.",
    },
    version: " (version #)",
    open: {
      requested: "Review it",
      approved: "Open the review",
      changes_requested: "Open the review",
    },
    privacy: "This email never includes notes or the names of other reviewers.",
    unnamed: "An artifact",
    optOut:
      "Review emails follow your comment notices setting. To stop them, change your settings:",
    settings: "Settings",
    optOutEnd: ".",
    unsubscribe: "Or turn comment and review notices off with one click:",
    unsubscribeLink: "Unsubscribe",
    reason: {
      requested: "You received this email because someone asked for your review on Portifact.",
      completed: "You received this email because you manage this artifact on Portifact.",
    },
  },
  es: {
    subject: {
      requested: "Te piden una revisión en Portifact",
      approved: "Se aprobó una versión en Portifact",
      changes_requested: "Se pidieron cambios en Portifact",
    },
    heading: {
      requested: "Te pidieron una revisión",
      approved: "Versión aprobada",
      changes_requested: "Cambios solicitados",
    },
    preheader: {
      requested: "Abre el artifact en Portifact para revisarlo y dar tu veredicto.",
      approved: "Los revisores aprobaron la versión en revisión.",
      changes_requested: "Un revisor pidió cambios en la versión en revisión.",
    },
    sentence: {
      requested:
        "Te pidieron que revises {name}. Ábrelo para leerlo y luego apruébalo o pide cambios.",
      approved: "Los revisores aprobaron {name}.",
      changes_requested: "Un revisor pidió cambios en {name}.",
    },
    version: " (versión #)",
    open: {
      requested: "Revisarlo",
      approved: "Abrir la revisión",
      changes_requested: "Abrir la revisión",
    },
    privacy: "Este correo nunca incluye notas ni los nombres de otros revisores.",
    unnamed: "Un artifact",
    optOut:
      "Los correos de revisión siguen tu configuración de avisos de comentarios. Para dejar de recibirlos, cambia tu configuración:",
    settings: "Configuración",
    optOutEnd: ".",
    unsubscribe: "O desactiva los avisos de comentarios y revisiones con un clic:",
    unsubscribeLink: "Darme de baja",
    reason: {
      requested: "Recibiste este correo porque alguien pidió tu revisión en Portifact.",
      completed: "Recibiste este correo porque gestionas este artifact en Portifact.",
    },
  },
  "pt-BR": {
    subject: {
      requested: "Pediram sua revisão no Portifact",
      approved: "Uma versão foi aprovada no Portifact",
      changes_requested: "Pediram mudanças no Portifact",
    },
    heading: {
      requested: "Pediram sua revisão",
      approved: "Versão aprovada",
      changes_requested: "Mudanças pedidas",
    },
    preheader: {
      requested: "Abra o artifact no Portifact para revisá-lo e dar seu parecer.",
      approved: "Os revisores aprovaram a versão em revisão.",
      changes_requested: "Um revisor pediu mudanças na versão em revisão.",
    },
    sentence: {
      requested: "Pediram que você revise {name}. Abra para ler e depois aprove ou peça mudanças.",
      approved: "Os revisores aprovaram {name}.",
      changes_requested: "Um revisor pediu mudanças em {name}.",
    },
    version: " (versão #)",
    open: {
      requested: "Revisar",
      approved: "Abrir a revisão",
      changes_requested: "Abrir a revisão",
    },
    privacy: "Este e-mail nunca inclui notas nem os nomes de outros revisores.",
    unnamed: "Um artifact",
    optOut:
      "Os e-mails de revisão seguem sua configuração de avisos de comentários. Para parar de recebê-los, mude suas configurações:",
    settings: "Configurações",
    optOutEnd: ".",
    unsubscribe: "Ou desative os avisos de comentários e revisões com um clique:",
    unsubscribeLink: "Cancelar inscrição",
    reason: {
      requested: "Você recebeu este e-mail porque alguém pediu sua revisão no Portifact.",
      completed: "Você recebeu este e-mail porque gerencia este artifact no Portifact.",
    },
  },
  fr: {
    subject: {
      requested: "On vous demande une relecture sur Portifact",
      approved: "Une version a été approuvée sur Portifact",
      changes_requested: "Des modifications ont été demandées sur Portifact",
    },
    heading: {
      requested: "Votre relecture est demandée",
      approved: "Version approuvée",
      changes_requested: "Modifications demandées",
    },
    preheader: {
      requested: "Ouvrez l’artifact dans Portifact pour le relire et donner votre avis.",
      approved: "Les relecteurs ont approuvé la version en relecture.",
      changes_requested: "Un relecteur a demandé des modifications de la version en relecture.",
    },
    sentence: {
      requested:
        "On vous a demandé de relire {name}. Ouvrez-le pour le lire, puis approuvez-le ou demandez des modifications.",
      approved: "Les relecteurs ont approuvé {name}.",
      changes_requested: "Un relecteur a demandé des modifications sur {name}.",
    },
    version: " (version #)",
    open: {
      requested: "Le relire",
      approved: "Ouvrir la relecture",
      changes_requested: "Ouvrir la relecture",
    },
    privacy: "Cet e-mail ne contient jamais de notes ni les noms des autres relecteurs.",
    unnamed: "Un artifact",
    optOut:
      "Les e-mails de relecture suivent votre réglage des avis de commentaires. Pour ne plus les recevoir, modifiez vos réglages :",
    settings: "Réglages",
    optOutEnd: ".",
    unsubscribe: "Ou désactivez les avis de commentaires et de relecture en un clic :",
    unsubscribeLink: "Se désabonner",
    reason: {
      requested:
        "Vous recevez cet e-mail parce que quelqu’un a demandé votre relecture sur Portifact.",
      completed: "Vous recevez cet e-mail parce que vous gérez cet artifact sur Portifact.",
    },
  },
  de: {
    subject: {
      requested: "Dein Review wird auf Portifact angefragt",
      approved: "Eine Version wurde auf Portifact freigegeben",
      changes_requested: "Auf Portifact wurden Änderungen angefordert",
    },
    heading: {
      requested: "Dein Review wurde angefragt",
      approved: "Version freigegeben",
      changes_requested: "Änderungen angefordert",
    },
    preheader: {
      requested: "Öffne das Artifact in Portifact, um es zu prüfen und dein Urteil abzugeben.",
      approved: "Die Reviewer haben die geprüfte Version freigegeben.",
      changes_requested: "Ein Reviewer hat Änderungen an der geprüften Version angefordert.",
    },
    sentence: {
      requested:
        "Du wurdest gebeten, {name} zu prüfen. Öffne es, lies es und gib es dann frei oder fordere Änderungen an.",
      approved: "Die Reviewer haben {name} freigegeben.",
      changes_requested: "Ein Reviewer hat Änderungen an {name} angefordert.",
    },
    version: " (Version #)",
    open: {
      requested: "Jetzt prüfen",
      approved: "Review öffnen",
      changes_requested: "Review öffnen",
    },
    privacy: "Diese E-Mail enthält nie Notizen oder die Namen anderer Reviewer.",
    unnamed: "Ein Artifact",
    optOut:
      "Review-E-Mails folgen deiner Einstellung für Kommentarhinweise. Um sie abzustellen, ändere deine Einstellungen:",
    settings: "Einstellungen",
    optOutEnd: ".",
    unsubscribe: "Oder schalte Kommentar- und Review-Hinweise mit einem Klick ab:",
    unsubscribeLink: "Abmelden",
    reason: {
      requested: "Du erhältst diese E-Mail, weil jemand auf Portifact dein Review angefragt hat.",
      completed: "Du erhältst diese E-Mail, weil du dieses Artifact auf Portifact verwaltest.",
    },
  },
  ru: {
    subject: {
      requested: "Вас просят провести ревью в Portifact",
      approved: "В Portifact одобрена версия",
      changes_requested: "В Portifact запрошены изменения",
    },
    heading: {
      requested: "Вас попросили провести ревью",
      approved: "Версия одобрена",
      changes_requested: "Запрошены изменения",
    },
    preheader: {
      requested: "Откройте artifact в Portifact, чтобы провести ревью и вынести решение.",
      approved: "Ревьюеры одобрили версию на ревью.",
      changes_requested: "Ревьюер запросил изменения в версии на ревью.",
    },
    sentence: {
      requested:
        "Вас попросили провести ревью {name}. Откройте его, прочитайте, а затем одобрите или запросите изменения.",
      approved: "Ревьюеры одобрили {name}.",
      changes_requested: "Ревьюер запросил изменения в {name}.",
    },
    version: " (версия #)",
    open: {
      requested: "Провести ревью",
      approved: "Открыть ревью",
      changes_requested: "Открыть ревью",
    },
    privacy: "Это письмо никогда не содержит заметок и имён других ревьюеров.",
    unnamed: "Artifact",
    optOut:
      "Письма о ревью подчиняются настройке уведомлений о комментариях. Чтобы отключить их, измените настройки:",
    settings: "Настройки",
    optOutEnd: ".",
    unsubscribe: "Или отключите уведомления о комментариях и ревью одним нажатием:",
    unsubscribeLink: "Отписаться",
    reason: {
      requested: "Вы получили это письмо, потому что вас попросили провести ревью в Portifact.",
      completed: "Вы получили это письмо, потому что управляете этим artifact в Portifact.",
    },
  },
  ja: {
    subject: {
      requested: "Portifactでレビューを依頼されました",
      approved: "Portifactでバージョンが承認されました",
      changes_requested: "Portifactで変更が求められました",
    },
    heading: {
      requested: "レビューを依頼されました",
      approved: "バージョンが承認されました",
      changes_requested: "変更が求められました",
    },
    preheader: {
      requested: "Portifactでartifactを開いてレビューし、判断を伝えてください。",
      approved: "レビュー担当者がレビュー中のバージョンを承認しました。",
      changes_requested: "レビュー担当者がレビュー中のバージョンに変更を求めました。",
    },
    sentence: {
      requested:
        "{name}のレビューを依頼されました。開いて内容を確認し、承認するか変更を求めてください。",
      approved: "レビュー担当者が{name}を承認しました。",
      changes_requested: "レビュー担当者が{name}に変更を求めました。",
    },
    version: "（バージョン #）",
    open: {
      requested: "レビューする",
      approved: "レビューを開く",
      changes_requested: "レビューを開く",
    },
    privacy: "このメールにはメモやほかのレビュー担当者の名前は含まれません。",
    unnamed: "あるartifact",
    optOut: "レビューのメールはコメント通知の設定に従います。停止するには設定を変更してください：",
    settings: "設定",
    optOutEnd: "。",
    unsubscribe: "または、ワンクリックでコメントとレビューの通知をオフにできます：",
    unsubscribeLink: "配信を停止",
    reason: {
      requested: "Portifactでレビューを依頼されたため、このメールをお送りしています。",
      completed: "Portifactでこのartifactを管理しているため、このメールをお送りしています。",
    },
  },
  "zh-CN": {
    subject: {
      requested: "有人在 Portifact 上请你审阅",
      approved: "Portifact 上的一个版本已获批准",
      changes_requested: "Portifact 上有人要求修改",
    },
    heading: {
      requested: "有人请你审阅",
      approved: "版本已获批准",
      changes_requested: "已要求修改",
    },
    preheader: {
      requested: "在 Portifact 中打开该 artifact，审阅后给出你的结论。",
      approved: "审阅人已批准正在审阅的版本。",
      changes_requested: "有审阅人要求修改正在审阅的版本。",
    },
    sentence: {
      requested: "有人请你审阅{name}。打开阅读后，批准它或要求修改。",
      approved: "审阅人已批准{name}。",
      changes_requested: "有审阅人要求修改{name}。",
    },
    version: "（版本 #）",
    open: { requested: "去审阅", approved: "打开审阅", changes_requested: "打开审阅" },
    privacy: "这封邮件从不包含备注或其他审阅人的姓名。",
    unnamed: "一个 artifact",
    optOut: "审阅邮件沿用你的评论通知设置。如需停止，请更改设置：",
    settings: "设置",
    optOutEnd: "。",
    unsubscribe: "或一键关闭评论和审阅通知：",
    unsubscribeLink: "退订",
    reason: {
      requested: "你收到这封邮件，是因为有人在 Portifact 上请你审阅。",
      completed: "你收到这封邮件，是因为你在 Portifact 上管理这个 artifact。",
    },
  },
};

/** A name on one line, so an odd one cannot break the sentence or the text version. */
function oneLine(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

export function reviewNoticeEmail(input: ReviewNoticeInput): EmailContent {
  const locale = input.locale ?? DEFAULT_LOCALE;
  const t = REVIEW_TEXT[locale];
  const kind = input.kind;
  const name = input.names ? oneLine(input.name) || t.unnamed : t.unnamed;
  const version = input.version === null ? "" : t.version.replace("#", String(input.version));
  const [before = "", after = ""] = t.sentence[kind].split("{name}");
  const reason = t.reason[kind === "requested" ? "requested" : "completed"];

  const sentence: Inline[] = [before, { strong: name }, `${version}${after}`];
  const blocks: Block[] = [
    { kind: "paragraph", content: sentence },
    { kind: "paragraph", content: [{ href: input.url, text: t.open[kind] }] },
    { kind: "paragraph", content: [t.privacy], muted: true },
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
    title: t.subject[kind],
    preheader: t.preheader[kind],
    heading: t.heading[kind],
    blocks,
    footer: reason,
    lang: locale,
  });
  const text = [
    t.heading[kind],
    "",
    `${before}${name}${version}${after}`,
    "",
    `${t.open[kind]}: ${input.url}`,
    "",
    t.privacy,
    "",
    `${t.optOut}${gap(t.optOut)}${input.settingsUrl}`,
    `${t.unsubscribe}${gap(t.unsubscribe)}${input.unsubscribeUrl}`,
    "",
    reason,
    "Portifact, https://portifact.com",
  ].join("\n");
  return { subject: t.subject[kind], text, html };
}
