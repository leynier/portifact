// The downgrade notice for custom domains (decision 0006, section 7): when an owner's plan ended
// and the plan they have now allows fewer custom domains, the newest ones keep serving for a grace
// period and then stop. This email, sent once per detach time to the owner (each admin of a
// workspace), lists the hostnames that will stop and when, and says the artifacts keep their
// Portifact addresses. Hostnames are checked, punycode ASCII names, still only ever escaped. It is
// written in the recipient's language, English when they chose none.
import { DEFAULT_LOCALE, type LocaleCode } from "@portifact/contracts/locales";
import { formatExpiry, gap } from "./expiry-notice.ts";
import { type Block, type Inline, renderEmail } from "./layout.ts";
import type { EmailContent } from "./message.ts";
import { pluralCategory } from "./plural.ts";

export interface DomainNoticeInput {
  /** The hostnames that will stop, oldest proof first; at least one. */
  hostnames: string[];
  /** When they stop. */
  detachAt: number;
  /** How many custom domains the owner's plan allows now. */
  limit: number;
  /** The dashboard's usage page, which shows the plan. */
  usageUrl: string;
  locale?: LocaleCode | undefined;
}

/** The notice in one language. Dates come in already formatted, with "UTC". */
export interface DomainNoticeText {
  subject(count: number): string;
  heading(count: number): string;
  preheader(date: string): string;
  intro(limit: number, date: string): string;
  keep: string;
  /** Followed by the usage page's link (or its address in the text version), after `gap`. */
  plan: string;
  planLink: string;
  planEnd: string;
  reason: string;
}

const one = (locale: LocaleCode, count: number) => pluralCategory(locale, count) === "one";

