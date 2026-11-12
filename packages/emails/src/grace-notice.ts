// The grace emails (decision 0022, third delivery): when an owner's plan ends, is removed or is
// lowered, what it kept is held for 60 days, and each hold is announced when it starts, 14 days
// before it ends and 3 days before it ends. The email says until when the data is held, what goes
// then and how much (counts per kind, in the dashboard's words for each kind, never a list of
// artifacts), and the two actions: download the data (the space's "Download your data" page or
// `portifact export`) and ask for the plan again. It is a service notice about the deletion of
// the recipient's data, so it has no unsubscribe link and says it cannot be turned off.
//
// `names: false` is an owner whose data stays outside the default region (`noticeDetail` in
// packages/domain, decision 0005): the workspace is not named, only linked. The workspace name is
// owner-chosen text: kept on one line, never in the subject and always escaped.
import type { GraceForecastKind, GraceNoticeMoment } from "@portifact/contracts";
import { DEFAULT_LOCALE, type LocaleCode } from "@portifact/contracts/locales";
import { formatExpiry, gap } from "./expiry-notice.ts";
import { type Block, renderEmail, textSignature } from "./layout.ts";
import type { EmailContent } from "./message.ts";

export interface GraceNoticeKind {
  kind: GraceForecastKind;
  count: number;
  /** When these go. */
  from: number;
}

export interface GraceNoticeInput {
  moment: GraceNoticeMoment;
  /** When the hold ends. */
  until: number;
  /** The held plan's label (`Pro`, `Team`, `Enterprise`). */
  plan: string;
  /** What goes and when, from the forecast: at least one step (a hold is announced only then). */
  kinds: GraceNoticeKind[];
  /** The workspace's name, null for a personal space. */
  workspace: string | null;
  /** Whether the email may name the workspace (`noticeDetail`). */
  names: boolean;
  /** The space's "Download your data" page. */
  downloadUrl: string;
  /** `portifact export` for this space, ready to copy. */
  exportCommand: string;
  /** The plan request (`planRequestHref`). */
  requestUrl: string;
  locale?: LocaleCode | undefined;
}

/** The email in one language. Dates come in already formatted, with "UTC". */
export interface GraceNoticeText {
  subject: { readonly [moment in GraceNoticeMoment]: (date: string) => string };
  /** With the first date anything held goes. */
  preheader(date: string): string;
  introStart(plan: string, date: string): string;
  /** The first date anything held goes: the earliest step listed, never a later one. */
  safe(date: string): string;
  introLater(plan: string, date: string): string;
  space: string;
  personal: string;
  someWorkspace: string;
  goes: string;
  /** The dashboard's words for each kind (`data.kind.*`). */
  kinds: { readonly [kind in GraceForecastKind]: string };
  amount(count: string, date: string): string;
  /** Followed by the download page's link, after `gap`. */
  download: string;
  downloadLink: string;
  cli: string;
  /** Followed by the request link, after `gap`. */
  request: string;
  requestLink(plan: string): string;
  reason: string;
}

