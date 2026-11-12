// The outcome of a report (docs/operations.md, "Reports"): when the operator resolves a report
// that came with an email address, the reporter learns what was decided and how to ask for a
// review. It never names the people who manage the content: only the address or ID the reporter
// gave, the date of the report and the decision. Written in the report form's language.
import { DEFAULT_LOCALE, type LocaleCode } from "@portifact/contracts/locales";
import { formatExpiry } from "./expiry-notice.ts";
import { type Block, renderEmail, textSignature } from "./layout.ts";
import type { EmailContent } from "./message.ts";

export type ReportOutcome = "actioned" | "dismissed";

export interface ReportOutcomeInput {
  outcome: ReportOutcome;
  /** What the reporter named: the exact address they gave, or the artifact's ID. */
  reported: string;
  reportedAt: number;
  locale?: LocaleCode | undefined;
}

/** The email in one language. */
export interface ReportOutcomeText {
  subject: string;
  intro(reported: string, at: string): string;
  actioned: string;
  dismissed: string;
  human: string;
  review: string;
  footer: string;
}

export const REPORT_OUTCOME_TEXT: { readonly [code in LocaleCode]: ReportOutcomeText } = {
  en: {
    subject: "The outcome of your report to Portifact",
    intro: (r, at) => `On ${at} you reported this to Portifact: ${r}`,
    actioned: "We reviewed it and restricted the content.",
    dismissed:
      "We reviewed it and did not find that it breaks our rules or the law, so we took no action.",
    human: "A person took this decision.",
    review:
      "To ask us to review this decision, write to abuse@portifact.com and mention the address you reported. Someone looks at it again and tells you the outcome. You may also have other redress, such as a court.",
    footer:
      "You received this email because you gave this address when you reported content to Portifact.",
  },
  es: {
    subject: "El resultado de tu denuncia a Portifact",
    intro: (r, at) => `El ${at} denunciaste esto a Portifact: ${r}`,
    actioned: "Lo revisamos y restringimos el contenido.",
    dismissed:
      "Lo revisamos y no encontramos que infrinja nuestras reglas ni la ley, así que no tomamos ninguna medida.",
    human: "Una persona tomó esta decisión.",
    review:
      "Para pedirnos que revisemos esta decisión, escribe a abuse@portifact.com y menciona la dirección que denunciaste. Otra persona la vuelve a mirar y te dice el resultado. También puedes tener otras vías, como un tribunal.",
    footer: "Recibiste este correo porque diste esta dirección al denunciar contenido a Portifact.",
  },
  "pt-BR": {
    subject: "O resultado da sua denúncia ao Portifact",
    intro: (r, at) => `Em ${at} você denunciou isto ao Portifact: ${r}`,
    actioned: "Analisamos e restringimos o conteúdo.",
    dismissed:
      "Analisamos e não concluímos que viole nossas regras ou a lei, por isso não tomamos nenhuma medida.",
    human: "Uma pessoa tomou esta decisão.",
    review:
      "Para pedir que revisemos esta decisão, escreva para abuse@portifact.com e mencione o endereço que você denunciou. Outra pessoa a examina de novo e informa o resultado. Você também pode ter outros recursos, como um tribunal.",
    footer:
      "Você recebeu este e-mail porque informou este endereço ao denunciar conteúdo ao Portifact.",
  },
  fr: {
    subject: "Le résultat de votre signalement à Portifact",
    intro: (r, at) => `Le ${at}, vous avez signalé ceci à Portifact : ${r}`,
    actioned: "Nous l’avons examiné et avons restreint le contenu.",
    dismissed:
      "Nous l’avons examiné et n’avons pas constaté qu’il enfreint nos règles ou la loi ; nous n’avons donc rien fait.",
    human: "Une personne a pris cette décision.",
    review:
      "Pour nous demander de réexaminer cette décision, écrivez à abuse@portifact.com en indiquant l’adresse signalée. Une autre personne la réexamine et vous communique le résultat. D’autres recours, comme un tribunal, peuvent aussi vous être ouverts.",
    footer:
      "Vous avez reçu cet e-mail parce que vous avez donné cette adresse en signalant un contenu à Portifact.",
  },
  de: {
    subject: "Das Ergebnis Ihrer Meldung an Portifact",
    intro: (r, at) => `Am ${at} haben Sie Folgendes an Portifact gemeldet: ${r}`,
    actioned: "Wir haben es geprüft und den Inhalt eingeschränkt.",
    dismissed:
      "Wir haben es geprüft und keinen Verstoß gegen unsere Regeln oder das Gesetz festgestellt, daher haben wir nichts unternommen.",
    human: "Ein Mensch hat diese Entscheidung getroffen.",
    review:
      "Um eine Überprüfung dieser Entscheidung zu verlangen, schreiben Sie an abuse@portifact.com und nennen Sie die gemeldete Adresse. Eine andere Person sieht sie sich erneut an und teilt Ihnen das Ergebnis mit. Ihnen können auch andere Rechtsbehelfe offenstehen, etwa ein Gericht.",
    footer:
      "Sie erhalten diese E-Mail, weil Sie diese Adresse bei einer Meldung an Portifact angegeben haben.",
  },
  ru: {
    subject: "Результат вашей жалобы в Portifact",
    intro: (r, at) => `${at} вы пожаловались в Portifact на следующее: ${r}`,
    actioned: "Мы проверили это и ограничили контент.",
    dismissed:
      "Мы проверили это и не нашли нарушения наших правил или закона, поэтому не приняли мер.",
    human: "Это решение принял человек.",
    review:
      "Чтобы попросить нас пересмотреть это решение, напишите на abuse@portifact.com и укажите адрес, на который вы пожаловались. Другой человек рассмотрит его заново и сообщит вам результат. У вас также могут быть другие средства защиты, например суд.",
    footer:
      "Вы получили это письмо, потому что указали этот адрес, когда пожаловались на контент в Portifact.",
  },
  ja: {
    subject: "Portifact への通報の結果",
    intro: (r, at) => `${at} に次の内容を Portifact に通報いただきました: ${r}`,
    actioned: "確認のうえ、コンテンツを制限しました。",
    dismissed:
      "確認しましたが、当社のルールまたは法律に違反するとは判断しなかったため、対応は行いませんでした。",
    human: "この決定は人が行いました。",
    review:
      "この決定の見直しを求めるには、通報したアドレスを添えて abuse@portifact.com までご連絡ください。別の担当者が改めて確認し、結果をお知らせします。裁判所など、その他の救済手段を利用できる場合もあります。",
    footer:
      "Portifact にコンテンツを通報した際にこのアドレスを入力されたため、このメールをお送りしました。",
  },
  "zh-CN": {
    subject: "你向 Portifact 举报的处理结果",
    intro: (r, at) => `你于 ${at} 向 Portifact 举报了以下内容:${r}`,
    actioned: "我们已审查并限制了该内容。",
    dismissed: "我们已审查,但未发现其违反我们的规则或法律,因此没有采取行动。",
    human: "此决定由人作出。",
    review:
      "如需请求我们复核此决定,请写信至 abuse@portifact.com 并注明你举报的地址。另一位人员会重新审查并告知你结果。你也可能有其他救济途径,例如法院。",
    footer: "你收到这封邮件,是因为你在向 Portifact 举报内容时留下了这个地址。",
  },
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
const oneLine = (text: string) => text.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();

export function reportOutcomeEmail(input: ReportOutcomeInput): EmailContent {
  const locale = input.locale ?? DEFAULT_LOCALE;
  const t = REPORT_OUTCOME_TEXT[locale];
  const intro = t.intro(oneLine(input.reported), formatExpiry(input.reportedAt, locale));
  const decision = input.outcome === "actioned" ? t.actioned : t.dismissed;
  const blocks: Block[] = [
    { kind: "paragraph", content: [intro] },
    { kind: "paragraph", content: [`${decision} ${t.human}`] },
    { kind: "divider" },
    { kind: "paragraph", content: [t.review], muted: true },
  ];
  const html = renderEmail({
    title: t.subject,
    preheader: decision,
    heading: t.subject,
    blocks,
    footer: t.footer,
    lang: locale,
  });
  const text = [
    t.subject,
    "",
    intro,
    "",
    `${decision} ${t.human}`,
    "",
    t.review,
    "",
    t.footer,
    ...textSignature(locale),
  ].join("\n");
  return { subject: t.subject, text, html };
}
