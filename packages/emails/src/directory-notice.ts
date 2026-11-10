// The notice a person gets when their organization's directory adds their existing Portifact
// account to a workspace through SCIM (decision 0017): they joined without an accept step, so
// the email says who added them, links the workspace, and says how to leave and that leaving
// holds. The workspace name is owner-chosen text: kept on one line and always escaped. Written
// in the recipient's language, English when they chose none.
import { DEFAULT_LOCALE, type LocaleCode } from "@portifact/contracts/locales";
import { gap } from "./expiry-notice.ts";
import { type Block, renderEmail } from "./layout.ts";
import type { EmailContent } from "./message.ts";

export interface DirectoryNoticeInput {
  workspaceName: string;
  /** The dashboard in the workspace's space. */
  workspaceUrl: string;
  /** The workspace's Members page, where the person can leave. */
  membersUrl: string;
  locale?: LocaleCode | undefined;
}

/** The notice in one language. */
export interface DirectoryNoticeText {
  subject(workspace: string): string;
  preheader: string;
  intro(workspace: string): string;
  shares: string;
  /** Followed by the workspace's link, after `gap`. */
  open: string;
  /** Followed by the Members page's link, after `gap`. */
  leave: string;
  leaveLink: string;
  leaveEnd: string;
  reason: string;
}

