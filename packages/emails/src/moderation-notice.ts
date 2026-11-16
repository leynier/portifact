// The statement of reasons (docs/operations.md, "Reports"): the email the people who manage an
// artifact, an account or a brand get when the operator suspends or reinstates it, and the
// variant for the signed-in authors of an artifact's data the operator named. It says what was
// restricted, its scope and duration, the category, whether it followed a notice or the
// operator's own review, that a person decided, the facts and the ground the operator wrote
// (shown as written, always escaped) and how to ask for a review. The fixed parts are in the
// recipient's language; the operator's text is in the language the operator wrote it in. A
// service notice: it cannot be turned off, so it has no unsubscribe link.
import type { AbuseReason } from "@portifact/contracts";
import { DEFAULT_LOCALE, type LocaleCode } from "@portifact/contracts/locales";
import { formatExpiry, gap } from "./expiry-notice.ts";
import { type Block, renderEmail, textSignature } from "./layout.ts";
import type { EmailContent } from "./message.ts";

export type ModerationTarget = "artifact" | "account" | "brand" | "attachment";
export type ModerationAction = "suspend" | "reinstate";

export interface ModerationNoticeInput {
  action: ModerationAction;
  target: ModerationTarget;
  /** The artifact's ID, for an artifact or a file on one of its comments. */
  artifactId?: string | undefined;
  /** The file's ID, for a file on a comment (decision 0029). */
  attachmentId?: string | undefined;
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
  /**
   * Who the email is for: a person who manages the content (the default), or a signed-in author
   * of the artifact's data the operator named (an artifact decision only).
   */
  audience?: "manager" | "data_author" | undefined;
  locale?: LocaleCode | undefined;
}

type ByTarget<T> = { readonly [target in ModerationTarget]: T };

/** The "what" of a notice: the artifact's label and, for a file on a comment, its ID. */
type What = (label: string, file?: string) => string;

/** The notice in one language. */
export interface ModerationNoticeText {
  suspendSubject: ByTarget<(label: string) => string>;
  liftSubject: ByTarget<(label: string) => string>;
  suspendWhat: ByTarget<What>;
  liftWhat: ByTarget<What>;
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
  /** What a signed-in author of an artifact's data reads instead of the managers' parts. */
  dataAuthor: {
    suspendSubject: (label: string) => string;
    liftSubject: (label: string) => string;
    suspendWhat: (label: string) => string;
    liftWhat: (label: string) => string;
    open: string;
    openLink: string;
    footer: string;
  };
  reasons: { readonly [reason in AbuseReason]: string };
}

