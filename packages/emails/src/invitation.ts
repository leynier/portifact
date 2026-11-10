// The invitation to a workspace an admin sends from the dashboard (premium plan T1): who invited
// the reader, to which workspace and with which role, the link to accept it, when it expires and
// that it can be ignored. The inviter's and the workspace's names are user input: they are only
// ever escaped and kept on one line, and never put in the subject or the preview text. It is
// written in the inviter's account language, since the invited person may have no account yet;
// the texts are typed by the locale list, so a new language fails the typecheck until it is here.
import type { WorkspaceRole } from "@portifact/contracts";
import { DEFAULT_LOCALE, type LocaleCode } from "@portifact/contracts/locales";
import { formatExpiry } from "./expiry-notice.ts";
import { renderEmail } from "./layout.ts";
import type { EmailContent } from "./message.ts";

export interface InvitationInput {
  /** The invited address, shown so the reader knows which account to sign in with. */
  email: string;
  inviterName: string;
  workspaceName: string;
  role: WorkspaceRole;
  /** The link that accepts it: the dashboard's invitation page with the token. */
  acceptUrl: string;
  expiresAt: number;
  /** The inviter's language; English when absent. */
  locale?: LocaleCode | undefined;
}

export interface InvitationText {
  subject: string;
  heading: string;
  preheader: string;
  /** "<inviter> invited you to <workspace> as <role>." in three parts around the names. */
  invited(role: string): [beforeInviter: string, beforeWorkspace: string, after: string];
  roles: Record<WorkspaceRole, string>;
  /** Stands for an inviter whose account has no name. */
  someone: string;
  accept: string;
  /** Followed by the invited address in bold and `signInEnd`. */
  signIn: string;
  signInEnd: string;
  expires(date: string): string;
  ignore: string;
  reason: string;
}