export const DOMAIN_NOTICE_TEXT: { readonly [code in LocaleCode]: DomainNoticeText } = {
  en: {
    subject: (count) =>
      one("en", count)
        ? "Your custom domain will stop soon"
        : `${count} of your custom domains will stop soon`,
    heading: (count) =>
      one("en", count)
        ? "A custom domain will stop soon"
        : `${count} custom domains will stop soon`,
    preheader: (date) => `They stop serving your artifacts on ${date} unless your plan is renewed.`,
    intro: (limit, date) =>
      `Your plan ended, and the plan you have now includes ${limit} custom ${limit === 1 ? "domain" : "domains"}. Unless the plan is renewed, these stop serving your artifacts on ${date}:`,
    keep: "Your artifacts keep their Portifact addresses, and you can add the domains again later with a new DNS check.",
    plan: "See your plan:",
    planLink: "Usage",
    planEnd: ".",
    reason: "You received this email because you manage custom domains on Portifact.",
  },
  es: {
    subject: (count) =>
      one("es", count)
        ? "Tu dominio propio dejará de funcionar pronto"
        : `${count} de tus dominios propios dejarán de funcionar pronto`,
    heading: (count) =>
      one("es", count)
        ? "Un dominio propio dejará de funcionar pronto"
        : `${count} dominios propios dejarán de funcionar pronto`,
    preheader: (date) => `Dejan de servir tus artifacts el ${date} si no renuevas tu plan.`,
    intro: (limit, date) =>
      `Tu plan terminó, y el plan que tienes ahora incluye ${limit} ${limit === 1 ? "dominio propio" : "dominios propios"}. Si no renuevas el plan, estos dejan de servir tus artifacts el ${date}:`,
    keep: "Tus artifacts conservan sus direcciones de Portifact, y puedes volver a agregar los dominios más adelante con una nueva comprobación de DNS.",
    plan: "Consulta tu plan:",
    planLink: "Uso",
    planEnd: ".",
    reason: "Recibiste este correo porque administras dominios propios en Portifact.",
  },
  "pt-BR": {
    subject: (count) =>
      one("pt-BR", count)
        ? "Seu domínio próprio vai parar em breve"
        : `${count} dos seus domínios próprios vão parar em breve`,
    heading: (count) =>
      one("pt-BR", count)
        ? "Um domínio próprio vai parar em breve"
        : `${count} domínios próprios vão parar em breve`,
    preheader: (date) =>
      `Eles deixam de servir seus artifacts em ${date} se o plano não for renovado.`,
    intro: (limit, date) =>
      `Seu plano terminou, e o plano que você tem agora inclui ${limit} ${limit === 1 ? "domínio próprio" : "domínios próprios"}. Se o plano não for renovado, estes deixam de servir seus artifacts em ${date}:`,
    keep: "Seus artifacts mantêm os endereços do Portifact, e você pode adicionar os domínios de novo depois com uma nova verificação de DNS.",
    plan: "Veja seu plano:",
    planLink: "Uso",
    planEnd: ".",
    reason: "Você recebeu este e-mail porque administra domínios próprios no Portifact.",
  },
  fr: {
    subject: (count) =>
      one("fr", count)
        ? "Votre domaine personnalisé va bientôt s’arrêter"
        : `${count} de vos domaines personnalisés vont bientôt s’arrêter`,
    heading: (count) =>
      one("fr", count)
        ? "Un domaine personnalisé va bientôt s’arrêter"
        : `${count} domaines personnalisés vont bientôt s’arrêter`,
    preheader: (date) =>
      `Ils cessent de servir vos artifacts le ${date} si le forfait n’est pas renouvelé.`,
    intro: (limit, date) =>
      `Votre forfait a pris fin, et votre forfait actuel inclut ${limit} ${limit === 1 ? "domaine personnalisé" : "domaines personnalisés"}. Sans renouvellement, ceux-ci cessent de servir vos artifacts le ${date} :`,
    keep: "Vos artifacts gardent leurs adresses Portifact, et vous pourrez ajouter les domaines à nouveau plus tard avec une nouvelle vérification DNS.",
    plan: "Voir votre forfait :",
    planLink: "Utilisation",
    planEnd: ".",
    reason:
      "Vous avez reçu cet e-mail parce que vous gérez des domaines personnalisés sur Portifact.",
  },
  de: {
    subject: (count) =>
      one("de", count)
        ? "Ihre eigene Domain wird bald abgeschaltet"
        : `${count} Ihrer eigenen Domains werden bald abgeschaltet`,
    heading: (count) =>
      one("de", count)
        ? "Eine eigene Domain wird bald abgeschaltet"
        : `${count} eigene Domains werden bald abgeschaltet`,
    preheader: (date) =>
      `Sie liefern Ihre Artifacts ab ${date} nicht mehr aus, wenn der Tarif nicht verlängert wird.`,
    intro: (limit, date) =>
      `Ihr Tarif ist abgelaufen, und Ihr jetziger Tarif umfasst ${limit} ${limit === 1 ? "eigene Domain" : "eigene Domains"}. Ohne Verlängerung liefern diese Domains Ihre Artifacts ab ${date} nicht mehr aus:`,
    keep: "Ihre Artifacts behalten ihre Portifact-Adressen, und Sie können die Domains später mit einer neuen DNS-Prüfung wieder hinzufügen.",
    plan: "Ihr Tarif:",
    planLink: "Nutzung",
    planEnd: ".",
    reason: "Sie haben diese E-Mail erhalten, weil Sie eigene Domains auf Portifact verwalten.",
  },
  ru: {
    subject: (count) =>
      one("ru", count)
        ? "Ваш домен скоро перестанет работать"
        : `Ваши домены (${count}) скоро перестанут работать`,
    heading: (count) =>
      one("ru", count)
        ? "Домен скоро перестанет работать"
        : `Домены (${count}) скоро перестанут работать`,
    preheader: (date) => `Они перестанут открывать ваши artifacts ${date}, если тариф не продлить.`,
    intro: (limit, date) =>
      `Ваш тариф закончился, и текущий тариф включает своих доменов: ${limit}. Если тариф не продлить, эти домены перестанут открывать ваши artifacts ${date}:`,
    keep: "Ваши artifacts сохранят адреса на Portifact, а домены можно будет добавить снова позже, пройдя новую проверку DNS.",
    plan: "Ваш тариф:",
    planLink: "Использование",
    planEnd: ".",
    reason: "Вы получили это письмо, потому что управляете своими доменами в Portifact.",
  },
  ja: {
    subject: (count) =>
      one("ja", count)
        ? "カスタムドメインがまもなく停止します"
        : `${count} 件のカスタムドメインがまもなく停止します`,
    heading: (count) =>
      one("ja", count)
        ? "カスタムドメインがまもなく停止します"
        : `${count} 件のカスタムドメインがまもなく停止します`,
    preheader: (date) => `プランを更新しない場合、${date} に artifact の公開を停止します。`,
    intro: (limit, date) =>
      `プランが終了しました。現在のプランのカスタムドメインは ${limit} 件までです。プランを更新しない場合、次のドメインは ${date} に artifact の公開を停止します。`,
    keep: "artifact の Portifact のアドレスはそのまま使えます。ドメインは後で新しい DNS 確認を行えば再び追加できます。",
    plan: "プランの確認:",
    planLink: "使用状況",
    planEnd: "。",
    reason: "Portifact でカスタムドメインを管理しているため、このメールをお送りしました。",
  },
  "zh-CN": {
    subject: (count) =>
      one("zh-CN", count) ? "你的自定义域名即将停止" : `你的 ${count} 个自定义域名即将停止`,
    heading: (count) =>
      one("zh-CN", count) ? "自定义域名即将停止" : `${count} 个自定义域名即将停止`,
    preheader: (date) => `如果不续订套餐,它们将在 ${date} 停止提供你的 artifact。`,
    intro: (limit, date) =>
      `你的套餐已结束,当前套餐包含 ${limit} 个自定义域名。如果不续订套餐,以下域名将在 ${date} 停止提供你的 artifact:`,
    keep: "你的 artifact 会保留其 Portifact 地址,之后你可以通过新的 DNS 检查重新添加这些域名。",
    plan: "查看你的套餐:",
    planLink: "使用情况",
    planEnd: "。",
    reason: "你收到这封邮件,是因为你在 Portifact 上管理自定义域名。",
  },
};

export function domainNoticeEmail(input: DomainNoticeInput): EmailContent {
  const locale = input.locale ?? DEFAULT_LOCALE;
  const t = DOMAIN_NOTICE_TEXT[locale];
  const date = formatExpiry(input.detachAt, locale);
  const count = input.hostnames.length;
  const subject = t.subject(count);
  const heading = t.heading(count);
  const intro = t.intro(input.limit, date);
  const items: Inline[][] = input.hostnames.map((hostname) => [{ strong: hostname }]);
  const blocks: Block[] = [
    { kind: "paragraph", content: [intro] },
    { kind: "list", items },
    { kind: "paragraph", content: [t.keep] },
    { kind: "divider" },
    {
      kind: "paragraph",
      content: [t.plan + gap(t.plan), { href: input.usageUrl, text: t.planLink }, t.planEnd],
      muted: true,
    },
  ];
  const html = renderEmail({
    title: subject,
    preheader: t.preheader(date),
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
    ...input.hostnames.map((hostname) => `- ${hostname}`),
    "",
    t.keep,
    `${t.plan}${gap(t.plan)}${input.usageUrl}`,
    "",
    t.reason,
    "Portifact, https://portifact.com",
  ].join("\n");
  return { subject, text, html };
}
