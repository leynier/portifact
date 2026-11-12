// The statement of reasons (docs/operations.md, "Reports"): the email the people who manage an
// artifact, an account or a brand get when the operator suspends or reinstates it. It says what
// was restricted, its scope and duration, the category, whether it followed a notice or the
// operator's own review, that a person decided, the facts and the ground the operator wrote
// (shown as written, always escaped) and how to ask for a review. The fixed parts are in the
// recipient's language; the operator's text is in the language the operator wrote it in. A
// service notice: it cannot be turned off, so it has no unsubscribe link.
import type { AbuseReason } from "@portifact/contracts";
import { DEFAULT_LOCALE, type LocaleCode } from "@portifact/contracts/locales";
import { formatExpiry, gap } from "./expiry-notice.ts";
import { type Block, renderEmail, textSignature } from "./layout.ts";
import type { EmailContent } from "./message.ts";

export type ModerationTarget = "artifact" | "account" | "brand";
export type ModerationAction = "suspend" | "reinstate";

export interface ModerationNoticeInput {
  action: ModerationAction;
  target: ModerationTarget;
  /** The artifact's ID, for an artifact. */
  artifactId?: string | undefined;
  /** The artifact's name, only where a notice may name it (`noticeNames`); else the ID alone. */
  artifactName?: string | null | undefined;
  reason: AbuseReason | null;
  source: "notice" | "review";
  /** The facts the operator relied on, as written. */
  facts: string;
  /** The ground (the law or the rule of the terms), as written; null for a reinstatement. */
  ground: string | null;
  decidedAt: number;
  /** Where the recipient sees it in the dashboard. */
  dashboardUrl: string;
  locale?: LocaleCode | undefined;
}

type ByTarget<T> = { readonly [target in ModerationTarget]: T };

/** The notice in one language. */
export interface ModerationNoticeText {
  suspendSubject: ByTarget<(label: string) => string>;
  liftSubject: ByTarget<(label: string) => string>;
  suspendWhat: ByTarget<(label: string) => string>;
  liftWhat: ByTarget<(label: string) => string>;
  /** Territorial scope and duration of a suspension. */
  scope: string;
  category: string;
  decided: string;
  sourceNotice: string;
  sourceReview: string;
  human: string;
  facts: string;
  ground: string;
  review: string;
  /** Followed by the dashboard's link, after `gap`. */
  open: string;
  openLink: string;
  footer: string;
  reasons: { readonly [reason in AbuseReason]: string };
}