export const GRACE_NOTICE_TEXT: { readonly [code in LocaleCode]: GraceNoticeText } = {
  en: {
    subject: {
      start: (date) => `Your data is held until ${date}`,
      two_weeks: (date) => `Two weeks left: your held data goes on ${date}`,
      three_days: (date) => `Three days left: your held data goes on ${date}`,
    },
    preheader: (date) => `Nothing held goes before ${date}. Download what you need.`,
    introStart: (plan, date) =>
      `The ${plan} plan of this space ended or was lowered. What it kept is held until ${date}.`,
    safe: (date) => `Nothing held goes before ${date}.`,
    introLater: (plan, date) =>
      `What the ${plan} plan of this space kept is held only until ${date}.`,
    space: "Space",
    personal: "Your account",
    someWorkspace: "One of your workspaces",
    goes: "What goes, and from when, unless the plan is back:",
    kinds: {
      versions: "Previous versions",
      accessLog: "Access log entries",
      analytics: "Daily analytics counters",
      auditEvents: "Audit events",
      pins: "Pinned artifacts (unpinned, then archived as usual)",
    },
    amount: (count, date) => `${count}, from ${date}`,
    download: "Download what you need before then:",
    downloadLink: "Download your data",
    cli: "Or take everything at once with the Portifact CLI:",
    request: "To keep everything, ask for the plan again:",
    requestLink: (plan) => `Ask for ${plan} again`,
    reason:
      "You received this email because you manage this space on Portifact. It is a service notice about your data, so it cannot be turned off.",
  },
  es: {
    subject: {
      start: (date) => `Tus datos se conservan hasta el ${date}`,
      two_weeks: (date) => `Quedan dos semanas: tus datos conservados se borran el ${date}`,
      three_days: (date) => `Quedan tres días: tus datos conservados se borran el ${date}`,
    },
    preheader: (date) =>
      `No se borra nada de lo conservado antes del ${date}. Descarga lo que necesites.`,
    introStart: (plan, date) =>
      `El plan ${plan} de este espacio terminó o se redujo. Lo que guardaba se conserva hasta el ${date}.`,
    safe: (date) => `No se borra nada de lo conservado antes del ${date}.`,
    introLater: (plan, date) =>
      `Lo que guardaba el plan ${plan} de este espacio se conserva solo hasta el ${date}.`,
    space: "Espacio",
    personal: "Tu cuenta",
    someWorkspace: "Uno de tus espacios de trabajo",
    goes: "Lo que se borra, y desde cuándo, si el plan no vuelve:",
    kinds: {
      versions: "Versiones anteriores",
      accessLog: "Entradas del registro de accesos",
      analytics: "Contadores diarios de analítica",
      auditEvents: "Eventos de auditoría",
      pins: "Artefactos fijados (se desfijan y luego se archivan como siempre)",
    },
    amount: (count, date) => `${count}, desde el ${date}`,
    download: "Descarga lo que necesites antes:",
    downloadLink: "Descarga tus datos",
    cli: "O llévatelo todo de una vez con la CLI de Portifact:",
    request: "Para conservarlo todo, pide el plan de nuevo:",
    requestLink: (plan) => `Pide ${plan} de nuevo`,
    reason:
      "Recibiste este correo porque administras este espacio en Portifact. Es un aviso de servicio sobre tus datos, así que no se puede desactivar.",
  },
  "pt-BR": {
    subject: {
      start: (date) => `Seus dados ficam guardados até ${date}`,
      two_weeks: (date) => `Faltam duas semanas: seus dados guardados são apagados em ${date}`,
      three_days: (date) => `Faltam três dias: seus dados guardados são apagados em ${date}`,
    },
    preheader: (date) =>
      `Nada do que está guardado é apagado antes de ${date}. Baixe o que precisar.`,
    introStart: (plan, date) =>
      `O plano ${plan} deste espaço terminou ou foi reduzido. O que ele guardava fica até ${date}.`,
    safe: (date) => `Nada do que está guardado é apagado antes de ${date}.`,
    introLater: (plan, date) => `O que o plano ${plan} deste espaço guardava fica só até ${date}.`,
    space: "Espaço",
    personal: "Sua conta",
    someWorkspace: "Um dos seus espaços de trabalho",
    goes: "O que é apagado, e a partir de quando, se o plano não voltar:",
    kinds: {
      versions: "Versões anteriores",
      accessLog: "Entradas do registro de acesso",
      analytics: "Contadores diários de análise",
      auditEvents: "Eventos de auditoria",
      pins: "Artefatos fixados (desafixados e depois arquivados como sempre)",
    },
    amount: (count, date) => `${count}, a partir de ${date}`,
    download: "Baixe o que precisar antes disso:",
    downloadLink: "Baixe seus dados",
    cli: "Ou leve tudo de uma vez com a CLI do Portifact:",
    request: "Para manter tudo, peça o plano de novo:",
    requestLink: (plan) => `Peça o ${plan} de novo`,
    reason:
      "Você recebeu este e-mail porque administra este espaço no Portifact. É um aviso de serviço sobre seus dados, por isso não pode ser desativado.",
  },
  fr: {
    subject: {
      start: (date) => `Vos données sont conservées jusqu’au ${date}`,
      two_weeks: (date) =>
        `Plus que deux semaines : vos données conservées seront supprimées le ${date}`,
      three_days: (date) =>
        `Plus que trois jours : vos données conservées seront supprimées le ${date}`,
    },
    preheader: (date) =>
      `Rien de ce qui est conservé n’est supprimé avant le ${date}. Téléchargez ce dont vous avez besoin.`,
    introStart: (plan, date) =>
      `L’offre ${plan} de cet espace a pris fin ou a été réduite. Ce qu’elle gardait est conservé jusqu’au ${date}.`,
    safe: (date) => `Rien de ce qui est conservé n’est supprimé avant le ${date}.`,
    introLater: (plan, date) =>
      `Ce que gardait l’offre ${plan} de cet espace n’est conservé que jusqu’au ${date}.`,
    space: "Espace",
    personal: "Votre compte",
    someWorkspace: "L’un de vos espaces de travail",
    goes: "Ce qui sera supprimé, et à partir de quand, si l’offre n’est pas rétablie :",
    kinds: {
      versions: "Versions précédentes",
      accessLog: "Entrées du journal d'accès",
      analytics: "Compteurs quotidiens de statistiques",
      auditEvents: "Événements d'audit",
      pins: "Artefacts épinglés (désépinglés, puis archivés comme d'habitude)",
    },
    amount: (count, date) => `${count}, à partir du ${date}`,
    download: "Téléchargez ce dont vous avez besoin avant cette date :",
    downloadLink: "Télécharger vos données",
    cli: "Ou récupérez tout d’un coup avec la CLI Portifact :",
    request: "Pour tout garder, redemandez l’offre :",
    requestLink: (plan) => `Redemander ${plan}`,
    reason:
      "Vous avez reçu cet e-mail parce que vous gérez cet espace sur Portifact. C’est un avis de service concernant vos données : il ne peut pas être désactivé.",
  },
  de: {
    subject: {
      start: (date) => `Ihre Daten bleiben bis ${date} erhalten`,
      two_weeks: (date) => `Noch zwei Wochen: Ihre aufbewahrten Daten werden am ${date} gelöscht`,
      three_days: (date) => `Noch drei Tage: Ihre aufbewahrten Daten werden am ${date} gelöscht`,
    },
    preheader: (date) =>
      `Vor ${date} wird nichts Aufbewahrtes gelöscht. Laden Sie herunter, was Sie brauchen.`,
    introStart: (plan, date) =>
      `Der Tarif ${plan} dieses Bereichs ist abgelaufen oder wurde herabgestuft. Was er aufbewahrte, bleibt bis ${date} erhalten.`,
    safe: (date) => `Vor ${date} wird nichts Aufbewahrtes gelöscht.`,
    introLater: (plan, date) =>
      `Was der Tarif ${plan} dieses Bereichs aufbewahrte, bleibt nur noch bis ${date} erhalten.`,
    space: "Bereich",
    personal: "Ihr Konto",
    someWorkspace: "Einer Ihrer Arbeitsbereiche",
    goes: "Was gelöscht wird, und ab wann, wenn der Tarif nicht zurückkommt:",
    kinds: {
      versions: "Frühere Versionen",
      accessLog: "Einträge im Zugriffsprotokoll",
      analytics: "Tägliche Analysezähler",
      auditEvents: "Audit-Ereignisse",
      pins: "Angeheftete Artefakte (gelöst, dann wie üblich archiviert)",
    },
    amount: (count, date) => `${count}, ab ${date}`,
    download: "Laden Sie vorher herunter, was Sie brauchen:",
    downloadLink: "Daten herunterladen",
    cli: "Oder holen Sie alles auf einmal mit der Portifact-CLI:",
    request: "Um alles zu behalten, fordern Sie den Tarif erneut an:",
    requestLink: (plan) => `${plan} erneut anfordern`,
    reason:
      "Sie haben diese E-Mail erhalten, weil Sie diesen Bereich auf Portifact verwalten. Es ist ein Servicehinweis zu Ihren Daten und kann nicht abbestellt werden.",
  },
  ru: {
    subject: {
      start: (date) => `Ваши данные сохраняются до ${date}`,
      two_weeks: (date) => `Осталось две недели: сохранённые данные будут удалены ${date}`,
      three_days: (date) => `Осталось три дня: сохранённые данные будут удалены ${date}`,
    },
    preheader: (date) => `Из сохранённого ничего не удаляется до ${date}. Скачайте нужное.`,
    introStart: (plan, date) =>
      `Тариф ${plan} этого пространства закончился или был понижен. То, что он хранил, сохраняется до ${date}.`,
    safe: (date) => `Из сохранённого ничего не удаляется до ${date}.`,
    introLater: (plan, date) =>
      `То, что хранил тариф ${plan} этого пространства, сохраняется только до ${date}.`,
    space: "Пространство",
    personal: "Ваш аккаунт",
    someWorkspace: "Одно из ваших рабочих пространств",
    goes: "Что будет удалено и с какого момента, если тариф не вернуть:",
    kinds: {
      versions: "Предыдущие версии",
      accessLog: "Записи журнала доступа",
      analytics: "Ежедневные счётчики аналитики",
      auditEvents: "События аудита",
      pins: "Закреплённые артефакты (открепляются, затем архивируются как обычно)",
    },
    amount: (count, date) => `${count}, с ${date}`,
    download: "Скачайте нужное до этой даты:",
    downloadLink: "Скачать данные",
    cli: "Или заберите всё сразу с помощью Portifact CLI:",
    request: "Чтобы сохранить всё, запросите тариф снова:",
    requestLink: (plan) => `Запросить ${plan} снова`,
    reason:
      "Вы получили это письмо, потому что управляете этим пространством в Portifact. Это служебное уведомление о ваших данных, его нельзя отключить.",
  },
  ja: {
    subject: {
      start: (date) => `データは ${date} まで保持されます`,
      two_weeks: (date) => `残り 2 週間: 保持中のデータは ${date} に削除されます`,
      three_days: (date) => `残り 3 日: 保持中のデータは ${date} に削除されます`,
    },
    preheader: (date) =>
      `保持中のものは ${date} までは削除されません。必要なものをダウンロードしてください。`,
    introStart: (plan, date) =>
      `このスペースの ${plan} プランが終了したか、引き下げられました。そのプランで保持していたものは ${date} まで保持されます。`,
    safe: (date) => `保持中のものは ${date} までは削除されません。`,
    introLater: (plan, date) =>
      `このスペースの ${plan} プランで保持していたものは ${date} までしか保持されません。`,
    space: "スペース",
    personal: "あなたのアカウント",
    someWorkspace: "あなたのワークスペースの 1 つ",
    goes: "プランが戻らない場合に削除されるものと、その時期:",
    kinds: {
      versions: "以前のバージョン",
      accessLog: "アクセスログのエントリ",
      analytics: "日ごとの分析カウンター",
      auditEvents: "監査イベント",
      pins: "ピン留めされたアーティファクト（ピンが外れ、通常どおりアーカイブされます）",
    },
    amount: (count, date) => `${count} 件、${date} から`,
    download: "その前に必要なものをダウンロードしてください:",
    downloadLink: "データをダウンロード",
    cli: "または Portifact CLI ですべてを一度に取り出せます:",
    request: "すべてを残すには、もう一度プランを申請してください:",
    requestLink: (plan) => `${plan} をもう一度申請`,
    reason:
      "Portifact でこのスペースを管理しているため、このメールをお送りしました。データに関するサービス通知のため、配信を停止することはできません。",
  },
  "zh-CN": {
    subject: {
      start: (date) => `你的数据将保留到 ${date}`,
      two_weeks: (date) => `还剩两周：保留的数据将于 ${date} 删除`,
      three_days: (date) => `还剩三天：保留的数据将于 ${date} 删除`,
    },
    preheader: (date) => `保留的内容在 ${date} 之前不会被删除。请下载你需要的内容。`,
    introStart: (plan, date) =>
      `此空间的 ${plan} 方案已结束或已降级。它保留的内容将保留到 ${date}。`,
    safe: (date) => `保留的内容在 ${date} 之前不会被删除。`,
    introLater: (plan, date) => `此空间的 ${plan} 方案保留的内容只保留到 ${date}。`,
    space: "空间",
    personal: "你的账户",
    someWorkspace: "你的某个工作空间",
    goes: "如果方案没有恢复，将删除的内容及开始时间：",
    kinds: {
      versions: "以前的版本",
      accessLog: "访问日志条目",
      analytics: "每日分析计数",
      auditEvents: "审计事件",
      pins: "已固定的制品（取消固定，然后照常归档）",
    },
    amount: (count, date) => `${count} 项，自 ${date} 起`,
    download: "请在此之前下载你需要的内容：",
    downloadLink: "下载你的数据",
    cli: "或使用 Portifact CLI 一次性取出全部内容：",
    request: "要保留全部内容，请再次申请该方案：",
    requestLink: (plan) => `再次申请 ${plan}`,
    reason:
      "你收到这封邮件，是因为你在 Portifact 上管理此空间。这是一封关于你的数据的服务通知，无法关闭。",
  },
};

