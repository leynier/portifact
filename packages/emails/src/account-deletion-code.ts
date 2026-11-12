// The account deletion code email (docs/legal.md, "Leaving without accepting"): the code a person
// whose account has not accepted the current terms enters to delete the account without
// accepting them. Built like the sign-in code email: the code first, large and in one piece, never
// in the subject or the preview text; then what entering it does, that it signs nobody in, and a
// warning: the code is sent only from a live session of the account, so if the owner did not ask
// for it someone else holds a session, and this email is their only warning. A service email sent only on request, so it has no opt-out. It
// is written in the language of the page that asked for it.
import { DEFAULT_LOCALE, type LocaleCode } from "@portifact/contracts/locales";
import { renderEmail, textSignature } from "./layout.ts";
import type { EmailContent } from "./message.ts";
import { pluralForm } from "./plural.ts";

export interface AccountDeletionCodeInput {
  /** The account's address, shown so the reader knows which account. */
  email: string;
  code: string;
  expiresInMinutes: number;
  /** The language of the email; English when absent. */
  locale?: LocaleCode | undefined;
}

interface DeletionCodeText {
  subject: string;
  heading: string;
  codeLabel: string;
  /** "Enter this code ... delete the account" and what follows the address. */
  intro: [before: string, after: string];
  expiry(minutes: number): string;
  effect: string;
  share: string;
  /** What to do if the reader did not ask: someone may hold a session of the account. */
  warning: string;
  reason: string;
  preheader(expiry: string): string;
}

