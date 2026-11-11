// French messages of the dashboard (France, "vous"), with the same keys as en.ts. French
// typography: a no-break space before : ; ! ? and inside « ». Titles and buttons have no
// trailing period; no em dashes.
import { planTextFr } from "../../plans/i18n/fr.ts";
import type { Catalog } from "./en.ts";

export const fr = {
  ...planTextFr,
  "app.title": "Portifact",
  "app.pageTitle": "{page} · Portifact",
  "shell.skipLink": "Aller au contenu",
  "shell.navigation": "Principale",
  "shell.home": "Tableau de bord Portifact",
  "shell.artifacts": "Artifacts",
  "shell.usageLink": "Utilisation",
  "shell.appsLink": "Apps",
  "shell.webhooksLink": "Webhooks",
  "shell.settingsLink": "Paramètres",
  "shell.profileLink": "Profil",
  "shell.openNavigation": "Ouvrir la navigation",
  "shell.closeNavigation": "Fermer la navigation",
  "shell.collapseSidebar": "Réduire la barre latérale",
  "shell.expandSidebar": "Développer la barre latérale",
  "shell.resizeSidebar": "Redimensionner la barre latérale",
  "shell.signOut": "Se déconnecter",
  "shell.signingOut": "Déconnexion en cours.",
  "shell.signOutFailed": "La déconnexion n’a pas abouti. Réessayez.",
  "shell.publishLink": "Publier",
  "shell.dismiss": "Fermer le message",
  "theme.legend": "Thème",
  "theme.system": "Système",
  "theme.light": "Clair",
  "theme.dark": "Sombre",
  "copy.done": "Copié dans le presse-papiers",
  "copy.failed":
    "Le navigateur a bloqué le presse-papiers. Sélectionnez le texte et copiez-le manuellement.",
  "copy.copied": "Copié",
  "shell.loadingAccount": "Chargement de votre compte",
  "shell.capacity.title": "Portifact protège sa capacité",
  "shell.capacity.new_artifacts":
    "La création de nouveaux artifacts est suspendue pour le moment. Les mises à jour de vos artifacts fonctionnent toujours, et vos artifacts restent en ligne.",
  "shell.capacity.publishing":
    "Les nouveaux envois sont suspendus pour le moment, et les nouveaux commentaires peuvent l’être aussi. Vos artifacts restent en ligne, et vous pouvez toujours les lire, les exporter, les supprimer, les renouveler et en réduire l’accès.",

  "language.title": "Langue",
  "language.hint":
    "La langue du tableau de bord, des pages de connexion et des e-mails que Portifact vous envoie.",
  "language.label": "Langue",
  "language.description":
    "Enregistrée dans votre compte, pour que vos autres appareils l’utilisent aussi.",
  "language.changed": "Le tableau de bord est maintenant en français.",
  "language.loadFailed":
    "La langue n’a pas pu être chargée. Vérifiez votre connexion et réessayez.",
  "language.saveFailed":
    "La langue a changé dans ce navigateur, mais votre compte n’a pas pu l’enregistrer. Réessayez plus tard.",

  "list.title": "Artifacts",
  "list.description":
    "Tout ce que vous avez publié. La liste s’actualise tant que cet onglet est ouvert.",
  "list.loading": "Chargement de vos artifacts",
  "list.caption": "Vos artifacts",
  "list.column.name": "Nom",
  "list.column.state": "État",
  "list.column.expires": "Expiration",
  "list.column.usage": "Taille",
  "list.column.activity": "Activité",
  "list.column.actions": "Actions rapides",
  "list.noVersion": "Aucune version",
  "list.versions": "{count, plural, one {# version conservée} other {# versions conservées}}",
  "list.updated": "Mis à jour {date}",
  "list.openThreads":
    "{count, plural, =0 {Aucun fil ouvert} one {# fil ouvert} other {# fils ouverts}}",
  "list.lastComment": "Commentaires modifiés {date}",
  "list.trafficNote": "Le trafic est compté pour tout votre compte, pas par artifact.",
  "list.trafficLink": "Voir l’utilisation",
  "list.loadMore": "Charger plus",
  "list.loadingMore": "Chargement d’autres artifacts",
  "list.count": "{count, plural, one {# artifact affiché} other {# artifacts affichés}}",
  "list.empty.title": "Aucun artifact pour l’instant",
  "list.empty.body":
    "Publiez un fichier HTML, un dossier, un ZIP ou un document avec le bouton Publier ou depuis votre terminal, et il apparaîtra ici.",
  "list.error.title": "Vos artifacts n’ont pas pu être chargés",
  "list.refreshFailed.title": "La liste n’a pas pu être actualisée",
  "list.refreshFailed.body":
    "Elle affiche ce qui a été chargé en dernier. Portifact réessaie dans un instant.",
  "list.never": "Jamais",
  "list.pinned": "Épinglé",
  "list.column.access": "Accès",
  "list.captionFiltered": "Vos artifacts correspondant à la recherche et aux filtres",
  "list.countFiltered":
    "{count, plural, one {# artifact correspondant affiché} other {# artifacts correspondants affichés}}",
  "list.searching": "Recherche dans vos artifacts",
  "list.noMatch.title": "Aucun artifact ne correspond",
  "list.noMatch.body":
    "Essayez une autre recherche, ou effacez les filtres pour voir tous les artifacts.",
  "list.access.public": "Public",
  "list.access.authenticated": "Utilisateurs connectés",
  "list.access.restricted": "Restreint",
  "list.annotations.off": "Commentaires désactivés",
  "list.annotations.open": "Commentaires ouverts",
  "list.annotations.locked": "Commentaires verrouillés",
  "list.filter.label": "Rechercher et filtrer les artifacts",
  "list.filter.search": "Rechercher",
  "list.filter.searchPlaceholder": "Nom ou ID",
  "list.filter.clearSearch": "Effacer la recherche",
  "list.filter.searchTooLong": "Recherchez au maximum {max} caractères",
  "list.filter.state": "État",
  "list.filter.type": "Type",
  "list.filter.access": "Accès",
  "list.filter.annotations": "Commentaires",
  "list.filter.any": "Tous",
  "list.filter.open": "Filtres",
  "list.filter.activeCount": "actifs",
  "list.filter.sheetTitle": "Filtrer les artifacts",
  "list.filter.close": "Fermer les filtres",
  "list.filter.done": "Terminé",
  "list.filter.clear": "Effacer les filtres",
  "list.content.toggle": "Rechercher dans le contenu",
  "list.content.toggleHint":
    "Trouvez des mots dans le texte des artifacts actifs, pas seulement dans leurs noms.",
  "list.content.search": "Rechercher dans le contenu",
  "list.content.placeholder": "Mots du texte",
  "list.content.caption": "Artifacts dont le texte correspond à la recherche",
  "list.content.column.match": "Correspondance",
  "list.content.file": "Dans {path}",
  "list.content.partial":
    "Indexé en partie : une partie de son texte était trop volumineuse pour la recherche.",
  "list.content.count":
    "{count, plural, one {# artifact dont le texte correspond} other {# artifacts dont le texte correspond}}",
  "list.content.searching": "Recherche dans vos artifacts",
  "list.content.noMatch.title": "Aucun texte ne correspond",
  "list.content.noMatch.body":
    "Chaque mot doit apparaître dans le texte. Les artifacts archivés ne sont pas recherchés.",
  "list.content.error": "La recherche a échoué",
  "list.open": "Ouvrir",
  "list.openLabel": "Ouvrir la version publiée de {name}",
  "list.review": "Relire",
  "list.reviewLabel": "Relire et commenter {name}",
  "list.onboarding.lead":
    "Chaque artifact a son propre lien, privé jusqu’à ce que vous choisissiez qui d’autre peut l’ouvrir. Choisissez la méthode qui correspond à votre façon de travailler.",
  "list.onboarding.browser.title": "Envoyer depuis le navigateur",
  "list.onboarding.browser.body":
    "Déposez un fichier HTML, un dossier, un ZIP ou un document Markdown.",
  "list.onboarding.browser.action": "Publier depuis le navigateur",
  "list.onboarding.cli.title": "Publier depuis votre terminal",
  "list.onboarding.cli.body":
    "Installez la CLI, connectez-vous une fois, puis publiez un fichier ou un dossier.",
  "list.onboarding.cli.install": "Installer la CLI",
  "list.onboarding.cli.publish": "Publier un fichier",
  "list.onboarding.cli.copy": "Copier la commande",
  "list.onboarding.mcp.title": "Laissez votre agent publier",
  "list.onboarding.mcp.body":
    "Ajoutez Portifact comme serveur MCP distant dans Claude, Codex, Cursor ou tout client MCP, puis demandez à votre agent de publier ce qu’il a construit.",
  "list.onboarding.mcp.url": "URL du serveur MCP",
  "list.onboarding.mcp.copy": "Copier l’URL",

  "detail.loading": "Chargement de l’artifact",
  "detail.back": "Tous les artifacts",
  "detail.notFound.title": "Artifact introuvable",
  "detail.notFound.body": "Il n’existe pas, a été supprimé ou appartient à un autre compte.",
  "detail.error.title": "L’artifact n’a pas pu être chargé",
  "detail.facts": "Détails",
  "detail.url": "URL",
  "detail.type": "Type",
  "detail.state": "État",
  "detail.access": "Accès",
  "detail.created": "Créé",
  "detail.updated": "Mis à jour",
  "detail.expires": "Expire",
  "detail.archived": "Archivé",
  "detail.purge": "Supprimé définitivement le",
  "detail.notSet": "Non défini",
  "detail.link": "Lien",
  "detail.copyLink": "Copier le lien",
  "detail.linkCopied": "Lien copié",
  "detail.open": "Ouvrir",
  "detail.lifecycleHint":
    "Le renouveler le garde en ligne 30 jours de plus. Les artifacts archivés passent hors ligne et sont supprimés définitivement plus tard ; restaurez-les avant.",
  "detail.comments.title": "Commentaires",
  "detail.comments.body":
    "Les relecteurs commentent des phrases et des éléments précis. Lisez-les, répondez-y et résolvez-les dans la visionneuse de relecture, où votre agent peut aussi les lire.",
  "detail.comments.unavailable":
    "Les commentaires peuvent être lus et ajoutés tant que l’artifact est actif.",
  "detail.versions.title": "Versions",
  "detail.versions.body":
    "Chaque publication crée une nouvelle version. Téléchargez, comparez et rétablissez les versions conservées dans l’historique.",
  "detail.actions": "Actions",
  "detail.sectionsNav": "Sections de l’artifact",
  "sections.title": "Sur cette page",
  "detail.section.overview": "Aperçu",
  "detail.section.sharing": "Partage",
  "detail.section.comments": "Commentaires",
  "detail.section.activity": "Activité",
  "detail.section.danger": "Zone de danger",
  "detail.danger.body":
    "L’archivage met l’artifact hors ligne ; il est supprimé définitivement plus tard, sauf si vous le restaurez avant. La suppression le retire immédiatement avec toutes ses versions, définitivement.",
  "detail.keepOnline.body": "Le renouveler le garde en ligne 30 jours de plus.",
  "detail.restore.body": "Restaurez-le avant sa suppression définitive pour le remettre en ligne.",
  "detail.noActions": "Aucune action n’est disponible dans cet état.",
  "detail.renew": "Renouveler pour 30 jours",
  "detail.pin": "Épingler",
  "detail.unpin": "Désépingler",
  "detail.pinned.body":
    "Épinglé : il reste en ligne sans expiration jusqu’à ce que vous le désépingliez.",
  "detail.pin.paid":
    "Épingler garde un artifact en ligne sans expiration. Cela fait partie de l’offre {plan}.",
  "detail.expiresNever": "Jamais, il est épinglé",
  "detail.pinnedDone": "Artifact épinglé. Il reste en ligne sans expiration.",
  "detail.unpinnedDone": "Artifact désépinglé. Il expire maintenant le {date}.",
  "detail.archive": "Archiver",
  "detail.restore": "Restaurer",
  "detail.delete": "Supprimer",
  "detail.renewed": "Artifact renouvelé. Il expire maintenant le {date}.",
  "detail.archivedDone":
    "Artifact archivé. Il sera supprimé définitivement le {date}, sauf si vous le restaurez.",
  "detail.restored": "Artifact restauré. Il expire le {date}.",
  "detail.deleted": "Artifact {name} supprimé.",
  "detail.working": "Opération en cours.",
  "detail.actionFailed.title": "L’action n’a pas abouti",
  "detail.confirmDelete.title": "Supprimer {name} ?",
  "detail.confirmDelete.body":
    "L’artifact cesse immédiatement d’être servi et ses fichiers sont supprimés. Cette action est irréversible.",
  "detail.confirmDelete.confirm": "Supprimer l’artifact",
  "detail.confirmDelete.cancel": "Le conserver",

  "accessSettings.title": "Accès",
  "accessSettings.loading": "Chargement des personnes qui peuvent ouvrir cet artifact",
  "accessSettings.loadFailed.title": "Les paramètres d’accès n’ont pas pu être chargés",
  "accessSettings.republish":
    "Publier une nouvelle version ne modifie jamais ces paramètres, donc republier n’ouvre jamais un artifact à plus de personnes. Vous seul pouvez élargir l’accès, ici, depuis la CLI ou depuis un agent que vous avez autorisé à partager.",
  "accessSettings.suspended": "Cet artifact est suspendu, son accès ne peut donc pas changer.",
  "detail.suspended.title":
    "Suspendu pour une possible violation de la Politique d’utilisation acceptable",
  "detail.suspended.body":
    "Portifact a suspendu cet artifact après examen. Il n’est servi à personne et ne peut être ni modifié ni republié. Motif : {reason}. Si vous pensez qu’il s’agit d’une erreur, écrivez à abuse@portifact.com en indiquant l’adresse de l’artifact.",
  "reason.phishing": "hameçonnage ou fausse page de connexion",
  "reason.malware": "logiciel malveillant, exploits ou minage de cryptomonnaie",
  "reason.sexual_content": "contenu sexuellement explicite",
  "reason.child_safety": "contenu sexualisant des mineurs",
  "reason.copyright": "atteinte au droit d’auteur ou au droit des marques",
  "reason.impersonation": "usurpation d’identité",
  "reason.harassment": "menaces, harcèlement ou extrémisme violent",
  "reason.private_information": "informations privées d’une personne",
  "reason.spam": "spam",
  "reason.other": "autre manquement aux règles",
  "accessSettings.mode.legend": "Qui peut ouvrir cet artifact",
  "accessSettings.mode.restricted":
    "Vous et les adresses e-mail listées ci-dessous. Chaque personne se connecte avec cette adresse avant de l’ouvrir.",
  "accessSettings.mode.authenticated":
    "Toute personne disposant du lien qui se connecte à Portifact, avec n’importe quel compte.",
  "accessSettings.mode.public": "Toute personne disposant du lien, sans se connecter.",
  "accessSettings.mode.publicFrom":
    "Disponible à partir du {date}. Les nouveaux comptes attendent {minutes} minutes avant de rendre un artifact public.",
  "accessSettings.indexable.label": "Autoriser les moteurs de recherche à le référencer",
  "accessSettings.indexable.hint": "S’applique uniquement tant que l’artifact est public.",
  "accessSettings.embeddable.label": "Autoriser d’autres sites à l’intégrer",
  "accessSettings.embeddable.hint":
    "D’autres sites peuvent l’afficher dans un cadre. S’applique uniquement tant que l’artifact est public.",
  "accessSettings.bar.label": "Afficher la barre Portifact",
  "accessSettings.bar.hint":
    "Les liens s’ouvrent dans la visionneuse de Portifact, avec la barre en haut et les commentaires à côté de l’artifact. Désactivez-la pour les applications et les pages qui ont besoin de toute la fenêtre ; le lien ouvre alors l’artifact seul.",
  "accessSettings.comments.legend": "Qui voit les commentaires",
  "accessSettings.comments.owner": "Vous seul, et chaque personne les siens",
  "accessSettings.comments.owner.hint":
    "Chaque personne voit les fils qu’elle a lancés et ceux que vous avez lancés, avec toutes leurs réponses. Vous voyez tous les fils.",
  "accessSettings.comments.everyone": "Toutes les personnes qui peuvent ouvrir l’artifact",
  "accessSettings.comments.everyone.hint":
    "Toutes les personnes qui peuvent ouvrir l’artifact voient tous les fils et peuvent y répondre.",
  "accessSettings.comments.exceptions":
    "Vous pouvez faire une exception pour une personne que vous avez ajoutée, à côté de son adresse dans Partage.",
  "accessSettings.comments.confirm.title": "Montrer tous les commentaires à tout le monde ?",
  "accessSettings.comments.confirm.body":
    "Les commentaires déjà écrits deviennent visibles par toutes les personnes qui peuvent ouvrir l’artifact, pas seulement les nouveaux.",
  "accessSettings.comments.confirm.action": "Montrer tous les commentaires",
  "accessSettings.cancel": "Annuler",
  "accessSettings.save": "Enregistrer l’accès",
  "accessSettings.saved":
    "Accès enregistré. Les personnes qui ne peuvent plus ouvrir l’artifact perdent l’accès en moins d’une minute.",
  "accessSettings.unchanged": "Rien à enregistrer : l’accès est déjà configuré ainsi.",
  "accessSettings.saveFailed.title": "L’accès n’a pas été enregistré",
  "accessSettings.conflict":
    "L’accès a été modifié ailleurs entre-temps. Les derniers paramètres sont maintenant affichés ; vérifiez-les et réessayez.",
  "accessSettings.tooNew":
    "Les nouveaux comptes peuvent rendre un artifact public {minutes} minutes après leur création, à partir du {date}.",
  "accessSettings.tooNewNoDate":
    "Les nouveaux comptes peuvent rendre un artifact public {minutes} minutes après leur création.",
  "accessSettings.readersFull":
    "Un artifact peut lister au maximum {max} personnes. Retirez-en une pour en ajouter une autre.",

  "settings.unsaved": "Modifications non enregistrées",
  "linkSettings.title": "Paramètres du lien",
  "linkSettings.description":
    "Comment le lien s’ouvre, et si les moteurs de recherche et d’autres sites peuvent l’utiliser.",
  "linkSettings.save": "Enregistrer les paramètres du lien",
  "linkSettings.saved": "Paramètres du lien enregistrés.",
  "linkSettings.unchanged": "Rien à enregistrer : le lien est déjà configuré ainsi.",
  "linkSettings.saveFailed.title": "Les paramètres du lien n’ont pas été enregistrés",
  "commentSettings.title": "Paramètres des commentaires",
  "commentSettings.mode.legend": "Commentaires sur cet artifact",
  "commentSettings.mode.open": "Ouverts",
  "commentSettings.mode.open.hint":
    "Les personnes qui peuvent ouvrir l’artifact peuvent commenter et répondre.",
  "commentSettings.mode.locked": "Verrouillés",
  "commentSettings.mode.locked.hint":
    "Les commentaires restent lisibles ; personne ne peut en ajouter.",
  "commentSettings.mode.off": "Désactivés",
  "commentSettings.mode.off.hint": "Les commentaires sont masqués et personne ne peut commenter.",
  "commentSettings.save": "Enregistrer les paramètres des commentaires",
  "commentSettings.saved": "Paramètres des commentaires enregistrés.",
  "commentSettings.unchanged": "Rien à enregistrer : les commentaires sont déjà configurés ainsi.",
  "commentSettings.saveFailed.title": "Les paramètres des commentaires n’ont pas été enregistrés",

  "readers.title": "Personnes ajoutées",
  "readers.hint":
    "Elles peuvent ouvrir l’artifact tant que l’accès est limité à vous et aux personnes que vous ajoutez.",
  "readers.count": "{count} sur {max} personnes",
  "readers.empty": "Personne pour l’instant. Ajoutez une adresse e-mail ci-dessous.",
  "readers.list": "Personnes qui peuvent ouvrir cet artifact",
  "readers.email.label": "Adresse e-mail",
  "readers.email.hint": "Elles se connectent avec cette adresse exacte pour ouvrir l’artifact.",
  "readers.add": "Ajouter",
  "readers.added": "Adresse {email} ajoutée.",
  "readers.remove": "Retirer",
  "readers.removeLabel": "Retirer {email}",
  "readers.removed": "Adresse {email} retirée. La personne perd l’accès en moins d’une minute.",
  "readers.invalid": "Saisissez une adresse e-mail, par exemple ana@example.com.",
  "readers.duplicate": "{email} figure déjà dans la liste.",
  "readers.full": "La liste est complète : un artifact peut avoir au maximum {max} personnes.",
  "readers.failed.title": "La liste n’a pas été modifiée",
  "readers.comments.label": "Commentaires visibles par {email}",
  "readers.comments.inherit.owner": "Par défaut : les siens et les vôtres",
  "readers.comments.inherit.everyone": "Par défaut : tous",
  "readers.comments.all": "Tous les commentaires",
  "readers.comments.own": "Seulement les siens et les vôtres",
  "readers.comments.hint":
    "Le menu à côté de chaque personne choisit les commentaires qu’elle voit. Il s’applique chaque fois qu’elle se connecte avec cette adresse, quel que soit le mode d’accès.",
  "readers.comments.changed": "{email} voit maintenant : {choice}.",
  "readers.comments.confirm.title": "Montrer tous les commentaires à {email} ?",
  "readers.comments.confirm.body":
    "{email} verra tous les fils de cet artifact, y compris les commentaires déjà écrits par d’autres personnes.",

  "profile.title": "Profil",
  "profile.description":
    "Qui vous êtes sur Portifact, comment vous vous connectez et où vous êtes connecté.",
  "profile.details": "Votre compte",
  "profile.sectionsNav": "Sections du profil",
  "account.name": "Nom",
  "account.email": "E-mail",
  "account.memberSince": "Membre depuis",
  "account.methods.title": "Méthodes de connexion",
  "account.methods.hint":
    "Une connexion Google ou GitHub rejoint automatiquement ce compte lorsqu’elle confirme la même adresse e-mail.",
  "account.methods.loading": "Chargement de vos méthodes de connexion",
  "account.methods.error": "Les méthodes de connexion n’ont pas pu être chargées",
  "account.methods.email": "Code par e-mail",
  "account.methods.emailDetail": "Les codes sont envoyés à {email}",
  "account.methods.connected": "Connecté le {date}",
  "provider.google": "Google",
  "provider.github": "GitHub",
  "account.sessions.title": "Sessions de navigateur",
  "account.sessions.hint":
    "Les navigateurs connectés à votre compte. Les artifacts protégés ouverts dans un navigateur se ferment en moins d’une minute après sa déconnexion.",
  "account.sessions.loading": "Chargement de vos sessions de navigateur",
  "account.sessions.error": "Les sessions de navigateur n’ont pas pu être chargées",
  "account.sessions.caption": "Navigateurs connectés à votre compte",
  "account.sessions.column.browser": "Navigateur",
  "account.sessions.column.lastActive": "Dernière activité",
  "account.sessions.column.expires": "Déconnexion le",
  "account.sessions.this": "Ce navigateur",
  "account.sessions.device": "{browser} sur {system}",
  "account.sessions.unknown": "Navigateur inconnu",
  "account.sessions.signOutOthers": "Déconnecter les autres sessions",
  "account.sessions.onlyThis": "Ce navigateur est le seul connecté.",
  "account.sessions.confirm.title": "Déconnecter les autres sessions ?",
  "account.sessions.confirm.body":
    "Tous les autres navigateurs sont déconnectés immédiatement. Les apps que vous avez connectées, comme la CLI et vos agents, continuent de fonctionner jusqu’à ce que vous les déconnectiez ci-dessous.",
  "account.sessions.confirm.confirm": "Déconnecter les autres",
  "account.sessions.signedOut":
    "{count, plural, =0 {Aucun autre navigateur n’était connecté.} one {# autre session déconnectée.} other {# autres sessions déconnectées.}}",
  "apps.title": "Apps",
  "apps.description":
    "La CLI et les agents qui peuvent agir en votre nom. Déconnectez-les quand vous le souhaitez.",
  "apps.connect.title": "Connecter une app",
  "apps.connect.hint":
    "Chaque app demande votre accord dans le navigateur la première fois, puis apparaît ici.",
  "apps.connect.cli": "Se connecter depuis la CLI",
  "apps.connect.mcp": "URL du serveur MCP pour votre agent",
  "apps.connect.copyCommand": "Copier la commande",
  "apps.connect.copyUrl": "Copier l’URL",
  "account.apps.title": "Apps connectées",
  "account.apps.hint":
    "La CLI et les agents que vous avez connectés via MCP. Chacun peut faire ce que ses détails indiquent jusqu’à ce que vous le déconnectiez.",
  "account.apps.loading": "Chargement de vos apps connectées",
  "account.apps.error": "Les apps connectées n’ont pas pu être chargées",
  "account.apps.empty.title": "Aucune app connectée",
  "account.apps.empty.body":
    "Exécutez portifact login dans un terminal, ou ajoutez le serveur MCP de Portifact à votre agent. Chacun demande votre accord ici, puis apparaît dans cette liste jusqu’à ce que vous le déconnectiez.",
  "account.apps.unnamed": "App sans nom",
  "account.apps.firstParty": "Conçue par Portifact",
  "account.apps.thirdParty": "App tierce",
  "account.apps.resources": "Se connecte à",
  "account.apps.connectsTo": "Se connecte à {resources}",
  "account.apps.access.full": "Accès complet",
  "account.apps.access.readOnly": "Lecture seule",
  "account.apps.access.partial":
    "{count, plural, one {# autorisation sur {total}} other {# autorisations sur {total}}}",
  "account.apps.lastUsed": "Dernière utilisation {when}",
  "account.apps.expiresOn": "L’accès expire le {date}",
  "account.apps.details": "Détails",
  "account.apps.detailsOf": "Détails de {name}",
  "account.apps.resource.api": "API Portifact",
  "account.apps.resource.mcp": "MCP Portifact",
  "account.apps.scopes": "Autorisée à",
  "account.apps.approved": "Approuvée le",
  "account.apps.lastIssued": "Dernier jeton émis",
  "account.apps.expires": "L’accès expire",
  "account.apps.noExpiry": "N’expire pas",
  "account.apps.disconnect": "Déconnecter",
  "account.apps.disconnectLabel": "Déconnecter {name}",
  "account.apps.confirm.title": "Déconnecter {name} ?",
  "account.apps.confirm.body":
    "Elle perd l’accès immédiatement et devra redemander votre accord pour se reconnecter.",
  "account.apps.disconnected": "{name} déconnectée.",
  "settings.title": "Paramètres",
  "settings.sectionsNav": "Sections des paramètres",
  "settings.description":
    "Votre langue, l’apparence de Portifact, la configuration initiale des nouveaux artifacts, les e-mails que vous recevez, vos données et la suppression de votre compte.",
  "settings.appearance.title": "Apparence",
  "settings.appearance.hint":
    "L’apparence de Portifact dans ce navigateur. Système suit le réglage de votre appareil. Les artifacts gardent l’apparence que leurs créateurs leur ont donnée.",
  "settings.defaults.title": "Valeurs par défaut des nouveaux artifacts",
  "settings.defaults.hint":
    "Chaque artifact que vous créez à partir de maintenant démarre ainsi, que vous publiiez depuis le tableau de bord, la CLI ou un agent. Les artifacts existants gardent leurs propres paramètres ; modifiez-les sur la page de chaque artifact.",
  "settings.defaults.loading": "Chargement de vos paramètres",
  "settings.defaults.error": "Vos paramètres n’ont pas pu être chargés",
  "settings.defaults.access": "Qui peut ouvrir un nouvel artifact",
  "settings.defaults.access.restricted":
    "Vous seul, jusqu’à ce que vous ajoutiez des personnes. C’est le choix le plus sûr.",
  "settings.defaults.comments": "Commentaires sur un nouvel artifact",
  "settings.defaults.comments.off": "Désactivés",
  "settings.defaults.comments.off.hint":
    "Personne ne peut commenter tant que vous n’activez pas les commentaires.",
  "settings.defaults.comments.open": "Ouverts",
  "settings.defaults.comments.open.hint":
    "Toutes les personnes qui peuvent ouvrir l’artifact peuvent commenter.",
  "settings.defaults.bar.label": "Afficher la barre Portifact sur les nouveaux artifacts",
  "settings.defaults.save": "Enregistrer les valeurs par défaut",
  "settings.defaults.saved":
    "Valeurs par défaut enregistrées. Les nouveaux artifacts démarrent ainsi.",
  "settings.defaults.unchanged":
    "Rien à enregistrer : vos valeurs par défaut sont déjà configurées ainsi.",
  "settings.defaults.failed": "Vos valeurs par défaut n’ont pas été enregistrées",
  "settings.notices.title": "Avis par e-mail",
  "settings.notices.hint":
    "Les artifacts cessent d’être servis 30 jours après leur dernière publication ou leur dernier renouvellement. Portifact peut vous le rappeler quelques jours avant.",
  "settings.notices.expiry.label": "M’envoyer un e-mail avant l’expiration de mes artifacts",
  "settings.notices.expiry.hint":
    "Au plus un e-mail par jour, listant chaque artifact qui expire dans les 3 jours, avec un lien pour renouveler chacun.",
  "settings.notices.save": "Enregistrer les avis par e-mail",
  "settings.notices.saved": "Avis par e-mail enregistrés.",
  "settings.notices.unchanged":
    "Rien à enregistrer : vos avis par e-mail sont déjà configurés ainsi.",
  "settings.notices.failed": "Vos avis par e-mail n’ont pas été enregistrés",
  "settings.notices.comments.label":
    "M’envoyer un e-mail en cas de nouveaux commentaires ou relectures",
  "settings.notices.comments.hint":
    "Au plus un e-mail toutes les 10 minutes, avec le nombre de nouveaux fils, réponses et résolutions sur chaque artifact, jamais ce qui a été écrit. Seulement pour les artifacts dont le propriétaire a un plan avec les avis de commentaires. Le même réglage couvre les e-mails de relecture : quand quelqu’un demande votre relecture, et quand une version que vous gérez est approuvée ou fait l’objet de demandes de modifications.",
  "commentNotices.label": "M’envoyer un e-mail en cas de nouveaux commentaires sur cet artifact",
  "commentNotices.hint":
    "Au plus un e-mail toutes les 10 minutes, avec des nombres seulement. Désactivez tous les e-mails de commentaires dans vos paramètres.",
  "commentNotices.muted": "E-mails de commentaires désactivés pour cet artifact.",
  "commentNotices.unmuted": "E-mails de commentaires activés pour cet artifact.",
  "commentNotices.failed": "Votre choix n’a pas été enregistré",
  "commentNotices.planRequired":
    "Les avis par e-mail des nouveaux commentaires font partie du plan {plan}.",
  "settings.danger.title": "Zone de danger",
  "settings.danger.hint": "Ces actions sont irréversibles.",
  "account.data.title": "Vos données",
  "account.data.hint":
    "Téléchargez tout ce que contient votre compte au format JSON : votre profil, vos artifacts avec leur accès, leurs versions et leurs listes de fichiers, et vos commentaires. Chaque version indique un lien qui télécharge ses fichiers.",
  "account.data.download": "Télécharger vos données",
  "account.delete.title": "Supprimer le compte",
  "account.delete.hint":
    "Supprimer votre compte supprime vos artifacts, sessions, apps et méthodes de connexion, ainsi que vos commentaires sur les artifacts d’autres personnes. Un commentaire auquel quelqu’un a répondu est remplacé par la mention « Message supprimé ». Les adresses des artifacts ne sont jamais attribuées à quelqu’un d’autre. Cette action est irréversible, alors téléchargez d’abord vos données.",
  "account.delete.confirmLabel": "Saisissez votre e-mail pour confirmer",
  "account.delete.confirmHint": "Saisissez {email}",
  "account.delete.mismatch": "Saisissez exactement l’e-mail de votre compte pour confirmer.",
  "account.delete.button": "Supprimer le compte",
  "account.delete.dialog.title": "Supprimer définitivement votre compte ?",
  "account.delete.dialog.body":
    "Vos artifacts cessent immédiatement de fonctionner et tout ce qui est listé ci-dessus est supprimé. Vous serez déconnecté.",
  "account.delete.dialog.confirm": "Supprimer mon compte",
  "account.delete.reauth.title": "Reconnectez-vous pour supprimer votre compte",
  "account.delete.reauth.body":
    "Pour votre sécurité, la suppression nécessite une connexion datant de moins de 10 minutes. Reconnectez-vous, puis revenez ici.",
  "account.delete.reauth.action": "Se reconnecter",
  "account.delete.done": "Votre compte a été supprimé.",
  "account.actionFailed.title": "L’action n’a pas abouti",
  "accessLog.title": "Qui l’a ouvert",
  "accessLog.hint":
    "Les visiteurs connectés qui ont ouvert cet artifact au cours des derniers jours ({days, plural, one {# jour} other {# jours}}), du plus récent au plus ancien, une entrée par visiteur toutes les 30 minutes. Vous seul voyez cette liste. Seuls les artifacts limités aux personnes que vous listez enregistrent les ouvertures, vos propres visites ne sont pas enregistrées, et certaines ouvertures peuvent manquer.",
  "accessLog.loading": "Chargement des personnes qui ont ouvert l’artifact",
  "accessLog.error.title": "Le journal d’accès n’a pas pu être chargé",
  "accessLog.empty.title": "Aucun visiteur pour l’instant",
  "accessLog.empty.body":
    "Personne de connecté n’a ouvert cet artifact au cours des derniers jours ({days, plural, one {# jour} other {# jours}}).",
  "accessLog.caption": "Ouvertures de cet artifact par des visiteurs connectés",
  "accessLog.column.opened": "Ouvert",
  "accessLog.column.visitor": "Visiteur",
  "accessLog.loadMore": "Afficher plus",
  "accessLog.export.hint":
    "Les exports contiennent toutes les entrées des derniers jours ({days, plural, one {# jour} other {# jours}}), pas seulement celles affichées.",
  "accessLog.export.csv": "Exporter en CSV",
  "accessLog.export.json": "Exporter en JSON",
  "accessLog.export.doneCsv": "Le journal d’accès a été exporté en CSV.",
  "accessLog.export.doneJson": "Le journal d’accès a été exporté en JSON.",
  "accessLog.export.failed": "Le journal d’accès n’a pas pu être exporté",

  "analytics.title": "Statistiques",
  "analytics.hint":
    "Les pages vues par jour (UTC) et, pour les artifacts limités aux personnes que vous listez, combien d’entre elles l’ont ouvert. Uniquement des comptes : personne n’est identifié ici.",
  "analytics.loading": "Chargement des statistiques de l’artifact",
  "analytics.error.title": "Les statistiques n’ont pas pu être chargées",
  "analytics.planRequired":
    "Les statistiques par artifact et un journal d’accès d’un an font partie de l’offre {plan}.",
  "analytics.range.label": "Période",
  "analytics.range.days": "Derniers jours ({count, plural, one {# jour} other {# jours}})",
  "analytics.total.views": "Vues",
  "analytics.total.signedIn": "Vues de visiteurs connectés",
  "analytics.total.visitors": "Visiteurs connectés distincts",
  "analytics.visitors.notKept":
    "Comptés seulement pour les artifacts limités aux personnes que vous listez",
  "analytics.chart.label": "Vues par jour",
  "analytics.chart.summary":
    "Vues : {views} sur {days, plural, one {# jour} other {# jours}}. Jour le plus actif : {busiest}, avec {most}.",
  "analytics.chart.summaryEmpty": "Aucune vue sur {days, plural, one {# jour} other {# jours}}.",
  "analytics.chart.day": "{day}. Vues : {views}. Connectés : {signedIn}.",
  "analytics.chart.dayWithVisitors":
    "{day}. Vues : {views}. Connectés : {signedIn}. Visiteurs distincts : {visitors}.",
  "analytics.chart.keyboard":
    "Placez le focus sur le graphique et utilisez les flèches pour lire chaque jour.",
  "analytics.table.show": "Afficher les chiffres dans un tableau",
  "analytics.table.caption": "Vues par jour de cet artifact",
  "analytics.column.day": "Jour",
  "analytics.column.views": "Vues",
  "analytics.column.signedIn": "Connectés",
  "analytics.column.visitors": "Visiteurs distincts",
  "analytics.note":
    "Conservées {days, plural, one {# jour} other {# jours}}. Vos propres visites et les aperçus de liens ne sont pas comptés, mais les navigateurs automatisés peuvent l’être : ces chiffres sont un indicateur, pas un audit.",

  "usage.title": "Utilisation",
  "usage.description":
    "Vos quotas et ce que vos artifacts ont servi ce mois-ci. Le trafic est compté toutes les quelques secondes, il peut donc avoir un léger retard.",
  "usage.meterPercent": "{used} sur {limit} ({percent})",
  "usage.plan.section": "Formule",
  "usage.plan.hint": "Votre formule fixe les limites de cette page.",
  "usage.plan.name": "Formule actuelle",
  "usage.plan.free": "Free",
  "usage.plan.pro": "Pro",
  "usage.plan.team": "Team",
  "usage.plan.enterprise": "Enterprise",
  "usage.plan.seats": "Places",
  "usage.plan.until": "Valable jusqu’au",
  "usage.traffic.section": "Trafic ce mois-ci",
  "usage.traffic.hint":
    "Compté pour tout votre compte, sur l’ensemble de vos artifacts. Atteindre l’une des limites suspend tous les artifacts jusqu’à la réinitialisation.",
  "usage.trafficRequests.hint":
    "Chaque page, fichier et téléchargement auxquels vos artifacts ont répondu.",
  "usage.trafficBytes.hint": "La taille de tout ce que vos artifacts ont envoyé aux visiteurs.",
  "usage.storage.section": "Artifacts et stockage",
  "usage.activeArtifacts.hint":
    "Les artifacts actuellement en ligne. Les artifacts archivés et supprimés ne comptent pas.",
  "usage.storage.hint":
    "Les fichiers uniques que vous conservez dans toutes les versions, comptés une seule fois. Les envois en cours comptent pendant leur déroulement.",
  "usage.publishing.section": "Publication",
  "usage.publishing.hint":
    "Les limites de rythme de publication. Les fenêtres de 24 heures sont glissantes, elles se libèrent donc progressivement.",
  "usage.publishes.hint": "Les versions que vous avez publiées ou rétablies.",
  "usage.newFiles": "Nouveaux fichiers, 24 dernières heures",
  "usage.newFiles.hint":
    "Les fichiers que vous n’aviez jamais envoyés ; ceux que vous conservez déjà ne comptent pas.",
  "usage.newBytes": "Nouvelles données, 24 dernières heures",
  "usage.newBytes.hint": "La taille de ces nouveaux fichiers.",
  "usage.newObjects": "Nouveaux fichiers ce mois-ci",
  "usage.newObjects.hint": "Réinitialisé le {date}.",
  "usage.openUploads": "Envois en cours",
  "usage.openUploads.hint": "Publications commencées mais pas encore terminées.",
  "usage.versions.section": "Limites de chaque version",
  "usage.versions.hint": "Les mêmes pour chaque artifact.",
  "usage.versions.publishedBytes": "Taille publiée",
  "usage.versions.files": "Fichiers",
  "usage.versions.documentBytes": "Document Markdown ou texte",
  "usage.public.title": "Les artifacts publics seront bientôt disponibles",
  "usage.public.body":
    "Les nouveaux comptes peuvent rendre un artifact public {minutes} minutes après leur création. Vous le pourrez à partir du {date}.",
  "usage.loading": "Chargement de votre utilisation",
  "usage.error": "L’utilisation n’a pas pu être chargée",
  "usage.meter": "{used} sur {limit}",
  "usage.activeArtifacts": "Artifacts actifs",
  "usage.storage": "Stockage",
  "usage.publishes": "Publications, 24 dernières heures",
  "usage.trafficRequests": "Requêtes servies ce mois-ci",
  "usage.trafficBytes": "Données servies ce mois-ci",
  "usage.trafficResets": "Réinitialisation du trafic le",
  "usage.blocks": "Bloqué actuellement",
  "usage.lifts": "{message} Fin du blocage le {date}.",
  "usage.traffic.title": "Vos artifacts ont épuisé le trafic de ce mois-ci",
  "usage.traffic.body":
    "Vos artifacts ont servi 1 million de requêtes ou 25 Go ce mois-ci, les visiteurs reçoivent donc une erreur (HTTP 429) sur tous jusqu’au {date}. Vos autres quotas ne sont pas affectés : vous pouvez toujours publier, modifier l’accès et gérer vos artifacts. Les artifacts des autres personnes continuent de fonctionner.",
  "usage.traffic.link": "Voir votre utilisation",
  "usage.nearLimit": "Proche de la limite",
  "usage.atLimit": "Limite atteinte",
  "account.cancel": "Annuler",

  "scope.artifacts:read": "Voir vos artifacts, leurs paramètres et leurs versions",
  "scope.artifacts:write": "Publier et mettre à jour des artifacts",
  "scope.artifacts:share": "Modifier qui peut ouvrir vos artifacts",
  "scope.artifacts:delete": "Archiver et supprimer vos artifacts",
  "scope.annotations:read": "Lire les commentaires sur vos artifacts",
  "scope.annotations:write": "Écrire des commentaires et y répondre en votre nom",
  "scope.annotations:moderate": "Résoudre, masquer et supprimer les commentaires sur vos artifacts",
  "scope.credentials:manage": "Voir les apps connectées à votre compte et les déconnecter",
  "scope.offline_access": "Rester connectée jusqu’à ce que vous la déconnectiez",
  "scope.unknown": "Utiliser l’autorisation {name}",

  "list.publish": "Publier",

  "content.title": "Contenu",
  "content.publishVersion": "Publier une nouvelle version",
  "content.edit": "Modifier le document",
  "content.history": "Historique des versions",

  "publish.title": "Publier",
  "publish.description":
    "Envoyez un fichier HTML, un dossier, un ZIP ou un document. Rien n’est envoyé avant que vous l’ayez vérifié.",
  "publish.versionTitle": "Nouvelle version de {name}",
  "publish.versionDescription":
    "Les fichiers que vous choisissez remplacent la version actuelle. Les visiteurs continuent de la voir jusqu’à la publication de la nouvelle.",
  "publish.loading": "Chargement de l’artifact",
  "publish.unavailable":
    "Cet artifact ne peut pas recevoir de nouvelle version dans son état actuel. Restaurez-le d’abord s’il est archivé.",
  "publish.step.choose": "Choisir ce que vous publiez",
  "publish.steps.label": "Étapes de publication",
  "publish.steps.choose": "Choisir",
  "publish.steps.review": "Vérifier",
  "publish.steps.publish": "Publier",
  "steps.done": "terminé",
  "steps.upcoming": "pas commencé",
  "publish.drop.site": "Glissez des fichiers, un dossier ou un ZIP ici, ou choisissez-les",
  "publish.drop.document": "Glissez un document ici, ou choisissez-le",
  "publish.drop.active": "Déposez pour choisir ces fichiers",
  "publish.done.review": "Relire et commenter",
  "publish.type.legend": "Type",
  "publish.type.site": "Un fichier HTML, un dossier de fichiers statiques ou un ZIP de celui-ci.",
  "publish.type.markdown": "Un document Markdown, rendu par Portifact.",
  "publish.type.text": "Un document en texte brut, affiché exactement tel qu’il est écrit.",
  "publish.name.label": "Nom",
  "publish.name.hint":
    "Affiché dans votre liste et comme titre de la page. Par défaut, le nom du fichier ou du dossier.",
  "publish.entry.label": "Page d’entrée",
  "publish.entry.hint":
    "La page que les visiteurs ouvrent en premier. Un fichier HTML seul devient toujours cette page.",
  "publish.pick.files": "Choisir des fichiers",
  "publish.pick.filesHint": "Une page HTML, ou plusieurs fichiers publiés côte à côte.",
  "publish.pick.folder": "Choisir un dossier",
  "publish.pick.folderHint": "Tous ses fichiers, en conservant sa structure.",
  "publish.pick.zip": "Choisir un fichier ZIP",
  "publish.pick.zipHint":
    "Un ZIP de votre site. Utilisez-le quand votre navigateur ne peut pas choisir de dossiers.",
  "publish.pick.zipOnly":
    "Ce navigateur ne peut pas choisir de dossiers. Placez le dossier dans un fichier ZIP et choisissez celui-ci.",
  "publish.pick.document": "Choisir un fichier",
  "publish.pick.documentHint": "Un fichier texte UTF-8 de 5 Mo au maximum.",
  "publish.text.label": "Ou écrivez-le ici",
  "publish.text.hint": "Collez ou saisissez le document. Il est publié sous le nom {file}.",
  "publish.text.use": "Vérifier ce texte",
  "publish.text.required": "Écrivez ou collez d’abord le document.",
  "publish.untitled": "Sans titre",
  "publish.building": "Lecture et vérification des fichiers",
  "publish.buildingProgress": "{done} sur {total}",
  "publish.cancel": "Annuler",
  "publish.buildCancelled": "Lecture des fichiers interrompue. Rien n’a été envoyé.",
  "publish.buildFailed.title": "Ces fichiers ne peuvent pas être publiés",
  "publish.step.review": "Vérifier avant de publier",
  "publish.review.summary": "Résumé",
  "publish.review.files": "Fichiers",
  "publish.review.filesValue": "{count, plural, one {# fichier} other {# fichiers}}, {size}",
  "publish.review.entry": "Page d’entrée",
  "publish.review.access": "Qui peut l’ouvrir",
  "publish.review.accessNew":
    "Vous seul. Après la publication, vous pouvez le partager depuis la page de l’artifact.",
  "publish.review.accessVersion":
    "{mode}. Publier une nouvelle version ne modifie jamais qui peut l’ouvrir.",
  "publish.review.caption": "Fichiers à publier",
  "publish.review.column.path": "Chemin",
  "publish.review.column.size": "Taille",
  "publish.review.column.type": "Type de contenu",
  "publish.review.excluded": "{count, plural, one {# entrée exclue} other {# entrées exclues}}",
  "publish.review.excludedHint":
    "Elles ne sont jamais publiées, comme avec la CLI. Retirez-les de la source si vous pensez que l’une d’elles devrait l’être.",
  "publish.reason.default": "contrôle de version, dépendances ou caches",
  "publish.reason.secret": "peut contenir des secrets",
  "publish.review.publish": "Publier",
  "publish.review.back": "Choisir d’autres fichiers",
  "publish.phase.preparing": "Préparation de l’envoi",
  "publish.phase.uploading": "Envoi",
  "publish.phase.committing": "Vérification des fichiers et publication",
  "publish.uploadProgress": "{sent} sur {total}, {done} fichiers sur {count}",
  "publish.uploadStarted":
    "{count, plural, =0 {Tous les fichiers sont déjà stockés. Publication.} one {Envoi de # nouveau fichier.} other {Envoi de # nouveaux fichiers.}}",
  "publish.uploadCancelled": "Envoi annulé. Rien n’a été publié.",
  "publish.failed.title": "La publication n’a pas abouti",
  "publish.resume": "Reprendre l’envoi",
  "publish.startOver": "Recommencer",
  "publish.done.title": "Version {number} publiée",
  "publish.done.body": "Elle est en ligne à {url} et expire le {date}.",
  "publish.done.pinned": "Elle est en ligne à {url}. Elle est épinglée, donc elle n’expire pas.",
  "publish.done.open": "Ouvrir la page de l’artifact",
  "publish.done.another": "Publier autre chose",
  "publish.announce.done": "Version {number} de {name} publiée.",

  "manifest.empty":
    "Il n’y a rien à publier : tous les fichiers ont été exclus ou la source est vide.",
  "manifest.too_many_files": "Une version peut contenir au maximum {detail} fichiers.",
  "manifest.too_large": "Une version peut contenir au maximum {detail}.",
  "manifest.invalid_path": "Un chemin de fichier n’est pas autorisé : {detail}",
  "manifest.missing_entry":
    "La page d’entrée {detail} ne fait pas partie des fichiers. Changez la page d’entrée ou ajoutez-la.",
  "manifest.document_files": "Un document est un seul fichier. Choisissez un fichier.",
  "manifest.document_too_large": "Les documents sont limités à 5 Mo.",
  "manifest.not_text":
    "Ce n’est pas un fichier texte UTF-8, il ne peut donc pas être publié comme document.",
  "manifest.not_zip": "Ce n’est pas un fichier ZIP, ou il est endommagé.",
  "manifest.unsupported":
    "Ce ZIP utilise un format que Portifact ne lit pas (ZIP64, archives fractionnées ou compression inhabituelle). Recréez-le avec les réglages standard.",
  "manifest.encrypted": "{detail} est chiffré. Utilisez un ZIP sans mot de passe.",
  "manifest.symlink":
    "{detail} est un lien. Les liens ne sont pas publiés ; remplacez-le par le fichier lui-même.",
  "manifest.special_file": "{detail} n’est pas un fichier ordinaire.",
  "manifest.corrupt":
    "Le ZIP est endommagé : {detail} ne se décompresse pas comme l’archive l’indique.",
  "manifest.unexpected": "Les fichiers n’ont pas pu être lus. Réessayez.",

  "upload.integrity":
    "{path} n’est pas arrivé intact : le stockage l’a refusé à cause de sa taille ou de sa somme de contrôle. Recommencez pour relire les fichiers.",
  "upload.storage": "Le stockage a refusé {path}. Reprenez l’envoi pour réessayer.",
  "upload.network": "Le stockage est injoignable. Vérifiez votre connexion, puis reprenez l’envoi.",
  "upload.missing": "L’envoi demande un fichier que cette page n’a pas. Recommencez.",
  "publish.error.quota_exceeded":
    "Cela dépasse les limites de votre compte : artifacts actifs, stockage, fichiers ou publications par jour. Archivez ou supprimez quelque chose, ou réessayez plus tard.",
  "publish.error.version_conflict":
    "Une version plus récente a été publiée entre-temps. Recommencez pour que vos modifications s’appuient dessus.",
  "publish.error.upload_incomplete":
    "Tous les fichiers ne sont pas arrivés intacts dans le stockage. Reprenez l’envoi pour transmettre ce qui manque.",
  "publish.error.invalid_input":
    "Portifact a refusé ces fichiers. Vérifiez les chemins, les tailles et le type, puis recommencez.",

  "editor.title": "Modifier {name}",
  "editor.description":
    "Enregistrer publie une nouvelle version. Les visiteurs continuent de voir la version actuelle jusque-là.",
  "editor.loading": "Chargement du document",
  "editor.loadFailed.title": "Le document n’a pas pu être chargé",
  "editor.notDocument":
    "Seuls les artifacts Markdown et texte peuvent être modifiés ici. Publiez plutôt une nouvelle version.",
  "editor.unavailable":
    "Cet artifact ne peut pas recevoir de nouvelle version dans son état actuel. Restaurez-le d’abord s’il est archivé.",
  "editor.source.markdown": "Markdown",
  "editor.source.text": "Texte",
  "editor.source.hint": "{path}, 5 Mo au maximum.",
  "editor.preview": "Aperçu",
  "editor.previewTitle": "Aperçu de {name}",
  "editor.previewHeading": "Aperçu",
  "editor.previewHint":
    "Rendu par Portifact exactement comme il sera publié. Les liens et les images qu’il contient ne s’ouvrent pas ici.",
  "editor.previewEmpty": "Choisissez Aperçu pour voir le document rendu.",
  "editor.previewStale": "Le texte a changé depuis cet aperçu.",
  "editor.previewFailed.title": "L’aperçu n’a pas pu être rendu",
  "editor.save": "Enregistrer et publier",
  "editor.unchanged": "Rien à enregistrer : le document n’a pas changé.",
  "editor.saving": "Publication d’une nouvelle version.",
  "editor.saved": "Enregistré comme version {number}.",
  "editor.saveFailed.title": "Le document n’a pas été enregistré",
  "editor.reload": "Charger la dernière version",
  "editor.tooLarge": "Les documents sont limités à 5 Mo.",

  "history.title": "Historique de {name}",
  "history.versionsTitle": "Versions conservées",
  "history.description": "Les versions que vous pouvez encore télécharger ou rétablir.",
  "history.retention":
    "L’offre du propriétaire conserve {count, plural, one {# version précédente} other {# versions précédentes}} pendant {days, plural, one {# jour} other {# jours}} après le remplacement de chacune.",
  "compare.title": "Comparer des versions",
  "compare.description": "Choisissez deux versions pour voir quels fichiers ont changé et comment.",
  "compare.paid":
    "Comparer des versions et en conserver davantage plus longtemps font partie de l’offre {plan}.",
  "compare.needTwo": "Publiez une autre version pour la comparer à celle-ci.",
  "compare.from": "Version antérieure",
  "compare.to": "Version ultérieure",
  "compare.currentOption": "Version {number} (actuelle)",
  "compare.submit": "Comparer",
  "compare.loading": "Comparaison des versions",
  "compare.error.title": "Les versions n’ont pas pu être comparées",
  "compare.summary":
    "Version {from} comparée à la version {to}. Ajoutés : {added}. Supprimés : {removed}. Modifiés : {changed}. Inchangés : {unchanged}.",
  "compare.none": "Les deux versions ont les mêmes fichiers.",
  "compare.caption": "Fichiers qui diffèrent entre la version {from} et la version {to}",
  "compare.column.file": "Fichier",
  "compare.column.change": "Modification",
  "compare.column.size": "Taille",
  "compare.change.added": "Ajouté",
  "compare.change.removed": "Supprimé",
  "compare.change.changed": "Modifié",
  "compare.source": "Source",
  "compare.sizes": "{before} avant, {after} après",
  "compare.noFile": "aucun",
  "compare.show": "Voir les modifications",
  "compare.showLabel": "Voir les modifications de {path}",
  "compare.loadMore": "Voir plus de fichiers",
  "diff.title": "Modifications de {path}",
  "diff.close": "Masquer les modifications",
  "diff.loading": "Chargement des modifications",
  "diff.counts": "Lignes ajoutées : {added}. Lignes supprimées : {removed}.",
  "diff.layout": "Disposition",
  "diff.unified": "Unifiée",
  "diff.split": "Côte à côte",
  "diff.caption": "Modifications de {path} de la version {from} à la version {to}",
  "diff.column.before": "Avant",
  "diff.column.after": "Après",
  "diff.column.change": "Modification",
  "diff.column.text": "Texte",
  "diff.added": "Ajoutée",
  "diff.removed": "Supprimée",
  "diff.unchanged": "Inchangée",
  "diff.noNewline": "pas de saut de ligne à la fin",
  "diff.hunk": "À partir de la ligne {before} avant et de la ligne {after} après",
  "diff.more": "Voir plus de modifications",
  "diff.status.identical": "Ce fichier est identique dans les deux versions.",
  "diff.status.binary": "Ce fichier n’est pas du texte, seule sa taille est donc comparée.",
  "diff.status.too_large": "Ce fichier est trop volumineux pour être comparé ligne par ligne.",
  "diff.status.too_many_lines": "Ce fichier a trop de lignes pour être comparé ligne par ligne.",
  "diff.status.too_many_changes": "Ce fichier a trop changé pour être affiché ligne par ligne.",
  "history.loading": "Chargement des versions",
  "history.error.title": "Les versions n’ont pas pu être chargées",
  "history.caption": "Versions, de la plus récente à la plus ancienne",
  "history.column.version": "Version",
  "history.column.published": "Publiée",
  "history.column.files": "Fichiers",
  "history.column.kept": "Conservée jusqu’au",
  "history.column.actions": "Actions",
  "history.version": "Version {number}",
  "history.current": "Actuelle",
  "history.whileCurrent": "Tant qu’elle est actuelle",
  "history.files": "{count, plural, one {# fichier} other {# fichiers}}, {size}",
  "history.sources": "{count, plural, one {# source} other {# sources}}, {size}",
  "history.empty.title": "Aucune version pour l’instant",
  "history.empty.body": "Publiez la première version et elle apparaîtra ici.",
  "history.loadMore": "Charger les versions plus anciennes",
  "history.download": "Télécharger les fichiers",
  "history.downloadLabel": "Télécharger les fichiers de la version {number}",
  "history.downloadSources": "Télécharger les sources",
  "history.downloadSourcesLabel": "Télécharger les sources de la version {number}",
  "history.downloading": "Téléchargement et vérification des fichiers.",
  "history.downloaded": "{file} est prêt.",
  "history.downloadFailed.title": "Le téléchargement n’a pas abouti",
  "download.integrity":
    "{path} ne correspondait pas à sa somme de contrôle, il n’a donc pas été enregistré. Réessayez.",
  "download.network": "{path} n’a pas pu être téléchargé. Réessayez.",
  "history.rollback": "Rétablir",
  "history.rollbackLabel": "Rétablir la version {number}",
  "history.rollbackUnavailable": "Le rétablissement est disponible tant que l’artifact est actif.",
  "history.confirmRollback.title": "Rétablir la version {number} ?",
  "history.confirmRollback.body":
    "Ses fichiers sont publiés de nouveau comme une nouvelle version, et l’expiration de 30 jours repart de zéro. Les personnes qui peuvent ouvrir l’artifact ne changent pas.",
  "history.confirmRollback.confirm": "Rétablir",
  "history.rolledBack": "La version {from} est publiée de nouveau comme version {number}.",
  "history.actionFailed.title": "L’action n’a pas abouti",
  "history.archive.title": "Archivé",
  "history.archive.body":
    "Cet artifact est archivé et personne ne peut l’ouvrir. Il sera supprimé définitivement le {date}, sauf si vous le restaurez. Vous pouvez toujours télécharger ses versions.",
  "history.archive.noDate":
    "Il est supprimé définitivement au bout de six mois, sauf si vous le restaurez.",
  "history.conversations.title": "Conversations sur les versions précédentes",
  "history.conversations.description":
    "Les fils de commentaires restent attachés à la version sur laquelle ils ont été écrits. Vous seul voyez les anciens, ici et en lecture seule ; les visiteurs voient les fils de la version actuelle.",
  "history.conversations.loading": "Chargement des conversations",
  "history.conversations.error": "Les conversations n’ont pas pu être chargées",
  "history.conversations.refreshFailed": "Les conversations n’ont pas pu être actualisées",
  "history.conversations.empty": "Aucune version précédente n’a de fils de commentaires.",
  "history.conversations.counts":
    "{count, plural, one {# fil} other {# fils}}, {open, plural, =0 {aucun ouvert} one {# ouvert} other {# ouverts}}",
  "history.conversations.version": "Version {number} : {counts}",
  "history.conversations.unlisted": "Versions qui ne sont plus listées : {counts}",
  "review.open": "Relire et commenter",
  "viewer.loading": "Ouverture de l’artifact",
  "viewer.unavailable.title": "Cet artifact ne peut pas être ouvert",
  "viewer.unavailable.body":
    "Il n’existe pas, n’est pas disponible pour le moment, ou votre compte ne peut pas l’ouvrir.",
  "viewer.failed.title": "L’artifact n’a pas pu être ouvert",
  "viewer.dashboard": "Vos artifacts",
  "viewer.skipLink": "Aller à l’artifact",
  "viewer.brand": "Portifact",
  "viewer.version": "Version {number}",
  "viewer.withoutBar": "Ouvrir sans la barre Portifact",
  "viewer.copyLink": "Copier le lien",
  "viewer.copied": "Lien copié.",
  "viewer.copyFailed": "Le lien n’a pas pu être copié : {url}",
  "viewer.manage": "Gérer",
  "viewer.comments": "Commentaires",
  "viewer.comments.open": "{count, plural, one {(# fil ouvert)} other {(# fils ouverts)}}",
  "viewer.closeComments": "Fermer les commentaires",
  "viewer.more": "Plus",
  "viewer.account": "Votre compte",
  "viewer.signIn": "Se connecter",
  "viewer.frame.label": "Artifact",
  "viewer.frame.title": "{name}, publié avec Portifact",
  "viewer.anonymous.body":
    "Connectez-vous pour lire les commentaires sur cet artifact et ajouter les vôtres. Vous revenez sur cette page après la connexion.",
  "viewer.anonymous.signIn": "Se connecter pour commenter",
  "review.startFailed.title": "Les commentaires n’ont pas pu être reliés à l’artifact",
  "review.frame.connecting": "Connexion à la page",
  "review.frame.isolated":
    "L’artifact s’exécute sur son propre site et ne peut voir ni votre compte, ni votre e-mail, ni les commentaires des autres personnes. Sélectionner quelque chose dedans ne publie jamais de commentaire : vous écrivez et confirmez chacun ici.",
  "review.status.unavailable.title":
    "Les outils de relecture ne sont pas disponibles dans ce navigateur",
  "review.status.unavailable.body":
    "Ce navigateur bloque le cookie dont la relecture a besoin dans le cadre. Vous pouvez toujours laisser des commentaires généraux sur la page.",
  "review.status.silent.title": "La page ne répond pas aux outils de relecture",
  "review.status.silent.body":
    "Sa propre politique de sécurité les bloque peut-être. Vous pouvez toujours laisser des commentaires généraux sur la page.",
  "review.tab.title": "Relire dans un onglet séparé",
  "review.tab.body":
    "Ouvrez l’artifact dans son propre onglet pour le voir en mode relecture. L’onglet affiche l’artifact lui-même, écrit par son auteur, pas par Portifact : ne vous y connectez pas et n’y saisissez rien, même s’il ressemble à Portifact. Il n’a pas d’outils de relecture, écrivez donc vos commentaires ici. Sa session de relecture prend fin après {minutes} minutes, ou lorsque vous choisissez Terminer la relecture dans l’onglet.",
  "review.tab.prepare": "Préparer un onglet de relecture",
  "review.tab.open": "Ouvrir l’onglet de relecture",
  "review.tab.ready": "Le lien de l’onglet de relecture est prêt.",
  "review.tab.opened":
    "L’onglet de relecture s’est ouvert. Choisissez Terminer la relecture dans l’onglet quand vous avez fini ; les commentaires restent ici.",
  "review.tab.expired": "Le lien a expiré avant d’être ouvert. Préparez-en un nouveau.",
  "review.status.ended.title": "Cette session de relecture est terminée",
  "review.status.ended.body":
    "C’est ce qu’indique la page dans le cadre. Les commentaires ici continuent de fonctionner ; rechargez la relecture pour utiliser de nouveau les outils de relecture dans la page.",
  "review.status.failed.title": "Le lien de relecture a expiré",
  "review.status.failed.body":
    "C’est ce qu’indique la page dans le cadre. Les commentaires ici continuent de fonctionner ; rechargez la relecture pour ouvrir de nouveau la page.",
  "review.status.foreign.title": "Le cadre n’exécute pas votre session de relecture",
  "review.status.foreign.body":
    "Quelque chose, peut-être un autre artifact, a ouvert une autre session de relecture dans le cadre, les outils de relecture y sont donc désactivés. Rechargez la relecture pour relancer la vôtre. Les commentaires ici ne sont pas affectés.",
  "review.status.lost.title": "Le cadre ne répond plus depuis l’artifact",
  "review.status.lost.body":
    "Il affiche peut-être un autre site, un autre artifact ou un fichier sans les outils de relecture, ne considérez donc pas ce qu’il montre comme cet artifact. Rechargez la relecture pour afficher de nouveau l’artifact. Les commentaires ici ne sont pas affectés.",
  "review.reload": "Recharger la relecture",
  "review.newVersion.title": "Une version plus récente a été publiée",
  "review.newVersion.body":
    "Vous consultez une version plus ancienne. Les nouveaux commentaires vont sur la version la plus récente.",
  "review.newVersion.action": "Relire la nouvelle version",
  "review.mode.off.owner.title": "Les commentaires sont désactivés",
  "review.mode.off.owner.body":
    "Activez-les pour permettre aux personnes qui peuvent ouvrir cet artifact de commenter.",
  "review.mode.off.turnOn": "Activer les commentaires",
  "review.mode.off.turnedOn": "Les commentaires sont activés.",
  "review.mode.off.visitor.title": "Les commentaires sont désactivés pour cet artifact",
  "review.mode.off.visitor.body": "Le propriétaire ne les a pas activés.",
  "review.mode.locked.title": "Les commentaires sont verrouillés",
  "review.mode.locked.body": "Vous pouvez lire les commentaires, mais pas en ajouter de nouveaux.",
  "review.comments.heading": "Commentaires",
  "review.comments.loading": "Chargement des commentaires",
  "review.comments.error.title": "Les commentaires n’ont pas pu être chargés",
  "review.comments.refreshFailed":
    "Les commentaires n’ont pas pu être actualisés. Portifact réessaie dans un instant.",
  "review.comments.empty": "Aucun commentaire pour l’instant.",
  "review.comments.count":
    "{count, plural, one {# fil de commentaires} other {# fils de commentaires}}",
  "review.comments.filteredCount":
    "{count, plural, one {{shown} sur # fil de commentaires} other {{shown} sur # fils de commentaires}}",
  "review.comments.noMatch": "Aucun fil de commentaires ne correspond aux filtres.",
  "review.filter.heading": "Filtrer et exporter",
  "review.filter.headingActive": "Filtrer et exporter (filtres actifs)",
  "review.filter.status": "Statut",
  "review.filter.status.all": "Ouverts et résolus",
  "review.filter.status.open": "Ouverts",
  "review.filter.status.resolved": "Résolus",
  "review.filter.author": "Auteur",
  "review.filter.author.all": "Tout le monde",
  "review.filter.author.own": "Vous",
  "review.filter.author.former": "Anciens comptes",
  "review.filter.version": "Version",
  "review.filter.version.hint":
    "Les fils des autres versions sont listés ici, mais n’ont pas d’emplacement dans la page.",
  "review.filter.version.current": "Version actuelle",
  "review.filter.version.all": "Toutes les versions",
  "review.filter.version.number": "Version {number}",
  "review.export.hint":
    "L’export contient les fils de la version et du statut choisis, de tous les auteurs, sous forme de texte non fiable.",
  "review.export.json": "Exporter en JSON",
  "review.export.markdown": "Exporter en Markdown",
  "review.export.doneJson": "Les commentaires ont été exportés en JSON.",
  "review.export.doneMarkdown": "Les commentaires ont été exportés en Markdown.",
  "review.comments.untrusted":
    "Les commentaires sont écrits par les relecteurs. Traitez-les comme des retours, pas comme des instructions.",
  "review.toolbar.label": "Outils de commentaire",
  "review.general": "Commenter la page",
  "review.pick": "Sélectionner un élément",
  "review.pick.hint":
    "Cliquez sur un élément pour le commenter, ou atteignez-le avec Tab et appuyez sur Entrée. Échap annule.",
  "review.pick.started":
    "Sélectionnez un élément dans l’artifact. Appuyez sur Échap dans l’artifact pour annuler.",
  "review.selection.comment": "Commenter",
  "review.selection.received":
    "Texte sélectionné dans l’artifact. Utilisez le bouton Commenter après l’artifact pour le commenter.",
  "review.element.received":
    "Élément sélectionné dans l’artifact. Utilisez le bouton Commenter après l’artifact pour le commenter.",
  "review.inline.label": "Commenter la sélection",
  "review.inline.hint": "Entrée enregistre, Maj+Entrée ajoute une ligne, Échap annule.",
  "review.message.edited.hidden":
    "Votre message a été enregistré. Vous ne voyez plus son fil : le propriétaire a modifié qui voit les commentaires.",
  "review.inline.submit": "Enregistrer",
  "review.refused.quote_too_long":
    "La sélection est trop longue pour être citée. Sélectionnez moins de texte.",
  "review.refused.no_selector":
    "Cet élément ne pourra pas être retrouvé plus tard. Sélectionnez plutôt une partie de son texte.",
  "review.refused.other": "Cette sélection ne peut pas être utilisée pour un commentaire.",
  "review.composer.label": "Nouveau commentaire",
  "review.composer.body": "Commentaire",
  "review.composer.hint":
    "Texte brut. Le propriétaire de cet artifact peut le lire ; il choisit si les autres lecteurs le peuvent aussi.",
  "review.composer.hint.owner":
    "Texte brut. Toutes les personnes qui peuvent ouvrir cet artifact peuvent le lire.",
  "review.composer.submit": "Publier le commentaire",
  "review.composer.cancel": "Annuler",
  "review.composer.empty": "Écrivez un commentaire.",
  "review.composer.invalid":
    "Le commentaire est trop long ou contient des caractères non autorisés.",
  "review.composer.posted": "Commentaire publié.",
  "review.humanCheck.body":
    "Une vérification rapide que vous êtes humain avant la publication de votre commentaire. Il est publié dès que la vérification est terminée.",
  "review.humanCheck.needed":
    "Une vérification rapide que vous êtes humain avant la publication de votre commentaire.",
  "review.humanCheck.retry":
    "La vérification que vous êtes humain n’a pas abouti. Terminez-la, puis enregistrez de nouveau.",
  "review.humanCheck.unavailable":
    "La vérification que vous êtes humain n’a pas pu se charger sur cette page. Rechargez la page et réessayez.",
  "review.report": "Signaler cet artifact",
  "review.target.general": "Commentaire général sur {path}",
  "review.target.element": "Élément {tag}",
  "review.target.quote": "Texte cité",
  "review.thread.title": "Fil {number}",
  "review.thread.titlePrefix": "Fil ",
  "review.thread.more": "Plus d’actions pour le fil {number}",
  "review.thread.showMessages":
    "{count, plural, one {Afficher le commentaire} other {Afficher les # commentaires}}",
  "review.thread.hideMessages": "Replier les commentaires",
  "review.thread.open": "Ouvert",
  "review.thread.resolved": "Résolu",
  "review.thread.replies": "{count, plural, one {# réponse} other {# réponses}}",
  "review.thread.hideReplies": "Masquer les réponses",
  "review.thread.otherVersion": "Version précédente",
  "review.thread.orphaned": "Sans emplacement",
  "review.thread.otherPage": "Sur {path}",
  "review.thread.show": "Afficher dans l’artifact",
  "review.thread.resolve": "Résoudre",
  "review.thread.reopen": "Rouvrir",
  "review.thread.reply": "Répondre",
  "review.thread.delete": "Supprimer le fil",
  "review.thread.resolvedDone": "Fil {number} résolu.",
  "review.thread.reopenedDone": "Fil {number} rouvert.",
  "review.thread.deletedDone": "Fil {number} supprimé.",
  "review.thread.activated": "Fil {number} sélectionné.",
  "review.thread.activatedMany": "Fils {numbers} sélectionnés.",
  "review.group.heading":
    "{count, plural, one {# fil sur le texte cliqué} other {# fils sur le texte cliqué}}",
  "review.group.clear": "Afficher tous les fils",
  "review.thread.confirmDelete.title": "Supprimer le fil {number} ?",
  "review.thread.confirmDelete.body":
    "Tous ses messages sont supprimés pour tout le monde. Cette action est irréversible.",
  "review.thread.confirmDelete.confirm": "Supprimer le fil",
  "review.thread.confirmDelete.cancel": "Le conserver",
  "review.message.formerAccount": "Ancien compte",
  "review.message.you": "Vous",
  "review.message.hidden": "Masqué par le propriétaire",
  "review.message.deleted": "Message supprimé",
  "review.message.edited": "Modifié",
  "review.message.hide": "Masquer",
  "review.message.unhide": "Afficher de nouveau",
  "review.message.delete": "Supprimer",
  "review.message.more": "Plus d’actions pour le message de {author}",
  "review.message.moderated": "Message mis à jour.",
  "review.message.edit": "Modifier",
  "review.message.editLabel": "Modifier votre message",
  "review.message.editBody": "Message",
  "review.message.editSave": "Enregistrer",
  "review.message.edited.done": "Message modifié.",
  "review.message.editConflict":
    "Ce message a été modifié ailleurs entre-temps. La dernière version est affichée ; modifiez-la de nouveau.",
  "review.reply.label": "Répondre au fil {number}",
  "review.reply.body": "Réponse",
  "review.reply.hint.owner":
    "Le propriétaire a lancé ce fil, donc toutes les personnes qui peuvent voir les commentaires voient votre réponse.",
  "review.reply.submit": "Publier la réponse",
  "review.reply.posted": "Réponse publiée.",
  "review.actionFailed.title": "L’action n’a pas abouti",

  "notFound.title": "Page introuvable",
  "notFound.body": "Cette adresse ne correspond à aucune page du tableau de bord.",

  "action.retry": "Réessayer",

  "type.site": "Site",
  "type.markdown": "Markdown",
  "type.text": "Texte",

  "state.draft": "Brouillon",
  "state.active": "Actif",
  "state.archived": "Archivé",
  "state.suspended": "Suspendu",
  "state.purging": "En cours de suppression",
  "state.deleted": "Supprimé",

  "access.public": "Public : toute personne disposant du lien",
  "access.authenticated": "Toute personne connectée à Portifact",
  "access.restricted": "Vous et les personnes que vous ajoutez",

  "error.network": "Portifact est injoignable. Vérifiez votre connexion et réessayez.",
  "error.unexpected": "Un problème est survenu. Réessayez.",
  "error.invalid_input": "La requête n’était pas valide.",
  "error.unauthenticated": "Votre session a pris fin. Reconnectez-vous.",
  "error.forbidden": "Vous n’êtes pas autorisé à faire cela.",
  "error.not_found": "L’artifact n’existe plus.",
  "error.version_conflict": "L’artifact a changé entre-temps. Rechargez et réessayez.",
  "error.quota_exceeded":
    "Vous avez atteint la limite d’artifacts actifs. Archivez-en ou supprimez-en un, puis réessayez.",
  "error.traffic_exceeded":
    "Vos artifacts ont épuisé le trafic de ce mois-ci. Ils fonctionneront de nouveau le mois prochain.",
  "error.upload_incomplete": "L’envoi n’est pas encore terminé.",
  "error.artifact_archived": "L’artifact est archivé. Restaurez-le d’abord.",
  "error.account_too_new_for_public":
    "Les nouveaux comptes ne peuvent pas encore rendre des artifacts publics.",
  "error.capacity_unavailable":
    "Portifact a atteint sa capacité pour le moment. Réessayez plus tard.",
  "error.sole_workspace_admin":
    "Un workspace doit garder une personne qui l’administre, et vous êtes la seule. Nommez d’abord un autre membre administrateur, ou demandez à Portifact à hello@portifact.com de supprimer le workspace.",
  "error.seats_exhausted":
    "Le workspace utilise toutes ses places. Retirez un membre ou révoquez une invitation, ou demandez plus de places.",
  "error.rate_limited": "Trop de requêtes. Patientez un instant et réessayez.",
  "error.reauthentication_required": "Reconnectez-vous pour faire cela.",
  "error.human_verification_required":
    "Vos premiers commentaires sur les artifacts d’autres personnes nécessitent une vérification rapide que vous êtes humain. Terminez-la, puis publiez de nouveau.",
  "error.plan_required":
    "Cette fonctionnalité ne fait pas partie de l’offre du propriétaire de l’artifact.",
  "shareLinks.title": "Liens de partage",
  "shareLinks.description":
    "Des liens qui permettent à toute personne qui les a de lire cet artifact sans compte. Les visiteurs lisent seulement la version actuelle : ils ne peuvent pas commenter et ne sont jamais identifiés.",
  "shareLinks.loading": "Chargement des liens de partage",
  "shareLinks.loadFailed": "Les liens de partage n'ont pas pu être chargés",
  "shareLinks.paidTitle": "Les liens de partage font partie d'une offre payante",
  "shareLinks.paid":
    "Votre offre n'inclut pas les liens de partage. Ajouter des personnes et l'accès public fonctionnent comme avant.",
  "shareLinks.paused":
    "Votre offre n'inclut plus les liens de partage, ces liens ne s'ouvrent donc pas. Ils sont conservés et fonctionnent à nouveau si l'offre inclut les liens de partage. Vous pouvez toujours les révoquer.",
  "shareLinks.publicNote":
    "Cet artifact est public, donc tout le monde peut déjà l'ouvrir. Les liens de partage comptent si vous restreignez l'accès plus tard.",
  "shareLinks.created.title": "Lien « {label} » créé",
  "shareLinks.created.once":
    "Copiez-le maintenant : par sécurité, il n'est affiché que cette fois. Toute personne qui a ce lien peut lire l'artifact.",
  "shareLinks.created.label": "Lien de partage",
  "shareLinks.created.copy": "Copier le lien",
  "shareLinks.created.done": "Terminé",
  "shareLinks.created.announce":
    "Lien de partage créé. Copiez-le maintenant ; il n'est affiché qu'une fois.",
  "shareLinks.empty": "Aucun lien de partage pour l'instant.",
  "shareLinks.list": "Liens de partage de cet artifact",
  "shareLinks.expired": "Expiré",
  "shareLinks.noExpiry": "Sans expiration",
  "shareLinks.expires": "Expire le {date}",
  "shareLinks.withPassword": "Mot de passe",
  "shareLinks.noPassword": "Sans mot de passe",
  "shareLinks.neverUsed": "Pas encore utilisé",
  "shareLinks.lastUsed": "Dernière utilisation le {date}",
  "shareLinks.revoke": "Révoquer",
  "shareLinks.revokeLabel": "Révoquer le lien {label}",
  "shareLinks.revoked": "Le lien {label} a été révoqué.",
  "shareLinks.revokeFailed": "Le lien n'a pas été révoqué",
  "shareLinks.confirm.title": "Révoquer « {label} » ?",
  "shareLinks.confirm.body":
    "Toute personne qui a ce lien perd l'accès en moins d'une minute. C'est définitif ; un nouveau lien a une nouvelle adresse.",
  "shareLinks.cancel": "Annuler",
  "shareLinks.create": "Créer un lien",
  "shareLinks.createFailed": "Le lien n'a pas été créé",
  "shareLinks.full":
    "Cet artifact a {max} liens actifs, le maximum. Révoquez-en un pour en créer un autre.",
  "shareLinks.label.label": "Libellé",
  "shareLinks.label.hint": "Vous seul le voyez, par exemple pour qui est le lien.",
  "shareLinks.label.invalid": "Donnez au lien un libellé de 1 à {max} caractères.",
  "shareLinks.expiry.label": "Expire après",
  "shareLinks.expiry.never": "Jamais",
  "shareLinks.expiry.days": "{count, plural, one {# jour} other {# jours}}",
  "shareLinks.password.label": "Mot de passe (facultatif)",
  "shareLinks.password.hint":
    "Au moins {min} caractères. Les visiteurs le saisissent avant que l'artifact s'ouvre. Envoyez-le séparément du lien.",
  "shareLinks.password.short": "Utilisez au moins {min} caractères, ou laissez vide.",
  "domains.title": "Domaine personnalisé",
  "domains.description":
    "Servez cet artifact depuis un domaine à vous, comme docs.example.com. Son adresse Portifact continue de fonctionner.",
  "domains.loading": "Chargement du domaine personnalisé",
  "domains.loadFailed": "Le domaine personnalisé ne s'est pas chargé",
  "domains.paidTitle": "Les domaines personnalisés font partie d'un forfait payant",
  "domains.paid":
    "Avec un forfait payant, vous pouvez servir cet artifact depuis votre propre domaine.",
  "domains.unavailableTitle": "Les domaines personnalisés ne sont pas encore disponibles",
  "domains.unavailable":
    "Portifact ne sert pas encore de domaines personnalisés. Cette section s'ouvrira quand ce sera le cas.",
  "domains.removingNote": "{hostname} est en cours de suppression.",
  "domains.cardLabel": "Domaine personnalisé {hostname}",
  "domains.state.pending": "En attente du DNS",
  "domains.state.provisioning": "Configuration en cours",
  "domains.state.active": "Actif",
  "domains.state.removing": "Suppression",
  "domains.next.pending":
    "Créez les deux enregistrements ci-dessous chez votre fournisseur DNS, puis vérifiez à nouveau.",
  "domains.next.provisioning":
    "Votre domaine est vérifié. Le certificat prend en général quelques minutes ; vérifiez à nouveau sous peu.",
  "domains.next.active":
    "Votre artifact est servi sur ce domaine. Gardez l'enregistrement TXT : il est vérifié chaque jour.",
  "domains.next.removing": "Le domaine est en cours de suppression.",
  "domains.problem.txt_missing": "L'enregistrement TXT est introuvable",
  "domains.problem.txt_missing.hint":
    "Vérifiez que le nom et la valeur de l'enregistrement correspondent exactement. Les changements DNS peuvent mettre quelques minutes à apparaître.",
  "domains.problem.certificate_pending": "Le certificat n'est pas encore prêt",
  "domains.problem.certificate_pending.hint":
    "Vérifiez que l'enregistrement CNAME pointe vers la valeur ci-dessous, puis vérifiez à nouveau dans quelques minutes.",
  "domains.problem.cloudflare_unavailable": "Le service de certificats n'a pas répondu",
  "domains.problem.cloudflare_unavailable.hint":
    "Rien ne cloche de votre côté. Une nouvelle tentative a lieu sous peu.",
  "domains.problem.cname_elsewhere": "Le domaine ne pointe pas vers Portifact",
  "domains.problem.cname_elsewhere.hint":
    "Son DNS ne mène plus à la cible CNAME ci-dessous. Faites-le pointer de nouveau ; un domaine actif est retiré après 3 vérifications quotidiennes de suite dans cet état.",
  "domains.missedChecks":
    "{count, plural, one {L'enregistrement TXT manquait lors de la dernière vérification quotidienne. Après 3 absences de suite, le domaine est retiré.} other {L'enregistrement TXT manquait lors des # dernières vérifications quotidiennes. Après 3 absences de suite, le domaine est retiré.}}",
  "domains.records": "Enregistrements à créer",
  "domains.records.type": "Enregistrement {type}",
  "domains.records.txtHint":
    "Prouve que vous contrôlez le domaine. Gardez-le une fois le domaine actif.",
  "domains.records.cnameHint": "Fait pointer votre domaine vers Portifact.",
  "domains.records.name": "Nom",
  "domains.records.value": "Valeur",
  "domains.records.copy": "Copier",
  "domains.claimExpires":
    "Ajoutez les enregistrements avant le {date}, ou ajoutez à nouveau le domaine.",
  "domains.check": "Vérifier à nouveau",
  "domains.checkFailed": "Le domaine n'a pas été vérifié",
  "domains.remove": "Retirer le domaine",
  "domains.removed": "{hostname} a été retiré.",
  "domains.removeFailed": "Le domaine n'a pas été retiré",
  "domains.confirm.title": "Retirer {hostname} ?",
  "domains.confirm.body":
    "L'artifact cesse immédiatement d'être servi sur ce domaine et garde son adresse Portifact. Ajouter à nouveau le domaine demandera une nouvelle vérification DNS.",
  "domains.cancel": "Annuler",
  "domains.bar.title":
    "Les visites s'ouvrent dans la visionneuse tant que la barre Portifact est activée",
  "domains.bar.body":
    "Tant que la barre est activée, les personnes qui ouvrent votre domaine arrivent dans la visionneuse sur app.portifact.com. Désactivez la barre pour garder votre domaine dans la barre d'adresse.",
  "domains.bar.turnOff": "Désactiver la barre",
  "domains.bar.done": "La barre Portifact est désactivée.",
  "domains.add": "Ajouter le domaine",
  "domains.added": "{hostname} a été ajouté. Créez maintenant ses enregistrements DNS.",
  "domains.addFailed": "Le domaine n'a pas été ajouté",
  "domains.full":
    "{count, plural, one {Votre forfait inclut # domaine personnalisé, déjà utilisé.} other {Votre forfait inclut # domaines personnalisés, tous utilisés.}}",
  "domains.hostname.label": "Nom d'hôte",
  "domains.hostname.hint":
    "Un sous-domaine que vous contrôlez, comme docs.example.com. Les domaines racine et les jokers ne sont pas pris en charge.",
  "domains.hostname.invalid": "Saisissez un nom d'hôte comme docs.example.com.",
  "accessLog.shareLink": "Lien de partage : {label}",
  "webhooks.title": "Webhooks",
  "webhooks.description":
    "Envoyez les événements de vos artifacts à vos propres systèmes, à Slack ou à Discord.",
  "webhooks.planTitle": "Les webhooks font partie d'une offre payante",
  "webhooks.planRequired":
    "Les webhooks font partie de l'offre {plan}. Les webhooks que vous avez ajoutés restent ici, en pause, et fonctionnent à nouveau quand votre offre les inclut.",
  "webhooks.add.title": "Ajouter un webhook",
  "webhooks.add.hint":
    "Les événements de chacun de vos artifacts sont envoyés à cette adresse. Le texte des commentaires et les adresses e-mail des lecteurs ne sont jamais envoyés.",
  "webhooks.add.url": "URL",
  "webhooks.add.urlHint": "Une adresse HTTPS publique sur le port standard.",
  "webhooks.add.format": "Format",
  "webhooks.format.generic": "JSON générique, signé",
  "webhooks.format.genericHint":
    "Vérifiez l'en-tête webhook-signature de chaque envoi avec le secret de signature.",
  "webhooks.format.slack": "Slack",
  "webhooks.format.slackHint": "Une URL de webhook entrant Slack (hooks.slack.com).",
  "webhooks.format.discord": "Discord",
  "webhooks.format.discordHint": "Une URL de webhook de salon Discord (discord.com/api/webhooks).",
  "webhooks.add.events": "Événements",
  "webhooks.event.comment.created": "Nouveaux commentaires et réponses",
  "webhooks.event.thread.resolved": "Fils résolus",
  "webhooks.event.artifact.published": "Nouvelles versions",
  "webhooks.event.artifact.expiring": "Artifacts sur le point d'expirer",
  "webhooks.event.artifact.access_changed": "Changements d'accès",
  "webhooks.event.review.requested": "Demandes de relecture",
  "webhooks.event.review.completed": "Relectures approuvées ou avec modifications demandées",
  "webhooks.add.submit": "Ajouter le webhook",
  "webhooks.add.noEvents": "Choisissez au moins un événement.",
  "webhooks.add.limit":
    "Vous pouvez avoir au plus {limit} webhooks. Supprimez-en un pour en ajouter un autre.",
  "webhooks.added": "Webhook ajouté pour {host}.",
  "webhooks.secret.title": "Copiez le secret de signature maintenant",
  "webhooks.secret.body":
    "Il n'est affiché qu'une fois. Gardez-le dans la configuration de votre récepteur pour vérifier chaque envoi.",
  "webhooks.secret.label": "Secret de signature pour {host}",
  "webhooks.secret.copy": "Copier le secret",
  "webhooks.secret.done": "Je l'ai enregistré",
  "webhooks.list.title": "Vos webhooks",
  "webhooks.list.loading": "Chargement de vos webhooks",
  "webhooks.list.error": "Impossible de charger les webhooks",
  "webhooks.empty.title": "Aucun webhook pour l'instant",
  "webhooks.empty.body":
    "Ajoutez-en un pour recevoir les événements de vos artifacts là où travaille votre équipe.",
  "webhooks.state.active": "Actif",
  "webhooks.state.paused": "En pause par l'offre",
  "webhooks.state.disabled": "Désactivé",
  "webhooks.reason.manual": "Désactivé par un administrateur",
  "webhooks.reason.failures": "Désactivé après des échecs répétés",
  "webhooks.reason.gone": "Désactivé : le récepteur indique qu'il n'existe plus",
  "webhooks.reason.invalid_url": "Désactivé : l'URL n'est plus autorisée",
  "webhooks.failures": "{count} tentatives échouées d'affilée",
  "webhooks.lastAttempt": "Dernière tentative {when} : {outcome}",
  "webhooks.outcome.delivered": "envoyé",
  "webhooks.outcome.failed": "échoué",
  "webhooks.outcome.skipped": "ignoré",
  "webhooks.noAttempts": "Aucune tentative pour l'instant",
  "webhooks.test": "Envoyer un test",
  "webhooks.testLabel": "Envoyer un test à {host}",
  "webhooks.testQueued":
    "Événement de test en file pour {host}. Il part dans environ deux minutes.",
  "webhooks.enable": "Activer",
  "webhooks.enableLabel": "Activer le webhook de {host}",
  "webhooks.disable": "Désactiver",
  "webhooks.disableLabel": "Désactiver le webhook de {host}",
  "webhooks.enabled": "Webhook de {host} activé.",
  "webhooks.disabled": "Webhook de {host} désactivé.",
  "webhooks.remove": "Supprimer",
  "webhooks.removeLabel": "Supprimer le webhook de {host}",
  "webhooks.removed": "Webhook de {host} supprimé.",
  "webhooks.confirm.title": "Supprimer le webhook de {host} ?",
  "webhooks.confirm.body":
    "Il ne reçoit plus d'événements et son journal d'envois est effacé. C'est irréversible.",
  "webhooks.deliveries": "Envois",
  "webhooks.deliveriesOf": "Envois du webhook de {host}",
  "webhooks.deliveries.loading": "Chargement des envois",
  "webhooks.deliveries.error": "Impossible de charger les envois",
  "webhooks.deliveries.empty": "Aucune tentative ces {days} derniers jours.",
  "webhooks.deliveries.time": "Heure",
  "webhooks.deliveries.attempt": "Tentative",
  "webhooks.deliveries.outcome": "Résultat",
  "webhooks.error.timeout": "délai dépassé",
  "webhooks.error.network": "pas de connexion",
  "webhooks.error.redirect": "redirigé, non suivi",
  "webhooks.error.invalid_url": "URL non autorisée",
  "webhooks.error.daily_cap": "limite quotidienne atteinte",
  "webhooks.actionFailed": "Cela n'a pas fonctionné",
  "webhooks.notOfferedTitle": "Les webhooks ne sont pas encore disponibles",
  "webhooks.notOffered":
    "Portifact n'envoie pas encore de webhooks. Ils apparaîtront ici quand ils seront proposés.",
  "webhooks.reason.key_unavailable":
    "Désactivé : la clé qui le protège n'est plus disponible. Supprimez-le et ajoutez-le à nouveau.",
  "webhooks.reason.unavailable": "Désactivé : Portifact a coupé les webhooks pour l'instant",
  "webhooks.error.key_unavailable": "clé indisponible",
  "webhooks.via.dashboard": "Ajouté dans le tableau de bord",
  "webhooks.via.cli": "Ajouté avec la CLI Portifact",
  "webhooks.via.other": "Ajouté depuis une autre app",
  "webhooks.via.by": "par {name}",
  "webhooks.probation":
    "Réactivé après des échecs : quelques échecs de plus le désactivent jusqu'à un envoi réussi.",
  "shell.brandingLink": "Marque",
  "branding.title": "Marque",
  "branding.description":
    "Affichez votre nom, votre logo, votre couleur et votre lien sur la barre au-dessus de vos artifacts dans la visionneuse. La mention de Portifact, l’adresse de l’artifact et le lien de signalement restent toujours sur la barre.",
  "branding.loading": "Chargement de votre marque",
  "branding.error": "Impossible de charger votre marque",
  "branding.paidTitle": "La marque fait partie d’une offre payante",
  "branding.paid":
    "Afficher votre marque sur la barre de la visionneuse fait partie de l’offre {plan}. Vos artifacts affichent la barre par défaut, et la marque enregistrée reste ici pour le jour où votre offre l’inclura de nouveau.",
  "branding.suspendedTitle": "Votre marque est suspendue",
  "branding.suspended":
    "Vos artifacts affichent la barre par défaut tant que dure la suspension. Écrivez à abuse@portifact.com à ce sujet.",
  "branding.form.title": "Marque",
  "branding.form.hint":
    "Affichée sous forme de texte et de lien. Rien ici ne change l’apparence des artifacts eux-mêmes.",
  "branding.form.name": "Nom",
  "branding.form.nameHint": "Jusqu’à {max} caractères. Il ne peut pas se lire comme Portifact.",
  "branding.form.nameRequired": "Saisissez le nom à afficher.",
  "branding.form.nameTooLong": "Utilisez au plus {max} caractères.",
  "branding.form.link": "Lien (facultatif)",
  "branding.form.linkHint":
    "Votre propre site, ouvert dans un nouvel onglet. Il commence par https://.",
  "branding.form.linkInvalid": "Saisissez une adresse qui commence par https://.",
  "branding.form.color": "Couleur d’accent (facultatif)",
  "branding.form.colorHint":
    "Une couleur comme #1a2b3c. Elle remplit l’étiquette de la marque, et le texte passe en noir ou en blanc pour rester lisible.",
  "branding.form.colorPicker": "Choisir la couleur d’accent",
  "branding.form.colorInvalid": "Utilisez une couleur comme #1a2b3c.",
  "branding.form.save": "Enregistrer la marque",
  "branding.form.saved": "Marque enregistrée.",
  "branding.form.failed": "Impossible d’enregistrer la marque",
  "branding.form.invalid":
    "Vérifiez le nom et le lien : le nom ne peut pas se lire comme Portifact, et le lien doit être l’adresse https de votre propre site.",
  "branding.logo.title": "Logo",
  "branding.logo.hint":
    "Une image PNG, JPEG ou WebP de {kb} Ko et {px} sur {px} pixels au plus, sans animation. Elle compte dans votre stockage.",
  "branding.logo.needsName": "Enregistrez d’abord le nom de la marque, puis ajoutez un logo.",
  "branding.logo.none": "Pas encore de logo.",
  "branding.logo.current": "{type}, {width} sur {height} pixels, {size}.",
  "branding.logo.choose": "Choisir un logo",
  "branding.logo.replace": "Remplacer le logo",
  "branding.logo.remove": "Retirer le logo",
  "branding.logo.uploaded": "Logo enregistré.",
  "branding.logo.removed": "Logo retiré.",
  "branding.logo.failed": "Impossible d’enregistrer le logo",
  "branding.logo.invalid":
    "Utilisez une image PNG, JPEG ou WebP de {kb} Ko et {px} sur {px} pixels au plus, sans animation ni texte enregistré dedans.",
  "branding.logo.full": "Votre stockage est plein. Supprimez d’abord quelque chose.",
  "branding.preview.title": "Aperçu",
  "branding.preview.hint":
    "La barre dans chaque thème avec le contenu du formulaire, enregistré ou non.",
  "branding.preview.light": "Thème clair",
  "branding.preview.dark": "Thème sombre",
  "branding.preview.sample": "Rapport trimestriel",
  "branding.preview.noName": "Votre nom",
  "branding.preview.origin": "a1b2c3d4e5.portifact.dev",
  "branding.delete.title": "Supprimer la marque",
  "branding.delete.hint":
    "Vos artifacts affichent de nouveau la barre par défaut, et le logo est supprimé.",
  "branding.delete.action": "Supprimer la marque",
  "branding.delete.confirm": "Supprimer la marque ?",
  "branding.delete.body":
    "Le nom, la couleur, le lien et le logo sont retirés, et la visionneuse affiche la barre par défaut sur tous vos artifacts.",
  "branding.delete.done": "Marque supprimée.",
  "branding.delete.failed": "Impossible de supprimer la marque",
  "branding.delete.cancel": "Annuler",
  "viewer.brandNewTab": "(s’ouvre dans un nouvel onglet)",
  "viewer.hosting.poweredBy": "Propulsé par Portifact",
  "viewer.hosting.origin": "Publié sur",
  // Workspaces (premium plan T1): the space menu, members, invitations and transfers.
  "space.label": "Espace",
  "space.personal": "Personnel",
  "space.personalDetail": "Votre propre espace",
  "space.invitations":
    "{count, plural, one {# invitation en attente} other {# invitations en attente}}",
  "space.missing.title": "Workspace introuvable",
  "space.missing.body":
    "Ce workspace n’existe pas, ou vous n’en êtes pas membre. Demandez à l’un de ses admins de vous inviter.",
  "space.missing.personal": "Aller à votre espace personnel",
  "space.notAllowed.title": "Indisponible avec votre rôle",
  "space.notAllowed.back": "Retour aux artifacts",
  "space.notAllowed.list":
    "En tant que membre de {workspace}, vous lisez et commentez les artifacts partagés avec vous, depuis leurs liens. Voir et gérer tous les artifacts du workspace demande le rôle d’éditeur ou d’admin : demandez-le à l’un de ses admins.",
  "space.notAllowed.publish":
    "Publier dans {workspace} demande le rôle d’éditeur ou d’admin. Demandez-le à l’un de ses admins.",
  "space.notAllowed.usage":
    "L’utilisation de {workspace} est visible par ses éditeurs et ses admins.",
  "space.notAllowed.branding": "Seuls les admins de {workspace} définissent sa marque.",
  "role.admin": "Admin",
  "role.editor": "Éditeur",
  "role.member": "Membre",
  "role.admin.hint":
    "gère les membres, la marque et tous les artifacts, et peut sortir des artifacts du workspace",
  "role.editor.hint": "publie et gère les artifacts du workspace",
  "role.member.hint": "lit et commente ce qui est partagé avec lui",
  "shell.membersLink": "Membres",
  "list.descriptionWorkspace":
    "Tout ce qui est publié dans {workspace}, avec son état, son accès et son activité.",
  "publish.descriptionWorkspace":
    "Publiez dans {workspace} : un fichier HTML, un dossier, un ZIP ou un document. Rien n’est envoyé avant votre relecture.",
  "publish.review.accessNewWorkspace":
    "Les admins et les éditeurs de {workspace}. Après la publication, vous pouvez le partager depuis la page de l’artifact.",
  "usage.descriptionWorkspace":
    "Les quotas de {workspace}, partagés par tous ceux qui y publient, et le trafic de ce mois.",
  "branding.descriptionWorkspace":
    "La marque que la barre de la visionneuse affiche sur les artifacts de {workspace}.",
  "detail.section.space": "Espace",
  "transfer.title": "Déplacer vers un autre espace",
  "transfer.description":
    "Cet artifact se trouve dans {space}. Déplacez-le vers votre espace personnel ou vers un workspace où vous êtes éditeur ou admin.",
  "transfer.destination": "Destination",
  "transfer.move": "Déplacer l’artifact",
  "transfer.blocked": "Cet artifact ne peut pas être déplacé pour l’instant",
  "transfer.notAdmin": "Seul un admin de {workspace} peut en sortir ses artifacts.",
  "transfer.domain":
    "Cet artifact a un domaine personnalisé, actif ou en attente. Retirez-le dans Partage, puis déplacez l’artifact.",
  "transfer.none":
    "Il n’y a aucun autre espace où le déplacer. Vous pouvez déplacer des artifacts vers votre espace personnel et vers les workspaces où vous êtes éditeur ou admin.",
  "transfer.confirm.title": "Déplacer {name} vers {space} ?",
  "transfer.confirm.stays":
    "Ne change pas : son ID, son lien, ses versions, les personnes que vous avez ajoutées et les commentaires.",
  "transfer.confirm.changes":
    "Change : les admins et les éditeurs de {space} le gèrent et voient qui l’a ouvert, y compris avant le déplacement, et il compte dans l’utilisation de {space}.",
  "transfer.confirm.plan":
    "Les épinglages et les liens de partage suivent le forfait de {space} : s’il ne les inclut pas, ils cessent de fonctionner.",
  "transfer.confirm.blocks":
    "Il n’est pas déplacé si {space} n’a pas de place pour lui ou si un envoi est encore ouvert.",
  "transfer.confirm.action": "Déplacer",
  "transfer.done": "{name} a été déplacé vers {space}.",
  "transfer.failed": "L’artifact n’a pas été déplacé",
  "transfer.error.quota_exceeded":
    "{space} n’a pas de place pour cet artifact. Libérez d’abord un emplacement actif ou du stockage.",
  "transfer.error.version_conflict":
    "Un envoi vers cet artifact est encore ouvert, ou il a changé entre-temps. Terminez ou annulez l’envoi, rechargez et réessayez.",
  "transfer.error.invalid_input":
    "Cet artifact a un domaine personnalisé, ou il est déjà dans cet espace. Retirez d’abord le domaine.",
  "transfer.error.forbidden":
    "Votre rôle ne permet pas de sortir cet artifact de son espace ni de le déplacer vers celui-ci.",
  "transfer.error.artifact_archived": "Seul un artifact actif ou archivé peut être déplacé.",
  "transfer.error.not_found": "Cet espace ou cet artifact ne vous est plus accessible.",
  "members.title": "Membres",
  "members.description":
    "Les personnes de {workspace} et ce que chacune peut faire. Les admins gèrent les membres et les invitations.",
  "members.personal.title": "Votre espace personnel n’a pas de membres",
  "members.personal.body":
    "Les membres appartiennent aux workspaces. Choisissez un workspace dans le menu des espaces pour voir ses membres.",
  "members.loading": "Chargement des membres",
  "members.loadFailed": "Les membres n’ont pas pu être chargés",
  "members.seats": "Places",
  "members.seatsUsed": "Places utilisées",
  "members.seatsValue": "{used} sur {limit} ({percent})",
  "members.seatsHint":
    "Chaque membre et chaque invitation en attente occupe une place. Le forfait du workspace en fixe le nombre.",
  "members.listTitle": "Personnes",
  "members.count": "{count, plural, one {# membre} other {# membres}}",
  "members.caption": "Membres de {workspace}",
  "members.you": "Vous",
  "members.joined": "Membre depuis le {date}",
  "members.roleLabel": "Rôle de {name}",
  "members.remove": "Retirer",
  "members.removeNamed": "Retirer {name}",
  "members.leave": "Quitter le workspace",
  "members.lastAdmin":
    "Seul admin : nommez un autre membre admin avant de changer ce rôle, de retirer cette personne ou de partir.",
  "members.confirmRemove.title": "Retirer {name} de {workspace} ?",
  "members.confirmRemove.body":
    "La personne perd aussitôt l’accès aux artifacts du workspace. Ce qu’elle a publié reste dans le workspace.",
  "members.confirmRemove.action": "Retirer le membre",
  "members.confirmLeave.title": "Quitter {workspace} ?",
  "members.confirmLeave.body":
    "Vous perdez aussitôt l’accès à ses artifacts. Pour revenir, un admin doit vous inviter à nouveau.",
  "members.roleChanged": "{name} est maintenant {role}.",
  "members.removed": "{name} a été retiré.",
  "members.left": "Vous avez quitté {workspace}.",
  "members.actionFailed": "La modification n’a pas été enregistrée",
  "members.error.forbidden":
    "Votre rôle a changé entre-temps : seuls les admins gèrent les membres et les invitations. Rechargez la page.",
  "members.error.version_conflict": "Le membre a changé entre-temps. Rechargez et réessayez.",
  "members.error.not_found": "Cette personne ne fait plus partie du workspace.",
  "invite.title": "Inviter quelqu’un",
  "invite.description":
    "Nous envoyons par e-mail un lien valable 7 jours. La personne rejoint le workspace en se connectant avec cette adresse.",
  "invite.email": "E-mail",
  "invite.role": "Rôle",
  "invite.send": "Envoyer l’invitation",
  "invite.sent": "Invitation envoyée à {email}.",
  "invite.emailInvalid": "Saisissez une adresse e-mail, comme nom@exemple.com.",
  "invite.alreadyMember": "{email} est déjà membre.",
  "invite.full.title": "Aucune place libre",
  "invite.failed": "L’invitation n’a pas été envoyée",
  "invite.error.invalid_input":
    "Cette adresse appartient déjà à un membre, ou ce n’est pas une adresse e-mail valide.",
  "invite.error.rate_limited": "Trop d’invitations pour l’instant. Patientez un peu et réessayez.",
  "invite.error.capacity_unavailable":
    "Portifact a envoyé tous les e-mails d’invitation possibles ce mois-ci. Réessayez le mois prochain.",
  "invite.error.not_found": "Cette invitation n’existe plus. Rechargez la page.",
  "pending.title": "Invitations en attente",
  "pending.description":
    "Chacune occupe une place jusqu’à ce qu’elle soit acceptée, refusée, révoquée ou expirée.",
  "pending.loading": "Chargement des invitations",
  "pending.loadFailed": "Les invitations n’ont pas pu être chargées",
  "pending.empty": "Aucune invitation en attente.",
  "pending.detail": "{role}, invité par {inviter}, expire le {date}",
  "pending.unknownInviter": "un ancien membre",
  "pending.resend": "Inviter à nouveau",
  "pending.resendNamed": "Inviter à nouveau : {email}",
  "pending.revoke": "Révoquer",
  "pending.revokeNamed": "Révoquer : {email}",
  "pending.confirmRevoke.title": "Révoquer l’invitation de {email} ?",
  "pending.confirmRevoke.body": "Son lien cesse de fonctionner et sa place est de nouveau libre.",
  "pending.confirmRevoke.action": "Révoquer l’invitation",
  "pending.revoked": "L’invitation de {email} a été révoquée.",
  "pending.resent":
    "Une nouvelle invitation a été envoyée à {email}. L’ancien lien ne fonctionne plus.",
  "invitation.title": "Invitation à un workspace",
  "invitation.signedOut.body":
    "Quelqu’un vous a invité dans un workspace sur Portifact. Connectez-vous avec l’adresse e-mail qui a reçu l’invitation, puis acceptez-la ou refusez-la ici.",
  "invitations.signedOut.body":
    "Connectez-vous pour voir les invitations à des workspaces envoyées à votre adresse e-mail.",
  "invitation.signIn": "Se connecter pour répondre",
  "invitation.loading": "Chargement de l’invitation",
  "invitation.loadFailed": "L’invitation n’a pas pu être chargée",
  "invitation.invited.body": "{inviter} vous a invité dans {workspace} en tant que {role}.",
  "invitation.invited.bodyNoInviter": "Vous êtes invité dans {workspace} en tant que {role}.",
  "invitation.expiresTerm": "Expire",
  "invitation.accept": "Accepter",
  "invitation.acceptNamed": "Accepter l’invitation à {workspace}",
  "invitation.decline": "Refuser",
  "invitation.declineNamed": "Refuser l’invitation à {workspace}",
  "invitation.confirmDecline.title": "Refuser l’invitation à {workspace} ?",
  "invitation.confirmDecline.body":
    "Le lien cesse de fonctionner. Un admin pourra vous inviter à nouveau plus tard.",
  "invitation.confirmDecline.action": "Refuser l’invitation",
  "invitation.accepted": "Vous avez rejoint {workspace}.",
  "invitation.declined": "Vous avez refusé l’invitation à {workspace}.",
  "invitation.failed": "Votre réponse n’a pas été enregistrée",
  "invitation.other.title": "Cette invitation est destinée à une autre adresse",
  "invitation.other.body":
    "Elle a été envoyée à {email}, et vous êtes connecté en tant que {current}. Connectez-vous avec {email} pour y répondre.",
  "invitation.other.unverified":
    "Elle a été envoyée à {email}, l’adresse de ce compte, qui n’est pas encore vérifiée. Déconnectez-vous et reconnectez-vous avec un code envoyé à {email}.",
  "invitation.switch": "Se connecter avec un autre compte",
  "invitation.missing.title": "Cette invitation ne fonctionne plus",
  "invitation.missing.body":
    "Elle a expiré, a été révoquée ou a déjà servi. Demandez à un admin du workspace de vous inviter à nouveau.",
  "invitations.title": "Invitations",
  "invitations.description":
    "Les invitations à des workspaces envoyées à votre adresse e-mail vérifiée.",
  "invitations.loading": "Chargement des invitations",
  "invitations.loadFailed": "Les invitations n’ont pas pu être chargées",
  "invitations.empty.title": "Aucune invitation en attente",
  "invitations.empty.body":
    "Quand un admin invite votre adresse dans un workspace, l’invitation apparaît ici et dans vos e-mails.",
  "invitations.others": "Autres invitations",
  "invitations.notice.title": "Vous êtes invité dans un workspace",
  "invitations.notice.body":
    "{count, plural, one {Vous avez # invitation en attente.} other {Vous avez # invitations en attente.}}",
  "invitations.notice.link": "Voir les invitations",
  "workspaces.title": "Workspaces",
  "workspaces.description":
    "Les workspaces dont vous faites partie et votre rôle dans chacun. Les admins invitent des personnes et changent les rôles sur la page Membres de chaque workspace.",
  "workspaces.loading": "Chargement des workspaces",
  "workspaces.loadFailed": "Les workspaces n’ont pas pu être chargés",
  "workspaces.none":
    "Vous ne faites partie d’aucun workspace. Portifact crée des workspaces pour les équipes, et un admin vous invite par e-mail.",
  "workspaces.leave": "Quitter",
  "workspaces.leaveNamed": "Quitter {workspace}",
  "account.delete.soleAdmin.title": "Vous êtes le seul admin d’un workspace",
  "account.delete.soleAdmin.body":
    "Un workspace doit garder un admin. Nommez un autre membre admin dans chacun de ces workspaces, ou demandez à Portifact à hello@portifact.com de les supprimer, puis supprimez votre compte.",
  "account.delete.soleAdmin.members": "Membres de {workspace}",
  "webhooks.adminOnly.title": "Seuls les administrateurs gèrent les webhooks",
  "webhooks.adminOnly.body":
    "Les webhooks envoient les événements des artifacts de ce workspace vers d’autres systèmes : seuls les administrateurs de {workspace} peuvent les voir et les gérer. Demandez à l’un d’eux si vous avez besoin d’un webhook.",
  "shell.planLink": "Offre",
  "plan.title": "Offre",
  "plan.description":
    "L’offre de votre espace personnel, ses limites et ses fonctions, et les autres offres.",
  "plan.descriptionWorkspace":
    "L’offre de {workspace}, ses limites et ses fonctions, et les autres offres.",
  "plan.current.hint":
    "Ce dont cet espace dispose maintenant. La page Utilisation montre ce qui en est utilisé.",
  "plan.current.limits": "Limites de l’offre actuelle",
  "plan.current.usageLink": "Voir l’utilisation",
  "plan.loading": "Chargement de l’offre",
  "plan.error": "Impossible de charger l’offre.",
  "plan.compare.section": "Toutes les offres",
  "plan.requestNote": "Seuls les administrateurs de {workspace} peuvent demander une autre offre.",
  "plan.hidden": "L’offre de {workspace} est visible par ses éditeurs et ses administrateurs.",
  "usage.plan.compare": "Comparer les offres",
  "shell.auditLink": "Journal d'audit",
  "audit.title": "Journal d'audit",
  "audit.description":
    "Qui a changé quoi dans cet espace. Les changements sont conservés {days} jours.",
  "audit.planTitle": "Le journal d'audit fait partie d'une offre payante",
  "audit.planRequired":
    "Le journal d'audit fait partie de l'offre {plan}. Les changements sont déjà enregistrés : les 90 derniers jours s'afficheront ici quand l'offre l'inclura.",
  "audit.forbidden.title": "Seuls les administrateurs peuvent lire le journal d'audit",
  "audit.forbidden.body":
    "Demandez à un administrateur de cet espace de travail si vous devez savoir qui a changé quelque chose.",
  "audit.loading": "Chargement du journal d'audit",
  "audit.error.title": "Le journal d'audit n'a pas pu être chargé",
  "audit.empty.title": "Aucun changement enregistré",
  "audit.empty.body": "Rien ne correspond à ces filtres sur les {days} derniers jours.",
  "audit.caption": "Changements dans cet espace, du plus récent au plus ancien",
  "audit.column.when": "Quand",
  "audit.column.who": "Qui",
  "audit.column.what": "Quoi",
  "audit.column.on": "Sur",
  "audit.loadMore": "Afficher les changements plus anciens",
  "audit.filters": "Filtrer le journal d'audit",
  "audit.filter.kind": "Type de changement",
  "audit.filter.actor": "Qui",
  "audit.filter.period": "Période",
  "audit.group.all": "Tous les changements",
  "audit.group.access": "Accès et partage",
  "audit.group.lifecycle": "Publication et cycle de vie",
  "audit.group.integrations": "Domaines, webhooks et marque",
  "audit.group.members": "Membres, jetons et forfait",
  "audit.actor.all": "N'importe qui",
  "audit.period.day": "Dernières 24 heures",
  "audit.period.week": "7 derniers jours",
  "audit.period.month": "30 derniers jours",
  "audit.period.all": "Tout ce qui est conservé",
  "audit.actor.removed": "Membre retiré",
  "audit.actor.token": "{label} (jeton de service)",
  "audit.actor.tokenGone": "Jeton de service révoqué",
  "audit.actor.operator": "Opérateur de Portifact",
  "audit.actor.system": "Portifact",
  "audit.artifact.gone": "Artifact supprimé",
  "audit.target.space": "Cet espace",
  "audit.target.invitation": "Une invitation",
  "audit.kind.published": "A publié la version {version}",
  "audit.kind.publishedFirst": "L'a créé avec la version {version}",
  "audit.kind.rolledBack":
    "Est revenu aux fichiers de la version {from}, désormais version {version}",
  "audit.kind.renewed": "L'a renouvelé",
  "audit.kind.archived": "L'a archivé",
  "audit.kind.restored": "L'a restauré",
  "audit.kind.deleted": "L'a supprimé",
  "audit.kind.pinned": "L'a épinglé",
  "audit.kind.unpinned": "L'a désépinglé",
  "audit.kind.transferredIn":
    "L'a déplacé ici depuis {from, select, workspace {un espace de travail} other {un espace personnel}}",
  "audit.kind.transferredOut":
    "L'a déplacé vers {to, select, workspace {un espace de travail} other {un espace personnel}}",
  "audit.kind.accessChanged": "A changé l'accès : {changes}",
  "audit.access.mode":
    "{mode, select, public {l'a rendu public} authenticated {l'a ouvert à toute personne connectée} other {l'a réservé aux lecteurs de la liste}}",
  "audit.access.readersAdded":
    "{count, plural, one {a ajouté # lecteur} other {a ajouté # lecteurs}}",
  "audit.access.readersRemoved":
    "{count, plural, one {a retiré # lecteur} other {a retiré # lecteurs}}",
  "audit.access.domains": "chez {domains}",
  "audit.access.exceptions":
    "{count, plural, one {a changé les commentaires visibles par # lecteur} other {a changé les commentaires visibles par # lecteurs}}",
  "audit.access.bar":
    "{on, select, true {a activé la barre Portifact} other {a désactivé la barre Portifact}}",
  "audit.access.comments":
    "{visibility, select, everyone {a montré les commentaires à tous} other {a montré les commentaires au propriétaire seulement}}",
  "audit.access.indexable":
    "{on, select, true {a autorisé l'indexation} other {a arrêté l'indexation}}",
  "audit.access.embeddable":
    "{on, select, true {a autorisé l'intégration} other {a arrêté l'intégration}}",
  "audit.kind.shareLinkCreated":
    "A créé un lien de partage{password, select, true { avec mot de passe} other {}}{expires, select, true {, qui expire} other {}}",
  "audit.kind.shareLinkRevoked": "A révoqué un lien de partage",
  "detail.section.reviews": "Relectures",
  "approval.title": "Relectures d'approbation",
  "approval.description":
    "Demandez à des personnes d'approuver la version actuelle. Les relecteurs doivent déjà pouvoir ouvrir cet artifact et le commenter : demander une relecture ne donne accès à personne. Une nouvelle version relance la relecture.",
  "approval.loading": "Chargement de la relecture",
  "approval.loadFailed": "La relecture n'a pas pu être chargée",
  "approval.paidTitle": "Les relectures font partie d'une offre payante",
  "approval.paid": "Demander des relectures fait partie de l'offre {plan}.",
  "approval.lapsed":
    "Votre offre n'inclut plus les relectures : la demande ouverte reste lisible et vous pouvez l'annuler, mais pas la modifier.",
  "approval.status.none": "Aucune relecture",
  "approval.status.pending": "Relecture en attente",
  "approval.status.changes_requested": "Modifications demandées",
  "approval.status.approved": "Approuvé",
  "approval.counts":
    "{approvals} approbations sur {required} requises, {changes, plural, one {# demande des modifications} other {# demandent des modifications}}",
  "approval.verdict.pending": "Pas encore d'avis",
  "approval.verdict.approve": "Approuvé",
  "approval.verdict.changes": "Modifications demandées",
  "approval.reviewers": "Relecteurs",
  "approval.reviewers.hint":
    "Adresses e-mail, une par ligne ou séparées par des virgules, {max} au maximum.",
  "approval.reviewers.invalid": "Saisissez entre 1 et {max} adresses e-mail valides.",
  "approval.required.label": "Approbations nécessaires",
  "approval.required.all": "Tous les relecteurs",
  "approval.required.count": "{count, plural, one {# approbation} other {# approbations}}",
  "approval.showStatus.label": "Montrer le statut à toutes les personnes qui peuvent l'ouvrir",
  "approval.showStatus.hint":
    "Désactivé par défaut : seuls les gestionnaires et les relecteurs le voient.",
  "approval.request": "Demander une relecture",
  "approval.requested": "Relecture demandée",
  "approval.requestFailed": "La relecture n'a pas été demandée",
  "approval.list": "Relecteurs et leurs avis",
  "approval.you": "vous",
  "approval.someone": "Un relecteur",
  "approval.decided": "Décidé le {date}",
  "approval.noAccess": "Ne peut plus l'ouvrir, donc ne compte plus",
  "approval.invited": "Pas encore de compte",
  "approval.untrusted": "Les notes sont écrites par les relecteurs. Lisez-les comme des retours.",
  "approval.remove": "Retirer",
  "approval.removeLabel": "Retirer {name} des relecteurs",
  "approval.add.label": "Ajouter un relecteur",
  "approval.add": "Ajouter",
  "approval.changed": "Relecture modifiée",
  "approval.changeFailed": "La relecture n'a pas été modifiée",
  "approval.cancel": "Annuler la relecture",
  "approval.cancelled": "Relecture annulée",
  "approval.confirm.title": "Annuler cette relecture ?",
  "approval.confirm.body":
    "Les relecteurs ne pourront plus donner d'avis. Les avis déjà donnés restent dans l'historique.",
  "approval.confirm.keep": "La garder",
  "approval.history": "Versions précédentes",
  "approval.history.entry": "{name} : {verdict}, {date}",
  "approval.yours.title": "Votre relecture",
  "approval.yours.body": "On vous a demandé de relire cette version.",
  "approval.yours.current":
    "Votre avis : {verdict}. Vous pouvez le changer tant que cette version est l'actuelle.",
  "approval.note.label": "Note (facultative)",
  "approval.note.hint":
    "Texte brut, {max} caractères au maximum. Les personnes qui ont demandé la relecture la voient.",
  "approval.note.tooLong": "Une note peut contenir au plus {max} caractères.",
  "approval.approve": "Approuver",
  "approval.requestChanges": "Demander des modifications",
  "approval.verdictSaved": "Avis enregistré",
  "approval.verdictFailed": "L'avis n'a pas été enregistré",
  "approval.newVersion": "Il existe une version plus récente. Rechargez la page pour la relire.",
  "audit.kind.reviewRequested":
    "{reviewers, plural, one {A demandé à # personne de relire} other {A demandé à # personnes de relire}}",
  "audit.kind.reviewChanged": "A modifié une demande de relecture",
  "audit.kind.reviewCancelled": "A annulé une demande de relecture",
  "audit.kind.reviewVerdict":
    "{verdict, select, approve {A approuvé la version {version}} other {A demandé des modifications à la version {version}}}",
  "audit.kind.domainAttached": "A rattaché le domaine {hostname}",
  "audit.kind.domainRemoved":
    "{reason, select, removed {A retiré le domaine {hostname}} operator {Portifact a retiré le domaine {hostname}} other {Le domaine {hostname} a été détaché automatiquement}}",
  "audit.kind.webhookCreated":
    "A ajouté un webhook {format, select, slack {Slack} discord {Discord} other {signé}} vers {host}",
  "audit.kind.webhookChanged":
    "{enabled, select, true {A activé un webhook} false {A désactivé un webhook} other {A changé les événements d'un webhook}}",
  "audit.kind.webhookRemoved": "A retiré un webhook",
  "audit.kind.brandChanged":
    "{logo, select, true {A changé le logo de la marque} other {A changé le nom, la couleur ou le lien de la marque}}",
  "audit.kind.brandRemoved":
    "{logo, select, true {A retiré le logo de la marque} other {A retiré la marque}}",
  "audit.kind.memberInvited": "A invité une personne de {domain} comme {role}",
  "audit.kind.invitationRevoked": "A révoqué une invitation",
  "audit.kind.memberJoined": "{member} a rejoint comme {role}",
  "audit.kind.roleChanged": "A changé {member} de {from} à {to}",
  "audit.kind.memberRemoved": "A retiré {member}",
  "audit.kind.memberLeft": "{member} est parti",
  "audit.kind.planGranted":
    "A défini l'offre {plan} avec {seats, plural, one {# siège} other {# sièges}}",
  "audit.kind.planGrantedUntil":
    "A défini l'offre {plan} avec {seats, plural, one {# siège} other {# sièges}} jusqu'au {until}",
  "audit.kind.planRemoved": "A retiré l'offre : l'espace revient à Free",
  "audit.kind.tokenCreated":
    "A créé un jeton de service qui expire dans {days, plural, one {# jour} other {# jours}}",
  "audit.kind.tokenRevoked": "A révoqué un jeton de service",
  "audit.export.label": "Exporter le journal d'audit",
  "audit.export.csv": "Exporter en CSV",
  "audit.export.jsonl": "Exporter en JSON Lines",
  "audit.export.hint":
    "Télécharge tous les changements conservés qui correspondent aux filtres, du plus récent au plus ancien. Les membres sont nommés, jamais par leur adresse.",
  "audit.export.doneCsv": "Le journal d'audit a été exporté en CSV.",
  "audit.export.doneJsonl": "Le journal d'audit a été exporté en JSON Lines.",
  "audit.export.failed": "Le journal d'audit n'a pas pu être exporté",
  "audit.export.planRequired": "L'export du journal d'audit fait partie de l'offre {plan}.",
  "audit.kind.exported":
    "{format, select, csv {A exporté le journal d'audit en CSV} other {A exporté le journal d'audit en JSON Lines}}",
  "audit.kind.emailDomainVerified": "A vérifié le domaine e-mail {domain}",
  "audit.kind.emailDomainRemoved":
    "{reason, select, removed {A retiré le domaine e-mail {domain}} claimed {Le domaine e-mail {domain} a été retiré, car un autre workspace l'a prouvé} other {Le domaine e-mail {domain} a été retiré, car son enregistrement DNS est absent}}",
  "shell.serviceTokensLink": "Jetons de service",
  "tokens.title": "Jetons de service",
  "tokens.description":
    "Des identifiants qui permettent à une automatisation, comme la CI, de publier dans {workspace} sans la connexion d'une personne. Chaque jeton a un rôle, des autorisations et une expiration, et cesse de fonctionner dès que vous le révoquez.",
  "tokens.personal.title": "Les jetons de service appartiennent à un workspace",
  "tokens.personal.body": "Passez à un workspace que vous administrez pour y créer des jetons.",
  "tokens.adminOnly.title": "Seuls les admins gèrent les jetons de service",
  "tokens.adminOnly.body": "Demandez un jeton à un admin de ce workspace.",
  "tokens.planTitle": "Les jetons de service ne font pas partie du forfait de ce workspace",
  "tokens.planRequired":
    "Créer des jetons de service fait partie du forfait {plan}. Les jetons existants restent listés et peuvent être révoqués, mais ils ne fonctionnent plus tant que le forfait ne les inclut pas de nouveau.",
  "tokens.list.title": "Jetons",
  "tokens.loading": "Chargement des jetons de service",
  "tokens.loadFailed": "Les jetons de service n'ont pas pu être chargés",
  "tokens.empty.title": "Aucun jeton de service pour l'instant",
  "tokens.empty.body":
    "Créez-en un pour une tâche de CI, enregistrez-le comme secret PORTIFACT_TOKEN et lancez la CLI portifact.",
  "tokens.secret.title": "Copiez le jeton maintenant",
  "tokens.secret.body":
    "C'est la seule fois qu'il est affiché. Enregistrez-le comme secret de votre CI, par exemple PORTIFACT_TOKEN. Quiconque le détient peut faire ce que ses autorisations permettent jusqu'à son expiration ou sa révocation.",
  "tokens.secret.label": "Jeton de service {label}",
  "tokens.secret.copy": "Copier le jeton",
  "tokens.secret.done": "Je l'ai enregistré",
  "tokens.create.title": "Créer un jeton",
  "tokens.create.hint": "Il agit pour le workspace, jamais pour vous, et n'en est jamais membre.",
  "tokens.create.limit":
    "Ce workspace a atteint le nombre maximal de jetons ({limit}). Révoquez-en un pour en créer un autre.",
  "tokens.create.label": "Libellé",
  "tokens.create.labelHint": "Où il sert, par exemple les aperçus GitHub",
  "tokens.create.labelError": "Saisissez un libellé de 1 à 80 caractères.",
  "tokens.create.scopes": "Ce qu'il peut faire",
  "tokens.create.scopesError": "Choisissez-en au moins une.",
  "tokens.create.expiry": "Expire après",
  "tokens.create.expiryHint": "À son expiration, un nouveau jeton le remplace.",
  "tokens.create.days": "{days, plural, one {# jour} other {# jours}}",
  "tokens.create.restriction": "Limiter à",
  "tokens.create.prefix": "Préfixe de clé",
  "tokens.create.prefixHint":
    "Chaque artifact qu'il publie doit avoir une clé qui commence ainsi, par exemple pr-.",
  "tokens.create.prefixError":
    "Utilisez des lettres, des chiffres, des points, des tirets bas, des barres obliques ou des tirets, en commençant par une lettre ou un chiffre.",
  "tokens.create.submit": "Créer le jeton",
  "tokens.scope.read": "Lire",
  "tokens.scope.readHint": "Lister les artifacts et leurs versions",
  "tokens.scope.write": "Publier",
  "tokens.scope.writeHint": "Publier des artifacts et des versions, renouveler et archiver",
  "tokens.scope.share": "Partager",
  "tokens.scope.shareHint":
    "Changer qui peut ouvrir un artifact, y compris le rendre public. Un jeton divulgué pourrait exposer des artifacts.",
  "tokens.scope.delete": "Supprimer",
  "tokens.scope.deleteHint":
    "Supprimer des artifacts définitivement. Un jeton divulgué pourrait les détruire ; limitez-le à un préfixe de clé.",
  "tokens.restriction.none": "Tous les artifacts du workspace",
  "tokens.restriction.noneHint": "Le jeton atteint chaque artifact du workspace.",
  "tokens.restriction.own": "Les artifacts qu'il a créés",
  "tokens.restriction.ownHint":
    "Ce que publient des personnes ou d'autres jetons lui semble inexistant.",
  "tokens.restriction.key": "Les artifacts avec un préfixe de clé",
  "tokens.restriction.keyHint":
    "Seulement les artifacts publiés avec une clé sous le préfixe choisi.",
  "tokens.created": "Jeton {label} créé",
  "tokens.actionFailed": "Cela n'a pas fonctionné",
  "tokens.reach.none": "Atteint chaque artifact du workspace",
  "tokens.reach.own": "Atteint seulement les artifacts qu'il a créés",
  "tokens.reach.key": "Atteint seulement les clés qui commencent par {prefix}",
  "tokens.expired": "Expiré",
  "tokens.revoke": "Révoquer",
  "tokens.revokeLabel": "Révoquer {label}",
  "tokens.scopes": "Autorisations : {scopes}",
  "tokens.expiresOn": "Expire le {date}",
  "tokens.expiredOn": "A expiré le {date}",
  "tokens.lastUsed": "Dernière utilisation {when}",
  "tokens.neverUsed": "Jamais utilisé",
  "tokens.createdBy": "Créé par {name} le {date}",
  "tokens.createdOn": "Créé le {date}",
  "tokens.revoked": "Jeton {label} révoqué",
  "tokens.confirm.title": "Révoquer {label} ?",
  "tokens.confirm.body":
    "Tout ce qui l'utilise cesse de fonctionner dès la requête suivante. C'est irréversible.",
  "access.workspace": "Tout le workspace",
  "access.domain": "Le workspace et ses domaines e-mail",
  "list.access.workspace": "Workspace",
  "list.access.domain": "Domaine e-mail",
  "accessSettings.mode.workspace":
    "{count, plural, one {Le # membre de ce workspace} other {Les # membres de ce workspace}}, après connexion, quel que soit leur rôle.",
  "accessSettings.mode.domain":
    "{count, plural, one {Le # membre de ce workspace} other {Les # membres de ce workspace}} et toute personne connectée avec une adresse vérifiée chez {domains}.",
  "accessSettings.mode.domainNone":
    "{count, plural, one {Le # membre de ce workspace} other {Les # membres de ce workspace}} et toute personne connectée avec une adresse vérifiée dans les domaines e-mail du workspace. Aucun domaine n'est encore vérifié : un admin en ajoute un sur la page Membres.",
  "accessSettings.mode.listOnlyRestricted":
    "Les personnes listées ci-dessous ne peuvent l'ouvrir que tant qu'il est restreint.",
  "accessSettings.mode.workspacePlan": "Inclus dans l'offre {plan}.",
  "accessSettings.lapsed.title": "Pour l'instant, seuls les membres peuvent ouvrir cet artifact",
  "accessSettings.lapsed.body":
    "L'offre du workspace n'inclut plus le partage avec des domaines e-mail, donc seuls ses membres peuvent ouvrir cet artifact jusqu'à ce que l'offre l'inclue de nouveau. Rien n'a été modifié.",
  "emailDomains.title": "Domaines e-mail",
  "emailDomains.description":
    "Toute personne connectée à Portifact avec une adresse vérifiée dans l'un de ces domaines peut ouvrir les artifacts du workspace partagés avec ses domaines e-mail. Seul le domaine exact compte, pas ses sous-domaines.",
  "emailDomains.loading": "Chargement des domaines e-mail",
  "emailDomains.loadFailed": "Les domaines e-mail n'ont pas pu être chargés",
  "emailDomains.rules":
    "Prouvez chaque domaine avec un enregistrement DNS. Les fournisseurs de messagerie publics (comme gmail.com), les suffixes partagés et les domaines de Portifact sont refusés. Portifact vérifie l'enregistrement chaque jour et retire un domaine après 3 vérifications manquées d'affilée.",
  "emailDomains.addFailed": "Le domaine n'a pas été ajouté",
  "emailDomains.add": "Ajouter le domaine",
  "emailDomains.domain": "Domaine",
  "emailDomains.domainHint":
    "Le domaine de votre organisation, comme example.com. Jusqu'à {limit} domaines.",
  "emailDomains.domainRequired": "Saisissez un domaine.",
  "emailDomains.empty": "Aucun domaine e-mail pour l'instant.",
  "emailDomains.added": "{domain} a été ajouté. Créez son enregistrement TXT, puis vérifiez-le.",
  "emailDomains.planTitle": "Les domaines e-mail font partie d'une offre payante",
  "emailDomains.plan":
    "La vérification des domaines e-mail fait partie de l'offre {plan}. Les domaines déjà listés restent, et vous pouvez toujours les retirer.",
  "emailDomains.state.verified": "Vérifié",
  "emailDomains.state.pending": "En attente de l'enregistrement DNS",
  "emailDomains.verifiedOn": "Vérifié le {date}.",
  "emailDomains.pendingUntil":
    "Créez l'enregistrement avant le {date}, sinon la demande est abandonnée.",
  "emailDomains.failing.title": "L'enregistrement DNS est absent",
  "emailDomains.failing.body":
    "{count, plural, one {L'enregistrement était absent lors de la dernière vérification quotidienne.} other {L'enregistrement était absent lors des # dernières vérifications quotidiennes d'affilée.}} {left, plural, one {Après # vérification manquée de plus, le domaine est retiré.} other {Après # vérifications manquées de plus, le domaine est retiré.}}",
  "emailDomains.actionFailed": "La modification n'a pas été enregistrée",
  "emailDomains.recordHint":
    "Créez cet enregistrement chez votre fournisseur DNS. Il peut mettre un moment à apparaître.",
  "emailDomains.verify": "Vérifier",
  "emailDomains.verifyNamed": "Vérifier {domain}",
  "emailDomains.remove": "Retirer",
  "emailDomains.removeNamed": "Retirer {domain}",
  "emailDomains.verified": "{domain} est vérifié.",
  "emailDomains.removed": "{domain} a été retiré.",
  "emailDomains.confirmRemove.title": "Retirer {domain} ?",
  "emailDomains.confirmRemove.body":
    "Les personnes qui ouvrent des artifacts uniquement grâce à ce domaine perdent l'accès d'ici une minute. Vous pourrez l'ajouter de nouveau plus tard avec un nouvel enregistrement.",
  "emailDomains.confirmRemove.action": "Retirer le domaine",
  "emailDomains.error.quota_exceeded": "Le workspace a déjà le nombre maximal de domaines e-mail.",
  "emailDomains.error.version_conflict":
    "Le domaine a changé entre-temps, ou un autre workspace le prouve encore dans son DNS. Rechargez et réessayez.",
  "emailDomains.error.capacity_unavailable":
    "Le DNS n'a pas pu être vérifié pour l'instant. Réessayez dans un moment.",
  "emailDomains.error.not_found": "Ce domaine n'est plus dans la liste.",
  "emailDomains.error.refused":
    "Ce domaine ne peut pas être ajouté. Utilisez le domaine de votre organisation : les fournisseurs de messagerie publics, les suffixes partagés, les noms réservés et les domaines de Portifact sont refusés.",
  "emailDomains.error.recordMissing":
    "L'enregistrement TXT avec la valeur de ce domaine n'a pas encore été trouvé. Les modifications DNS peuvent mettre du temps à apparaître ; réessayez plus tard. Une demande de plus de 7 jours doit être ajoutée de nouveau.",
  "transfer.confirm.accessReset":
    "Il est partagé avec son workspace ou un domaine e-mail, il devient donc restreint : seules les personnes de sa liste de lecteurs peuvent encore le lire.",
  "shell.groupsLink": "Groupes",
  "groups.title": "Groupes",
  "groups.description":
    "Des ensembles nommés de membres de {workspace}. Ajoutez un groupe à un artifact restreint et ses membres peuvent l'ouvrir, comme les lecteurs de la liste.",
  "groups.personal.title": "Les groupes appartiennent à un workspace",
  "groups.personal.body": "Passez à un workspace que vous administrez pour gérer ses groupes.",
  "groups.adminOnly.title": "Seuls les administrateurs gèrent les groupes",
  "groups.adminOnly.body":
    "Les éditeurs choisissent des groupes dans les réglages de partage d'un artifact. Demandez à un administrateur de ce workspace d'en créer ou d'en modifier un.",
  "groups.planTitle": "Les groupes ne sont pas dans l'offre de ce workspace",
  "groups.planRequired":
    "Les groupes font partie de l'offre {plan}. Les groupes existants peuvent être renommés, vidés et supprimés, mais ils ne donnent accès à personne tant que l'offre ne les inclut pas de nouveau.",
  "groups.list.title": "Groupes",
  "groups.loading": "Chargement des groupes",
  "groups.loadFailed": "Les groupes ne se sont pas chargés",
  "groups.empty.title": "Aucun groupe pour l'instant",
  "groups.empty.body":
    "Créez un groupe, ajoutez-y des membres, puis ajoutez-le dans les réglages de partage d'un artifact restreint.",
  "groups.create.title": "Créer un groupe",
  "groups.create.hint":
    "Les administrateurs et les éditeurs voient son nom quand ils choisissent qui peut ouvrir un artifact.",
  "groups.create.limit":
    "Un workspace peut avoir au plus {limit} groupes. Supprimez-en un d'abord.",
  "groups.create.name": "Nom",
  "groups.create.submit": "Créer le groupe",
  "groups.nameError": "Utilisez une ligne de 1 à {max} caractères.",
  "groups.actionFailed": "Le groupe n'a pas changé",
  "groups.created": "Groupe {name} créé.",
  "groups.memberCount": "{count, plural, one {# membre} other {# membres}}",
  "groups.showMembers": "Membres",
  "groups.hideMembers": "Masquer les membres",
  "groups.rename": "Renommer",
  "groups.renameLabel": "Renommer {name}",
  "groups.renameField": "Nouveau nom pour {name}",
  "groups.save": "Enregistrer le nom",
  "groups.renamed": "Le groupe s'appelle maintenant {name}.",
  "groups.delete": "Supprimer",
  "groups.deleteLabel": "Supprimer {name}",
  "groups.deleted": "Groupe {name} supprimé.",
  "groups.confirm.title": "Supprimer {name} ?",
  "groups.confirm.body":
    "Ses membres cessent de lire les artifacts qui l'incluent en moins d'une minute, sauf si autre chose leur donne accès. Cette action est définitive.",
  "groups.membersLoading": "Chargement des membres du groupe",
  "groups.noMembers": "Personne n'est encore dans ce groupe.",
  "groups.membersOf": "Membres de {name}",
  "groups.removeMember": "Retirer",
  "groups.removeMemberLabel": "Retirer {name} de {group}",
  "groups.memberRemoved": "{name} a été retiré de {group}.",
  "groups.addMember": "Ajouter un membre à {name}",
  "groups.chooseMember": "Choisissez un membre",
  "groups.add": "Ajouter",
  "groups.memberAdded": "{name} a été ajouté à {group}.",
  "groupAccess.title": "Groupes",
  "groupAccess.hint":
    "Les membres de ces groupes du workspace peuvent l'ouvrir après connexion, comme les lecteurs de la liste.",
  "groupAccess.onlyRestricted":
    "Les groupes donnent accès à leurs membres seulement tant que l'accès est restreint ; dans les autres modes, ils ne gardent que leurs exceptions de commentaires.",
  "groupAccess.count": "{count} groupes sur {max}",
  "groupAccess.planTitle": "Les groupes ne sont pas dans l'offre de ce workspace",
  "groupAccess.planRequired":
    "Ajouter des groupes fait partie de l'offre {plan}. Les groupes déjà ajoutés ne donnent accès à personne tant que l'offre ne les inclut pas de nouveau, et vous pouvez toujours les retirer.",
  "groupAccess.failed.title": "Les groupes n'ont pas changé",
  "groupAccess.empty": "Aucun groupe ajouté.",
  "groupAccess.list": "Groupes qui peuvent ouvrir cet artifact",
  "groupAccess.removeLabel": "Retirer le groupe {name}",
  "groupAccess.removed": "Groupe {name} retiré.",
  "groupAccess.full": "Un artifact peut inclure au plus {max} groupes.",
  "groupAccess.none":
    "Ce workspace n'a pas encore de groupes. Ses administrateurs les créent sur la page Groupes.",
  "groupAccess.added": "Groupe {name} ajouté.",
  "groupAccess.pick": "Ajouter un groupe",
  "groupAccess.choose": "Choisissez un groupe",
  "groupAccess.option": "{name} ({count, plural, one {# membre} other {# membres}})",
  "groupAccess.add": "Ajouter le groupe",
  "groupAccess.comments.label": "Commentaires que voit le groupe {name}",
  "groupAccess.comments.changed": "Le groupe {name} voit maintenant : {choice}.",
  "groupAccess.comments.confirm.title": "Montrer tous les commentaires à {name} ?",
  "groupAccess.comments.confirm.body":
    "Chaque membre de {name} verra tous les fils de commentaires de cet artifact, y compris ceux que d'autres lecteurs ont commencés avant.",
  "audit.group.groups": "Groupes",
  "audit.kind.groupCreated": "A créé le groupe {group}",
  "audit.kind.groupRenamed": "A renommé un groupe, désormais {group}",
  "audit.kind.groupDeleted": "A supprimé le groupe {group}",
  "audit.kind.groupMemberAdded": "A ajouté {member} au groupe {group}",
  "audit.kind.groupMemberRemoved": "A retiré {member} du groupe {group}",
  "audit.target.groupGone": "un groupe supprimé",
  "audit.access.groupsAdded": "{count, plural, one {a ajouté # groupe} other {a ajouté # groupes}}",
  "audit.access.groupsRemoved":
    "{count, plural, one {a retiré # groupe} other {a retiré # groupes}}",
  "audit.access.groupExceptions":
    "{count, plural, one {a changé la visibilité des commentaires de # groupe} other {a changé la visibilité des commentaires de # groupes}}",
  // Single sign-on (premium plan E1, decision 0016).
  "sso.title": "Authentification unique",
  "sso.description":
    "Les personnes ayant une adresse dans les domaines e-mail vérifiés du workspace peuvent se connecter avec le fournisseur d’identité de votre organisation via OpenID Connect.",
  "sso.loadFailed": "Impossible de charger l’authentification unique",
  "sso.stateLabel": "État",
  "sso.state.off": "Non configurée",
  "sso.state.on": "Active",
  "sso.state.plan": "En pause : hors de ce forfait",
  "sso.state.domains": "En pause : aucun domaine vérifié",
  "sso.planTitle": "Hors de ce forfait",
  "sso.plan":
    "L’authentification unique fait partie du forfait {plan}. Un fournisseur déjà configuré reste en place, et vous pouvez toujours le retirer.",
  "sso.lapsedTitle": "Un domaine n’est plus vérifié",
  "sso.lapsed":
    "{domains} n’est plus vérifié, donc ses adresses ne peuvent plus se connecter ainsi tant que le domaine n’est pas vérifié à nouveau.",
  "sso.membership":
    "Les personnes qui se connectent ainsi rejoignent le workspace comme membres, ou avec le rôle d’une invitation en attente, tant qu’il reste une place. Les membres actuels gardent leur rôle.",
  "sso.removalNote":
    "Une personne retirée par un admin ne peut pas revenir par l’authentification unique tant qu’un admin ne l’invite pas à nouveau. Une personne partie d’elle-même le peut.",
  "sso.redirectUri": "URI de redirection",
  "sso.redirectPending":
    "Enregistrez le fournisseur pour obtenir l’URI de redirection à déclarer chez votre fournisseur d’identité. Elle ressemble à {pattern}.",
  "sso.saveFailed": "La modification n’a pas été enregistrée",
  "sso.testOkTitle": "La découverte fonctionne",
  "sso.testOk":
    "La connexion passe par {authorization}, les jetons viennent de {token} et les clés de {keys}.",
  "sso.testOkShort": "La découverte fonctionne.",
  "sso.testFailed": "La découverte a échoué",
  "sso.formLabel": "Fournisseur d’authentification unique",
  "sso.issuer": "URL de l’émetteur",
  "sso.issuerHint":
    "L’émetteur de votre fournisseur d’identité, par exemple https://login.example.com. Portifact lit son document de découverte. Il ne peut plus changer une fois enregistré.",
  "sso.clientId": "ID client",
  "sso.clientSecret": "Secret client",
  "sso.secretHint": "Conservé chiffré et jamais réaffiché.",
  "sso.secretKeep": "Laissez vide pour garder le secret enregistré.",
  "sso.domains": "Domaines pris en charge",
  "sso.domainsHint":
    "Seulement les domaines e-mail vérifiés du workspace. Une adresse d’un autre domaine ne peut pas se connecter ainsi.",
  "sso.noDomains": "Vérifiez d’abord un domaine e-mail ci-dessus.",
  "sso.issuerRequired": "Saisissez l’URL de l’émetteur.",
  "sso.clientIdRequired": "Saisissez l’ID client.",
  "sso.secretRequired": "Saisissez le secret client.",
  "sso.domainsRequired": "Choisissez au moins un domaine.",
  "sso.save": "Enregistrer",
  "sso.saveChanges": "Enregistrer les modifications",
  "sso.test": "Vérifier l’émetteur",
  "sso.remove": "Retirer l’authentification unique",
  "sso.saved": "Authentification unique enregistrée.",
  "sso.removed": "Authentification unique retirée.",
  "sso.scim":
    "Retirer quelqu’un chez votre fournisseur d’identité ne le retire pas ici : retirez-le de la liste des membres.",
  "sso.confirmRemove.title": "Retirer l’authentification unique ?",
  "sso.confirmRemove.body":
    "Plus personne ne pourra se connecter avec ce fournisseur. Les membres restent membres et gardent leur compte ; ils se connectent avec un code par e-mail, Google ou GitHub. Un nouveau fournisseur reçoit une nouvelle URI de redirection.",
  "sso.confirmRemove.action": "Retirer",
  "sso.problem.invalid_issuer":
    "L’émetteur doit être une URL https publique sans requête ni fragment.",
  "sso.problem.unreachable": "Impossible de joindre le fournisseur d’identité.",
  "sso.problem.timeout": "Le fournisseur d’identité a mis trop de temps à répondre.",
  "sso.problem.redirect":
    "Le fournisseur d’identité a répondu par une redirection, que Portifact ne suit pas. Utilisez l’émetteur vers lequel il redirige.",
  "sso.problem.http_error": "Le fournisseur d’identité a répondu par une erreur.",
  "sso.problem.too_large": "La réponse du fournisseur d’identité est trop volumineuse.",
  "sso.problem.not_json": "Le document de découverte n’est pas un JSON valide.",
  "sso.problem.issuer_mismatch":
    "Le document de découverte indique un autre émetteur. Utilisez l’émetteur exactement comme le document l’indique.",
  "sso.problem.missing_endpoint":
    "Il manque au document de découverte le point de terminaison d’autorisation, de jetons ou de clés.",
  "sso.problem.invalid_endpoint":
    "Un point de terminaison du document de découverte n’est pas une URL https publique.",
  "sso.problem.no_code_flow":
    "Le fournisseur d’identité ne propose pas le flux du code d’autorisation.",
  "sso.problem.no_pkce": "Le fournisseur d’identité ne prend pas en charge PKCE avec S256.",
  "sso.problem.no_signing_algorithm":
    "Le fournisseur d’identité signe les jetons d’identité avec un algorithme que Portifact n’accepte pas (familles RS256, PS256, ES256 ou EdDSA).",
  "sso.error.invalid_input":
    "Vérifiez l’émetteur, le client et les domaines. « Vérifier l’émetteur » montre ce qui a échoué dans la découverte.",
  "sso.error.capacity_unavailable":
    "L’authentification unique n’est pas disponible pour le moment.",
  "sso.error.version_conflict":
    "L’authentification unique a changé entre-temps. Rechargez et réessayez.",
  "sso.error.not_found": "L’authentification unique n’est pas configurée.",
  "audit.kind.memberJoinedSso":
    "{member} a rejoint en tant que {role} par l’authentification unique",
  "audit.kind.ssoCreated":
    "A configuré l’authentification unique avec {host} pour {count, plural, one {# domaine} other {# domaines}}",
  "audit.kind.ssoChanged": "A modifié l’authentification unique",
  "audit.kind.ssoRemoved": "A retiré l’authentification unique",
  "shell.policiesLink": "Règles",
  "policies.title": "Règles",
  "policies.description":
    "Règles pour tous les artefacts de {workspace}. Elles s’appliquent à tous ceux qui agissent sur ses artefacts, admins et jetons de service compris.",
  "policies.personal.title": "Les règles concernent les espaces de travail",
  "policies.personal.body":
    "Un espace personnel n’a pas de règles. Passe à un espace de travail pour voir les siennes.",
  "policies.loading": "Chargement des règles",
  "policies.loadFailed": "Les règles n’ont pas pu être chargées",
  "policies.planTitle": "Définir des règles fait partie de l’offre {plan}",
  "policies.planRequired":
    "L’offre de l’espace de travail n’inclut pas les règles. Celles déjà définies continuent de s’appliquer, et les admins peuvent toujours les assouplir ou les retirer.",
  "policies.readOnly.title": "Définies par les admins",
  "policies.readOnly.body":
    "Seuls les admins modifient les règles. Elles s’appliquent aussi à toi.",
  "policies.adminsToo": "Ces règles s’appliquent aussi aux admins.",
  "policies.public.legend": "Accès public",
  "policies.public.allowed": "Autorisé",
  "policies.public.allowedHint":
    "Les admins et éditeurs peuvent rendre un artefact public : toute personne ayant son lien peut l’ouvrir.",
  "policies.public.forbidden": "Interdit",
  "policies.public.forbiddenHint":
    "Aucun artefact de l’espace de travail ne peut être public. Les artefacts publics deviennent partagés avec l’espace de travail.",
  "policies.default.legend": "Accès des nouveaux artefacts",
  "policies.default.hint":
    "Ce avec quoi un nouvel artefact de l’espace de travail démarre. Les artefacts existants gardent le leur.",
  "policies.default.restricted":
    "Seuls son côté propriétaire et les lecteurs ajoutés peuvent l’ouvrir.",
  "policies.default.workspace": "Tout membre de l’espace de travail peut l’ouvrir.",
  "policies.default.domain":
    "Les membres et toute personne connectée avec une adresse vérifiée des domaines de messagerie de l’espace de travail peuvent l’ouvrir.",
  "policies.default.domainNone": "Vérifie d’abord un domaine de messagerie sur la page Membres.",
  "policies.readers.legend": "Domaines des lecteurs",
  "policies.readers.any": "N’importe quelle adresse",
  "policies.readers.anyHint":
    "Des lecteurs peuvent être ajoutés à n’importe quelle adresse e-mail.",
  "policies.readers.only": "Seulement ces domaines",
  "policies.readers.onlyHint":
    "Des lecteurs ne peuvent être ajoutés qu’à ces domaines de messagerie. Les membres et les groupes ne sont pas concernés.",
  "policies.readers.domains": "Domaines autorisés",
  "policies.readers.domainsHint": "Un par ligne, comme example.com, au plus {max}.",
  "policies.readers.domainsError": "Écris entre 1 et {max} domaines simples, comme example.com.",
  "policies.links.legend": "Liens de partage",
  "policies.links.allowed": "Autorisés",
  "policies.links.allowedHint":
    "Les admins et éditeurs peuvent créer des liens de partage, avec ou sans mot de passe.",
  "policies.links.password_required": "Mot de passe obligatoire",
  "policies.links.password_requiredHint":
    "Chaque lien de partage demande un mot de passe. Ceux qui n’en ont pas ne s’ouvrent plus.",
  "policies.links.disabled": "Désactivés",
  "policies.links.disabledHint": "Aucun lien de partage. Ceux qui existent sont révoqués.",
  "policies.lifetime.label": "Durée de vie maximale d’un lien, en jours",
  "policies.lifetime.hint":
    "Laisse vide pour aucune limite. Les liens plus anciens ne s’ouvrent plus.",
  "policies.lifetime.error": "Écris un nombre entier de jours entre 1 et {max}, ou laisse vide.",
  "policies.save": "Enregistrer les règles",
  "policies.saved": "Les règles ont été enregistrées.",
  "policies.saveFailed": "Les règles n’ont pas été enregistrées",
  "policies.conflict":
    "Quelqu’un a modifié les règles entre-temps. Elles ont été rechargées : vérifie-les et enregistre.",
  "policies.impact.title": "Appliquer ces règles aux artefacts existants ?",
  "policies.impact.body": "Enregistrer modifie ce qui existe déjà dans {workspace} :",
  "policies.impact.public":
    "{count, plural, one {# artefact public devient partagé avec l’espace de travail} other {# artefacts publics deviennent partagés avec l’espace de travail}}",
  "policies.impact.readers":
    "{count, plural, one {# lecteur hors des domaines autorisés est retiré} other {# lecteurs hors des domaines autorisés sont retirés}}",
  "policies.impact.revoked":
    "{count, plural, one {# lien de partage est révoqué} other {# liens de partage sont révoqués}}",
  "policies.impact.password":
    "{count, plural, one {# lien sans mot de passe ne s’ouvre plus} other {# liens sans mot de passe ne s’ouvrent plus}}",
  "policies.impact.lifetime":
    "{count, plural, one {# lien au-delà de la durée de vie ne s’ouvre plus} other {# liens au-delà de la durée de vie ne s’ouvrent plus}}",
  "policies.impact.note":
    "Cela se fait en arrière-plan, par petits lots, et figure dans le journal d’audit.",
  "policies.impact.confirm": "Appliquer et enregistrer",
  "policies.impact.cancel": "Continuer à modifier",
  "policies.note.publicForbidden": "La règle de l’espace de travail interdit l’accès public.",
  "policies.note.readerDomains":
    "La règle de l’espace de travail n’autorise que des lecteurs de {domains}.",
  "policies.note.linksDisabled":
    "La règle de l’espace de travail n’autorise pas les liens de partage.",
  "policies.note.linksPassword":
    "La règle de l’espace de travail exige un mot de passe sur chaque lien de partage.",
  "policies.note.linksLifetime":
    "La règle de l’espace de travail limite les liens de partage à {days, plural, one {# jour} other {# jours}}.",
  "error.policy_refused": "Une règle de l’espace de travail ne le permet pas.",
  "audit.group.policies": "Règles",
  "audit.kind.policyChanged": "A modifié les règles de l’espace de travail : {changes}",
  "audit.kind.policyEnforced": "A appliqué les règles de l’espace de travail : {changes}",
  "audit.policy.public":
    "{value, select, forbidden {accès public interdit} other {accès public autorisé}}",
  "audit.policy.default":
    "{mode, select, workspace {nouveaux artefacts partagés avec l’espace de travail} domain {nouveaux artefacts partagés avec les domaines de messagerie} other {nouveaux artefacts restreints}}",
  "audit.policy.readers": "lecteurs seulement de {domains}",
  "audit.policy.readersAny": "lecteurs de n’importe quel domaine",
  "audit.policy.links":
    "{value, select, disabled {liens de partage désactivés} password_required {liens de partage avec mot de passe} other {liens de partage autorisés}}",
  "audit.policy.lifetime":
    "liens de partage d’au plus {days, plural, one {# jour} other {# jours}}",
  "audit.policy.lifetimeNone": "aucune limite de durée pour les liens",
  "audit.policy.narrowed":
    "{count, plural, one {a limité # artefact à l’espace de travail} other {a limité # artefacts à l’espace de travail}}",
  "audit.policy.readersRemoved":
    "{count, plural, one {a retiré # lecteur} other {a retiré # lecteurs}}",
  "audit.policy.linksRevoked": "{count, plural, one {a révoqué # lien} other {a révoqué # liens}}",
  "audit.policy.sessionsEnded":
    "{count, plural, one {a fermé # session de lien} other {a fermé # sessions de lien}}",
  "policies.impact.stale":
    "Ce que cette règle change sur les artefacts existants a augmenté depuis ta vérification. Enregistre à nouveau pour revoir les nouveaux chiffres.",
  "policies.savedWithChanges":
    "Les artefacts existants sont mis en conformité avec les règles. Leurs pages et le journal d’audit montrent ce qui a changé.",
  "policies.default.domainLapsed":
    "Aucun domaine de messagerie n’est vérifié : les nouveaux artefacts démarrent partagés avec l’espace de travail jusqu’à ce qu’un domaine soit de nouveau vérifié.",
  "audit.access.byPolicy": "par la règle de l’espace de travail",
  "audit.actor.directory": "{label} (annuaire)",
  "audit.actor.directoryGone": "Annuaire (jeton SCIM révoqué)",
  "audit.kind.memberJoinedDirectory": "{member} a rejoint en tant que {role} via l’annuaire",
  "audit.kind.memberProvisioned":
    "A provisionné une personne de {domain} en tant que {role} ; elle rejoint à sa connexion",
  "audit.kind.scimTokenCreated":
    "A créé un jeton SCIM ({days, plural, one {# jour} other {# jours}})",
  "audit.kind.scimTokenRevoked": "A révoqué un jeton SCIM",
  "audit.kind.scimEmailsOn": "A activé les e-mails d’invitation pour les personnes provisionnées",
  "audit.kind.scimEmailsOff":
    "A désactivé les e-mails d’invitation pour les personnes provisionnées",
  "pending.directory": "De l’annuaire",
  "pending.directoryDetail":
    "{role}, provisionné par l’annuaire : rejoint à sa première connexion, occupe une place jusqu’au {date}",
  "scim.title": "Synchronisation de l’annuaire (SCIM)",
  "scim.description":
    "Laissez votre fournisseur d’identité ajouter et retirer les personnes de l’espace de travail. Il provisionne des adresses de vos domaines de messagerie vérifiés ; une personne sans compte Portifact rejoint à sa première connexion avec cette adresse.",
  "scim.loadFailed": "La synchronisation de l’annuaire n’a pas pu être chargée",
  "scim.baseUrl": "URL de base SCIM",
  "scim.baseUrlCopy": "Copier l’URL",
  "scim.baseUrlHint":
    "Collez-la dans votre fournisseur d’identité comme URL de base SCIM ou URL du locataire, avec un jeton ci-dessous comme jeton porteur.",
  "scim.planTitle": "Pas dans cette offre",
  "scim.plan":
    "La synchronisation de l’annuaire nécessite l’offre {plan}. D’ici là, les requêtes de l’annuaire sont refusées ; vous pouvez toujours révoquer ses jetons.",
  "scim.rules":
    "Les nouvelles personnes rejoignent en tant que membres. Désactiver une personne dans l’annuaire la retire de l’espace de travail et ferme toutes ses sessions ; son compte et son espace personnel restent les siens. Une personne retirée ici à la main n’est pas rajoutée par la synchronisation suivante.",
  "scim.lastSync": "Dernière synchronisation",
  "scim.lastSyncNever": "L’annuaire ne s’est pas encore connecté.",
  "scim.pendingLabel": "En attente de connexion",
  "scim.pending":
    "{count, plural, =0 {Personne} one {# personne, dans les invitations en attente} other {# personnes, dans les invitations en attente}}",
  "scim.tokens": "Jetons",
  "scim.tokensEmpty": "Aucun jeton pour l’instant.",
  "scim.tokenExpires": "Expire le {date}",
  "scim.tokenExpired": "A expiré le {date}",
  "scim.tokenUsed": "dernière utilisation le {date}",
  "scim.tokenUnused": "jamais utilisé",
  "scim.create": "Créer un jeton SCIM",
  "scim.label": "Libellé",
  "scim.labelHint": "Par exemple le nom du fournisseur d’identité.",
  "scim.labelRequired": "Saisissez un libellé de 80 caractères au plus.",
  "scim.expiry": "Expire après",
  "scim.days": "{count, plural, one {# jour} other {# jours}}",
  "scim.limit":
    "Un espace de travail a au plus {count} jetons SCIM, pour qu’un jeton en remplace un autre sans interruption. Révoquez-en un pour en créer un autre.",
  "scim.secret.title": "Copiez le jeton maintenant",
  "scim.secret.body":
    "Il n’est affiché qu’une fois. Collez-le dans votre fournisseur d’identité comme jeton porteur.",
  "scim.secret.label": "Jeton SCIM {label}",
  "scim.secret.copy": "Copier le jeton",
  "scim.secret.done": "Je l’ai enregistré",
  "scim.revoke": "Révoquer",
  "scim.revokeNamed": "Révoquer : {label}",
  "scim.confirmRevoke.title": "Révoquer {label} ?",
  "scim.confirmRevoke.body":
    "La prochaine requête de l’annuaire avec ce jeton est refusée. Les personnes qu’il a provisionnées restent telles quelles.",
  "scim.confirmRevoke.action": "Révoquer le jeton",
  "scim.revoked": "Le jeton {label} a été révoqué.",
  "scim.created": "Le jeton {label} a été créé. Copiez-le maintenant.",
  "scim.emails":
    "Envoyer l’e-mail d’invitation aux personnes que l’annuaire provisionne sans compte Portifact",
  "scim.emailsHint":
    "Désactivé par défaut : les fournisseurs d’identité annoncent généralement eux-mêmes les nouvelles applications. Dans tous les cas, la personne rejoint à sa première connexion avec cette adresse.",
  "scim.emailsSaved": "Enregistré.",
  "scim.actionFailed": "La modification n’a pas été enregistrée",
  "audit.kind.scimRoleOn": "A donné le rôle {role} aux membres d’un groupe de l’annuaire",
  "audit.kind.scimRoleOff": "A cessé de donner le rôle {role} par un groupe de l’annuaire",
  "groups.directory": "Géré par votre annuaire",
  "groups.directoryNote":
    "L’annuaire de votre organisation gère ce groupe par SCIM : changez son nom et ses membres là-bas.",
  "members.directoryRole": "Dans un groupe de l’annuaire avec un rôle",
  "scim.roles.title": "Rôles à partir des groupes de l’annuaire",
  "scim.roles.description":
    "Les membres du groupe choisi reçoivent ce rôle quand il est supérieur au leur. L’annuaire ne reprend qu’un rôle qu’il a donné : il n’abaisse jamais un rôle défini à la main par un administrateur, et un rôle que vous changez à la main vous revient ensuite.",
  "scim.roles.access":
    "Un groupe indiqué sur un artifact permet à ses membres de le lire : votre annuaire décide désormais qui lit ces artifacts.",
  "scim.roles.editor": "Groupe dont les membres sont éditeurs",
  "scim.roles.admin": "Groupe dont les membres sont administrateurs",
  "scim.roles.none": "Aucun groupe",
  "scim.roles.option": "{name} ({count, plural, one {# membre} other {# membres}})",
  "scim.roles.noGroups": "Votre annuaire n’a encore envoyé aucun groupe.",
  "scim.roles.save": "Enregistrer les rôles",
  "scim.roles.saved": "Rôles enregistrés.",
  "scim.roles.confirm.title": "Faire des membres de {name} des administrateurs ?",
  "scim.roles.confirm.body":
    "{count, plural, one {# personne est} other {# personnes sont}} dans {name} actuellement, et {pending, plural, =0 {personne d’autre ne le sera} one {# de plus le sera} other {# de plus le seront}} à leur connexion. Qui contrôle votre annuaire décidera de qui administre cet espace de travail : ses membres, ses règles, ses jetons et ses réglages.",
  "scim.roles.confirm.action": "En faire des administrateurs",
  "groups.stopSync": "Arrêter la synchronisation",
  "groups.stopSyncLabel": "Arrêter la synchronisation de {name}",
  "groups.stopSync.title": "Arrêter de synchroniser {name} depuis votre annuaire ?",
  "groups.stopSync.body":
    "Votre annuaire ne gérera plus ce groupe : les administrateurs le modifient ici désormais. Son association de rôle est supprimée, et les personnes qu’il a faites éditeurs ou administrateurs gardent leur rôle. Si l’annuaire envoie plus tard un groupe du même nom, il est refusé.",
  "groups.stopSync.done": "{name} n’est plus synchronisé depuis votre annuaire.",
  "audit.kind.groupSyncStopped": "A arrêté de synchroniser le groupe {group} depuis l’annuaire",
  "shell.integrationsLink": "Intégrations",
  "integrations.title": "Intégrations",
  "integrations.description":
    "Transformez un fil de commentaires en ticket GitHub ou Linear. Une connexion agit avec un identifiant collé par un administrateur : les tickets apparaissent comme créés par ce compte.",
  "integrations.adminOnly.title": "Seuls les administrateurs gèrent les intégrations",
  "integrations.adminOnly.body":
    "Demandez à un administrateur de {workspace} de connecter GitHub ou Linear.",
  "integrations.planTitle": "Pas dans cette offre",
  "integrations.planRequired":
    "Les intégrations font partie de l'offre {plan}. Les connexions déjà faites sont conservées, mais aucun ticket ne peut être créé avec elles.",
  "integrations.list.title": "Connexions",
  "integrations.list.loading": "Chargement des connexions",
  "integrations.list.error": "Impossible de charger les connexions.",
  "integrations.empty.title": "Aucune connexion pour l'instant",
  "integrations.empty.body":
    "Connectez GitHub ou Linear pour que les administrateurs et les éditeurs créent des tickets depuis les fils de commentaires.",
  "integrations.service.github": "GitHub",
  "integrations.service.linear": "Linear",
  "integrations.add.title": "Connecter un service",
  "integrations.add.hint":
    "L'identifiant est vérifié auprès du service, stocké chiffré et jamais réaffiché : Portifact n'en montre que les quatre derniers caractères.",
  "integrations.add.service": "Service",
  "integrations.add.label": "Libellé",
  "integrations.add.labelHint": "Un nom que votre équipe reconnaît, comme Dépôt produit.",
  "integrations.add.credential.github": "Jeton d'accès personnel à granularité fine",
  "integrations.add.credential.linear": "Clé d'API Linear",
  "integrations.add.targets.github": "Dépôts",
  "integrations.add.targets.linear": "ID d'équipes",
  "integrations.add.targetsHint.github": "Un propriétaire/dépôt par ligne, au plus {limit}.",
  "integrations.add.targetsHint.linear":
    "Un ID d'équipe par ligne, au plus {limit}. Linear l'affiche dans les réglages de l'équipe.",
  "integrations.add.failed":
    "Le service n'a pas accepté l'identifiant ou l'un des dépôts ou équipes. Vérifiez-les avec les étapes ci-dessus, puis réessayez.",
  "integrations.add.submit": "Connecter",
  "integrations.add.limit":
    "Un espace peut avoir au plus {limit} connexions. Supprimez-en une pour en ajouter une autre.",
  "integrations.howto.github.title": "Créer un jeton GitHub au moindre privilège",
  "integrations.howto.github.1":
    "Dans GitHub, ouvrez Settings, Developer settings, Personal access tokens, Fine-grained tokens, puis choisissez Generate new token.",
  "integrations.howto.github.2":
    "Choisissez comme propriétaire de la ressource le compte ou l'organisation qui possède les dépôts, et donnez-lui une date d'expiration.",
  "integrations.howto.github.3":
    "Sous Repository access, choisissez Only select repositories et sélectionnez les dépôts listés ici.",
  "integrations.howto.github.4":
    "Sous Repository permissions, réglez Issues sur Read and write. Laissez toutes les autres permissions sur No access ; Metadata reste en lecture seule.",
  "integrations.howto.github.5":
    "Générez le jeton et collez-le ici. Les tickets apparaissent comme créés par le compte du jeton.",
  "integrations.howto.linear.title": "Créer une clé d'API Linear",
  "integrations.howto.linear.1":
    "Dans Linear, ouvrez Settings, puis Security and access, et créez une clé d'API personnelle.",
  "integrations.howto.linear.2":
    "Si Linear permet de limiter la clé, autorisez seulement la création de tickets, et seulement dans les équipes listées ici.",
  "integrations.howto.linear.3":
    "Collez la clé ici. Les tickets apparaissent comme créés par votre compte Linear.",
  "integrations.connected": "{label} connecté.",
  "integrations.identity": "Agit en tant que {identity}",
  "integrations.credential": "Identifiant se terminant par {hint}",
  "integrations.attention.credential_rejected":
    "Le service a refusé cet identifiant. Collez-en un nouveau, puis testez-le.",
  "integrations.attention.key_unavailable":
    "L'identifiant enregistré ne peut plus être ouvert. Collez-le de nouveau.",
  "integrations.state.ready": "Prête",
  "integrations.state.attention": "À vérifier",
  "integrations.test": "Tester",
  "integrations.testLabel": "Tester {label}",
  "integrations.testPassed":
    "{label} fonctionne. Elle agit en tant que {identity} et chaque dépôt ou équipe est accessible.",
  "integrations.problem.credential_rejected":
    "Le service a refusé l'identifiant : il est faux, expiré ou révoqué.",
  "integrations.problem.missing_permission":
    "Le service a accepté l'identifiant, mais il ne peut pas lire son propre compte.",
  "integrations.problem.target_unreachable":
    "L'identifiant n'atteint pas {target}. Vérifiez son accès.",
  "integrations.problem.issues_disabled": "Les tickets sont désactivés dans {target}.",
  "integrations.problem.service_unavailable": "Le service n'a pas répondu. Réessayez plus tard.",
  "integrations.problem.rate_limited":
    "Le service limite les requêtes de cet identifiant. Réessayez plus tard.",
  "integrations.edit": "Modifier",
  "integrations.editLabel": "Modifier {label}",
  "integrations.edit.title": "Modifier {label}",
  "integrations.edit.credentialHint": "Laissez vide pour garder l'identifiant actuel.",
  "integrations.edit.save": "Enregistrer",
  "integrations.saved": "{label} enregistré.",
  "integrations.remove": "Supprimer",
  "integrations.removeLabel": "Supprimer {label}",
  "integrations.confirm.title": "Supprimer {label} ?",
  "integrations.confirm.body":
    "Son identifiant est effacé de Portifact. Les tickets déjà créés gardent leurs liens ; ceux encore en cours de création échouent. Révoquez aussi le jeton ou la clé chez le service.",
  "integrations.removed": "{label} supprimé.",
  "integrations.actionFailed": "Cela n'a pas fonctionné",
  "issues.create": "Créer un ticket",
  "issues.dialog.title": "Créer un ticket depuis le fil {number}",
  "issues.dialog.close": "Fermer",
  "issues.dialog.connection": "Connexion",
  "issues.dialog.target": "Dépôt ou équipe",
  "issues.dialog.issueTitle": "Titre du ticket",
  "issues.dialog.parts": "Ce qui est envoyé",
  "issues.dialog.part.link": "Un lien vers ce fil",
  "issues.dialog.part.artifactName": "Le nom de l'artifact",
  "issues.dialog.part.quote": "Le texte cité",
  "issues.dialog.part.quoteHint": "Une sélection dans l'artifact. Elle quitte Portifact.",
  "issues.dialog.part.message": "Le premier message du fil",
  "issues.dialog.part.messageHint":
    "Les mots de quelqu'un. Ils quittent Portifact et restent dans le ticket même si le commentaire est supprimé ensuite.",
  "issues.dialog.preview": "Exactement ce qui est envoyé",
  "issues.dialog.previewHint":
    "Le texte des commentaires part en texte brut : les mentions, liens et images qu'il contient ne font rien. Il est relu à la création du ticket, donc une modification ultérieure est ce qui part.",
  "issues.dialog.never":
    "Jamais envoyés : les adresses e-mail des lecteurs, le contenu de l'artifact, les autres messages du fil ou les notes de relecture.",
  "issues.dialog.visible":
    "Toute personne qui voit ce fil, y compris les lecteurs extérieurs à votre équipe, voit le lien du ticket créé et le nom de son dépôt ou de son équipe, même pour un dépôt privé.",
  "issues.failure.target_removed":
    "un administrateur a retiré ce dépôt ou cette équipe de la connexion.",
  "issues.failure.artifact_moved": "l'artifact a été déplacé vers un autre espace.",
  "issues.failure.requester_left": "vous ne pouvez plus créer de tickets pour cet espace.",
  "issues.failure.thread_gone": "le fil a été supprimé.",
  "issues.dialog.eu":
    "Cet espace garde ses données dans l'UE. Ce que vous envoyez va chez {service}, hors de l'UE.",
  "issues.dialog.submit": "Créer le ticket",
  "issues.dialog.noConnections":
    "Aucune connexion utilisable. Demandez à un administrateur de connecter GitHub ou Linear, ou de réparer une connexion à vérifier.",
  "issues.requested": "Ticket demandé. Son lien apparaît sur le fil dans quelques minutes.",
  "issues.list": "Tickets",
  "issues.link": "Ticket {key} dans {target}",
  "issues.pending": "Le ticket dans {target} est en cours de création",
  "issues.failed": "Le ticket dans {target} n'a pas été créé : {reason}",
  "issues.failure.credential_rejected": "l'identifiant de la connexion ne fonctionne plus.",
  "issues.failure.target_unreachable": "l'identifiant ne peut pas y créer de tickets.",
  "issues.failure.rejected": "le service l'a refusé.",
  "issues.failure.connection_removed": "la connexion a été supprimée.",
  "issues.failure.unavailable": "les intégrations ne sont pas disponibles.",
  "issues.failure.plan_lapsed": "l'offre n'inclut plus les intégrations.",
  "issues.failure.service_unavailable": "le service n'a pas répondu.",
  "issues.failure.invalid_response":
    "le service a répondu d'une façon que Portifact n'a pas pu utiliser.",
  "audit.kind.integrationConnected":
    "A connecté {service, select, github {GitHub} other {Linear}} avec {targets, plural, one {# dépôt ou équipe} other {# dépôts ou équipes}}",
  "audit.kind.integrationChanged":
    "{credential, select, true {A remplacé l'identifiant d'une connexion} other {A modifié le libellé ou les cibles d'une connexion}}",
  "audit.kind.integrationRemoved":
    "A supprimé une connexion {service, select, github {GitHub} other {Linear}}",
  "audit.kind.integrationFailing":
    "{reason, select, key_unavailable {L'identifiant d'une connexion ne peut plus être ouvert} other {{service, select, github {GitHub} other {Linear}} a refusé l'identifiant d'une connexion}}",
  "audit.kind.issueCreated":
    "A créé un ticket {service, select, github {GitHub} other {Linear}} dans {target} depuis un fil {message, select, true {avec son premier message} other {sans texte de commentaire}}",
  "policies.networks.legend": "Réseaux pour les personnes",
  "policies.networks.hint":
    "Les membres, administrateurs compris, n’agissent sur l’espace de travail et ne lisent ses artifacts réservés à l’espace de travail que depuis ces réseaux. Les artifacts publics, les liens de partage et les personnes extérieures avec qui vous avez partagé ne sont pas concernés.",
  "policies.networks.any": "Tout réseau",
  "policies.networks.anyHint": "Les personnes accèdent à l’espace de travail depuis n’importe où.",
  "policies.networks.only": "Uniquement ces réseaux",
  "policies.networks.onlyHint":
    "Les requêtes depuis d’autres adresses sont refusées avec un message qui en donne la raison.",
  "policies.networks.ranges": "Adresses et plages IP autorisées",
  "policies.networks.rangesHint":
    "Une par ligne, comme 192.0.2.0/24 ou 2001:db8::/32, {max} au maximum. Une adresse seule correspond à un appareil.",
  "policies.networks.rangesError":
    "Indiquez entre 1 et {max} adresses ou plages IP, comme 192.0.2.0/24. Une plage couvrant toutes les adresses (/0) n’est pas autorisée.",
  "policies.networks.yourIp":
    "Votre adresse actuelle est {ip}. La liste doit l’inclure, sinon l’enregistrer vous bloquerait.",
  "policies.networks.notStored":
    "Portifact vérifie l’adresse que Cloudflare indique pour chaque requête et ne la conserve jamais.",
  "policies.networks.hidden":
    "Les personnes n’accèdent à cet espace de travail que depuis des réseaux approuvés. Ses administrateurs voient la liste.",
  "policies.networks.limits":
    "Cela n’arrête pas quelqu’un qui atteint un réseau approuvé, par exemple via un VPN partagé, et cela limite les comptes des personnes, pas les artifacts déjà partagés hors de l’espace de travail.",
  "policies.tokenNetworks.legend": "Réseaux pour les jetons de service",
  "policies.tokenNetworks.hint":
    "Les jetons de service ne sont pas soumis à la liste pour les personnes. Donnez-leur leur propre liste, comme les adresses de vos runners de CI.",
  "policies.tokenNetworks.anyHint": "Les jetons de service fonctionnent depuis n’importe où.",
  "policies.tokenNetworks.onlyHint":
    "Les jetons de service utilisés depuis d’autres adresses sont refusés.",
  "policies.tokenNetworks.hidden":
    "Les jetons de service ne fonctionnent que depuis des réseaux approuvés. Les administrateurs de l’espace de travail voient la liste.",
  "policies.impact.networksTitle": "Limiter les réseaux qui accèdent à cet espace de travail ?",
  "policies.impact.members":
    "{count, plural, one {# membre n’accédera} other {# membres n’accéderont}} à l’espace de travail que depuis les réseaux autorisés",
  "policies.impact.tokens":
    "{count, plural, one {# jeton de service ne fonctionnera} other {# jetons de service ne fonctionneront}} que depuis les réseaux autorisés",
  "policies.impact.networksNote":
    "Portifact ne conserve l’adresse de personne : il ne peut donc pas savoir qui est hors de ces réseaux en ce moment. Votre propre adresse est incluse.",
  "policies.impact.networksConfirm": "Limiter les réseaux",
  "space.blocked.title": "Inaccessible depuis ce réseau",
  "space.blocked.body":
    "{workspace} n’autorise l’accès que depuis ses réseaux approuvés, et ce réseau n’en fait pas partie. Connectez-vous depuis un réseau approuvé, ou contactez un administrateur de l’espace de travail. Vos autres espaces continuent de fonctionner.",
  "audit.policy.networks":
    "personnes uniquement depuis {count, plural, one {# réseau} other {# réseaux}}",
  "audit.policy.networksAny": "personnes depuis tout réseau",
  "audit.policy.tokenNetworks":
    "jetons de service uniquement depuis {count, plural, one {# réseau} other {# réseaux}}",
  "audit.policy.tokenNetworksAny": "jetons de service depuis tout réseau",
} satisfies Catalog;