export const MODERATION_NOTICE_TEXT: { readonly [code in LocaleCode]: ModerationNoticeText } = {
  en: {
    suspendSubject: {
      artifact: (l) => `We suspended your artifact ${l}`,
      account: () => "We suspended your Portifact account",
      brand: () => "We suspended your space's brand",
    },
    liftSubject: {
      artifact: (l) => `Your artifact ${l} is no longer suspended`,
      account: () => "Your Portifact account is no longer suspended",
      brand: () => "Your space's brand is no longer suspended",
    },
    suspendWhat: {
      artifact: (l) =>
        `We suspended the artifact ${l}. It is no longer served to anyone, its share links stop working, and nobody can publish to it, change its access or restore it.`,
      account: () =>
        "We suspended your account. It can no longer publish, and its artifacts are suspended with it. You can still sign in, export your data and delete your account.",
      brand: () =>
        "We suspended the brand of your space's Portifact bar. The viewer shows the default bar instead.",
    },
    liftWhat: {
      artifact: (l) =>
        `We lifted the suspension of the artifact ${l}. It is back in the state it had, or in the archive if your space has no free active slot.`,
      account: () =>
        "We lifted the suspension of your account. It can publish again, and the artifacts suspended with it are back.",
      brand: () => "We lifted the suspension of your space's brand. The viewer shows it again.",
    },
    scope:
      "This applies everywhere Portifact is available. It has no end date: it lasts until we lift it, for example after a review you ask for.",
    category: "Category",
    decided: "Decided",
    sourceNotice: "We acted on a notice we received about it.",
    sourceReview: "We acted after our own review.",
    human: "A person took this decision. We used no automated detection or decision-making.",
    facts: "The facts we relied on:",
    ground: "The ground (the law or the rule of our terms) and why it applies:",
    review:
      "To ask us to review this decision, write to abuse@portifact.com and include the ID above. Someone looks at it again and tells you the outcome. You may also have other redress, such as a court.",
    open: "See it in the dashboard:",
    openLink: "Open Portifact",
    footer:
      "You received this email because you manage this on Portifact. It is a service notice about a decision on your content or account, so it cannot be turned off.",
    reasons: {
      phishing: "phishing or a fake sign-in page",
      malware: "malware, exploits or cryptocurrency mining",
      sexual_content: "sexually explicit content",
      child_safety: "content that sexualizes minors",
      copyright: "copyright or trademark infringement",
      impersonation: "impersonation",
      harassment: "threats, harassment or violent extremism",
      private_information: "someone's private information",
      spam: "spam",
      other: "another breach of the rules",
    },
  },
  es: {
    suspendSubject: {
      artifact: (l) => `Suspendimos tu artifact ${l}`,
      account: () => "Suspendimos tu cuenta de Portifact",
      brand: () => "Suspendimos la marca de tu espacio",
    },
    liftSubject: {
      artifact: (l) => `Tu artifact ${l} ya no está suspendido`,
      account: () => "Tu cuenta de Portifact ya no está suspendida",
      brand: () => "La marca de tu espacio ya no está suspendida",
    },
    suspendWhat: {
      artifact: (l) =>
        `Suspendimos el artifact ${l}. Ya no se muestra a nadie, sus enlaces para compartir dejan de funcionar y nadie puede publicar en él, cambiar su acceso ni restaurarlo.`,
      account: () =>
        "Suspendimos tu cuenta. Ya no puede publicar y sus artifacts quedan suspendidos con ella. Todavía puedes iniciar sesión, exportar tus datos y eliminar tu cuenta.",
      brand: () =>
        "Suspendimos la marca de la barra de Portifact de tu espacio. El visor muestra la barra predeterminada.",
    },
    liftWhat: {
      artifact: (l) =>
        `Levantamos la suspensión del artifact ${l}. Vuelve al estado que tenía, o al archivo si tu espacio no tiene un lugar activo libre.`,
      account: () =>
        "Levantamos la suspensión de tu cuenta. Puede volver a publicar y los artifacts suspendidos con ella están de vuelta.",
      brand: () =>
        "Levantamos la suspensión de la marca de tu espacio. El visor vuelve a mostrarla.",
    },
    scope:
      "Se aplica en todos los lugares donde Portifact está disponible. No tiene fecha de fin: dura hasta que la levantemos, por ejemplo después de una revisión que pidas.",
    category: "Categoría",
    decided: "Decidido",
    sourceNotice: "Actuamos a partir de un aviso que recibimos.",
    sourceReview: "Actuamos después de nuestra propia revisión.",
    human:
      "Una persona tomó esta decisión. No usamos detección ni toma de decisiones automatizadas.",
    facts: "Los hechos en los que nos basamos:",
    ground: "El fundamento (la ley o la regla de nuestros términos) y por qué se aplica:",
    review:
      "Para pedirnos que revisemos esta decisión, escribe a abuse@portifact.com e incluye el ID de arriba. Otra persona la vuelve a mirar y te dice el resultado. También puedes tener otras vías, como un tribunal.",
    open: "Míralo en el panel:",
    openLink: "Abrir Portifact",
    footer:
      "Recibiste este correo porque gestionas esto en Portifact. Es un aviso del servicio sobre una decisión acerca de tu contenido o tu cuenta, así que no se puede desactivar.",
    reasons: {
      phishing: "phishing o una página de inicio de sesión falsa",
      malware: "malware, exploits o minería de criptomonedas",
      sexual_content: "contenido sexual explícito",
      child_safety: "contenido que sexualiza a menores",
      copyright: "infracción de derechos de autor o de marca",
      impersonation: "suplantación de identidad",
      harassment: "amenazas, acoso o extremismo violento",
      private_information: "información privada de otra persona",
      spam: "spam",
      other: "otra infracción de las reglas",
    },
  },
  "pt-BR": {
    suspendSubject: {
      artifact: (l) => `Suspendemos seu artifact ${l}`,
      account: () => "Suspendemos sua conta do Portifact",
      brand: () => "Suspendemos a marca do seu espaço",
    },
    liftSubject: {
      artifact: (l) => `Seu artifact ${l} não está mais suspenso`,
      account: () => "Sua conta do Portifact não está mais suspensa",
      brand: () => "A marca do seu espaço não está mais suspensa",
    },
    suspendWhat: {
      artifact: (l) =>
        `Suspendemos o artifact ${l}. Ele não é mais exibido a ninguém, seus links de compartilhamento param de funcionar e ninguém pode publicar nele, mudar seu acesso ou restaurá-lo.`,
      account: () =>
        "Suspendemos sua conta. Ela não pode mais publicar, e seus artifacts ficam suspensos com ela. Você ainda pode entrar, exportar seus dados e excluir sua conta.",
      brand: () =>
        "Suspendemos a marca da barra do Portifact do seu espaço. O visualizador mostra a barra padrão.",
    },
    liftWhat: {
      artifact: (l) =>
        `Retiramos a suspensão do artifact ${l}. Ele volta ao estado que tinha, ou ao arquivo se o seu espaço não tiver uma vaga ativa livre.`,
      account: () =>
        "Retiramos a suspensão da sua conta. Ela pode publicar de novo, e os artifacts suspensos com ela estão de volta.",
      brand: () =>
        "Retiramos a suspensão da marca do seu espaço. O visualizador volta a mostrá-la.",
    },
    scope:
      "Vale em todos os lugares onde o Portifact está disponível. Não tem data de término: dura até que a retiremos, por exemplo depois de uma revisão que você pedir.",
    category: "Categoria",
    decided: "Decidido em",
    sourceNotice: "Agimos a partir de uma notificação que recebemos.",
    sourceReview: "Agimos depois da nossa própria análise.",
    human:
      "Uma pessoa tomou esta decisão. Não usamos detecção nem tomada de decisão automatizadas.",
    facts: "Os fatos em que nos baseamos:",
    ground: "O fundamento (a lei ou a regra dos nossos termos) e por que ele se aplica:",
    review:
      "Para pedir que revisemos esta decisão, escreva para abuse@portifact.com e inclua o ID acima. Outra pessoa a examina de novo e informa o resultado. Você também pode ter outros recursos, como um tribunal.",
    open: "Veja no painel:",
    openLink: "Abrir o Portifact",
    footer:
      "Você recebeu este e-mail porque gerencia isto no Portifact. É um aviso do serviço sobre uma decisão a respeito do seu conteúdo ou da sua conta, por isso não pode ser desativado.",
    reasons: {
      phishing: "phishing ou uma página de login falsa",
      malware: "malware, exploits ou mineração de criptomoedas",
      sexual_content: "conteúdo sexualmente explícito",
      child_safety: "conteúdo que sexualiza menores",
      copyright: "violação de direitos autorais ou de marca",
      impersonation: "falsificação de identidade",
      harassment: "ameaças, assédio ou extremismo violento",
      private_information: "informações privadas de alguém",
      spam: "spam",
      other: "outra violação das regras",
    },
  },
  fr: {
    suspendSubject: {
      artifact: (l) => `Nous avons suspendu votre artifact ${l}`,
      account: () => "Nous avons suspendu votre compte Portifact",
      brand: () => "Nous avons suspendu la marque de votre espace",
    },
    liftSubject: {
      artifact: (l) => `Votre artifact ${l} n’est plus suspendu`,
      account: () => "Votre compte Portifact n’est plus suspendu",
      brand: () => "La marque de votre espace n’est plus suspendue",
    },
    suspendWhat: {
      artifact: (l) =>
        `Nous avons suspendu l’artifact ${l}. Il n’est plus servi à personne, ses liens de partage cessent de fonctionner, et personne ne peut y publier, modifier son accès ni le restaurer.`,
      account: () =>
        "Nous avons suspendu votre compte. Il ne peut plus publier, et ses artifacts sont suspendus avec lui. Vous pouvez toujours vous connecter, exporter vos données et supprimer votre compte.",
      brand: () =>
        "Nous avons suspendu la marque de la barre Portifact de votre espace. Le lecteur affiche la barre par défaut.",
    },
    liftWhat: {
      artifact: (l) =>
        `Nous avons levé la suspension de l’artifact ${l}. Il retrouve l’état qu’il avait, ou passe aux archives si votre espace n’a plus d’emplacement actif libre.`,
      account: () =>
        "Nous avons levé la suspension de votre compte. Il peut publier de nouveau, et les artifacts suspendus avec lui sont de retour.",
      brand: () =>
        "Nous avons levé la suspension de la marque de votre espace. Le lecteur l’affiche de nouveau.",
    },
    scope:
      "Cela s’applique partout où Portifact est disponible. Il n’y a pas de date de fin : cela dure jusqu’à ce que nous la levions, par exemple après un réexamen que vous demandez.",
    category: "Catégorie",
    decided: "Décidé le",
    sourceNotice: "Nous avons agi à la suite d’une notification reçue.",
    sourceReview: "Nous avons agi après notre propre examen.",
    human:
      "Une personne a pris cette décision. Nous n’avons utilisé aucune détection ni prise de décision automatisée.",
    facts: "Les faits sur lesquels nous nous sommes fondés :",
    ground: "Le fondement (la loi ou la règle de nos conditions) et pourquoi il s’applique :",
    review:
      "Pour nous demander de réexaminer cette décision, écrivez à abuse@portifact.com en indiquant l’identifiant ci-dessus. Une autre personne la réexamine et vous communique le résultat. D’autres recours, comme un tribunal, peuvent aussi vous être ouverts.",
    open: "Voir dans le tableau de bord :",
    openLink: "Ouvrir Portifact",
    footer:
      "Vous avez reçu cet e-mail parce que vous gérez cet élément sur Portifact. C’est un avis de service sur une décision concernant votre contenu ou votre compte : il ne peut pas être désactivé.",
    reasons: {
      phishing: "hameçonnage ou fausse page de connexion",
      malware: "logiciel malveillant, exploits ou minage de cryptomonnaie",
      sexual_content: "contenu sexuellement explicite",
      child_safety: "contenu sexualisant des mineurs",
      copyright: "atteinte au droit d’auteur ou au droit des marques",
      impersonation: "usurpation d’identité",
      harassment: "menaces, harcèlement ou extrémisme violent",
      private_information: "informations privées d’une personne",
      spam: "spam",
      other: "autre manquement aux règles",
    },
  },
  de: {
    suspendSubject: {
      artifact: (l) => `Wir haben Ihr Artifact ${l} gesperrt`,
      account: () => "Wir haben Ihr Portifact-Konto gesperrt",
      brand: () => "Wir haben die Marke Ihres Bereichs gesperrt",
    },
    liftSubject: {
      artifact: (l) => `Ihr Artifact ${l} ist nicht mehr gesperrt`,
      account: () => "Ihr Portifact-Konto ist nicht mehr gesperrt",
      brand: () => "Die Marke Ihres Bereichs ist nicht mehr gesperrt",
    },
    suspendWhat: {
      artifact: (l) =>
        `Wir haben das Artifact ${l} gesperrt. Es wird niemandem mehr ausgeliefert, seine Freigabelinks funktionieren nicht mehr, und niemand kann darin veröffentlichen, seinen Zugriff ändern oder es wiederherstellen.`,
      account: () =>
        "Wir haben Ihr Konto gesperrt. Es kann nicht mehr veröffentlichen, und seine Artifacts sind mit ihm gesperrt. Sie können sich weiterhin anmelden, Ihre Daten exportieren und Ihr Konto löschen.",
      brand: () =>
        "Wir haben die Marke der Portifact-Leiste Ihres Bereichs gesperrt. Der Viewer zeigt stattdessen die Standardleiste.",
    },
    liftWhat: {
      artifact: (l) =>
        `Wir haben die Sperre des Artifacts ${l} aufgehoben. Es ist wieder im vorherigen Zustand, oder im Archiv, wenn Ihr Bereich keinen freien aktiven Platz hat.`,
      account: () =>
        "Wir haben die Sperre Ihres Kontos aufgehoben. Es kann wieder veröffentlichen, und die mit ihm gesperrten Artifacts sind zurück.",
      brand: () =>
        "Wir haben die Sperre der Marke Ihres Bereichs aufgehoben. Der Viewer zeigt sie wieder.",
    },
    scope:
      "Dies gilt überall, wo Portifact verfügbar ist. Es gibt kein Enddatum: Es gilt, bis wir es aufheben, zum Beispiel nach einer Überprüfung, die Sie verlangen.",
    category: "Kategorie",
    decided: "Entschieden am",
    sourceNotice: "Wir haben aufgrund einer Meldung gehandelt, die wir erhalten haben.",
    sourceReview: "Wir haben nach unserer eigenen Prüfung gehandelt.",
    human:
      "Ein Mensch hat diese Entscheidung getroffen. Wir haben keine automatisierte Erkennung oder Entscheidungsfindung verwendet.",
    facts: "Die Tatsachen, auf die wir uns stützen:",
    ground: "Die Grundlage (das Gesetz oder die Regel unserer Bedingungen) und warum sie gilt:",
    review:
      "Um eine Überprüfung dieser Entscheidung zu verlangen, schreiben Sie an abuse@portifact.com und geben Sie die obige ID an. Eine andere Person sieht sie sich erneut an und teilt Ihnen das Ergebnis mit. Ihnen können auch andere Rechtsbehelfe offenstehen, etwa ein Gericht.",
    open: "Im Dashboard ansehen:",
    openLink: "Portifact öffnen",
    footer:
      "Sie erhalten diese E-Mail, weil Sie dies auf Portifact verwalten. Es ist ein Servicehinweis zu einer Entscheidung über Ihre Inhalte oder Ihr Konto und kann daher nicht abbestellt werden.",
    reasons: {
      phishing: "Phishing oder eine gefälschte Anmeldeseite",
      malware: "Malware, Exploits oder Kryptomining",
      sexual_content: "sexuell explizite Inhalte",
      child_safety: "Inhalte, die Minderjährige sexualisieren",
      copyright: "Verletzung von Urheber- oder Markenrechten",
      impersonation: "Identitätsbetrug",
      harassment: "Drohungen, Belästigung oder gewalttätiger Extremismus",
      private_information: "private Informationen über eine Person",
      spam: "Spam",
      other: "ein anderer Regelverstoß",
    },
  },
  ru: {
    suspendSubject: {
      artifact: (l) => `Мы приостановили ваш артефакт ${l}`,
      account: () => "Мы приостановили ваш аккаунт Portifact",
      brand: () => "Мы приостановили бренд вашего пространства",
    },
    liftSubject: {
      artifact: (l) => `Ваш артефакт ${l} больше не приостановлен`,
      account: () => "Ваш аккаунт Portifact больше не приостановлен",
      brand: () => "Бренд вашего пространства больше не приостановлен",
    },
    suspendWhat: {
      artifact: (l) =>
        `Мы приостановили артефакт ${l}. Он больше никому не показывается, его ссылки для общего доступа перестают работать, и никто не может публиковать в нём, менять доступ к нему или восстанавливать его.`,
      account: () =>
        "Мы приостановили ваш аккаунт. Он больше не может публиковать, а его артефакты приостановлены вместе с ним. Вы по-прежнему можете входить, экспортировать свои данные и удалить аккаунт.",
      brand: () =>
        "Мы приостановили бренд панели Portifact вашего пространства. Просмотрщик показывает стандартную панель.",
    },
    liftWhat: {
      artifact: (l) =>
        `Мы сняли приостановку с артефакта ${l}. Он вернулся в прежнее состояние или в архив, если в вашем пространстве нет свободного активного места.`,
      account: () =>
        "Мы сняли приостановку с вашего аккаунта. Он снова может публиковать, а артефакты, приостановленные вместе с ним, вернулись.",
      brand: () =>
        "Мы сняли приостановку с бренда вашего пространства. Просмотрщик снова его показывает.",
    },
    scope:
      "Это действует везде, где доступен Portifact. Срока окончания нет: это действует, пока мы не снимем ограничение, например после проверки по вашей просьбе.",
    category: "Категория",
    decided: "Решение принято",
    sourceNotice: "Мы действовали по полученному уведомлению.",
    sourceReview: "Мы действовали по итогам собственной проверки.",
    human:
      "Это решение принял человек. Мы не использовали автоматическое обнаружение или автоматическое принятие решений.",
    facts: "Факты, на которые мы опирались:",
    ground: "Основание (закон или правило наших условий) и почему оно применяется:",
    review:
      "Чтобы попросить нас пересмотреть это решение, напишите на abuse@portifact.com и укажите ID выше. Другой человек рассмотрит его заново и сообщит вам результат. У вас также могут быть другие средства защиты, например суд.",
    open: "Посмотреть в панели управления:",
    openLink: "Открыть Portifact",
    footer:
      "Вы получили это письмо, потому что управляете этим в Portifact. Это служебное уведомление о решении по вашему контенту или аккаунту, поэтому его нельзя отключить.",
    reasons: {
      phishing: "фишинг или поддельная страница входа",
      malware: "вредоносное ПО, эксплойты или майнинг криптовалют",
      sexual_content: "откровенно сексуальный контент",
      child_safety: "контент, сексуализирующий несовершеннолетних",
      copyright: "нарушение авторских прав или прав на товарный знак",
      impersonation: "выдача себя за другое лицо",
      harassment: "угрозы, травля или насильственный экстремизм",
      private_information: "чужая личная информация",
      spam: "спам",
      other: "другое нарушение правил",
    },
  },
  ja: {
    suspendSubject: {
      artifact: (l) => `アーティファクト ${l} を停止しました`,
      account: () => "Portifact アカウントを停止しました",
      brand: () => "スペースのブランドを停止しました",
    },
    liftSubject: {
      artifact: (l) => `アーティファクト ${l} の停止を解除しました`,
      account: () => "Portifact アカウントの停止を解除しました",
      brand: () => "スペースのブランドの停止を解除しました",
    },
    suspendWhat: {
      artifact: (l) =>
        `アーティファクト ${l} を停止しました。誰にも配信されなくなり、共有リンクは機能しなくなります。また、誰も公開、アクセスの変更、復元を行えません。`,
      account: () =>
        "あなたのアカウントを停止しました。公開できなくなり、そのアーティファクトもあわせて停止されます。サインイン、データのエクスポート、アカウントの削除は引き続き行えます。",
      brand: () =>
        "スペースの Portifact バーのブランドを停止しました。ビューアーには既定のバーが表示されます。",
    },
    liftWhat: {
      artifact: (l) =>
        `アーティファクト ${l} の停止を解除しました。以前の状態に戻ります。スペースに空きのアクティブ枠がない場合はアーカイブに戻ります。`,
      account: () =>
        "アカウントの停止を解除しました。再び公開でき、あわせて停止されていたアーティファクトも戻りました。",
      brand: () => "スペースのブランドの停止を解除しました。ビューアーに再び表示されます。",
    },
    scope:
      "これは Portifact が利用できるすべての地域に適用されます。終了日はありません。あなたが求めた見直しの後など、解除するまで続きます。",
    category: "カテゴリ",
    decided: "決定日時",
    sourceNotice: "受け取った通報に基づいて対応しました。",
    sourceReview: "当社自身の確認に基づいて対応しました。",
    human: "この決定は人が行いました。自動検出や自動の意思決定は使用していません。",
    facts: "根拠とした事実:",
    ground: "根拠(法律または利用規約の規定)とそれが適用される理由:",
    review:
      "この決定の見直しを求めるには、上記の ID を添えて abuse@portifact.com までご連絡ください。別の担当者が改めて確認し、結果をお知らせします。裁判所など、その他の救済手段を利用できる場合もあります。",
    open: "ダッシュボードで確認:",
    openLink: "Portifact を開く",
    footer:
      "Portifact でこれを管理しているため、このメールをお送りしました。あなたのコンテンツまたはアカウントに関する決定についてのサービス通知のため、停止できません。",
    reasons: {
      phishing: "フィッシングまたは偽のサインインページ",
      malware: "マルウェア、エクスプロイト、暗号資産のマイニング",
      sexual_content: "露骨な性的コンテンツ",
      child_safety: "未成年者を性的に扱うコンテンツ",
      copyright: "著作権または商標の侵害",
      impersonation: "なりすまし",
      harassment: "脅迫、嫌がらせ、暴力的過激主義",
      private_information: "他人の個人情報",
      spam: "スパム",
      other: "その他のルール違反",
    },
  },
  "zh-CN": {
    suspendSubject: {
      artifact: (l) => `我们已暂停你的 artifact ${l}`,
      account: () => "我们已暂停你的 Portifact 账户",
      brand: () => "我们已暂停你空间的品牌",
    },
    liftSubject: {
      artifact: (l) => `你的 artifact ${l} 已解除暂停`,
      account: () => "你的 Portifact 账户已解除暂停",
      brand: () => "你空间的品牌已解除暂停",
    },
    suspendWhat: {
      artifact: (l) =>
        `我们已暂停 artifact ${l}。它不再向任何人提供,其共享链接停止生效,任何人都不能向其发布、更改其访问权限或恢复它。`,
      account: () =>
        "我们已暂停你的账户。它不能再发布内容,其 artifact 也随之暂停。你仍然可以登录、导出数据和删除账户。",
      brand: () => "我们已暂停你空间的 Portifact 栏中的品牌。查看器改为显示默认栏。",
    },
    liftWhat: {
      artifact: (l) =>
        `我们已解除 artifact ${l} 的暂停。它恢复到原来的状态;如果你的空间没有空闲的活跃名额,则回到归档。`,
      account: () => "我们已解除你账户的暂停。它可以再次发布,随之暂停的 artifact 也已恢复。",
      brand: () => "我们已解除你空间品牌的暂停。查看器会再次显示它。",
    },
    scope:
      "这适用于 Portifact 提供服务的所有地区。没有结束日期:在我们解除之前一直有效,例如在你请求复核之后。",
    category: "类别",
    decided: "决定时间",
    sourceNotice: "我们根据收到的通知采取了行动。",
    sourceReview: "我们根据自己的审查采取了行动。",
    human: "此决定由人作出。我们没有使用自动检测或自动决策。",
    facts: "我们依据的事实:",
    ground: "依据(法律或我们条款中的规则)以及适用的理由:",
    review:
      "如需请求我们复核此决定,请写信至 abuse@portifact.com 并附上上面的 ID。另一位人员会重新审查并告知你结果。你也可能有其他救济途径,例如法院。",
    open: "在控制台中查看:",
    openLink: "打开 Portifact",
    footer:
      "你收到这封邮件,是因为你在 Portifact 上管理此项内容。这是一则关于你的内容或账户的决定的服务通知,因此无法关闭。",
    reasons: {
      phishing: "网络钓鱼或伪造的登录页面",
      malware: "恶意软件、漏洞利用或加密货币挖矿",
      sexual_content: "露骨的色情内容",
      child_safety: "对未成年人进行性化的内容",
      copyright: "侵犯版权或商标",
      impersonation: "冒充他人",
      harassment: "威胁、骚扰或暴力极端主义",
      private_information: "他人的私人信息",
      spam: "垃圾内容",
      other: "其他违反规则的行为",
    },
  },
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
const oneLine = (text: string) => text.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();

/** The operator's text as paragraphs: one per line it wrote, blank lines dropped. */
function paragraphs(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** How the email names an artifact: `"name" (id)` where names may go, else the ID alone. */
function artifactLabel(input: ModerationNoticeInput): string {
  const id = input.artifactId ?? "";
  const name = input.artifactName ? oneLine(input.artifactName) : "";
  return name ? `"${name}" (${id})` : id;
}

export function moderationNoticeEmail(input: ModerationNoticeInput): EmailContent {
  const locale = input.locale ?? DEFAULT_LOCALE;
  const t = MODERATION_NOTICE_TEXT[locale];
  const label = input.target === "artifact" ? artifactLabel(input) : "";
  const suspend = input.action === "suspend";
  const subject = (suspend ? t.suspendSubject : t.liftSubject)[input.target](
    input.artifactId ?? "",
  );
  const what = (suspend ? t.suspendWhat : t.liftWhat)[input.target](label);
  const facts = [
    ...(input.target === "artifact" ? [{ label: "ID", value: input.artifactId ?? "" }] : []),
    ...(input.reason ? [{ label: t.category, value: t.reasons[input.reason] }] : []),
    { label: t.decided, value: formatExpiry(input.decidedAt, locale) },
  ];
  const source = input.source === "notice" ? t.sourceNotice : t.sourceReview;
  const operatorFacts = paragraphs(input.facts);
  const ground = input.ground === null ? [] : paragraphs(input.ground);
  const blocks: Block[] = [
    { kind: "paragraph", content: [what] },
    ...(suspend ? [{ kind: "paragraph" as const, content: [t.scope] }] : []),
    { kind: "facts", rows: facts },
    { kind: "paragraph", content: [`${source} ${t.human}`] },
    { kind: "paragraph", content: [t.facts] },
    ...operatorFacts.map((line) => ({ kind: "paragraph" as const, content: [line] })),
    ...(ground.length > 0
      ? [
          { kind: "paragraph" as const, content: [t.ground] },
          ...ground.map((line) => ({ kind: "paragraph" as const, content: [line] })),
        ]
      : []),
    { kind: "divider" },
    { kind: "paragraph", content: [t.review] },
    {
      kind: "paragraph",
      content: [t.open + gap(t.open), { href: input.dashboardUrl, text: t.openLink }],
      muted: true,
    },
  ];
  const html = renderEmail({
    title: subject,
    preheader: what,
    heading: subject,
    blocks,
    footer: t.footer,
    lang: locale,
  });
  const text = [
    subject,
    "",
    what,
    "",
    ...(suspend ? [t.scope, ""] : []),
    ...facts.map((row) => `${row.label}: ${row.value}`),
    "",
    `${source} ${t.human}`,
    "",
    t.facts,
    ...operatorFacts,
    ...(ground.length > 0 ? ["", t.ground, ...ground] : []),
    "",
    t.review,
    "",
    `${t.open}${gap(t.open)}${input.dashboardUrl}`,
    "",
    t.footer,
    ...textSignature(locale),
  ].join("\n");
  return { subject, text, html };
}