export const ACCOUNT_DELETION_CODE_TEXT: { readonly [code in LocaleCode]: DeletionCodeText } = {
  en: {
    subject: "Your code to delete your Portifact account",
    heading: "Your account deletion code",
    codeLabel: "Deletion code",
    intro: ["Enter this code on the Portifact page where you asked to delete the account ", "."],
    expiry: (minutes) =>
      `It expires in ${minutes} minute${minutes === 1 ? "" : "s"} and works once.`,
    effect:
      "Entering it deletes the account for good, without accepting the new terms. This code cannot be used to sign in.",
    share: "Never share this code. Portifact will never ask you for it.",
    warning:
      'Nothing is deleted without this code. If you did not ask for it, someone may be signed in to your account: sign in and use "Sign out other sessions" on the Apps page, or write to privacy@portifact.com.',
    reason:
      "You received this email because someone signed in to this Portifact account asked to delete it. It is a service email sent only on request.",
    preheader: (expiry) => `Enter it on the page where you asked to delete the account. ${expiry}`,
  },
  es: {
    subject: "Tu código para eliminar tu cuenta de Portifact",
    heading: "Tu código para eliminar la cuenta",
    codeLabel: "Código de eliminación",
    intro: ["Ingresa este código en la página de Portifact donde pediste eliminar la cuenta ", "."],
    expiry: (minutes) =>
      `Vence en ${minutes} minuto${minutes === 1 ? "" : "s"} y funciona una sola vez.`,
    effect:
      "Al ingresarlo, la cuenta se elimina para siempre, sin aceptar los nuevos términos. Este código no sirve para iniciar sesión.",
    share: "Nunca compartas este código. Portifact nunca te lo va a pedir.",
    warning:
      'Sin este código no se elimina nada. Si no lo pediste, alguien puede tener la sesión iniciada en tu cuenta: inicia sesión y usa "Cerrar las otras sesiones" en la página Apps, o escribe a privacy@portifact.com.',
    reason:
      "Recibiste este correo porque alguien con la sesión iniciada en esta cuenta de Portifact pidió eliminarla. Es un correo de servicio que solo se envía cuando se pide.",
    preheader: (expiry) => `Ingrésalo en la página donde pediste eliminar la cuenta. ${expiry}`,
  },
  "pt-BR": {
    subject: "Seu código para excluir sua conta do Portifact",
    heading: "Seu código de exclusão da conta",
    codeLabel: "Código de exclusão",
    intro: [
      "Digite este código na página do Portifact em que você pediu para excluir a conta ",
      ".",
    ],
    expiry: (minutes) =>
      `Ele expira em ${minutes} minuto${minutes === 1 ? "" : "s"} e funciona uma vez.`,
    effect:
      "Ao digitá-lo, a conta é excluída para sempre, sem aceitar os novos termos. Este código não serve para entrar.",
    share: "Nunca compartilhe este código. O Portifact nunca vai pedi-lo a você.",
    warning:
      'Nada é excluído sem este código. Se você não o pediu, alguém pode estar conectado à sua conta: entre e use "Sair das outras sessões" na página Apps, ou escreva para privacy@portifact.com.',
    reason:
      "Você recebeu este e-mail porque alguém conectado a esta conta do Portifact pediu para excluí-la. É um e-mail de serviço enviado só quando pedido.",
    preheader: (expiry) => `Digite-o na página em que você pediu para excluir a conta. ${expiry}`,
  },
  fr: {
    subject: "Votre code pour supprimer votre compte Portifact",
    heading: "Votre code de suppression du compte",
    codeLabel: "Code de suppression",
    intro: [
      "Saisissez ce code sur la page de Portifact où vous avez demandé à supprimer le compte ",
      ".",
    ],
    expiry: (minutes) =>
      `Il expire dans ${minutes} minute${minutes < 2 ? "" : "s"} et ne fonctionne qu’une fois.`,
    effect:
      "Le saisir supprime le compte définitivement, sans accepter les nouvelles conditions. Ce code ne permet pas de se connecter.",
    share: "Ne partagez jamais ce code. Portifact ne vous le demandera jamais.",
    warning:
      'Rien n’est supprimé sans ce code. Si vous ne l’avez pas demandé, quelqu’un est peut-être connecté à votre compte : connectez-vous et utilisez "Déconnecter les autres sessions" sur la page Apps, ou écrivez à privacy@portifact.com.',
    reason:
      "Vous avez reçu cet e-mail, car une personne connectée à ce compte Portifact a demandé à le supprimer. C’est un e-mail de service envoyé uniquement sur demande.",
    preheader: (expiry) =>
      `Saisissez-le sur la page où vous avez demandé à supprimer le compte. ${expiry}`,
  },
  de: {
    subject: "Dein Code zum Löschen deines Portifact-Kontos",
    heading: "Dein Code zum Löschen des Kontos",
    codeLabel: "Löschcode",
    intro: [
      "Gib diesen Code auf der Portifact-Seite ein, auf der du das Löschen des Kontos angefordert hast: ",
      ".",
    ],
    expiry: (minutes) =>
      `Er läuft in ${minutes} Minute${minutes === 1 ? "" : "n"} ab und funktioniert einmal.`,
    effect:
      "Wenn du ihn eingibst, wird das Konto endgültig gelöscht, ohne die neuen Bedingungen anzunehmen. Mit diesem Code kann man sich nicht anmelden.",
    share: "Teile diesen Code niemals. Portifact wird dich nie danach fragen.",
    warning:
      'Ohne diesen Code wird nichts gelöscht. Wenn du ihn nicht angefordert hast, ist vielleicht jemand in deinem Konto angemeldet: Melde dich an und nutze "Andere Sitzungen abmelden" auf der Seite Apps, oder schreib an privacy@portifact.com.',
    reason:
      "Du hast diese E-Mail erhalten, weil jemand, der in diesem Portifact-Konto angemeldet ist, das Löschen angefordert hat. Es ist eine Service-E-Mail, die nur auf Anfrage gesendet wird.",
    preheader: (expiry) =>
      `Gib ihn auf der Seite ein, auf der du das Löschen angefordert hast. ${expiry}`,
  },
  ru: {
    subject: "Ваш код для удаления аккаунта Portifact",
    heading: "Ваш код для удаления аккаунта",
    codeLabel: "Код удаления",
    intro: ["Введите этот код на странице Portifact, где вы запросили удаление аккаунта ", "."],
    // Accusative after "действует": 1 минуту, 2 минуты, 5 минут.
    expiry: (minutes) =>
      `Код действует ${minutes} ${pluralForm("ru", minutes, { one: "минуту", few: "минуты", many: "минут", other: "минуты" })} и только один раз.`,
    effect:
      "Ввод кода удаляет аккаунт навсегда, без принятия новых условий. Войти с этим кодом нельзя.",
    share: "Никому не сообщайте этот код. Portifact никогда не попросит его у вас.",
    warning:
      'Без этого кода ничего не удаляется. Если вы его не запрашивали, возможно, кто-то вошёл в ваш аккаунт: войдите и нажмите "Завершить другие сеансы" на странице "Приложения" или напишите на privacy@portifact.com.',
    reason:
      "Вы получили это письмо, потому что кто-то, вошедший в этот аккаунт Portifact, запросил его удаление. Это служебное письмо, оно отправляется только по запросу.",
    preheader: (expiry) => `Введите его на странице, где вы запросили удаление. ${expiry}`,
  },
  ja: {
    subject: "Portifactアカウント削除用のコード",
    heading: "アカウント削除用のコード",
    codeLabel: "削除コード",
    intro: [
      "",
      "のアカウントの削除をリクエストしたPortifactのページで、このコードを入力してください。",
    ],
    expiry: (minutes) => `有効期限は${minutes}分で、1回だけ使用できます。`,
    effect:
      "入力すると、新しい規約に同意することなく、アカウントが完全に削除されます。このコードではサインインできません。",
    share: "このコードは誰にも教えないでください。Portifactがコードを尋ねることはありません。",
    warning:
      "このコードがなければ何も削除されません。リクエストしていない場合は、誰かがあなたのアカウントにサインインしている可能性があります。サインインして「アプリ」ページの「ほかのセッションをサインアウト」を使うか、privacy@portifact.com までご連絡ください。",
    reason:
      "このPortifactアカウントにサインインしている人が削除をリクエストしたため、このメールをお送りしています。リクエストがあった場合にのみ送信されるサービスメールです。",
    preheader: (expiry) => `削除をリクエストしたページで入力してください。${expiry}`,
  },
  "zh-CN": {
    subject: "删除你的 Portifact 账号的验证码",
    heading: "账号删除验证码",
    codeLabel: "删除验证码",
    intro: ["请在你申请删除账号 ", " 的 Portifact 页面输入此验证码。"],
    expiry: (minutes) => `验证码将在 ${minutes} 分钟后过期，且只能使用一次。`,
    effect: "输入后，账号将被永久删除，无需接受新条款。此验证码不能用于登录。",
    share: "切勿分享此验证码。Portifact 绝不会向你索要它。",
    warning:
      "没有此验证码，任何内容都不会被删除。如果你没有申请，可能有人已登录你的账号：请登录并在“应用”页面使用“退出其他会话”，或发送邮件至 privacy@portifact.com。",
    reason:
      "你收到这封邮件，是因为已登录此 Portifact 账号的人申请删除它。这是一封仅在申请时发送的服务邮件。",
    preheader: (expiry) => `请在申请删除的页面输入。${expiry}`,
  },
};

export function accountDeletionCodeEmail(input: AccountDeletionCodeInput): EmailContent {
  const locale = input.locale ?? DEFAULT_LOCALE;
  const text = ACCOUNT_DELETION_CODE_TEXT[locale];
  const expiry = text.expiry(input.expiresInMinutes);
  const [before, after] = text.intro;

  const html = renderEmail({
    title: text.subject,
    preheader: text.preheader(expiry),
    heading: text.heading,
    blocks: [
      { kind: "paragraph", content: [before, { strong: input.email }, after] },
      { kind: "code", label: text.codeLabel, value: input.code },
      { kind: "paragraph", content: [`${expiry} ${text.effect}`] },
      { kind: "paragraph", content: [text.share] },
      { kind: "divider" },
      { kind: "paragraph", content: [text.warning] },
    ],
    footer: text.reason,
    lang: locale,
  });

  const plain = [
    text.subject,
    "",
    input.code,
    "",
    `${before}${input.email}${after}`,
    `${expiry} ${text.effect}`,
    text.share,
    "",
    text.warning,
    "",
    text.reason,
    ...textSignature(locale),
  ].join("\n");

  return { subject: text.subject, text: plain, html };
}