export const MODERATION_NOTICE_TEXT: { readonly [code in LocaleCode]: ModerationNoticeText } = {
  en: {
    suspendSubject: {
      artifact: (l) => `We suspended your artifact ${l}`,
      account: () => "We suspended your Portifact account",
      brand: () => "We suspended your space's brand",
      attachment: () => "We withheld a file on a comment",
    },
    liftSubject: {
      artifact: (l) => `Your artifact ${l} is no longer suspended`,
      account: () => "Your Portifact account is no longer suspended",
      brand: () => "Your space's brand is no longer suspended",
      attachment: () => "A file on a comment is no longer withheld",
    },
    suspendWhat: {
      artifact: (l) =>
        `We suspended the artifact ${l}. It is no longer served to anyone, its share links stop working, and nobody can publish to it, change its access or restore it.`,
      account: () =>
        "We suspended your account. It can no longer publish, and its artifacts are suspended with it. You can still sign in, export your data and delete your account.",
      brand: () =>
        "We suspended the brand of your space's Portifact bar. The viewer shows the default bar instead.",
      attachment: (l, f = "") =>
        `We withheld the file ${f} attached to a comment on the artifact ${l}. Nobody can view or download it while it is withheld; the comment itself stays. It is kept, not deleted: if you ask for a review or send a counter-notice, we look at it again. If the decision stands, we may delete the file for good 30 days after this email at the earliest.`,
    },
    liftWhat: {
      artifact: (l) =>
        `We lifted the suspension of the artifact ${l}. It is back in the state it had, or in the archive if your space has no free active slot.`,
      account: () =>
        "We lifted the suspension of your account. It can publish again, and the artifacts suspended with it are back.",
      brand: () => "We lifted the suspension of your space's brand. The viewer shows it again.",
      attachment: (l, f = "") =>
        `We lifted the restriction on the file ${f} attached to a comment on the artifact ${l}. Everyone who can read the comment can view and download it again.`,
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
    dataAuthor: {
      suspendSubject: (l) => `We suspended an artifact where you saved data: ${l}`,
      liftSubject: (l) => `An artifact where you saved data is no longer suspended: ${l}`,
      suspendWhat: (l) =>
        `We suspended the artifact ${l} because of data saved in it, including documents you saved through its page. It is no longer served to anyone and its page cannot read or save data. Your documents are kept, not deleted, and you can still download and delete them from Data you shared.`,
      liftWhat: (l) =>
        `We lifted the suspension of the artifact ${l}, where you saved data through its page. Its page can read and save data again as its managers set it up.`,
      open: "See what you saved:",
      openLink: "Data you shared",
      footer:
        "You received this email because you saved data in this artifact with your Portifact account. It is a service notice about a decision on content you saved, so it cannot be turned off.",
    },
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
      attachment: () => "Retuvimos un archivo de un comentario",
    },
    liftSubject: {
      artifact: (l) => `Tu artifact ${l} ya no está suspendido`,
      account: () => "Tu cuenta de Portifact ya no está suspendida",
      brand: () => "La marca de tu espacio ya no está suspendida",
      attachment: () => "Un archivo de un comentario ya no está retenido",
    },
    suspendWhat: {
      artifact: (l) =>
        `Suspendimos el artifact ${l}. Ya no se muestra a nadie, sus enlaces para compartir dejan de funcionar y nadie puede publicar en él, cambiar su acceso ni restaurarlo.`,
      account: () =>
        "Suspendimos tu cuenta. Ya no puede publicar y sus artifacts quedan suspendidos con ella. Todavía puedes iniciar sesión, exportar tus datos y eliminar tu cuenta.",
      brand: () =>
        "Suspendimos la marca de la barra de Portifact de tu espacio. El visor muestra la barra predeterminada.",
      attachment: (l, f = "") =>
        `Retuvimos el archivo ${f} adjunto a un comentario del artifact ${l}. Nadie puede verlo ni descargarlo mientras esté retenido; el comentario sigue. Se conserva, no se borra: si pides una revisión o envías una contranotificación, lo volvemos a mirar. Si la decisión se mantiene, podemos borrar el archivo definitivamente a partir de 30 días después de este correo.`,
    },
    liftWhat: {
      artifact: (l) =>
        `Levantamos la suspensión del artifact ${l}. Vuelve al estado que tenía, o al archivo si tu espacio no tiene un lugar activo libre.`,
      account: () =>
        "Levantamos la suspensión de tu cuenta. Puede volver a publicar y los artifacts suspendidos con ella están de vuelta.",
      brand: () =>
        "Levantamos la suspensión de la marca de tu espacio. El visor vuelve a mostrarla.",
      attachment: (l, f = "") =>
        `Levantamos la restricción del archivo ${f} adjunto a un comentario del artifact ${l}. Quien pueda leer el comentario puede volver a verlo y descargarlo.`,
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
    dataAuthor: {
      suspendSubject: (l) => `Suspendimos un artifact donde guardaste datos: ${l}`,
      liftSubject: (l) => `Un artifact donde guardaste datos ya no está suspendido: ${l}`,
      suspendWhat: (l) =>
        `Suspendimos el artifact ${l} por datos guardados en él, entre ellos documentos que guardaste desde su página. Ya no se muestra a nadie y su página no puede leer ni guardar datos. Tus documentos se conservan, no se borran, y puedes seguir descargándolos y borrándolos desde Datos que compartiste.`,
      liftWhat: (l) =>
        `Levantamos la suspensión del artifact ${l}, donde guardaste datos desde su página. Su página puede volver a leer y guardar datos como la configuraron quienes lo gestionan.`,
      open: "Mira lo que guardaste:",
      openLink: "Datos que compartiste",
      footer:
        "Recibiste este correo porque guardaste datos en este artifact con tu cuenta de Portifact. Es un aviso del servicio sobre una decisión acerca de contenido que guardaste, así que no se puede desactivar.",
    },
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
      attachment: () => "Retivemos um arquivo de um comentário",
    },
    liftSubject: {
      artifact: (l) => `Seu artifact ${l} não está mais suspenso`,
      account: () => "Sua conta do Portifact não está mais suspensa",
      brand: () => "A marca do seu espaço não está mais suspensa",
      attachment: () => "Um arquivo de um comentário não está mais retido",
    },
    suspendWhat: {
      artifact: (l) =>
        `Suspendemos o artifact ${l}. Ele não é mais exibido a ninguém, seus links de compartilhamento param de funcionar e ninguém pode publicar nele, mudar seu acesso ou restaurá-lo.`,
      account: () =>
        "Suspendemos sua conta. Ela não pode mais publicar, e seus artifacts ficam suspensos com ela. Você ainda pode entrar, exportar seus dados e excluir sua conta.",
      brand: () =>
        "Suspendemos a marca da barra do Portifact do seu espaço. O visualizador mostra a barra padrão.",
      attachment: (l, f = "") =>
        `Retivemos o arquivo ${f} anexado a um comentário do artifact ${l}. Ninguém pode vê-lo ou baixá-lo enquanto estiver retido; o comentário continua. Ele é guardado, não excluído: se você pedir uma revisão ou enviar uma contranotificação, analisamos de novo. Se a decisão for mantida, podemos excluir o arquivo definitivamente a partir de 30 dias após este e-mail.`,
    },
    liftWhat: {
      artifact: (l) =>
        `Retiramos a suspensão do artifact ${l}. Ele volta ao estado que tinha, ou ao arquivo se o seu espaço não tiver uma vaga ativa livre.`,
      account: () =>
        "Retiramos a suspensão da sua conta. Ela pode publicar de novo, e os artifacts suspensos com ela estão de volta.",
      brand: () =>
        "Retiramos a suspensão da marca do seu espaço. O visualizador volta a mostrá-la.",
      attachment: (l, f = "") =>
        `Suspendemos a restrição do arquivo ${f} anexado a um comentário do artifact ${l}. Quem pode ler o comentário pode vê-lo e baixá-lo de novo.`,
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
    dataAuthor: {
      suspendSubject: (l) => `Suspendemos um artifact onde você salvou dados: ${l}`,
      liftSubject: (l) => `Um artifact onde você salvou dados não está mais suspenso: ${l}`,
      suspendWhat: (l) =>
        `Suspendemos o artifact ${l} por causa de dados salvos nele, incluindo documentos que você salvou pela página dele. Ele não é mais exibido a ninguém e a página dele não pode ler nem salvar dados. Seus documentos são mantidos, não apagados, e você ainda pode baixá-los e apagá-los em Dados que você compartilhou.`,
      liftWhat: (l) =>
        `Retiramos a suspensão do artifact ${l}, onde você salvou dados pela página dele. A página dele pode voltar a ler e salvar dados como quem o gerencia configurou.`,
      open: "Veja o que você salvou:",
      openLink: "Dados que você compartilhou",
      footer:
        "Você recebeu este e-mail porque salvou dados neste artifact com sua conta do Portifact. É um aviso do serviço sobre uma decisão a respeito de conteúdo que você salvou, por isso não pode ser desativado.",
    },
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
      attachment: () => "Nous avons retenu un fichier d'un commentaire",
    },
    liftSubject: {
      artifact: (l) => `Votre artifact ${l} n’est plus suspendu`,
      account: () => "Votre compte Portifact n’est plus suspendu",
      brand: () => "La marque de votre espace n’est plus suspendue",
      attachment: () => "Un fichier d'un commentaire n'est plus retenu",
    },
    suspendWhat: {
      artifact: (l) =>
        `Nous avons suspendu l’artifact ${l}. Il n’est plus servi à personne, ses liens de partage cessent de fonctionner, et personne ne peut y publier, modifier son accès ni le restaurer.`,
      account: () =>
        "Nous avons suspendu votre compte. Il ne peut plus publier, et ses artifacts sont suspendus avec lui. Vous pouvez toujours vous connecter, exporter vos données et supprimer votre compte.",
      brand: () =>
        "Nous avons suspendu la marque de la barre Portifact de votre espace. Le lecteur affiche la barre par défaut.",
      attachment: (l, f = "") =>
        `Nous avons retenu le fichier ${f} joint à un commentaire de l'artifact ${l}. Personne ne peut le voir ni le télécharger tant qu'il est retenu ; le commentaire reste. Il est conservé, pas supprimé : si vous demandez un réexamen ou envoyez une contre-notification, nous l'examinons à nouveau. Si la décision est maintenue, nous pourrons supprimer définitivement le fichier au plus tôt 30 jours après cet e-mail.`,
    },
    liftWhat: {
      artifact: (l) =>
        `Nous avons levé la suspension de l’artifact ${l}. Il retrouve l’état qu’il avait, ou passe aux archives si votre espace n’a plus d’emplacement actif libre.`,
      account: () =>
        "Nous avons levé la suspension de votre compte. Il peut publier de nouveau, et les artifacts suspendus avec lui sont de retour.",
      brand: () =>
        "Nous avons levé la suspension de la marque de votre espace. Le lecteur l’affiche de nouveau.",
      attachment: (l, f = "") =>
        `Nous avons levé la restriction du fichier ${f} joint à un commentaire de l'artifact ${l}. Toute personne qui peut lire le commentaire peut à nouveau le voir et le télécharger.`,
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
    dataAuthor: {
      suspendSubject: (l) =>
        `Nous avons suspendu un artifact où vous avez enregistré des données : ${l}`,
      liftSubject: (l) =>
        `Un artifact où vous avez enregistré des données n’est plus suspendu : ${l}`,
      suspendWhat: (l) =>
        `Nous avons suspendu l’artifact ${l} en raison de données enregistrées dans celui-ci, dont des documents que vous avez enregistrés depuis sa page. Il n’est plus servi à personne et sa page ne peut plus lire ni enregistrer de données. Vos documents sont conservés, pas supprimés, et vous pouvez toujours les télécharger et les supprimer depuis Données partagées.`,
      liftWhat: (l) =>
        `Nous avons levé la suspension de l’artifact ${l}, où vous avez enregistré des données depuis sa page. Sa page peut de nouveau lire et enregistrer des données comme ses gestionnaires l’ont configurée.`,
      open: "Voir ce que vous avez enregistré :",
      openLink: "Données partagées",
      footer:
        "Vous avez reçu cet e-mail parce que vous avez enregistré des données dans cet artifact avec votre compte Portifact. C’est un avis de service sur une décision concernant un contenu que vous avez enregistré : il ne peut pas être désactivé.",
    },
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
      attachment: () => "Wir haben eine Datei an einem Kommentar zurückgehalten",
    },
    liftSubject: {
      artifact: (l) => `Ihr Artifact ${l} ist nicht mehr gesperrt`,
      account: () => "Ihr Portifact-Konto ist nicht mehr gesperrt",
      brand: () => "Die Marke Ihres Bereichs ist nicht mehr gesperrt",
      attachment: () => "Eine Datei an einem Kommentar wird nicht mehr zurückgehalten",
    },
    suspendWhat: {
      artifact: (l) =>
        `Wir haben das Artifact ${l} gesperrt. Es wird niemandem mehr ausgeliefert, seine Freigabelinks funktionieren nicht mehr, und niemand kann darin veröffentlichen, seinen Zugriff ändern oder es wiederherstellen.`,
      account: () =>
        "Wir haben Ihr Konto gesperrt. Es kann nicht mehr veröffentlichen, und seine Artifacts sind mit ihm gesperrt. Sie können sich weiterhin anmelden, Ihre Daten exportieren und Ihr Konto löschen.",
      brand: () =>
        "Wir haben die Marke der Portifact-Leiste Ihres Bereichs gesperrt. Der Viewer zeigt stattdessen die Standardleiste.",
      attachment: (l, f = "") =>
        `Wir haben die Datei ${f} an einem Kommentar zum Artifact ${l} zurückgehalten. Solange sie zurückgehalten wird, kann niemand sie ansehen oder herunterladen; der Kommentar selbst bleibt. Sie wird aufbewahrt, nicht gelöscht: Wenn du eine Überprüfung verlangst oder eine Gegendarstellung schickst, sehen wir sie uns erneut an. Bleibt es bei der Entscheidung, können wir die Datei frühestens 30 Tage nach dieser E-Mail endgültig löschen.`,
    },
    liftWhat: {
      artifact: (l) =>
        `Wir haben die Sperre des Artifacts ${l} aufgehoben. Es ist wieder im vorherigen Zustand, oder im Archiv, wenn Ihr Bereich keinen freien aktiven Platz hat.`,
      account: () =>
        "Wir haben die Sperre Ihres Kontos aufgehoben. Es kann wieder veröffentlichen, und die mit ihm gesperrten Artifacts sind zurück.",
      brand: () =>
        "Wir haben die Sperre der Marke Ihres Bereichs aufgehoben. Der Viewer zeigt sie wieder.",
      attachment: (l, f = "") =>
        `Wir haben die Einschränkung der Datei ${f} an einem Kommentar zum Artifact ${l} aufgehoben. Alle, die den Kommentar lesen können, können sie wieder ansehen und herunterladen.`,
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
    dataAuthor: {
      suspendSubject: (l) =>
        `Wir haben ein Artifact gesperrt, in dem Sie Daten gespeichert haben: ${l}`,
      liftSubject: (l) =>
        `Ein Artifact, in dem Sie Daten gespeichert haben, ist nicht mehr gesperrt: ${l}`,
      suspendWhat: (l) =>
        `Wir haben das Artifact ${l} wegen darin gespeicherter Daten gesperrt, darunter Dokumente, die Sie über seine Seite gespeichert haben. Es wird niemandem mehr ausgeliefert, und seine Seite kann keine Daten mehr lesen oder speichern. Ihre Dokumente bleiben erhalten und werden nicht gelöscht; Sie können sie weiterhin unter Geteilte Daten herunterladen und löschen.`,
      liftWhat: (l) =>
        `Wir haben die Sperre des Artifacts ${l} aufgehoben, in dem Sie über seine Seite Daten gespeichert haben. Seine Seite kann wieder Daten lesen und speichern, wie die Verwaltenden es eingerichtet haben.`,
      open: "Ansehen, was Sie gespeichert haben:",
      openLink: "Geteilte Daten",
      footer:
        "Sie erhalten diese E-Mail, weil Sie mit Ihrem Portifact-Konto Daten in diesem Artifact gespeichert haben. Es ist ein Servicehinweis zu einer Entscheidung über Inhalte, die Sie gespeichert haben, und kann daher nicht abbestellt werden.",
    },
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
      attachment: () => "Мы задержали файл в комментарии",
    },
    liftSubject: {
      artifact: (l) => `Ваш артефакт ${l} больше не приостановлен`,
      account: () => "Ваш аккаунт Portifact больше не приостановлен",
      brand: () => "Бренд вашего пространства больше не приостановлен",
      attachment: () => "Файл в комментарии больше не задержан",
    },
    suspendWhat: {
      artifact: (l) =>
        `Мы приостановили артефакт ${l}. Он больше никому не показывается, его ссылки для общего доступа перестают работать, и никто не может публиковать в нём, менять доступ к нему или восстанавливать его.`,
      account: () =>
        "Мы приостановили ваш аккаунт. Он больше не может публиковать, а его артефакты приостановлены вместе с ним. Вы по-прежнему можете входить, экспортировать свои данные и удалить аккаунт.",
      brand: () =>
        "Мы приостановили бренд панели Portifact вашего пространства. Просмотрщик показывает стандартную панель.",
      attachment: (l, f = "") =>
        `Мы задержали файл ${f}, прикреплённый к комментарию к артефакту ${l}. Пока файл задержан, никто не может его просмотреть или скачать; сам комментарий остаётся. Файл хранится, а не удалён: если вы попросите пересмотреть решение или отправите встречное уведомление, мы рассмотрим его снова. Если решение останется в силе, мы можем окончательно удалить файл не ранее чем через 30 дней после этого письма.`,
    },
    liftWhat: {
      artifact: (l) =>
        `Мы сняли приостановку с артефакта ${l}. Он вернулся в прежнее состояние или в архив, если в вашем пространстве нет свободного активного места.`,
      account: () =>
        "Мы сняли приостановку с вашего аккаунта. Он снова может публиковать, а артефакты, приостановленные вместе с ним, вернулись.",
      brand: () =>
        "Мы сняли приостановку с бренда вашего пространства. Просмотрщик снова его показывает.",
      attachment: (l, f = "") =>
        `Мы сняли ограничение с файла ${f}, прикреплённого к комментарию к артефакту ${l}. Все, кто может читать комментарий, снова могут его просматривать и скачивать.`,
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
    dataAuthor: {
      suspendSubject: (l) => `Мы приостановили артефакт, в котором вы сохраняли данные: ${l}`,
      liftSubject: (l) => `Артефакт, в котором вы сохраняли данные, больше не приостановлен: ${l}`,
      suspendWhat: (l) =>
        `Мы приостановили артефакт ${l} из-за сохранённых в нём данных, включая документы, которые вы сохранили через его страницу. Он больше никому не показывается, и его страница не может читать или сохранять данные. Ваши документы сохраняются, а не удаляются, и вы по-прежнему можете скачать и удалить их в разделе «Ваши общие данные».`,
      liftWhat: (l) =>
        `Мы сняли приостановку с артефакта ${l}, в котором вы сохраняли данные через его страницу. Его страница снова может читать и сохранять данные так, как это настроили его управляющие.`,
      open: "Посмотреть, что вы сохранили:",
      openLink: "Ваши общие данные",
      footer:
        "Вы получили это письмо, потому что сохраняли данные в этом артефакте с аккаунтом Portifact. Это служебное уведомление о решении по сохранённому вами контенту, поэтому его нельзя отключить.",
    },
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
      attachment: () => "コメントのファイルを保留しました",
    },
    liftSubject: {
      artifact: (l) => `アーティファクト ${l} の停止を解除しました`,
      account: () => "Portifact アカウントの停止を解除しました",
      brand: () => "スペースのブランドの停止を解除しました",
      attachment: () => "コメントのファイルの保留を解除しました",
    },
    suspendWhat: {
      artifact: (l) =>
        `アーティファクト ${l} を停止しました。誰にも配信されなくなり、共有リンクは機能しなくなります。また、誰も公開、アクセスの変更、復元を行えません。`,
      account: () =>
        "あなたのアカウントを停止しました。公開できなくなり、そのアーティファクトもあわせて停止されます。サインイン、データのエクスポート、アカウントの削除は引き続き行えます。",
      brand: () =>
        "スペースの Portifact バーのブランドを停止しました。ビューアーには既定のバーが表示されます。",
      attachment: (l, f = "") =>
        `アーティファクト ${l} のコメントに添付されたファイル ${f} を保留しました。保留中は誰も表示やダウンロードができません。コメント自体は残ります。ファイルは削除されず保管されています。再審査の依頼や異議申し立てがあれば、改めて確認します。判断が維持された場合、このメールの送信から最短で 30 日後にファイルを完全に削除することがあります。`,
    },
    liftWhat: {
      artifact: (l) =>
        `アーティファクト ${l} の停止を解除しました。以前の状態に戻ります。スペースに空きのアクティブ枠がない場合はアーカイブに戻ります。`,
      account: () =>
        "アカウントの停止を解除しました。再び公開でき、あわせて停止されていたアーティファクトも戻りました。",
      brand: () => "スペースのブランドの停止を解除しました。ビューアーに再び表示されます。",
      attachment: (l, f = "") =>
        `アーティファクト ${l} のコメントに添付されたファイル ${f} の制限を解除しました。コメントを読めるすべての人が、再び表示とダウンロードができます。`,
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
    dataAuthor: {
      suspendSubject: (l) => `あなたがデータを保存したアーティファクト ${l} を停止しました`,
      liftSubject: (l) => `あなたがデータを保存したアーティファクト ${l} の停止を解除しました`,
      suspendWhat: (l) =>
        `アーティファクト ${l} に保存されたデータ (あなたがそのページから保存したドキュメントを含みます) を理由に、このアーティファクトを停止しました。誰にも配信されなくなり、そのページはデータの読み取りや保存ができなくなります。あなたのドキュメントは削除されずに保持され、「共有したデータ」から引き続きダウンロードや削除ができます。`,
      liftWhat: (l) =>
        `あなたがページからデータを保存したアーティファクト ${l} の停止を解除しました。そのページは、管理者の設定どおりに再びデータを読み取り、保存できます。`,
      open: "保存した内容を確認:",
      openLink: "共有したデータ",
      footer:
        "Portifact アカウントでこのアーティファクトにデータを保存したため、このメールをお送りしました。あなたが保存したコンテンツに関する決定についてのサービス通知のため、停止できません。",
    },
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
      attachment: () => "我们暂扣了评论中的一个文件",
    },
    liftSubject: {
      artifact: (l) => `你的 artifact ${l} 已解除暂停`,
      account: () => "你的 Portifact 账户已解除暂停",
      brand: () => "你空间的品牌已解除暂停",
      attachment: () => "评论中的一个文件已不再被暂扣",
    },
    suspendWhat: {
      artifact: (l) =>
        `我们已暂停 artifact ${l}。它不再向任何人提供,其共享链接停止生效,任何人都不能向其发布、更改其访问权限或恢复它。`,
      account: () =>
        "我们已暂停你的账户。它不能再发布内容,其 artifact 也随之暂停。你仍然可以登录、导出数据和删除账户。",
      brand: () => "我们已暂停你空间的 Portifact 栏中的品牌。查看器改为显示默认栏。",
      attachment: (l, f = "") =>
        `我们暂扣了制品 ${l} 的一条评论所附的文件 ${f}。暂扣期间，任何人都无法查看或下载它；评论本身保留。文件被保存而非删除：如果你申请复核或提交反通知，我们会重新审查。如果决定维持，我们最早可在本邮件发出 30 天后永久删除该文件。`,
    },
    liftWhat: {
      artifact: (l) =>
        `我们已解除 artifact ${l} 的暂停。它恢复到原来的状态;如果你的空间没有空闲的活跃名额,则回到归档。`,
      account: () => "我们已解除你账户的暂停。它可以再次发布,随之暂停的 artifact 也已恢复。",
      brand: () => "我们已解除你空间品牌的暂停。查看器会再次显示它。",
      attachment: (l, f = "") =>
        `我们解除了制品 ${l} 的一条评论所附文件 ${f} 的限制。所有能阅读该评论的人都可以再次查看和下载它。`,
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
    dataAuthor: {
      suspendSubject: (l) => `我们已暂停一个你保存过数据的 artifact:${l}`,
      liftSubject: (l) => `一个你保存过数据的 artifact 已解除暂停:${l}`,
      suspendWhat: (l) =>
        `由于 artifact ${l} 中保存的数据(包括你通过其页面保存的文档),我们已暂停它。它不再向任何人提供,其页面也不能读取或保存数据。你的文档会被保留,不会被删除,你仍可以在"你分享的数据"中下载和删除它们。`,
      liftWhat: (l) =>
        `我们已解除 artifact ${l} 的暂停,你曾通过其页面在其中保存数据。其页面可以按管理者的设置再次读取和保存数据。`,
      open: "查看你保存的内容:",
      openLink: "你分享的数据",
      footer:
        "你收到这封邮件,是因为你用 Portifact 账户在此 artifact 中保存过数据。这是一则关于你保存的内容的决定的服务通知,因此无法关闭。",
    },
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
  const onArtifact = input.target === "artifact" || input.target === "attachment";
  const label = onArtifact ? artifactLabel(input) : "";
  const suspend = input.action === "suspend";
  // A data author is told about the artifact their documents are in, never as its manager.
  const author = input.audience === "data_author" && input.target === "artifact";
  const subject = author
    ? (suspend ? t.dataAuthor.suspendSubject : t.dataAuthor.liftSubject)(input.artifactId ?? "")
    : (suspend ? t.suspendSubject : t.liftSubject)[input.target](input.artifactId ?? "");
  const what = author
    ? (suspend ? t.dataAuthor.suspendWhat : t.dataAuthor.liftWhat)(label)
    : (suspend ? t.suspendWhat : t.liftWhat)[input.target](label, input.attachmentId ?? "");
  const open = author ? t.dataAuthor.open : t.open;
  const openLink = author ? t.dataAuthor.openLink : t.openLink;
  const footer = author ? t.dataAuthor.footer : t.footer;
  const facts = [
    ...(onArtifact ? [{ label: "ID", value: input.artifactId ?? "" }] : []),
    ...(input.target === "attachment" ? [{ label: "File", value: input.attachmentId ?? "" }] : []),
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
      content: [open + gap(open), { href: input.dashboardUrl, text: openLink }],
      muted: true,
    },
  ];
  const html = renderEmail({
    title: subject,
    preheader: what,
    heading: subject,
    blocks,
    footer,
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
    `${open}${gap(open)}${input.dashboardUrl}`,
    "",
    footer,
    ...textSignature(locale),
  ].join("\n");
  return { subject, text, html };
}
