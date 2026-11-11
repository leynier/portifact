// French catalog of the auth and report pages: the scripts' messages and the pages' markers.
// French (France) with "vous", with a no-break space before : ; ! ? and inside « ». The sign-in
// notices keep every condition of the English (docs/legal.md, "Acceptance at sign-in") and the
// same three links.
import type { AuthMessages } from "./en.ts";
import type { AuthCatalog } from "./types.ts";

const messages = {
  network: "Portifact est injoignable. Vérifiez votre connexion et réessayez.",
  unexpected: "Un problème est survenu. Réessayez.",
  rateLimited: "Trop de tentatives. Patientez une minute et réessayez.",
  emailRequired: "Saisissez votre adresse e-mail.",
  emailInvalid: "Saisissez une adresse e-mail valide, par exemple nom@example.com.",
  codeRequired: "Saisissez le code à 6 chiffres reçu par e-mail.",
  codeInvalid: "Ce code n’est pas valide ou a expiré. Vérifiez-le ou demandez un nouveau code.",
  codeSent: (email: string) => `Nous avons envoyé un code à 6 chiffres à ${email}.`,
  codeSentStatus: "Code envoyé. Saisissez le code à 6 chiffres reçu par e-mail.",
  codeResent: "Un nouveau code est en route.",
  resendCode: "Envoyer un nouveau code",
  resendIn: (seconds: number) => `Envoyer un nouveau code dans ${seconds} s`,
  humanCheckNeeded:
    "Encore une étape : Cloudflare doit vérifier rapidement que vous êtes humain. Terminez la vérification sous les options de connexion pour continuer.",
  emailSuppressed:
    "Nous ne pouvons pas envoyer d’e-mail à cette adresse, car des messages précédents ont été rejetés ou signalés comme spam. Connectez-vous avec Google ou GitHub, ou écrivez à privacy@portifact.com pour la faire examiner.",
  emailCapacity:
    "Les codes par e-mail sont suspendus pour le moment, car Portifact a atteint sa limite mensuelle d’e-mails. Connectez-vous avec Google ou GitHub, ou réessayez plus tard.",
  signedInAs: (email: string) => `Connecté en tant que ${email}`,
  signedOut: "Vous êtes déconnecté.",
  methodConnected: "Connectée",
  methodNotUsed: "Pas encore utilisée",
  redirecting: "Connexion en cours.",
  ssoFor: (email: string) =>
    `${email} se connecte avec le fournisseur d’identité de votre organisation.`,
  ssoShown:
    "Votre organisation utilise l’authentification unique. Continuez avec elle, ou recevez plutôt un code par e-mail.",
  termsUpdateFor: (email: string) => `Connecté en tant que ${email}`,
  providerErrors: {
    human_verification_required:
      "Les nouveaux comptes nécessitent une vérification rapide que vous êtes humain, et elle n’a pas abouti. Réessayez ; si une vérification apparaît sous les options de connexion, terminez-la. Si rien n’apparaît, rechargez la page ou autorisez challenges.cloudflare.com.",
    terms_not_accepted:
      "Votre acceptation des conditions n’est pas parvenue à Portifact, ou elle a expiré au bout de 30 minutes. Choisissez de nouveau une option de connexion pour continuer.",
    account_not_linked:
      "Votre fournisseur n’a pas vérifié cette adresse e-mail, elle ne peut donc pas ouvrir le compte Portifact qui l’utilise. Vérifiez-la chez lui, ou connectez-vous avec un code par e-mail.",
    email_not_verified:
      "Votre fournisseur n’a pas vérifié cette adresse e-mail. Vérifiez-la chez lui, ou connectez-vous avec un code par e-mail.",
    email_not_found:
      "Votre fournisseur n’a pas partagé d’adresse e-mail. Connectez-vous avec un code par e-mail.",
    state_mismatch:
      "La connexion a pris trop de temps ou a été lancée dans un autre onglet. Réessayez.",
    artifact_unavailable:
      "Cet artifact n’existe pas, n’est plus disponible ou ne peut pas être ouvert avec ce compte. Pour utiliser un autre compte, déconnectez-vous et ouvrez de nouveau le lien.",
    session_age:
      "Cet espace de travail demande une nouvelle connexion au bout d’un moment, et la vôtre est plus ancienne que ce qu’il permet. Reconnectez-vous pour continuer ; vous reviendrez là où vous étiez.",
    network_refused:
      "Cet espace de travail n’autorise l’accès que depuis ses réseaux approuvés, et vous n’êtes sur aucun d’eux pour le moment. Connectez-vous depuis un réseau approuvé et ouvrez de nouveau le lien, ou contactez un administrateur de l’espace de travail.",
    read_rate_limited:
      "Ce compte a ouvert trop d’artifacts en peu de temps. Patientez quelques minutes et ouvrez de nouveau le lien.",
    sso_unavailable:
      "L’authentification unique n’est pas disponible pour cette adresse pour le moment. Connectez-vous autrement, ou contactez l’admin de votre workspace.",
    sso_email_outside_domain:
      "Le fournisseur d’identité de votre organisation a donné une adresse hors de ses domaines vérifiés, donc Portifact ne peut pas l’utiliser. Contactez l’admin de votre workspace.",
    sso_failed:
      "L’authentification unique n’a pas abouti. Réessayez ; si l’échec persiste, connectez-vous avec un code par e-mail et prévenez l’admin de votre workspace.",
    sso_workspace_full:
      "Le workspace de votre organisation n’a plus de place libre, vous n’avez donc pas pu le rejoindre. Demandez une place à son admin, puis reconnectez-vous.",
    sso_email_unverified:
      "Le fournisseur d’identité de votre organisation n’a pas vérifié cette adresse, donc Portifact ne peut pas l’utiliser. Contactez l’admin de votre workspace.",
    sso_link_required:
      "Cette adresse a déjà un compte Portifact. Connectez-vous une fois avec un code par e-mail ou comme d’habitude, puis choisissez Lier l’authentification unique sur cette page.",
    sso_removed:
      "Un admin du workspace vous a retiré, vous ne pouvez donc pas le rejoindre à nouveau par l’authentification unique. Demandez à un admin de vous inviter à nouveau.",
  },
  providerErrorFallback: "La connexion n’a pas abouti. Réessayez.",
  /** The read entry's confirmation before a code goes to an artifact's custom host. */
  readConfirm: {
    heading: "Ouvrir à sa propre adresse",
    body: (host: string) =>
      `Cet artifact se trouve sur ${host}, une adresse gérée par son propriétaire. Continuez seulement si vous vouliez l’ouvrir là.`,
    continue: "Continuer",
    missing:
      "Le lien était incomplet. Ouvrez-le de nouveau depuis l’endroit où vous l’avez trouvé.",
  },
  deviceCodeRequired: "Saisissez le code affiché dans votre terminal.",
  deviceCodeInvalid:
    "Ce code n’est pas valide ou a expiré. Exécutez de nouveau la commande de connexion.",
  deviceCodeTaken: "Un autre compte est déjà en train d’examiner ce code.",
  deviceProcessed: "Ce code a déjà été utilisé. Exécutez de nouveau la commande de connexion.",
  deviceApproved: "Appareil connecté. Vous pouvez retourner à votre terminal.",
  deviceDenied: "Demande refusée. L’appareil n’a pas obtenu d’accès.",
  consentMissing:
    "Cette page nécessite une demande d’autorisation. Recommencez depuis l’app qui vous a envoyé ici.",
  consentClientUnknown: "L’app qui vous a envoyé ici n’est pas enregistrée ou est désactivée.",
  redirectHost: (host: string) => `Une fois votre choix fait, vous revenez sur ${host}.`,
  scopes: {
    "artifacts:read": "Voir vos artifacts, leurs paramètres et leurs versions",
    "artifacts:write": "Publier et mettre à jour des artifacts",
    "artifacts:share": "Modifier qui peut ouvrir vos artifacts",
    "artifacts:delete": "Archiver et supprimer vos artifacts",
    "annotations:read": "Lire les commentaires sur vos artifacts",
    "annotations:write": "Écrire des commentaires et y répondre en votre nom",
    "annotations:moderate": "Résoudre, masquer et supprimer les commentaires sur vos artifacts",
    "credentials:manage": "Voir les apps connectées à votre compte et les déconnecter",
    offline_access: "Rester connectée jusqu’à ce que vous révoquiez l’accès",
  },
  unknownScope: (name: string) => `Utiliser l’autorisation « ${name} »`,
  languageLabel: "Langue",
  report: {
    artifactRequired: "Saisissez l’adresse ou l’ID de l’artifact.",
    artifactInvalid:
      "Saisissez une adresse comme https://abcdefghij.portifact.dev/ ou un ID de 10 caractères.",
    reasonRequired: "Choisissez le problème de l’artifact.",
    detailsInvalid: "Supprimez les caractères de contrôle ou raccourcissez les détails.",
    emailInvalid: "Saisissez une adresse e-mail valide, ou laissez le champ vide.",
    rateLimited:
      "Trop de signalements depuis cet endroit. Réessayez plus tard ou écrivez à abuse@portifact.com.",
    network: "Portifact est injoignable. Vérifiez votre connexion et réessayez.",
    failed: "Le signalement n’a pas pu être envoyé. Réessayez ou écrivez à abuse@portifact.com.",
    sent: "Signalement envoyé.",
  },
  /** The share link entry page (src/share/share.ts). */
  share: {
    checking: "Vérification du lien.",
    opening: "Ouverture de l'artifact.",
    passwordRequired: "Saisissez le mot de passe.",
    refused: "Le mot de passe est incorrect, ou le lien a expiré ou a été révoqué.",
    humanCheckShown:
      "Confirmez ci-dessous que vous êtes humain. Le mot de passe est réessayé quand vous avez terminé.",
    humanCheckUnavailable:
      "La vérification humaine n'a pas pu se charger. Autorisez challenges.cloudflare.com ou réessayez plus tard.",
    rateLimited: "Trop de tentatives. Patientez quelques minutes puis réessayez.",
    network: "Impossible de joindre Portifact. Vérifiez votre connexion et réessayez.",
    failed: "Le lien n'a pas pu être ouvert. Réessayez.",
  },
  /** The comment notice unsubscribe page (src/unsubscribe/unsubscribe.ts). */
  unsubscribe: {
    missing:
      "Ce lien est incomplet. Ouvrez de nouveau le lien de l’e-mail, ou désactivez les avis de commentaires dans vos paramètres.",
    invalid: "Ce lien ne fonctionne plus. Désactivez les avis de commentaires dans vos paramètres.",
    rateLimited: "Trop de tentatives depuis cet endroit. Réessayez dans quelques minutes.",
    network: "Portifact est injoignable. Vérifiez votre connexion et réessayez.",
    failed:
      "Les avis de commentaires n’ont pas pu être désactivés. Réessayez, ou désactivez-les dans vos paramètres.",
    done: "Avis de commentaires et de relecture désactivés.",
  },
} satisfies AuthMessages;