/** A name on one line, so a line break in it cannot fake another line in the text version. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: replacing control characters is the point
const oneLine = (name: string) => name.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();

const numberLocale = (locale: LocaleCode) => (locale === "en" ? "en-US" : locale);

export function graceNoticeEmail(input: GraceNoticeInput): EmailContent {
  // A hold is announced only when a forecast step falls on its end (decision 0022): an email that
  // lists nothing would say the data goes while nothing does, so it is a programming error.
  if (input.kinds.length === 0) throw new Error("A grace email lists at least one step.");
  const locale = input.locale ?? DEFAULT_LOCALE;
  const t = GRACE_NOTICE_TEXT[locale];
  const date = formatExpiry(input.until, locale);
  // The first date anything held goes comes from the steps listed, never from the hold's end
  // alone: another hold can let something go earlier (decision 0022, third delivery).
  const first = Math.min(input.until, ...input.kinds.map((entry) => entry.from));
  const firstDate = formatExpiry(first, locale);
  const subject = t.subject[input.moment](input.moment === "start" ? firstDate : date);
  const intro = (input.moment === "start" ? t.introStart : t.introLater)(input.plan, date);
  const safe = t.safe(firstDate);
  const space =
    input.workspace === null
      ? t.personal
      : input.names
        ? oneLine(input.workspace)
        : t.someWorkspace;
  const numbers = new Intl.NumberFormat(numberLocale(locale));
  const rows = input.kinds.map((entry) => ({
    label: t.kinds[entry.kind],
    value: t.amount(numbers.format(entry.count), formatExpiry(entry.from, locale)),
  }));
  const requestLink = t.requestLink(input.plan);
  const blocks: Block[] = [
    { kind: "paragraph", content: [`${intro}${gap(intro)}${safe}`] },
    { kind: "facts", rows: [{ label: t.space, value: space }] },
    { kind: "paragraph", content: [t.goes] },
    { kind: "facts", rows },
    {
      kind: "paragraph",
      content: [t.download + gap(t.download), { href: input.downloadUrl, text: t.downloadLink }],
    },
    { kind: "paragraph", content: [t.cli] },
    { kind: "command", value: input.exportCommand },
    {
      kind: "paragraph",
      content: [t.request + gap(t.request), { href: input.requestUrl, text: requestLink }],
    },
  ];
  const html = renderEmail({
    title: subject,
    preheader: t.preheader(firstDate),
    heading: subject,
    blocks,
    footer: t.reason,
    lang: locale,
  });
  const text = [
    subject,
    "",
    `${intro}${gap(intro)}${safe}`,
    "",
    `${t.space}: ${space}`,
    "",
    t.goes,
    ...rows.map((row) => `- ${row.label}: ${row.value}`),
    "",
    `${t.download}${gap(t.download)}${input.downloadUrl}`,
    t.cli,
    `  ${input.exportCommand}`,
    `${t.request}${gap(t.request)}${input.requestUrl}`,
    "",
    t.reason,
    ...textSignature(locale),
  ].join("\n");
  return { subject, text, html };
}
