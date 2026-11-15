// The notice the people who manage an artifact get when someone who saved data in it asks about
// it (decision 0026, "Moderation and law": the rights request page notifies the artifact's
// admins). It names the person only by the opaque visitor ID the artifact's data already holds
// (`_by`), never by name or address, and links the artifact's Data section. The artifact's name
// appears only where the region lets a notice name it, and never in the subject. A service
// notice: no unsubscribe link. Written in the recipient's language, English when they chose none.
import { DEFAULT_LOCALE, type LocaleCode } from "@portifact/contracts/locales";
import { gap } from "./expiry-notice.ts";
import { type Block, renderEmail, textSignature } from "./layout.ts";
import type { EmailContent } from "./message.ts";

export type DataRightsKind = "access" | "erasure";

export interface DataRightsNoticeInput {
  kind: DataRightsKind;
  /** Null where the region keeps artifact names out of email (decision 0005). */
  artifactName: string | null;
  visitorId: string;
  /** The artifact's page in the dashboard, where its Data section is. */
  dataUrl: string;
  locale?: LocaleCode | undefined;
}

export interface DataRightsNoticeText {
  subject: string;
  preheader: string;
  intro(kind: DataRightsKind, artifact: string | null): string;
  visitor(id: string): string;
  /** Followed by the artifact's link, after `gap`. */
  open: string;
  openLink: string;
  self: string;
  reason: string;
}