const TERMS_LINKS = {
  terms:
    '<a href="https://portifact.com/terms" target="_blank" rel="noopener">Conditions d’utilisation</a>',
  acceptableUse:
    '<a href="https://portifact.com/acceptable-use" target="_blank" rel="noopener">Politique d’utilisation acceptable</a>',
  privacy:
    '<a href="https://portifact.com/privacy" target="_blank" rel="noopener">Politique de confidentialité</a>',
};

/** The conditions of the sign-in notices after the action that accepts them. */
const termsConditions = `vous confirmez avoir 18 ans ou plus, accepter les ${TERMS_LINKS.terms} et la ${TERMS_LINKS.acceptableUse}, et avoir lu la ${TERMS_LINKS.privacy}. Les liens s’ouvrent dans un nouvel onglet.`;

export const fr: AuthCatalog = {
  messages,
  page: {
    // Shared by the four pages.
    "auth.skip": "Aller au contenu",
    "auth.home": "Accueil Portifact",
    "auth.legal": "Informations légales",
    "auth.terms": "Conditions",
    "auth.privacy": "Confidentialité",
    "auth.acceptableUse": "Utilisation acceptable",
    "auth.accessTo": "Accès à",
    "auth.ableTo": "Elle pourra",
    "auth.deny": "Refuser",

    // login.html
    "login.title": "Se connecter à Portifact",
    "login.intro": "Nouveau ? Votre première connexion crée votre compte.",
    "login.signedInHint":
      "Vous pouvez ouvrir votre tableau de bord, fermer cette page ou vous déconnecter de ce navigateur.",
    "login.openDashboard": "Ouvrir votre tableau de bord",
    "login.methodsHeading": "Méthodes de connexion",
    "login.methodsHint":
      "Un compte Google ou GitHub avec cette adresse e-mail vérifiée rejoint ce compte la première fois que vous l’utilisez.",
    "login.methodNotUsed": "Pas encore utilisée",
    "login.signOut": "Se déconnecter",
    "login.termsUpdateHeading": "Consultez les conditions pour continuer",
    "login.termsUpdateBody":
      "Votre compte n’a pas encore accepté la version actuelle des conditions.",
    "login.termsUpdateNotice": `En sélectionnant Accepter et continuer, ${termsConditions}`,
    "login.agreeAndContinue": "Accepter et continuer",
    "login.termsNotice": `En continuant avec Google, GitHub ou un code par e-mail, ${termsConditions}`,
    "login.termsNoticeSso": `En continuant avec Google, GitHub, un code par e-mail ou l’authentification unique, ${termsConditions}`,
    "login.ssoHeading": "Votre organisation utilise l’authentification unique",
    "login.ssoContinue": "Continuer avec l’authentification unique",
    "login.ssoUseCode": "Recevoir plutôt un code par e-mail",
    "login.ssoLinkHint":
      "Votre organisation utilise l’authentification unique. Liez-la une fois à ce compte et utilisez-la la prochaine fois.",
    "login.ssoLink": "Lier l’authentification unique",
    "login.google": "Continuer avec Google",
    "login.github": "Continuer avec GitHub",
    "login.orEmail": "ou utilisez votre e-mail",
    "login.emailLabel": "Adresse e-mail",
    "login.sendCode": "M’envoyer un code",
    "login.codeHeading": "Consultez vos e-mails",
    "login.codeLabel": "Code à 6 chiffres",
    "login.codeHint":
      "Le code expire au bout de 5 minutes et ne fonctionne qu’une fois. S’il n’est pas arrivé, vérifiez votre dossier de spam.",
    "login.verify": "Se connecter",
    "login.resend": "Envoyer un nouveau code",
    "login.changeEmail": "Utiliser une autre adresse e-mail",
    "login.humanHeading": "Encore une étape : confirmez que vous êtes humain",
    "login.humanBody":
      "Cloudflare doit effectuer une vérification rapide avant que Portifact puisse continuer. Terminez-la ci-dessous et votre connexion reprendra d’elle-même.",

    // device.html
    "device.title": "Connecter un appareil à Portifact",
    "device.eyebrow": "CLI et apps Portifact",
    "device.heading": "Connecter un appareil",
    "device.intro": "Approuvez la CLI Portifact ou une autre app qui vous a affiché un code.",
    "device.codeLabel": "Code affiché dans votre terminal",
    "device.continue": "Continuer",
    "device.reviewHeading": "Approuver cette connexion ?",
    "device.app": "App",
    "device.code": "Code",
    "device.warning":
      "Approuvez uniquement si vous avez lancé cette demande depuis votre propre terminal et que le code correspond.",
    "device.approve": "Approuver",

    // consent.html
    "consent.title": "Autoriser l’accès à Portifact",
    "consent.eyebrow": "Apps connectées",
    "consent.heading": "Autoriser l’accès",
    "consent.requestHeading":
      '<span id="client-name" class="font-semibold break-words"></span> souhaite utiliser votre compte Portifact',
    "consent.publishedBy": "Détails de l’app publiés par",
    "consent.loopback":
      "Elle revient vers une app sur cet appareil. Autorisez-la uniquement si vous avez lancé cette demande depuis une app de confiance.",
    "consent.allow": "Autoriser",
    "consent.disconnect":
      "Vous pouvez déconnecter des apps à tout moment depuis la page de votre compte dans le tableau de bord.",

    // report.html
    "report.title": "Signaler un artifact à Portifact",
    "report.heading": "Signaler un artifact",
    "report.intro":
      'Signalez-nous un contenu qui enfreint la <a href="https://portifact.com/acceptable-use">Politique d’utilisation acceptable</a>. Vous n’avez pas besoin de compte. Nous nous efforçons de répondre sous 48 heures.',
    "report.artifactLabel": "Adresse ou ID de l’artifact",
    "report.reasonLabel": "Quel est le problème",
    "report.reason.none": "Choisissez un motif",
    "report.reason.phishing": "Hameçonnage ou fausse page de connexion",
    "report.reason.malware": "Logiciel malveillant, exploits ou minage de cryptomonnaie",
    "report.reason.child_safety": "Sexualise des mineurs",
    "report.reason.sexual_content": "Contenu sexuellement explicite",
    "report.reason.copyright":
      "Atteinte au droit d’auteur ou au droit des marques, fichiers piratés",
    "report.reason.impersonation": "Usurpation d’identité",
    "report.reason.harassment": "Menaces, harcèlement ou extrémisme violent",
    "report.reason.private_information": "Informations privées d’une personne",
    "report.reason.spam": "Spam",
    "report.reason.other": "Autre chose qui enfreint les règles",
    "report.detailsLabel": 'Détails <span class="font-normal text-text-muted">(facultatif)</span>',
    "report.detailsHint":
      "Ce que vous avez vu et où. Ne collez pas de contenu illégal ; l’adresse suffit. Jusqu’à 2 000 caractères.",
    "report.emailLabel":
      'Votre e-mail <span class="font-normal text-text-muted">(facultatif)</span>',
    "report.emailHint":
      'Uniquement si vous souhaitez que nous puissions vous répondre. Consultez la <a href="https://portifact.com/privacy">Politique de confidentialité</a>.',
    "report.send": "Envoyer le signalement",
    "report.doneHeading": "Merci, nous avons reçu votre signalement",
    "report.doneBody":
      'Nous examinons chaque signalement. Vous pouvez aussi écrire à <a href="mailto:abuse@portifact.com">abuse@portifact.com</a>.',
    // share.html
    "share.title": "Ouvrir un artifact partagé",
    "share.heading": "Ouvrir un artifact partagé",
    "share.passwordIntro":
      "La personne qui a partagé cet artifact l'a protégé par un mot de passe.",
    "share.passwordLabel": "Mot de passe",
    "share.humanCheckHint":
      "Après plusieurs mots de passe incorrects, confirmez que vous êtes humain pour réessayer.",
    "share.open": "Ouvrir",
    "share.unavailableHeading": "Ce lien ne fonctionne pas",
    "share.unavailableBody":
      "Il a peut-être expiré ou été révoqué, ou ce n'est pas un lien de partage. Demandez un nouveau lien à la personne qui l'a partagé.",
    "share.incompleteHeading": "Ouvrez le lien à nouveau",
    "share.incompleteBody":
      "Cette page a besoin du lien complet, y compris la partie après #. Par sécurité, elle retire cette partie de la barre d'adresse : après un rechargement, ouvrez à nouveau le lien depuis l'endroit où vous l'avez reçu.",
    "share.privacy":
      "Vous lisez l'artifact sans compte. Portifact n'enregistre pas qui vous êtes ; le propriétaire voit seulement que le lien a été utilisé. L'artifact est écrit par son auteur, pas par Portifact : n'y saisissez ni mot de passe ni données personnelles.",
    "share.report": "Signaler un abus",

    // unsubscribe.html
    "unsubscribe.title": "Désactiver les avis de commentaires de Portifact",
    "unsubscribe.heading": "Désactiver les avis de commentaires",
    "unsubscribe.intro":
      "Vous ne recevrez plus d’e-mails sur les nouveaux commentaires et les relectures des artifacts Portifact. Les avis d’expiration et les e-mails de connexion ne changent pas.",
    "unsubscribe.confirm": "Désactiver les avis de commentaires",
    "unsubscribe.doneHeading": "Les avis de commentaires sont désactivés",
    "unsubscribe.doneBody":
      'Vous pouvez les réactiver dans vos <a href="/settings">paramètres</a>.',
  },
};