export const INVITATION_TEXT: { readonly [code in LocaleCode]: InvitationText } = {
  en: {
    subject: "You are invited to a workspace on Portifact",
    heading: "Join a workspace on Portifact",
    preheader: "Accept the invitation to see and publish the workspace's artifacts.",
    invited: (role) => ["", " invited you to the workspace ", ` as ${role}.`],
    roles: { admin: "an admin", editor: "an editor", member: "a member" },
    someone: "An admin",
    accept: "Accept the invitation",
    signIn: "Sign in with ",
    signInEnd:
      " to accept it. If you have no Portifact account yet, you create one when you sign in.",
    expires: (date) => `The invitation expires ${date} and works once.`,
    ignore: "If you did not expect it, ignore this email. Nothing happens unless you accept.",
    reason:
      "You received this email because an admin of a Portifact workspace invited this address.",
  },
  es: {
    subject: "Te invitaron a un espacio de trabajo en Portifact",
    heading: "Únete a un espacio de trabajo en Portifact",
    preheader: "Acepta la invitación para ver y publicar los artifacts del espacio de trabajo.",
    invited: (role) => ["", " te invitó al espacio de trabajo ", ` como ${role}.`],
    roles: { admin: "administrador", editor: "editor", member: "miembro" },
    someone: "Un administrador",
    accept: "Aceptar la invitación",
    signIn: "Inicia sesión con ",
    signInEnd:
      " para aceptarla. Si todavía no tienes una cuenta de Portifact, la creas al iniciar sesión.",
    expires: (date) => `La invitación vence el ${date} y funciona una sola vez.`,
    ignore: "Si no la esperabas, ignora este correo. No pasa nada a menos que la aceptes.",
    reason:
      "Recibiste este correo porque un administrador de un espacio de trabajo de Portifact invitó a esta dirección.",
  },
  "pt-BR": {
    subject: "Você foi convidado para um workspace no Portifact",
    heading: "Entre em um workspace no Portifact",
    preheader: "Aceite o convite para ver e publicar os artifacts do workspace.",
    invited: (role) => ["", " convidou você para o workspace ", ` como ${role}.`],
    roles: { admin: "administrador", editor: "editor", member: "membro" },
    someone: "Um administrador",
    accept: "Aceitar o convite",
    signIn: "Entre com ",
    signInEnd:
      " para aceitá-lo. Se você ainda não tem uma conta no Portifact, ela é criada quando você entra.",
    expires: (date) => `O convite expira em ${date} e funciona uma vez.`,
    ignore:
      "Se você não esperava este convite, ignore este e-mail. Nada acontece se você não aceitar.",
    reason:
      "Você recebeu este e-mail porque um administrador de um workspace do Portifact convidou este endereço.",
  },
  fr: {
    subject: "Vous êtes invité dans un espace de travail Portifact",
    heading: "Rejoignez un espace de travail Portifact",
    preheader: "Acceptez l’invitation pour voir et publier les artifacts de l’espace de travail.",
    invited: (role) => ["", " vous a invité dans l’espace de travail ", ` en tant que ${role}.`],
    roles: { admin: "administrateur", editor: "éditeur", member: "membre" },
    someone: "Un administrateur",
    accept: "Accepter l’invitation",
    signIn: "Connectez-vous avec ",
    signInEnd:
      " pour l’accepter. Si vous n’avez pas encore de compte Portifact, vous le créez en vous connectant.",
    expires: (date) => `L’invitation expire le ${date} et ne fonctionne qu’une fois.`,
    ignore:
      "Si vous ne l’attendiez pas, ignorez cet e-mail. Rien ne se passe tant que vous ne l’acceptez pas.",
    reason:
      "Vous avez reçu cet e-mail, car un administrateur d’un espace de travail Portifact a invité cette adresse.",
  },
  de: {
    subject: "Du wurdest in einen Workspace auf Portifact eingeladen",
    heading: "Tritt einem Workspace auf Portifact bei",
    preheader:
      "Nimm die Einladung an, um die Artifacts des Workspaces zu sehen und zu veröffentlichen.",
    invited: (role) => ["", " hat dich in den Workspace ", ` als ${role} eingeladen.`],
    roles: { admin: "Admin", editor: "Editor", member: "Mitglied" },
    someone: "Ein Admin",
    accept: "Einladung annehmen",
    signIn: "Melde dich mit ",
    signInEnd:
      " an, um sie anzunehmen. Wenn du noch kein Portifact-Konto hast, erstellst du es bei der Anmeldung.",
    expires: (date) => `Die Einladung läuft am ${date} ab und funktioniert einmal.`,
    ignore:
      "Wenn du sie nicht erwartet hast, ignoriere diese E-Mail. Ohne deine Zustimmung passiert nichts.",
    reason:
      "Du hast diese E-Mail erhalten, weil ein Admin eines Portifact-Workspaces diese Adresse eingeladen hat.",
  },
  ru: {
    subject: "Вас пригласили в рабочее пространство Portifact",
    heading: "Присоединяйтесь к рабочему пространству Portifact",
    preheader: "Примите приглашение, чтобы видеть и публиковать artifacts рабочего пространства.",
    invited: (role) => ["", " пригласил(а) вас в рабочее пространство ", ` с ролью «${role}».`],
    roles: { admin: "администратор", editor: "редактор", member: "участник" },
    someone: "Администратор",
    accept: "Принять приглашение",
    signIn: "Войдите с адресом ",
    signInEnd:
      ", чтобы принять его. Если у вас ещё нет аккаунта Portifact, он будет создан при входе.",
    expires: (date) => `Приглашение действует до ${date} и только один раз.`,
    ignore:
      "Если вы его не ждали, просто проигнорируйте это письмо. Без вашего согласия ничего не произойдёт.",
    reason:
      "Вы получили это письмо, потому что администратор рабочего пространства Portifact пригласил этот адрес.",
  },
  ja: {
    subject: "Portifactのワークスペースに招待されました",
    heading: "Portifactのワークスペースに参加",
    preheader: "招待を承認すると、ワークスペースのartifactを閲覧・公開できます。",
    invited: (role) => ["", "さんから、ワークスペース", `に${role}として招待されました。`],
    roles: { admin: "管理者", editor: "編集者", member: "メンバー" },
    someone: "管理者",
    accept: "招待を承認する",
    signIn: "承認するには ",
    signInEnd:
      " でサインインしてください。Portifactのアカウントをお持ちでない場合は、サインイン時に作成されます。",
    expires: (date) => `この招待の有効期限は${date}で、1回だけ使用できます。`,
    ignore: "心当たりがない場合は、このメールを無視してください。承認しない限り何も起こりません。",
    reason:
      "Portifactワークスペースの管理者がこのアドレスを招待したため、このメールをお送りしています。",
  },
  "zh-CN": {
    subject: "你受邀加入 Portifact 上的工作区",
    heading: "加入 Portifact 上的工作区",
    preheader: "接受邀请后即可查看并发布该工作区的 artifacts。",
    invited: (role) => ["", ` 邀请你以${role}身份加入工作区 `, "。"],
    roles: { admin: "管理员", editor: "编辑者", member: "成员" },
    someone: "一位管理员",
    accept: "接受邀请",
    signIn: "请使用 ",
    signInEnd: " 登录以接受邀请。如果你还没有 Portifact 账户，登录时会自动创建。",
    expires: (date) => `邀请将于 ${date} 过期，且只能使用一次。`,
    ignore: "如果你没有预料到这封邀请，请忽略此邮件。除非你接受，否则不会有任何变化。",
    reason: "你收到这封邮件，是因为某个 Portifact 工作区的管理员邀请了此地址。",
  },
};

/** A name on one line, so a line break in it cannot fake another line in the text version. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: replacing control characters is the point
const oneLine = (name: string) => name.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();

export function invitationEmail(input: InvitationInput): EmailContent {
  const locale = input.locale ?? DEFAULT_LOCALE;
  const t = INVITATION_TEXT[locale];
  const inviter = oneLine(input.inviterName) || t.someone;
  const workspace = oneLine(input.workspaceName);
  const [beforeInviter, beforeWorkspace, after] = t.invited(t.roles[input.role]);
  const expires = t.expires(formatExpiry(input.expiresAt, locale));

  const html = renderEmail({
    title: t.subject,
    preheader: t.preheader,
    heading: t.heading,
    blocks: [
      {
        kind: "paragraph",
        content: [
          beforeInviter,
          { strong: inviter },
          beforeWorkspace,
          { strong: workspace },
          after,
        ],
      },
      { kind: "paragraph", content: [{ href: input.acceptUrl, text: t.accept }] },
      { kind: "paragraph", content: [t.signIn, { strong: input.email }, t.signInEnd] },
      { kind: "paragraph", content: [expires] },
      { kind: "divider" },
      { kind: "paragraph", content: [t.ignore], muted: true },
    ],
    footer: t.reason,
    lang: locale,
  });

  const text = [
    t.heading,
    "",
    `${beforeInviter}${inviter}${beforeWorkspace}${workspace}${after}`,
    "",
    `${t.accept}: ${input.acceptUrl}`,
    "",
    `${t.signIn}${input.email}${t.signInEnd}`,
    expires,
    "",
    t.ignore,
    "",
    t.reason,
    "Portifact, https://portifact.com",
  ].join("\n");

  return { subject: t.subject, text, html };
}