export const DATA_RIGHTS_NOTICE_TEXT: { readonly [code in LocaleCode]: DataRightsNoticeText } = {
  en: {
    subject: "Someone asked about the data they saved in your artifact",
    preheader: "A person who saved data in an artifact you manage sent a request about it.",
    intro: (k, a) =>
      `Someone who saved data in ${a === null ? "an artifact you manage" : `the artifact ${a}`} asked you to ${k === "access" ? "give them a copy of" : "erase"} what they saved there.`,
    visitor: (id) => `In the artifact's data they are the visitor ${id} (the _by field).`,
    open: "Find their documents in the artifact's data:",
    openLink: "Open the artifact",
    self: "They can also export and delete the documents they created themselves. Portifact does not share their name or email with you.",
    reason: "You received this email because you manage an artifact that holds data on Portifact.",
  },
  es: {
    subject: "Alguien preguntó por los datos que guardó en tu artifact",
    preheader: "Una persona que guardó datos en un artifact que gestionas envió una solicitud.",
    intro: (k, a) =>
      `Alguien que guardó datos en ${a === null ? "un artifact que gestionas" : `el artifact ${a}`} te pidió ${k === "access" ? "una copia de" : "borrar"} lo que guardó ahí.`,
    visitor: (id) => `En los datos del artifact es el visitante ${id} (el campo _by).`,
    open: "Encuentra sus documentos en los datos del artifact:",
    openLink: "Abrir el artifact",
    self: "También puede exportar y eliminar por su cuenta los documentos que creó. Portifact no te comparte su nombre ni su correo.",
    reason: "Recibiste este correo porque gestionas un artifact con datos en Portifact.",
  },
  "pt-BR": {
    subject: "Alguém perguntou sobre os dados que salvou no seu artifact",
    preheader: "Uma pessoa que salvou dados em um artifact que você gerencia enviou um pedido.",
    intro: (k, a) =>
      `Alguém que salvou dados em ${a === null ? "um artifact que você gerencia" : `no artifact ${a}`} pediu ${k === "access" ? "uma cópia do" : "que você apague o"} que salvou ali.`,
    visitor: (id) => `Nos dados do artifact, a pessoa é o visitante ${id} (o campo _by).`,
    open: "Encontre os documentos dela nos dados do artifact:",
    openLink: "Abrir o artifact",
    self: "Ela também pode exportar e excluir por conta própria os documentos que criou. O Portifact não compartilha o nome nem o e-mail dela com você.",
    reason: "Você recebeu este e-mail porque gerencia um artifact com dados no Portifact.",
  },
  fr: {
    subject: "Quelqu'un a posé une question sur les données enregistrées dans votre artifact",
    preheader:
      "Une personne qui a enregistré des données dans un artifact que vous gérez a envoyé une demande.",
    intro: (k, a) =>
      `Une personne qui a enregistré des données dans ${a === null ? "un artifact que vous gérez" : `l'artifact ${a}`} vous demande ${k === "access" ? "une copie de" : "d'effacer"} ce qu'elle y a enregistré.`,
    visitor: (id) => `Dans les données de l'artifact, c'est le visiteur ${id} (le champ _by).`,
    open: "Retrouvez ses documents dans les données de l'artifact :",
    openLink: "Ouvrir l'artifact",
    self: "Elle peut aussi exporter et supprimer elle-même les documents qu'elle a créés. Portifact ne vous communique ni son nom ni son e-mail.",
    reason:
      "Vous recevez cet e-mail parce que vous gérez un artifact qui contient des données sur Portifact.",
  },
  de: {
    subject: "Jemand hat nach den Daten gefragt, die er in deinem Artifact gespeichert hat",
    preheader:
      "Eine Person, die Daten in einem von dir verwalteten Artifact gespeichert hat, hat eine Anfrage gesendet.",
    intro: (k, a) =>
      `Jemand, der Daten in ${a === null ? "einem von dir verwalteten Artifact" : `dem Artifact ${a}`} gespeichert hat, bittet dich, ${k === "access" ? "eine Kopie davon zu geben" : "das dort Gespeicherte zu löschen"}.`,
    visitor: (id) => `In den Daten des Artifacts ist die Person der Besucher ${id} (das Feld _by).`,
    open: "Finde ihre Dokumente in den Daten des Artifacts:",
    openLink: "Artifact öffnen",
    self: "Sie kann die Dokumente, die sie erstellt hat, auch selbst exportieren und löschen. Portifact teilt dir weder ihren Namen noch ihre E-Mail-Adresse mit.",
    reason: "Du erhältst diese E-Mail, weil du ein Artifact mit Daten auf Portifact verwaltest.",
  },
  ru: {
    subject: "Человек спросил о данных, которые сохранил в вашем artifact",
    preheader: "Человек, сохранивший данные в artifact под вашим управлением, отправил запрос.",
    intro: (k, a) =>
      `Человек, сохранивший данные в ${a === null ? "artifact под вашим управлением" : `artifact ${a}`}, просит ${k === "access" ? "предоставить копию" : "удалить"} то, что он там сохранил.`,
    visitor: (id) => `В данных artifact это посетитель ${id} (поле _by).`,
    open: "Найдите его документы в данных artifact:",
    openLink: "Открыть artifact",
    self: "Он также может сам экспортировать и удалить созданные им документы. Portifact не сообщает вам его имя и адрес почты.",
    reason: "Вы получили это письмо, потому что управляете artifact с данными в Portifact.",
  },
  ja: {
    subject: "あなたの artifact に保存したデータについて問い合わせがありました",
    preheader: "あなたが管理する artifact にデータを保存した人からリクエストが届きました。",
    intro: (k, a) =>
      `${a === null ? "あなたが管理する artifact" : `artifact ${a}`} にデータを保存した人から、保存した内容${k === "access" ? "のコピーを求める" : "の削除を求める"}リクエストが届きました。`,
    visitor: (id) => `artifact のデータでは、この人は訪問者 ${id}（_by フィールド）です。`,
    open: "artifact のデータでこの人のドキュメントを確認してください:",
    openLink: "artifact を開く",
    self: "この人は自分が作成したドキュメントを自分でエクスポート・削除することもできます。Portifact がこの人の名前やメールアドレスをあなたに伝えることはありません。",
    reason: "Portifact でデータを持つ artifact を管理しているため、このメールをお送りしました。",
  },
  "zh-CN": {
    subject: "有人询问了其在你的 artifact 中保存的数据",
    preheader: "一位在你管理的 artifact 中保存过数据的人发送了请求。",
    intro: (k, a) =>
      `一位在${a === null ? "你管理的 artifact" : ` artifact ${a} `}中保存过数据的人请你${k === "access" ? "提供其保存内容的副本" : "删除其保存的内容"}。`,
    visitor: (id) => `在该 artifact 的数据中，此人是访客 ${id}（_by 字段）。`,
    open: "在 artifact 的数据中查找此人的文档:",
    openLink: "打开 artifact",
    self: "此人也可以自行导出和删除自己创建的文档。Portifact 不会向你提供此人的姓名或邮箱。",
    reason: "你收到这封邮件，是因为你在 Portifact 上管理一个包含数据的 artifact。",
  },
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
const oneLine = (text: string) => text.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();

export function dataRightsNoticeEmail(input: DataRightsNoticeInput): EmailContent {
  const locale = input.locale ?? DEFAULT_LOCALE;
  const t = DATA_RIGHTS_NOTICE_TEXT[locale];
  const name = input.artifactName === null ? null : oneLine(input.artifactName);
  const intro = t.intro(input.kind, name);
  const visitor = t.visitor(input.visitorId);
  const blocks: Block[] = [
    { kind: "paragraph", content: [intro] },
    { kind: "paragraph", content: [visitor] },
    {
      kind: "paragraph",
      content: [t.open + gap(t.open), { href: input.dataUrl, text: t.openLink }],
    },
    { kind: "divider" },
    { kind: "paragraph", content: [t.self], muted: true },
  ];
  const html = renderEmail({
    title: t.subject,
    preheader: t.preheader,
    heading: t.subject,
    blocks,
    footer: t.reason,
    lang: locale,
  });
  const text = [
    t.subject,
    "",
    intro,
    "",
    visitor,
    "",
    `${t.open}${gap(t.open)}${input.dataUrl}`,
    "",
    t.self,
    "",
    t.reason,
    ...textSignature(locale),
  ].join("\n");
  return { subject: t.subject, text, html };
}