export const DIRECTORY_NOTICE_TEXT: { readonly [code in LocaleCode]: DirectoryNoticeText } = {
  en: {
    subject: (w) => `You were added to ${w}`,
    preheader: "Your organization's directory added your Portifact account to a workspace.",
    intro: (w) =>
      `Your organization's directory added your Portifact account to the workspace ${w} as a member.`,
    shares:
      "You now see what its members share with the workspace. Nothing of yours was shared, and your personal space stays yours.",
    open: "Open the workspace:",
    leave: "To leave, choose Leave on its",
    leaveLink: "Members page",
    leaveEnd: ". The directory's next sync does not add you back.",
    reason:
      "You received this email because your organization's directory added you to a workspace on Portifact.",
  },
  es: {
    subject: (w) => `Te agregaron a ${w}`,
    preheader:
      "El directorio de tu organización agregó tu cuenta de Portifact a un espacio de trabajo.",
    intro: (w) =>
      `El directorio de tu organización agregó tu cuenta de Portifact al espacio de trabajo ${w} como miembro.`,
    shares:
      "Ahora ves lo que sus miembros comparten con el espacio de trabajo. No se compartió nada tuyo y tu espacio personal sigue siendo tuyo.",
    open: "Abre el espacio de trabajo:",
    leave: "Para salir, elige Salir en su",
    leaveLink: "página de miembros",
    leaveEnd: ". La próxima sincronización del directorio no te vuelve a agregar.",
    reason:
      "Recibiste este correo porque el directorio de tu organización te agregó a un espacio de trabajo en Portifact.",
  },
  "pt-BR": {
    subject: (w) => `Você foi adicionado a ${w}`,
    preheader:
      "O diretório da sua organização adicionou sua conta do Portifact a um espaço de trabalho.",
    intro: (w) =>
      `O diretório da sua organização adicionou sua conta do Portifact ao espaço de trabalho ${w} como membro.`,
    shares:
      "Agora você vê o que os membros compartilham com o espaço de trabalho. Nada seu foi compartilhado, e seu espaço pessoal continua seu.",
    open: "Abra o espaço de trabalho:",
    leave: "Para sair, escolha Sair na",
    leaveLink: "página de membros",
    leaveEnd: ". A próxima sincronização do diretório não adiciona você de novo.",
    reason:
      "Você recebeu este e-mail porque o diretório da sua organização adicionou você a um espaço de trabalho no Portifact.",
  },
  fr: {
    subject: (w) => `Vous avez été ajouté à ${w}`,
    preheader:
      "L’annuaire de votre organisation a ajouté votre compte Portifact à un espace de travail.",
    intro: (w) =>
      `L’annuaire de votre organisation a ajouté votre compte Portifact à l’espace de travail ${w} en tant que membre.`,
    shares:
      "Vous voyez désormais ce que ses membres partagent avec l’espace de travail. Rien de ce qui est à vous n’a été partagé, et votre espace personnel reste le vôtre.",
    open: "Ouvrir l’espace de travail :",
    leave: "Pour partir, choisissez Quitter sur sa",
    leaveLink: "page des membres",
    leaveEnd: ". La prochaine synchronisation de l’annuaire ne vous rajoute pas.",
    reason:
      "Vous avez reçu cet e-mail parce que l’annuaire de votre organisation vous a ajouté à un espace de travail sur Portifact.",
  },
  de: {
    subject: (w) => `Sie wurden zu ${w} hinzugefügt`,
    preheader:
      "Das Verzeichnis Ihrer Organisation hat Ihr Portifact-Konto zu einem Workspace hinzugefügt.",
    intro: (w) =>
      `Das Verzeichnis Ihrer Organisation hat Ihr Portifact-Konto als Mitglied zum Workspace ${w} hinzugefügt.`,
    shares:
      "Sie sehen jetzt, was seine Mitglieder mit dem Workspace teilen. Nichts von Ihnen wurde geteilt, und Ihr persönlicher Bereich bleibt Ihrer.",
    open: "Workspace öffnen:",
    leave: "Zum Verlassen wählen Sie Verlassen auf der",
    leaveLink: "Mitgliederseite",
    leaveEnd: ". Die nächste Synchronisierung des Verzeichnisses fügt Sie nicht wieder hinzu.",
    reason:
      "Sie haben diese E-Mail erhalten, weil das Verzeichnis Ihrer Organisation Sie zu einem Workspace auf Portifact hinzugefügt hat.",
  },
  ru: {
    subject: (w) => `Вас добавили в ${w}`,
    preheader: "Каталог вашей организации добавил ваш аккаунт Portifact в рабочее пространство.",
    intro: (w) =>
      `Каталог вашей организации добавил ваш аккаунт Portifact в рабочее пространство ${w} как участника.`,
    shares:
      "Теперь вы видите то, чем его участники делятся с рабочим пространством. Ничего вашего не открыто, а личное пространство остаётся вашим.",
    open: "Открыть рабочее пространство:",
    leave: "Чтобы выйти, выберите «Покинуть» на",
    leaveLink: "странице участников",
    leaveEnd: ". Следующая синхронизация каталога не добавит вас снова.",
    reason:
      "Вы получили это письмо, потому что каталог вашей организации добавил вас в рабочее пространство в Portifact.",
  },
  ja: {
    subject: (w) => `${w} に追加されました`,
    preheader: "組織のディレクトリがあなたの Portifact アカウントをワークスペースに追加しました。",
    intro: (w) =>
      `組織のディレクトリが、あなたの Portifact アカウントをワークスペース ${w} にメンバーとして追加しました。`,
    shares:
      "メンバーがワークスペースと共有しているものを見られるようになりました。あなたのものは何も共有されておらず、個人スペースはあなたのものです。",
    open: "ワークスペースを開く:",
    leave: "退出するには、",
    leaveLink: "メンバーページ",
    leaveEnd:
      "で「退出」を選んでください。ディレクトリの次回の同期で再び追加されることはありません。",
    reason:
      "組織のディレクトリが Portifact のワークスペースにあなたを追加したため、このメールをお送りしました。",
  },
  "zh-CN": {
    subject: (w) => `你已被添加到 ${w}`,
    preheader: "你所在组织的目录已将你的 Portifact 账户添加到一个工作区。",
    intro: (w) => `你所在组织的目录已将你的 Portifact 账户以成员身份添加到工作区 ${w}。`,
    shares:
      "现在你可以看到其成员与工作区共享的内容。你的任何内容都没有被共享,你的个人空间仍归你所有。",
    open: "打开工作区:",
    leave: "如需离开,请在",
    leaveLink: "成员页面",
    leaveEnd: "选择“离开”。目录的下一次同步不会再次添加你。",
    reason: "你收到这封邮件,是因为你所在组织的目录将你添加到了 Portifact 上的一个工作区。",
  },
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
const oneLine = (text: string) => text.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();

export function directoryNoticeEmail(input: DirectoryNoticeInput): EmailContent {
  const locale = input.locale ?? DEFAULT_LOCALE;
  const t = DIRECTORY_NOTICE_TEXT[locale];
  const workspace = oneLine(input.workspaceName);
  const subject = t.subject(workspace);
  const intro = t.intro(workspace);
  const blocks: Block[] = [
    { kind: "paragraph", content: [intro] },
    { kind: "paragraph", content: [t.shares] },
    {
      kind: "paragraph",
      content: [t.open + gap(t.open), { href: input.workspaceUrl, text: workspace }],
    },
    { kind: "divider" },
    {
      kind: "paragraph",
      content: [t.leave + gap(t.leave), { href: input.membersUrl, text: t.leaveLink }, t.leaveEnd],
      muted: true,
    },
  ];
  const html = renderEmail({
    title: subject,
    preheader: t.preheader,
    heading: subject,
    blocks,
    footer: t.reason,
    lang: locale,
  });
  const text = [
    subject,
    "",
    intro,
    "",
    t.shares,
    "",
    `${t.open}${gap(t.open)}${input.workspaceUrl}`,
    "",
    `${t.leave}${gap(t.leave)}${t.leaveLink} (${input.membersUrl})${t.leaveEnd}`,
    "",
    t.reason,
    "Portifact, https://portifact.com",
  ].join("\n");
  return { subject, text, html };
}
