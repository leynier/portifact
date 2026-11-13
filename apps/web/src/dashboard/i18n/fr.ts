// French messages of the dashboard (France, "vous"), with the same keys as en.ts. French
// typography: a no-break space before : ; ! ? and inside « ». Titles and buttons have no
// trailing period; no em dashes.
import { planTextFr } from "../../plans/i18n/fr.ts";
import type { Catalog } from "./en.ts";

export const fr = {
  ...planTextFr,
  "app.title": "Portifact",
  "dataGrant.frame.granted": "Cette page peut maintenant enregistrer ce que vous saisissez",
  "dataGrant.frame.saving": "Enregistrement de votre choix",
  "dataGrant.frame.unavailable": "L'enregistrement n'est pas disponible dans ce cadre",
  "dataGrant.frame.unavailableHint":
    "Ce navigateur empêche le cadre de retenir votre choix. Ouvrez l'artifact dans son propre onglet et autorisez-le là.",
  "dataGrant.frame.openTab": "Ouvrir dans un nouvel onglet",
  "dataGrant.pageTitle": "Enregistrer ce que vous saisissez",
  "dataGrant.title": "Autoriser {host} à enregistrer ce que vous saisissez ?",
  "dataGrant.ownerPerson": "Publié par {name}",
  "dataGrant.ownerWorkspace": "Publié par l'espace de travail {name}",
  "dataGrant.learns":
    "La page vous connaîtra sous le nom {name}, avec un identifiant propre à cet artifact. Elle ne connaît jamais votre e-mail.",
  "dataGrant.managers":
    "Les personnes qui gèrent cet artifact peuvent lire tout ce qui y est enregistré.",
  "dataGrant.moves": "Si l'artifact change de propriétaire, ce que vous avez enregistré le suit.",
  "dataGrant.deletion":
    "Si vous supprimez votre compte, ce que vous y avez créé est supprimé, avec les modifications faites ensuite par d'autres. Vos modifications des entrées d'autres personnes restent, sans votre nom.",
  "dataGrant.lasts":
    "Valable {days} jours dans ce navigateur, jusqu'à votre déconnexion ou révocation.",
  "dataGrant.rights": "Voir ce que vous avez partagé et le révoquer",
  "dataGrant.allow": "Autoriser",
  "dataGrant.notNow": "Pas maintenant",
  "dataGrant.loading": "Chargement",
  "dataGrant.unavailable": "Cette demande ne peut pas être utilisée",
  "dataGrant.unavailableHint": "Rouvrez l'artifact et choisissez d'enregistrer depuis celui-ci.",
  "dataGrant.failed": "L'autorisation n'a pas abouti",
  "sharedData.title": "Données partagées",
  "sharedData.description":
    "Pages d'artifacts qui peuvent vous connaître et enregistrer ce que vous saisissez. La révocation prend effet en une minute ; ce que vous avez enregistré reste avec l'artifact.",
  "sharedData.listTitle": "Pages autorisées",
  "sharedData.loading": "Chargement de vos données partagées",
  "sharedData.failed": "Vos données partagées n'ont pas pu être chargées",
  "sharedData.empty": "Rien de partagé pour l'instant",
  "sharedData.emptyHint":
    "Quand la page d'un artifact demande à enregistrer ce que vous saisissez et que vous l'autorisez, elle apparaît ici.",
  "sharedData.artifact": "Artifact",
  "sharedData.since": "Autorisé depuis",
  "sharedData.status": "État",
  "sharedData.actions": "Actions",
  "sharedData.gone": "Artifact plus disponible",
  "sharedData.open": "Autorisé jusqu'au {date}",
  "sharedData.ended": "Terminé",
  "sharedData.revoke": "Révoquer",
  "sharedData.revokeNamed": "Révoquer {name}",
  "sharedData.revoked": "{name} ne peut plus enregistrer en votre nom",
  "sharedData.confirmTitle": "Révoquer {name} ?",
  "sharedData.confirmBody":
    "La page cesse de vous connaître et d'enregistrer en votre nom en une minute, dans tous les navigateurs. Ce que vous avez enregistré reste avec l'artifact.",
  "sharedData.cancel": "Annuler",
  "sharedData.revokeFailed": "La révocation n'a pas abouti",
  "sharedData.more": "Afficher plus",
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
  "list.filter.expiring": "Expiration",
  "list.expiring.soon": "Expire dans 3 jours ou moins",
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
  "detail.suspended.facts": "Les faits sur lesquels nous nous sommes fondés",
  "detail.suspended.ground":
    "Le fondement (la loi ou la règle de nos conditions) et pourquoi il s’applique",
  "detail.suspended.notice":
    "Décidé le {date} à la suite d’une notification reçue. Une personne a pris cette décision.",
  "detail.suspended.review":
    "Décidé le {date} après notre propre examen. Une personne a pris cette décision.",
  "settings.suspended.title": "Votre compte est suspendu",
  "settings.suspended.body":
    "Portifact a suspendu votre compte. Il ne peut plus publier, et ses artifacts sont suspendus avec lui. Vous pouvez toujours vous connecter, exporter vos données et supprimer votre compte. Motif : {reason}. Pour demander un réexamen, écrivez à abuse@portifact.com.",
  "branding.suspendedReason": "Motif : {reason}.",
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
  "accessSettings.mode.publicSlack":
    "Si cet espace a connecté Slack, un lien vers lui publié là-bas affiche son nom et son type, et Slack garde cet aperçu même après qu'il cesse d'être public.",
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
  "account.data.download": "Télécharger les données de votre compte (JSON)",
  "account.data.spacePersonal":
    "Pour récupérer ce que contient votre espace personnel (les versions conservées et les sources de chaque artefact, les journaux d'accès, les données de chaque artefact et de l'espace et le journal d'audit), utilisez la page de téléchargement de l'espace.",
  "account.data.spaceWorkspace":
    "Pour récupérer ce que contient l'espace de travail {workspace} (les versions conservées et les sources de chaque artefact, les journaux d'accès, les données de chaque artefact et de l'espace et le journal d'audit), utilisez la page de téléchargement de l'espace.",
  "account.data.spaceLink": "Télécharger les données de cet espace",
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
  "scope.data:read": "Lire et exporter les données enregistrées dans vos artifacts",
  "scope.data:write": "Modifier les données enregistrées dans vos artifacts",
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
  "suggest.mode.label": "Mode de relecture",
  "suggest.mode.comment": "Commenter",
  "suggest.mode.suggest": "Suggérer",
  "suggest.mode.name": "Mode {mode}",
  "suggest.mode.on":
    "Le mode suggestion est activé. Sélectionnez du texte dans l’artifact pour suggérer une modification.",
  "suggest.mode.off": "Le mode commentaire est activé.",
  "suggest.hint": "Sélectionnez le texte à modifier",
  "suggest.selection.received":
    "Texte sélectionné. « Suggérer une modification » vient ensuite, après l’artifact.",
  "suggest.selection.action": "Suggérer une modification",
  "suggest.discarded": "La page a changé, la modification non enregistrée a donc été abandonnée.",
  "suggest.editor.label": "Suggérer une modification de la sélection",
  "suggest.editor.page": "Sur {page}",
  "suggest.editor.title": "Suggérer une modification",
  "suggest.editor.reviewTitle": "Vérifiez votre suggestion",
  "suggest.editor.reviewHint":
    "Voici exactement ce qui sera enregistré. Entrée enregistre, Échap annule.",
  "suggest.editor.after": "Nouveau texte",
  "suggest.editor.afterHint":
    "Une ligne de texte brut. Entrée vérifie la modification, Échap annule.",
  "suggest.editor.unchanged": "Modifiez le texte pour suggérer une modification.",
  "suggest.editor.note": "Note",
  "suggest.editor.noteHint":
    "Pourquoi vous la suggérez. Les personnes qui gèrent l’artifact la voient avec la modification.",
  "suggest.editor.review": "Vérifier",
  "suggest.editor.back": "Modifier à nouveau",
  "suggest.editor.save": "Enregistrer la suggestion",
  "suggest.editor.cancel": "Annuler",
  "suggest.saved": "Suggestion enregistrée.",
  "suggest.diff.removed": "Supprimé",
  "suggest.diff.added": "Ajouté",
  "suggest.diff.character": "caractère",
  "suggest.diff.empty": "(rien)",
  "suggest.inspect": "Inspecter les caractères",
  "suggest.inspect.after": "Points de code du nouveau texte",
  "suggest.block.label": "Modification suggérée",
  "suggest.badge": "Suggestion",
  "suggest.state.pending": "En attente d’une décision",
  "suggest.state.applying": "En cours d’application",
  "suggest.state.accepted": "Acceptée",
  "suggest.state.rejected": "Refusée",
  "suggest.state.withdrawn": "Retirée",
  "suggest.state.outdated": "Obsolète",
  "suggest.state.unknown": "État inconnu",
  "suggest.carried": "Suggérée sur une version précédente",
  "suggest.attemptEnded": "La dernière acceptation ne s’est pas terminée : {reason}",
  "suggest.attempt.failed": "elle a échoué. Acceptez à nouveau pour réessayer.",
  "suggest.attempt.version_conflict": "une nouvelle version a été publiée entre-temps.",
  "suggest.attempt.quota_exceeded":
    "une limite a été atteinte ou la liste des modifications est pleine.",
  "suggest.attempt.capacity_unavailable":
    "Portifact limite actuellement les nouvelles tâches. Réessayez plus tard.",
  "suggest.attempt.plan_changed": "ce qui serait appliqué a changé. Vérifiez à nouveau.",
  "suggest.attempt.revoked": "l’accès a changé entre-temps.",
  "suggest.attempt.unknown": "une raison inconnue.",
  "suggest.edit.withdrawn": "La modification a été retirée.",
  "suggest.edit.unknown": "Cette modification ne peut pas être affichée ici.",
  "suggest.edit.notText": "Un changement de style ou de structure.",
  "suggest.plan.check": "Vérifier ce qui s’applique",
  "suggest.plan.lines": "Ce que fait l’acceptation, ligne par ligne",
  "suggest.plan.summary":
    "{applied, plural, one {# modification s’applique automatiquement} other {# modifications s’appliquent automatiquement}} ; {listed, plural, one {# va dans la liste des modifications} other {# vont dans la liste des modifications}}.",
  "suggest.tabs.label": "Modification suggérée",
  "suggest.tabs.plan": "Ce qui s’applique",
  "suggest.tabs.preview": "Aperçu",
  "suggest.preview.loading": "Création de l’aperçu",
  "suggest.preview.title": "Aperçu de la modification suggérée",
  "suggest.preview.hint":
    "Une copie de la page avec la modification, sans scripts, images ni styles externes. La page publiée peut avoir un aspect différent.",
  "suggest.preview.unavailable": "Pas d’aperçu :",
  "suggest.preview.cssTooComplex": "Les styles de la page sont trop complexes pour un aperçu.",
  "suggest.accept": "Accepter",
  "suggest.accept.title": "Accepter cette suggestion ?",
  "suggest.accept.body":
    "{applied, plural, one {# modification est publiée dans une nouvelle version} other {# modifications sont publiées dans une nouvelle version}} ; {listed, plural, one {# va dans la liste des modifications} other {# vont dans la liste des modifications}}.",
  "suggest.accept.confirm": "Accepter et publier",
  "suggest.accept.started":
    "Acceptation de la suggestion. La nouvelle version apparaîtra quand elle sera prête.",
  "suggest.reject": "Refuser",
  "suggest.reject.title": "Refuser cette suggestion ?",
  "suggest.reject.body":
    "La suggestion reste dans son fil, marquée comme refusée. Rien n’est publié.",
  "suggest.rejected": "Suggestion refusée.",
  "suggest.withdraw": "Retirer",
  "suggest.withdraw.title": "Retirer votre suggestion ?",
  "suggest.withdraw.body":
    "La modification est supprimée et le fil reste une conversation. Pour la changer, retirez-la et suggérez-la à nouveau.",
  "suggest.withdrawn": "Suggestion retirée.",
  "suggest.refusal.stale":
    "La page a changé depuis la sélection de ce texte. Sélectionnez-le à nouveau.",
  "suggest.refusal.invalid_after":
    "Le nouveau texte doit tenir sur une ligne de texte brut et différer de l’ancien.",
  "suggest.refusal.spans_blocks":
    "La modification touche deux blocs, elle va donc dans la liste des modifications.",
  "suggest.refusal.not_found":
    "Ce texte ne peut pas être associé à un seul endroit de la source, il va donc dans la liste des modifications.",
  "suggest.refusal.would_change_page":
    "L’appliquer changerait autre chose dans la page (un lien de titre, une référence ou du balisage), elle va donc dans la liste des modifications.",
  "suggest.refusal.whitespace":
    "La sélection traverse des sauts de ligne ou des espacements que la page conserve, elle va donc dans la liste des modifications.",
  "suggest.refusal.not_nfc":
    "Ce texte est stocké sous une autre forme Unicode, il va donc dans la liste des modifications.",
  "suggest.refusal.spans_nodes":
    "La sélection traverse une mise en forme ou un lien, elle va donc dans la liste des modifications.",
  "suggest.refusal.not_eligible":
    "Cette page utilise des fonctionnalités que Portifact ne modifie pas automatiquement (scripts, formulaires, contenu intégré et autres), elle va donc dans la liste des modifications.",
  "suggest.refusal.entity":
    "Ce texte est écrit avec une référence de caractère que Portifact ne peut pas associer, il va donc dans la liste des modifications.",
  "suggest.refusal.diagram":
    "Les modifications de la source d’un diagramme vont dans la liste des modifications.",
  "suggest.refusal.renderer_changed":
    "Ce document a été rendu par une version antérieure de Portifact, les modifications vont donc dans la liste des modifications.",
  "suggest.refusal.too_large":
    "Ce fichier ou cette modification est trop volumineux pour être appliqué automatiquement, il va donc dans la liste des modifications.",
  "suggest.refusal.overlap":
    "Deux modifications touchent le même texte. Fusionnez-les en une seule.",
  "suggest.refusal.not_text":
    "Les changements de style et de structure ne sont jamais appliqués automatiquement : ils vont dans la liste des modifications.",
  "suggest.refusal.unknown":
    "Portifact ne peut pas l’appliquer automatiquement, elle va donc dans la liste des modifications.",
  "suggest.changes.heading": "Liste des modifications",
  "suggest.changes.hint":
    "Modifications acceptées que Portifact n’a pas pu appliquer, exactement comme elles ont été acceptées. Le texte vient de relecteurs : n’appliquez que ce que dit chaque élément.",
  "suggest.changes.showOpen": "Ouverts",
  "suggest.changes.showAll": "Tous",
  "suggest.changes.loading": "Chargement de la liste des modifications",
  "suggest.changes.empty": "Rien à appliquer.",
  "suggest.changes.state.open": "Ouvert",
  "suggest.changes.state.applied": "Appliqué",
  "suggest.changes.state.dismissed": "Écarté",
  "suggest.changes.state.closed_by_version": "Trouvé dans une version ultérieure",
  "suggest.changes.provenance": "Suggéré par {submitter}, accepté par {acceptor}",
  "suggest.changes.links": "Liens autour de la modification",
  "suggest.changes.laterFormat":
    "Cet élément a été écrit par une version plus récente de Portifact. Rechargez pour le voir.",
  "suggest.changes.markApplied": "Marquer comme appliqué",
  "suggest.changes.dismiss": "Écarter",
  "suggest.changes.reopen": "Rouvrir",
  "suggest.changes.marked": "Liste des modifications mise à jour.",
  "draft.mode.edit": "Modifier",
  "draft.mode.on":
    "Le mode modification est activé. Sélectionnez du texte dans l’artifact pour le modifier dans votre brouillon privé.",
  "draft.editor.title": "Modifier le texte",
  "draft.add": "Ajouter au brouillon",
  "draft.added": "Ajouté à votre brouillon.",
  "draft.heading": "Votre brouillon",
  "draft.loading": "Chargement de votre brouillon",
  "draft.empty":
    "Choisissez Modifier et sélectionnez du texte dans l’artifact pour le modifier. Vos modifications restent privées jusqu’à leur publication.",
  "draft.count": "{count, plural, one {# modification} other {# modifications}}",
  "draft.changes": "Modifications de votre brouillon",
  "draft.remove": "Retirer la modification {number}",
  "draft.removeShort": "Retirer",
  "draft.stale":
    "Ce brouillon a été créé sur une version antérieure et ne peut pas être publié. Abandonnez-le et modifiez la version actuelle.",
  "draft.attemptEnded": "La dernière publication ne s’est pas terminée : {reason}",
  "draft.publishingBadge": "Publication",
  "draft.publishing":
    "Publication de votre brouillon. La nouvelle version apparaîtra dès qu’elle sera prête.",
  "draft.publish": "Publier",
  "draft.publish.title": "Publier ce brouillon ?",
  "draft.publish.confirm": "Publier une nouvelle version",
  "draft.discard": "Abandonner",
  "draft.discard.title": "Abandonner ce brouillon ?",
  "draft.discard.body":
    "Toutes les modifications qu’il contient sont supprimées. Rien n’est publié.",
  "draft.discarded": "Brouillon abandonné.",
  "draft.conflict":
    "Votre brouillon a changé dans un autre onglet ou une autre fenêtre. Il affiche maintenant son dernier état ; refaites votre modification.",
  "draft.refused.stale":
    "Votre brouillon a été créé sur une version antérieure. Abandonnez-le avant de modifier la version actuelle.",
  "draft.refused.other_page":
    "Votre brouillon contient des modifications d’une autre page. Publiez-le ou abandonnez-le avant de modifier cette page.",
  "draft.refused.full":
    "Votre brouillon contient déjà le maximum de modifications. Publiez-le ou abandonnez-le d’abord.",
  "draft.refused.invalid": "Cette modification ne peut pas être ajoutée au brouillon.",
  "suggest.editor.tabs": "Votre modification",
  "suggest.editor.tabs.change": "Modification",
  "draft.tabs": "Plan de votre brouillon",
  "draft.rebase": "Déplacer le brouillon vers la version actuelle",
  "draft.rebased":
    "Brouillon déplacé vers la version actuelle : {carried, plural, one {# modification reportée} other {# modifications reportées}}, {left, plural, one {# à refaire} other {# à refaire}}.",
  "draft.conflicts": "Modifications qui n’ont pas pu être déplacées, à refaire",
  "draft.conflicts.dismiss": "Masquer cette liste",
  "suggest.search.heading": "Suggérer une modification de texte",
  "suggest.search.hint":
    "Trouvez le texte dans la page au lieu de le sélectionner dans l’artifact. La recherche lit la page publiée, pas ce que ses scripts affichent.",
  "suggest.search.query": "Texte à trouver",
  "suggest.search.find": "Rechercher",
  "suggest.search.found":
    "{count, plural, =0 {Aucun emplacement trouvé.} one {# emplacement trouvé.} other {# emplacements trouvés.}}",
  "suggest.search.none": "Le texte n’a pas été trouvé sur cette page.",
  "suggest.search.results": "Emplacements contenant le texte",
  "suggest.search.choose": "Modifier le texte à l’emplacement {number}",
  "suggest.search.refused":
    "Cet emplacement ne peut pas être modifié. Essayez un morceau de texte plus court ou plus long.",
  "suggest.search.unavailable":
    "La recherche est disponible sur les pages HTML. Sur cette page, sélectionnez le texte dans l’artifact.",
  "draft.conflictReason": "Le texte modifié est différent ou absent dans la version actuelle.",
  "suggest.search.ownerOnly":
    "La recherche dans la page n'est pas encore disponible pour les relecteurs. Sélectionnez plutôt le texte dans l'artifact.",
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
  "transfer.noneInRegion":
    "Cet espace conserve ses données dans l’UE : l’artifact ne peut aller que dans un autre espace de l’UE, et vous n’en avez aucun.",
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
  "plan.grace.title": "Ce que gardait l'offre {plan} est conservé jusqu'au {date}",
  "plan.grace.body":
    "D'ici là rien n'est supprimé : jusqu'à {versions} versions précédentes de chaque artefact pendant {days} jours, et le journal d'accès et les statistiques pendant {log} jours. Après cette date, ce que l'offre de cet espace ne garde pas est supprimé.",
  "plan.grace.reads": "Toujours lisible d'ici là : {features}.",
  "plan.grace.download":
    "Téléchargez ce dont vous avez besoin avant : l'historique de chaque artefact contient ses versions, et le journal d'accès et le journal d'audit ont leurs exports. Ou demandez à nouveau l'offre pour tout garder.",
  "data.title": "Télécharger vos données",
  "data.description":
    "Tout ce que cet espace contient et que vous pouvez emporter : les versions conservées de chaque artefact et leurs sources, les journaux d'accès et les données de chacun (réglages, règles d'accès, liens de partage, revues, statistiques et commentaires), les données de l'espace, le journal d'audit et, pour votre espace personnel, les données de votre compte. Les fichiers viennent directement du stockage ; rien n'est regroupé sur le serveur.",
  "data.adminsOnly": "Télécharger toutes les données de {workspace} revient à ses admins.",
  "data.grace.title": "Ce qui part et quand",
  "data.grace.hint":
    "Une offre expirée, retirée ou réduite conserve ce qu'elle gardait pendant 60 jours. Ensuite, ce que l'offre de cet espace ne garde pas est supprimé.",
  "data.grace.body":
    "Téléchargez ce dont vous avez besoin avant ces dates, ou demandez à nouveau l'offre pour tout garder.",
  "data.grace.loading": "Chargement de ce qui part et quand",
  "data.grace.error": "Impossible de charger ce qui part et quand.",
  "data.grace.nothing": "Rien de ce qui est conservé ne part à la fin du délai de grâce.",
  "data.grace.caption": "Ce qui est supprimé à la fin du délai de grâce, et à partir de quand",
  "data.grace.column.kind": "Quoi",
  "data.grace.column.count": "Combien",
  "data.grace.column.from": "À partir du",
  "data.kind.versions": "Versions précédentes",
  "data.kind.accessLog": "Entrées du journal d'accès",
  "data.kind.analytics": "Compteurs quotidiens de statistiques",
  "data.kind.auditEvents": "Événements d'audit",
  "data.kind.pins": "Artefacts épinglés (désépinglés, puis archivés comme d'habitude)",
  "data.artifacts.title": "Artefacts",
  "data.artifacts.hint":
    "Ouvrez un artefact pour télécharger toute version qu'il conserve, fichiers publiés ou sources.",
  "data.artifacts.loading": "Chargement des artefacts",
  "data.artifacts.error": "Impossible de charger les artefacts.",
  "data.artifacts.none": "Cet espace n'a aucun artefact.",
  "data.artifacts.more": "Afficher plus d'artefacts",
  "data.artifact.summary":
    "{name} : {count, plural, one {# version conservée} other {# versions conservées}}",
  "data.versions.title": "Versions de {name}",
  "data.versions.caption": "Versions conservées de {name}, de la plus récente à la plus ancienne",
  "data.versions.size": "Taille",
  "data.accessLog.csv": "Journal d'accès en CSV",
  "data.accessLog.json": "Journal d'accès en JSON",
  "data.accessLog.csvLabel": "Journal d'accès en CSV de {name}",
  "data.accessLog.jsonLabel": "Journal d'accès en JSON de {name}",
  "data.accessLog.saved": "Le journal d'accès est prêt.",
  "data.records.button": "Données (JSON)",
  "data.records.label": "Données (JSON) de {name}",
  "data.records.saved": "Les données sont prêtes.",
  "data.records.later":
    "Certaines parties manquent parce que le serveur a demandé d'attendre. Téléchargez à nouveau dans quelques minutes.",
  "data.records.failed": "Les données n'ont pas pu être téléchargées.",
  "data.space.title": "Données de l'espace",
  "data.space.hint":
    "Les réglages de l'espace, sans secrets : pour un espace de travail, ses membres et rôles, les groupes et leurs membres, les invitations, les domaines e-mail, les politiques, l'authentification unique et les jetons de service ; pour tout espace, l'image de marque, les webhooks, les intégrations et les flux d'audit.",
  "data.space.download": "Télécharger les données de l'espace (JSON)",
  "data.space.logo": "Télécharger le logo de la marque",
  "data.logs.title": "Journaux et compte",
  "data.logs.hint":
    "Le journal d'audit de l'espace a son propre export, et votre espace personnel inclut les données de votre compte.",
  "data.logs.audit": "Exportez le journal d'audit depuis la page Journal d'audit",
  "data.logs.account": "Téléchargez les données de votre compte (JSON)",
  "data.logs.cli":
    "Pour tout emporter d'un coup, lancez portifact export <dossier> dans un terminal : il récupère chaque version conservée et les données de chaque artefact, reprend après une interruption et écrit un manifeste. Les membres, les invitations et les autres réglages que seul le tableau de bord lit sont dans les données de l'espace ci-dessus.",
  "shell.grace.title": "Ce que gardait l'offre {plan} est conservé jusqu'au {date}",
  "shell.grace.download": "Télécharger vos données",
  "shell.grace.request": "Redemander {plan}",
  "shell.grace.hide": "Masquer pour aujourd'hui",
  "shell.grace.body":
    "Après cette date, ce que l'offre de cet espace ne garde pas est supprimé. Téléchargez ce dont vous avez besoin, ou redemandez l'offre pour tout garder.",
  "shell.grace.bodyAskAdmin":
    "Après cette date, ce que l'offre de cet espace ne garde pas est supprimé. Demandez à un admin de cet espace de télécharger ce dont vous avez besoin ou de redemander l'offre.",
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
  "audit.group.suggestions": "Suggestions et liste des modifications",
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
  "audit.kind.suggestionAccepted":
    "A accepté une suggestion comme version {version} : {applied} appliquées, {listed} dans la liste des modifications",
  "audit.kind.suggestionAcceptedNothing":
    "A accepté une suggestion sans rien appliquer : {listed} dans la liste des modifications",
  "audit.kind.draftPublished":
    "A publié un brouillon comme version {version} : {applied} appliquées, {listed} dans la liste des modifications",
  "audit.kind.draftPublishedNothing":
    "A publié un brouillon sans rien appliquer : {listed} dans la liste des modifications",
  "audit.kind.suggestionRejected": "A refusé une suggestion",
  "audit.kind.suggestionWithdrawn": "A retiré une suggestion",
  "audit.kind.changeItemApplied":
    "A marqué un élément de la liste des modifications comme appliqué",
  "audit.kind.changeItemDismissed": "A écarté un élément de la liste des modifications",
  "audit.kind.changeItemReopened": "A rouvert un élément de la liste des modifications",
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
  "audit.kind.graceStarted":
    "Délai de grâce commencé ({reason}) : ce que gardait l'offre {plan} est conservé jusqu'au {until}",
  "audit.kind.graceEnded": "Délai de grâce terminé pour ce que gardait l'offre {plan} ({reason})",
  "audit.graceStart.lowered": "offre réduite",
  "audit.graceStart.removed": "offre retirée",
  "audit.graceStart.expired": "offre expirée",
  "audit.graceStart.unreadable": "délai illisible",
  "audit.graceEnd.renewed": "offre renouvelée",
  "audit.graceEnd.operator": "terminé par Portifact",
  "audit.graceEnd.expired": "délai écoulé",
  "audit.graceEnd.folded": "fusionné avec un délai ultérieur",
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
  "github.title": "GitHub Actions",
  "github.hint":
    "Permettre aux workflows d'un dépôt de confiance de publier des aperçus sans jeton enregistré.",
  "github.off":
    "La connexion avec GitHub Actions n'est pas encore disponible sur Portifact. Vous pouvez quand même retirer les dépôts listés ici.",
  "github.audience": "Audience",
  "github.audienceCopy": "Copier l'audience",
  "github.audienceHint":
    "Le workflow demande à GitHub un ID token avec cette audience. L'action d'aperçu et la CLI le font pour vous.",
  "github.loading": "Chargement des dépôts de confiance",
  "github.loadFailed": "Les dépôts de confiance n'ont pas pu être chargés.",
  "github.empty.title": "Aucun dépôt de confiance",
  "github.empty.body":
    "Faites confiance à un dépôt pour que ses workflows publient des aperçus dans ce workspace sans jeton.",
  "github.create.title": "Faire confiance à un dépôt",
  "github.create.hint":
    "La confiance est liée aux identifiants numériques de GitHub : un dépôt renommé reste de confiance, un dépôt supprimé puis recréé ne l'est plus.",
  "github.create.repository": "Dépôt",
  "github.create.repositoryHint":
    "Sous la forme propriétaire/nom. Affiché aux personnes seulement ; jamais vérifié.",
  "github.create.repositoryError": "Utilisez propriétaire/nom, par exemple acme/site.",
  "github.create.repositoryId": "ID du dépôt",
  "github.create.ownerId": "ID du propriétaire",
  "github.create.idsHint":
    "Trouvez-les avec gh api repos/OWNER/REPO --jq .id,.owner.id, ou dans GITHUB_REPOSITORY_ID et GITHUB_REPOSITORY_OWNER_ID d'une exécution.",
  "github.create.idError": "Utilisez le nombre affiché par GitHub.",
  "github.create.events": "Événements autorisés à publier",
  "github.create.eventsError": "Choisissez au moins un événement.",
  "github.event.push": "push",
  "github.event.pushHint":
    "Les push vers le dépôt. Seules les personnes ayant l'accès en écriture peuvent pousser.",
  "github.event.pull_request": "pull_request",
  "github.event.pull_requestHint":
    "Les pull requests. Dans un dépôt public, l'exécution d'un fork ne reçoit pas d'ID token : seules les branches du dépôt lui-même publient. Dans un dépôt privé avec les jetons d'écriture pour les forks, l'exécution d'un fork peut aussi publier.",
  "github.event.workflow_dispatch": "workflow_dispatch",
  "github.event.workflow_dispatchHint":
    "Les exécutions lancées à la main par des personnes ayant l'accès en écriture.",
  "github.event.merge_group": "merge_group",
  "github.event.merge_groupHint":
    "Les exécutions de la file de fusion, lancées par GitHub pour le dépôt.",
  "github.event.release": "release",
  "github.event.releaseHint": "Les releases publiées dans le dépôt.",
  "github.event.schedule": "schedule",
  "github.event.scheduleHint": "Les exécutions planifiées de la branche par défaut.",
  "github.event.pull_request_target": "pull_request_target",
  "github.event.pull_request_targetHint":
    "Des exécutions privilégiées que la pull request d'un fork peut lancer. Sûres seulement si le workflow ne compile jamais le code du fork.",
  "github.event.workflow_run": "workflow_run",
  "github.event.workflow_runHint":
    "Des exécutions privilégiées lancées par un autre workflow, que la pull request d'un fork peut déclencher. Sûres seulement si le workflow ne compile jamais le code du fork.",
  "github.create.privileged":
    "Je comprends que la pull request d'un fork peut lancer ces exécutions et que le workflow ne compile jamais son code",
  "github.create.privilegedError":
    "Confirmez pour faire confiance à pull_request_target ou workflow_run.",
  "github.create.ref": "Ref (facultative)",
  "github.create.refHint":
    "Exacte, par exemple refs/heads/main. La ref d'une exécution de pull request est refs/pull/NUMÉRO/merge : avec une ref de branche, aucune pull request ne publie.",
  "github.create.refError": "Utilisez une ref complète qui commence par refs/.",
  "github.create.environment": "Environnement (facultatif)",
  "github.create.environmentHint":
    "Nom exact. GitHub applique les règles de protection de l'environnement, comme les relecteurs requis, avant que le job reçoive son jeton.",
  "github.create.scopes": "Ce que ses exécutions peuvent faire",
  "github.create.scopesError": "Choisissez-en au moins un.",
  "github.create.submit": "Faire confiance au dépôt",
  "github.create.limit": "Un workspace peut faire confiance à {limit} dépôts au maximum.",
  "github.created": "{repository} est maintenant de confiance.",
  "github.rule.ids": "ID du dépôt {repositoryId}, ID du propriétaire {ownerId}",
  "github.rule.events": "Événements : {events}",
  "github.rule.prefix": "Ne publie que des clés qui commencent par {prefix}",
  "github.rule.ref": "Ref : {ref}",
  "github.rule.environment": "Environnement : {environment}",
  "github.rule.live":
    "{count, plural, =0 {Aucun identifiant actif} one {# identifiant actif} other {# identifiants actifs}}",
  "github.remove": "Retirer",
  "github.removeLabel": "Retirer {repository}",
  "github.confirm.title": "Ne plus faire confiance à {repository} ?",
  "github.confirm.body":
    "Ses workflows ne peuvent plus publier, et les identifiants déjà émis pour ses exécutions cessent de fonctionner aussitôt.",
  "github.removed": "{repository} n'est plus de confiance.",
  "audit.kind.githubTrusted": "A fait confiance au dépôt GitHub {repository}",
  "audit.kind.githubTrustChanged": "A modifié la confiance dans le dépôt GitHub {repository}",
  "audit.kind.githubTrustRemoved": "A cessé de faire confiance au dépôt GitHub {repository}",
  "audit.kind.githubExchanged": "L'exécution GitHub {run} de {repository} a reçu un identifiant",
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
  "error.terms_not_accepted":
    "Acceptez les conditions en vigueur pour continuer. Rechargez la page pour les consulter.",
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
    "Transformez un fil de commentaires en ticket GitHub, Linear ou Jira. Une connexion agit avec un identifiant collé par un administrateur : les tickets apparaissent comme créés par ce compte.",
  "integrations.adminOnly.title": "Seuls les administrateurs gèrent les intégrations",
  "integrations.adminOnly.body":
    "Demandez à un administrateur de {workspace} de connecter GitHub, Linear ou Jira.",
  "integrations.planTitle": "Pas dans cette offre",
  "integrations.planRequired":
    "Les intégrations font partie de l'offre {plan}. Les connexions déjà faites sont conservées, mais aucun ticket ne peut être créé avec elles.",
  "integrations.list.title": "Connexions",
  "integrations.list.loading": "Chargement des connexions",
  "integrations.list.error": "Impossible de charger les connexions.",
  "integrations.empty.title": "Aucune connexion pour l'instant",
  "integrations.empty.body":
    "Connectez GitHub, Linear ou Jira pour que les administrateurs et éditeurs créent des tickets depuis les fils de commentaires.",
  "integrations.service.github": "GitHub",
  "integrations.service.linear": "Linear",
  "integrations.service.jira": "Jira",
  "integrations.service.other": "Autre service",
  "integrations.add.title": "Connecter un service",
  "integrations.add.hint":
    "L'identifiant est vérifié auprès du service, stocké chiffré et jamais réaffiché : Portifact n'en montre que les quatre derniers caractères.",
  "integrations.add.service": "Service",
  "integrations.add.label": "Libellé",
  "integrations.add.labelHint": "Un nom que votre équipe reconnaît, comme Dépôt produit.",
  "integrations.add.credential.github": "Jeton d'accès personnel à granularité fine",
  "integrations.add.credential.linear": "Clé d'API Linear",
  "integrations.add.credential.jira": "Jeton d'API Atlassian avec portées",
  "integrations.add.targets.github": "Dépôts",
  "integrations.add.targets.linear": "ID d'équipes",
  "integrations.add.targets.jira": "Clés de projet",
  "integrations.add.targetsHint.github": "Un propriétaire/dépôt par ligne, au plus {limit}.",
  "integrations.add.targetsHint.linear":
    "Un ID d'équipe par ligne, au plus {limit}. Linear l'affiche dans les réglages de l'équipe.",
  "integrations.add.targetsHint.jira": "Une clé de projet par ligne, comme ENG, au plus {limit}.",
  "integrations.add.account": "E-mail du compte Atlassian",
  "integrations.add.accountHint":
    "L'e-mail du compte qui a créé le jeton. Il est stocké chiffré avec le jeton et n'est plus jamais affiché.",
  "integrations.add.site": "Site Jira",
  "integrations.add.siteHint": "Par exemple acme.atlassian.net.",
  "integrations.add.cloudId": "ID cloud",
  "integrations.add.cloudIdHint":
    "Ouvrez votre-site.atlassian.net/_edge/tenant_info dans le navigateur et copiez la valeur de cloudId.",
  "integrations.add.failed":
    "Le service n'a pas accepté l'identifiant ou l'un des dépôts, équipes ou projets. Vérifiez-les avec les étapes ci-dessus, puis réessayez.",
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
  "integrations.howto.jira.title": "Créer un jeton Jira aux droits minimaux",
  "integrations.howto.jira.1":
    "Connectez-vous à Atlassian avec le compte d'où doivent venir les tickets (idéalement un compte dédié), ouvrez les paramètres du compte, puis Sécurité, et choisissez Créer un jeton d'API avec portées.",
  "integrations.howto.jira.2":
    "Donnez-lui un nom et une expiration, et choisissez Jira comme application.",
  "integrations.howto.jira.3":
    "Sélectionnez uniquement les portées read:jira-user, read:jira-work et write:jira-work.",
  "integrations.howto.jira.4":
    "Créez le jeton et collez-le ici avec l'e-mail du compte, le site et son ID cloud. Un jeton sans portées ne fonctionne pas.",
  "integrations.howto.jira.5":
    "Les tickets apparaissent comme créés par ce compte, dans les projets que vous indiquez ici.",
  "integrations.connected": "{label} connecté.",
  "integrations.identity": "Agit en tant que {identity}",
  "integrations.credential": "Identifiant se terminant par {hint}",
  "integrations.site": "Site {site}",
  "integrations.attention.credential_rejected":
    "Le service a refusé cet identifiant. Collez-en un nouveau, puis testez-le.",
  "integrations.attention.key_unavailable":
    "L'identifiant enregistré ne peut plus être ouvert. Collez-le de nouveau.",
  "integrations.attention.site_mismatch":
    "L'ID cloud ne correspond plus à ce site Jira : le site a changé d'adresse. Supprimez cette connexion et reconnectez le site avec son nom actuel.",
  "integrations.state.ready": "Prête",
  "integrations.state.attention": "À vérifier",
  "integrations.test": "Tester",
  "integrations.testLabel": "Tester {label}",
  "integrations.testPassed":
    "{label} fonctionne. Il agit en tant que {identity}, et chaque dépôt, équipe ou projet est accessible.",
  "integrations.testRefreshed":
    "Portifact crée désormais les tickets dans {targets} avec le type de ticket actuel du projet.",
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
  "integrations.problem.site_mismatch":
    "L'ID cloud n'appartient pas à ce site Jira. Copiez à nouveau les deux depuis le site.",
  "integrations.edit": "Modifier",
  "integrations.editLabel": "Modifier {label}",
  "integrations.edit.title": "Modifier {label}",
  "integrations.edit.credentialHint": "Laissez vide pour garder l'identifiant actuel.",
  "integrations.edit.accountHint":
    "Nécessaire avec un nouveau jeton : l'e-mail de son compte Atlassian.",
  "integrations.edit.save": "Enregistrer",
  "integrations.saved": "{label} enregistré.",
  "integrations.remove": "Supprimer",
  "integrations.removeLabel": "Supprimer {label}",
  "integrations.confirm.title": "Supprimer {label} ?",
  "integrations.confirm.body":
    "Son identifiant est effacé de Portifact. Les tickets déjà créés gardent leurs liens ; ceux encore en cours de création échouent. Révoquez aussi le jeton ou la clé chez le service.",
  "integrations.removed": "{label} supprimé.",
  "integrations.actionFailed": "Cela n'a pas fonctionné",
  "integrations.service.slack": "Slack",
  "integrations.state.pending": "Non terminée",
  "integrations.attention.pending":
    "Terminez la connexion : collez le bot token et le signing secret de l'app Slack.",
  "integrations.attention.app_uninstalled":
    "Slack indique que l'app a été désinstallée ou que ses tokens ont été révoqués. Réinstallez-la dans Slack et collez son nouveau bot token et son signing secret.",
  "integrations.howto.slack.title": "Comment connecter Slack",
  "integrations.howto.slack.1":
    "Commencez ici par un libellé. Portifact affiche alors un manifeste pour votre propre app Slack ; rien n'est encore envoyé à Slack.",
  "integrations.howto.slack.2":
    "Ouvrez le lien pour créer l'app dans Slack à partir de ce manifeste, puis installez-la dans votre espace Slack. Il vous faut l'autorisation d'y créer et d'y installer des apps.",
  "integrations.howto.slack.3":
    "Copiez le Bot User OAuth Token (il commence par xoxb-) dans OAuth & Permissions et le Signing Secret dans Basic Information, puis collez-les ici.",
  "integrations.howto.slack.4":
    "Dans les réglages de l'app dans Slack, ouvrez Event Subscriptions et cliquez sur Verify à côté de la Request URL.",
  "integrations.slack.start": "Commencer",
  "integrations.slack.started":
    "{label} commencée. Créez l'app Slack à partir de son manifeste pour terminer.",
  "integrations.slack.previews":
    "Quand quelqu'un publie un lien vers l'un des artifacts publics de cet espace dans votre espace de travail Slack, l'app affiche dessous le nom et le type de l'artifact. Rien d'autre n'est envoyé : aucun contenu, et rien sur les artifacts qui ne sont pas publics.",
  "integrations.slack.previewsStay":
    "Slack garde l'aperçu dans son message : si un artifact cesse d'être public, les aperçus déjà affichés montrent encore son nom et son type, et les nouvelles publications de son lien n'en reçoivent aucun.",
  "integrations.slack.notices":
    "Les notifications dans un canal passent par les webhooks : ajoutez un incoming webhook à la même app Slack et collez son URL sur la page Webhooks.",
  "integrations.slack.noticesLink": "Ouvrir Webhooks",
  "integrations.slack.pending.title": "Terminer la connexion à Slack",
  "integrations.slack.pending.body":
    "Créez l'app à partir de ce manifeste et installez-la dans votre espace Slack, puis collez ci-dessous son bot token et son signing secret. Une connexion non terminée sous 24 heures est supprimée.",
  "integrations.slack.create": "Créer l'app dans Slack",
  "integrations.slack.manifest": "Manifeste de l'app",
  "integrations.slack.requestUrl": "Request URL",
  "integrations.slack.copyRequestUrl": "Copier la Request URL",
  "integrations.slack.copyManifest": "Copier le manifeste",
  "integrations.slack.copied": "Copié",
  "integrations.slack.botToken": "Bot User OAuth Token",
  "integrations.slack.botTokenHint":
    "Dans OAuth & Permissions, dans les réglages de l'app dans Slack. Il commence par xoxb-.",
  "integrations.slack.signingSecret": "Signing Secret",
  "integrations.slack.signingSecretHint":
    "Dans Basic Information, dans les réglages de l'app dans Slack, sous App Credentials.",
  "integrations.slack.finish": "Terminer la connexion",
  "integrations.slack.verify":
    "Ouvrez ensuite Event Subscriptions dans les réglages de l'app dans Slack et cliquez sur Verify à côté de la Request URL. Si Slack ne peut pas la vérifier, le signing secret est erroné : collez-le à nouveau ici.",
  "integrations.slack.rename":
    "L'app s'appelle Portifact. Pour distinguer deux espaces connectés au même espace Slack, renommez l'app dans ses réglages dans Slack (Basic Information, Display Information).",
  "integrations.slack.team": "Espace Slack {team}",
  "integrations.slack.outdatedTitle": "Manifeste ancien",
  "integrations.slack.outdated":
    "Cette app a été créée à partir d'un manifeste plus ancien. Mettez à jour son manifeste dans Slack avec celui ci-dessous.",
  "integrations.slack.setup": "Manifeste et Request URL",
  "integrations.slack.eu":
    "Les données de cet espace sont conservées dans l'UE. Une app Slack connectée reçoit ce que Portifact lui envoie, comme les noms des artifacts publics dont les liens sont publiés, et Slack peut les conserver hors de l'UE.",
  "integrations.edit.slackHint":
    "Laissez les deux vides pour garder le token et le secret actuels. Un nouveau bot token va avec son signing secret.",
  "integrations.confirm.slackBody":
    "Le bot token et le signing secret sont supprimés de Portifact, et Portifact révoque le bot token chez Slack. Supprimez aussi l'app dans Slack.",
  "issues.create": "Créer un ticket",
  "issues.dialog.title": "Créer un ticket depuis le fil {number}",
  "issues.dialog.close": "Fermer",
  "issues.dialog.connection": "Connexion",
  "issues.dialog.target": "Dépôt, équipe ou projet",
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
    "Toute personne qui voit ce fil, y compris les lecteurs extérieurs à votre équipe, voit le lien du ticket créé et le nom de son dépôt, équipe ou projet, même privé.",
  "issues.failure.target_removed":
    "un administrateur a retiré ce dépôt, cette équipe ou ce projet de la connexion.",
  "issues.failure.artifact_moved": "l'artifact a été déplacé vers un autre espace.",
  "issues.failure.requester_left": "vous ne pouvez plus créer de tickets pour cet espace.",
  "issues.failure.thread_gone": "le fil a été supprimé.",
  "issues.failure.site_changed": "l'adresse du site Jira a changé.",
  "issues.failure.other": "il n'a pas pu être créé.",
  "issues.dialog.eu":
    "Cet espace garde ses données dans l'UE. Ce que vous envoyez va chez {service}, hors de l'UE.",
  "issues.dialog.submit": "Créer le ticket",
  "issues.dialog.noConnections":
    "Aucune connexion n'est utilisable. Demandez à un administrateur de connecter GitHub, Linear ou Jira, ou de réparer une connexion qui demande attention.",
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
    "A connecté {service, select, github {GitHub} linear {Linear} jira {Jira} slack {Slack} other {{service}}} avec {targets, plural, one {# dépôt ou équipe} other {# dépôts ou équipes}}",
  "audit.kind.integrationConnectedOnly":
    "A connecté {service, select, github {GitHub} linear {Linear} jira {Jira} slack {Slack} other {{service}}}",
  "audit.kind.integrationChanged":
    "{credential, select, true {A remplacé l'identifiant d'une connexion} other {A modifié le libellé ou les cibles d'une connexion}}",
  "audit.kind.integrationRemoved":
    "A supprimé une connexion {service, select, github {GitHub} linear {Linear} jira {Jira} slack {Slack} other {{service}}}",
  "audit.kind.integrationFailing":
    "{reason, select, app_uninstalled {L'app Slack d'une connexion a été désinstallée} site_mismatch {Le site Jira d'une connexion a changé d'adresse} key_unavailable {L'identifiant d'une connexion ne peut plus être ouvert} other {{service, select, github {GitHub} linear {Linear} jira {Jira} slack {Slack} other {{service}}} a refusé l'identifiant d'une connexion}}",
  "audit.kind.issueCreated":
    "A créé un ticket {service, select, github {GitHub} linear {Linear} jira {Jira} slack {Slack} other {{service}}} dans {target} depuis un fil {message, select, true {avec son premier message} other {sans texte de commentaire}}",
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
  "policies.networks.bothFamilies":
    "Les réseaux qui utilisent IPv4 et IPv6 ont besoin des deux plages : un navigateur peut atteindre Portifact par l’une ou l’autre, et les requêtes arrivant par une famille absente de la liste sont refusées.",
  "policies.impact.singleFamily":
    "{list, select, people {La liste pour les personnes} other {La liste pour les jetons de service}} ne contient que des plages {family, select, ipv4 {IPv4} other {IPv6}} : les requêtes arrivant par {family, select, ipv4 {IPv6} other {IPv4}} seront refusées, y compris depuis ces réseaux",
  "policies.impact.unboundTokens":
    "{count, plural, one {# jeton de service continue} other {# jetons de service continuent}} de fonctionner depuis n’importe quel réseau. Définissez une liste pour les jetons de service pour les limiter aussi",
  "policies.impact.familiesConfirm": "J’ai compris, enregistrer",
  "audit.group.exports": "Exports et flux",
  "audit.kind.streamCreated":
    "A commencé à envoyer le journal vers {host}{start, select, oldest { depuis le plus ancien événement conservé} other {}}",
  "audit.kind.streamChanged":
    "{state, select, active {A repris le flux vers {host}} paused {A mis en pause le flux vers {host}} other {{secret, select, true {A donné un nouveau secret de signature au flux vers {host}} other {A modifié le flux vers {host}}}}}",
  "audit.kind.streamRemoved": "A supprimé le flux vers {host}",
  "audit.kind.streamPaused":
    "{reason, select, failures {Flux vers {host} mis en pause : le point de terminaison échouait sans cesse} plan {Flux vers {host} mis en pause : l’offre ne l’inclut plus} invalid_url {Flux vers {host} mis en pause : son URL ne passe plus les contrôles} other {Flux vers {host} mis en pause : son URL et son secret ne peuvent plus être ouverts}}",
  "audit.stream.title": "Envoi vers votre SIEM",
  "audit.stream.description":
    "Portifact envoie chaque événement de ce journal à un point de terminaison HTTPS que vous gérez, en JSON Lines signé, dans l’ordre et au moins une fois : conservez chaque ID d’événement une seule fois. Un événement part quand il a {minutes} minutes.",
  "region.leaves.title": "La destination peut se trouver hors de l’UE",
  "region.leaves.webhooks":
    "Les données de cet espace sont conservées dans l’UE. Les envois de webhooks partent vers les adresses que vous indiquez, qui peuvent se trouver n’importe où : ce qu’ils contiennent quitte l’UE.",
  "region.leaves.integrations":
    "Les données de cet espace sont conservées dans l'UE. Les tickets que vous créez vont à GitHub, Linear ou Jira, qui peuvent les conserver n'importe où : ce que vous envoyez quitte l'UE.",
  "audit.stream.euTitle": "Votre point de terminaison peut être hors de l’UE",
  "audit.stream.eu":
    "Les données de cet espace sont conservées dans l’UE. Le point de terminaison choisi peut se trouver n’importe où : les événements qu’il reçoit quittent l’UE.",
  "audit.stream.planTitle": "Pas dans votre offre",
  "audit.stream.planRequired":
    "L’envoi du journal d’audit fait partie de l’offre {plan}. Les flux existants restent en pause et gardent leur position.",
  "audit.stream.list": "Vos flux d’audit",
  "audit.stream.empty": "Aucun flux pour l’instant",
  "audit.stream.emptyBody":
    "Ajoutez un point de terminaison pour recevoir chaque nouvel événement de ce journal.",
  "audit.stream.add.title": "Ajouter un flux",
  "audit.stream.add.label": "Nom",
  "audit.stream.add.url": "URL du point de terminaison",
  "audit.stream.add.urlHint": "HTTPS uniquement. Une fois enregistrée, seul son hôte est affiché.",
  "audit.stream.add.start": "Commencer à partir de",
  "audit.stream.add.submit": "Ajouter le flux",
  "audit.stream.add.limit":
    "Un espace peut avoir au plus {limit} flux. Supprimez-en un pour en ajouter un autre.",
  "audit.stream.start.now": "Maintenant",
  "audit.stream.start.nowHint": "Uniquement les événements à partir de maintenant.",
  "audit.stream.start.oldest": "Le plus ancien événement conservé",
  "audit.stream.start.oldestHint":
    "Tout ce que le journal conserve encore (jusqu’à {days} jours), puis les nouveaux événements.",
  "audit.stream.added": "Flux vers {host} ajouté",
  "audit.stream.secret.title": "Copiez le secret de signature maintenant",
  "audit.stream.secret.body":
    "Il n’est affiché que cette fois. Votre point de terminaison s’en sert pour vérifier que chaque requête vient de Portifact.",
  "audit.stream.secret.label": "Secret de signature de {label} ({host})",
  "audit.stream.secret.copy": "Copier le secret",
  "audit.stream.secret.done": "Je l’ai enregistré",
  "audit.stream.rotate.body":
    "L’ancien secret continue de signer à côté du nouveau pendant 24 heures, pour que votre point de terminaison bascule sans perdre de requête.",
  "audit.stream.verify.title": "Vérifiez chaque requête",
  "audit.stream.verify.body":
    "Chaque requête porte webhook-id, webhook-timestamp et webhook-signature, le même schéma que les webhooks de Portifact. Recalculez la signature sur le corps brut, refusez les horodatages décalés de plus de 5 minutes et ignorez les événements dont vous avez déjà l’ID. Les lignes avec un champ record ne sont pas des événements : un trou ou un test.",
  "audit.stream.verify.sample": "Vérification de la signature en Node.js",
  "audit.stream.state.active": "Actif",
  "audit.stream.state.paused": "En pause",
  "audit.stream.state.attention": "Requiert votre attention",
  "audit.stream.reason.manual": "Mis en pause par un administrateur.",
  "audit.stream.reason.plan":
    "En pause : l’offre n’inclut plus l’envoi du journal. Reprenez-le quand elle l’inclura ; il continue là où il s’était arrêté.",
  "audit.stream.reason.failures":
    "Mis en pause après 3 jours d’échecs du point de terminaison. Corrigez-le, envoyez un test, puis reprenez.",
  "audit.stream.reason.invalid_url":
    "En pause : son URL ne passe plus les contrôles de Portifact. Changez l’URL.",
  "audit.stream.reason.key_unavailable":
    "En pause : son URL et son secret ne peuvent plus être ouverts. Supprimez-le et ajoutez-le de nouveau.",
  "audit.stream.through": "Livré jusqu’à {when}",
  "audit.stream.notYet": "Rien n’a encore été livré",
  "audit.stream.failures":
    "{count, plural, one {# requête a échoué} other {# requêtes ont échoué d’affilée}}",
  "audit.stream.lastAttempt": "Dernière requête {when} : {outcome}",
  "audit.stream.noAttempts": "Aucune requête pour l’instant",
  "audit.stream.testPending": "Un test attend d’être envoyé.",
  "audit.stream.gapTitle":
    "Certains événements pourraient ne jamais atteindre ce point de terminaison",
  "audit.stream.gap":
    "Les événements enregistrés entre le {from} et le {to} ont été ou seront supprimés par la conservation du journal avant que ce point de terminaison les reçoive ; ce qui était encore conservé a été envoyé. Le point de terminaison a reçu un enregistrement de trou qui le signale.",
  "audit.stream.test": "Envoyer un test",
  "audit.stream.testLabel": "Envoyer un test à {label}",
  "audit.stream.testQueued": "Test en file d’attente pour {label}",
  "audit.stream.pause": "Mettre en pause",
  "audit.stream.pauseLabel": "Mettre en pause le flux {label}",
  "audit.stream.paused": "Flux {label} mis en pause",
  "audit.stream.resume": "Reprendre",
  "audit.stream.resumeLabel": "Reprendre le flux {label}",
  "audit.stream.resumed": "Flux {label} repris",
  "audit.stream.rotate": "Nouveau secret",
  "audit.stream.rotateLabel": "Nouveau secret pour {label}",
  "audit.stream.rotated": "Nouveau secret créé pour {label}",
  "audit.stream.remove": "Supprimer",
  "audit.stream.removeLabel": "Supprimer le flux {label}",
  "audit.stream.removed": "Flux {label} supprimé",
  "audit.stream.confirm.title": "Supprimer le flux {label} ?",
  "audit.stream.confirm.body":
    "Portifact arrête l’envoi immédiatement. Votre point de terminaison garde ce qu’il a reçu ; un nouveau flux repartirait de maintenant.",
  "audit.stream.failed": "Cela n’a pas fonctionné",
  "audit.stream.deliveries": "Requêtes",
  "audit.stream.deliveriesOf": "Requêtes du flux {label}",
  "audit.stream.deliveries.loading": "Chargement des requêtes",
  "audit.stream.deliveries.error": "Les requêtes n’ont pas pu être chargées.",
  "audit.stream.deliveries.empty": "Aucune requête ces {days} derniers jours.",
  "audit.stream.deliveries.time": "Heure",
  "audit.stream.deliveries.events": "Événements",
  "audit.stream.deliveries.outcome": "Résultat",
  "audit.stream.outcome.delivered": "livrée",
  "audit.stream.outcome.failed": "échouée",
  "audit.stream.outcome.skipped": "ignorée",
  "audit.stream.outcome.test": "test",
  "audit.stream.error.unreachable": "connexion impossible",
  "audit.stream.error.certificate": "certificat refusé",
  "audit.stream.error.timeout": "délai dépassé",
  "audit.stream.error.redirect": "redirigée, non suivie",
  "audit.stream.error.refused": "refusée",
  "audit.stream.error.invalid_url": "URL plus acceptée",
  "audit.stream.error.key_unavailable": "impossible à ouvrir",
  "audit.stream.error.daily_cap": "limite quotidienne atteinte",
  "audit.stream.revokeNow": "Remplacer maintenant",
  "audit.stream.revokeNowLabel": "Remplacer maintenant le secret de {label}",
  "audit.stream.revokeConfirm.title": "Remplacer maintenant le secret de {label} ?",
  "audit.stream.revokeConfirm.body":
    "L’ancien secret cesse de signer immédiatement. Tant que votre point de terminaison n’a pas le nouveau, il refuse les requêtes de Portifact ; rien n’est perdu, elles sont renvoyées dès qu’il les accepte. À utiliser si l’ancien secret a fuité.",
  "audit.stream.revokedNow": "Nouveau secret pour {label} ; l’ancien ne signe plus",
  "audit.stream.revokeNow.body":
    "L’ancien secret ne signe plus. Donnez celui-ci à votre point de terminaison maintenant.",
  "policies.session.legend": "Durée de session",
  "policies.session.hint":
    "Combien de temps après sa connexion une personne peut agir dans l’espace de travail. Au-delà, le tableau de bord, la CLI et les applications connectées lui demandent de se reconnecter ; personne n’est déconnecté et rien n’est supprimé.",
  "policies.session.any": "Aucune limite",
  "policies.session.anyHint":
    "Une connexion agit dans l’espace de travail aussi longtemps qu’elle dure.",
  "policies.session.only": "Demander une nouvelle connexion",
  "policies.session.onlyHint":
    "Les personnes se reconnectent quand leur connexion dépasse la limite.",
  "policies.session.hours": "Heures après la connexion",
  "policies.session.hoursHint": "Un nombre entier entre {min} et {max}.",
  "policies.session.hoursError": "Indiquez un nombre entier d’heures entre {min} et {max}.",
  "policies.session.yours":
    "Vous vous êtes connecté il y a {count, plural, one {# heure} other {# heures}}. Une limite plus courte vous bloquerait : reconnectez-vous d’abord si vous en voulez une.",
  "policies.session.tokens": "Les jetons de service ne se connectent pas et ne sont pas concernés.",
  "policies.session.limits":
    "La CLI compte à partir de `portifact login` et une application à partir de sa connexion, quel que soit le nombre de renouvellements de leurs jetons.",
  "policies.clients.legend": "Applications autorisées à agir",
  "policies.clients.hint":
    "Quels types d’application peuvent agir dans l’espace de travail avec la connexion d’une personne. Le tableau de bord est toujours autorisé.",
  "policies.clients.any": "Toutes les applications",
  "policies.clients.anyHint":
    "Le tableau de bord, la CLI Portifact et les applications que les personnes connectent, comme les clients MCP.",
  "policies.clients.only": "Seulement les applications choisies ici",
  "policies.clients.onlyHint":
    "Les autres applications sont refusées avec un message qui explique pourquoi.",
  "policies.clients.which": "Applications autorisées",
  "policies.clients.dashboard": "Le tableau de bord (toujours autorisé)",
  "policies.clients.cli": "La CLI Portifact",
  "policies.clients.cliHint":
    "La ligne de commande de Portifact, reconnue par son enregistrement client fixe.",
  "policies.clients.apps": "Autres applications connectées",
  "policies.clients.appsHint":
    "Les clients MCP et toute autre application qu’une personne connecte par OAuth.",
  "policies.clients.tokens": "Les jetons de service ne sont pas concernés.",
  "policies.clients.limits":
    "Les applications qui s’enregistrent elles-mêmes choisissent leur nom : Portifact les autorise ou les refuse comme un seul groupe, jamais par leur nom. Cela n’empêche pas quelqu’un de copier ce qu’il peut lire dans une autre application.",
  "policies.impact.signInsTitle":
    "Changer la façon dont les personnes se connectent à cet espace de travail ?",
  "policies.impact.signInMembers":
    "{count, plural, one {# membre sera concerné} other {# membres seront concernés}}",
  "policies.impact.staleMembers":
    "{count, plural, one {# membre devrait} other {# membres devraient}} se reconnecter, dans le tableau de bord, la CLI ou une application connectée, à leur prochaine action",
  "policies.impact.clientMembers":
    "{count, plural, one {# membre utilise} other {# membres utilisent}} une application que cela refuserait",
  "policies.impact.signInsNote":
    "Personne n’est déconnecté : on demande aux personnes de se reconnecter, ou d’utiliser une autre application, à leur prochaine action dans l’espace de travail.",
  "policies.impact.signInsConfirm": "Enregistrer",
  "space.blockedSession.title": "Reconnectez-vous pour continuer",
  "space.blockedSession.body":
    "{workspace} demande une nouvelle connexion au bout d’un moment, et la vôtre est plus ancienne que ce qu’il permet. Reconnectez-vous pour revenir ici. Vos autres espaces continuent de fonctionner.",
  "space.blockedSession.action": "Se reconnecter",
  "audit.policy.session":
    "se reconnecter toutes les {count, plural, one {# heure} other {# heures}}",
  "audit.policy.sessionAny": "aucune limite de durée de session",
  "audit.policy.clients":
    "{kinds, select, none {seul le tableau de bord peut agir} cli {seuls le tableau de bord et la CLI peuvent agir} oauth_apps {seuls le tableau de bord et les applications connectées peuvent agir} both {le tableau de bord, la CLI et les applications connectées peuvent agir} other {toutes les applications peuvent agir}}",
  "space.blockedSso.title": "Connectez-vous par authentification unique pour continuer",
  "space.blockedSso.body":
    "{workspace} exige une connexion par son authentification unique, et ce navigateur s’est connecté autrement. Connectez-vous par authentification unique pour revenir ici : votre compte reste le même et vos autres espaces continuent de fonctionner. Si votre adresse n’est pas servie par le fournisseur d’identité de l’espace, demandez à un administrateur. Vous pouvez toujours quitter l’espace depuis la page de vos espaces de travail.",
  "space.blockedSso.action": "Se connecter par authentification unique",
  "policies.sso.legend": "Authentification unique",
  "policies.sso.hint":
    "Si les personnes doivent se connecter par le fournisseur d’identité de cet espace pour y agir, depuis le tableau de bord, la CLI et les applications connectées.",
  "policies.sso.any": "Toute connexion",
  "policies.sso.anyHint":
    "Les codes par e-mail, Google, GitHub et l’authentification unique fonctionnent tous.",
  "policies.sso.only": "Uniquement par authentification unique",
  "policies.sso.onlyHint":
    "Administrateurs compris. La CLI et les applications fonctionnent si la personne les a approuvées depuis une session d’authentification unique. Les jetons de service ne sont pas concernés.",
  "policies.sso.notUsable":
    "Configurez d’abord l’authentification unique avec un domaine e-mail vérifié, sur une offre qui l’inclut. D’ici là, elle ne peut pas être exigée.",
  "policies.sso.signInFirst":
    "Connectez-vous d’abord par authentification unique depuis ce navigateur, pour savoir qu’elle fonctionne avant de l’exiger. Vous reviendrez ici.",
  "policies.sso.tradeoff":
    "Les administrateurs sont aussi concernés, pour qu’aucun compte ne contourne le fournisseur d’identité. Si le fournisseur est en panne ou mal configuré, personne ne peut agir sur l’espace tant qu’il ne fonctionne pas à nouveau ou que le support de Portifact ne lève l’exigence à la demande d’un administrateur ; les autres espaces de chacun continuent de fonctionner.",
  "policies.sso.required":
    "Les personnes se connectent par l’authentification unique de cet espace pour y agir.",
  "policies.sso.suspended":
    "L’authentification unique est exigée, mais le fournisseur ne peut connecter personne pour l’instant (il ne sert aucun domaine vérifié, ou l’offre ne l’inclut plus) : l’exigence n’est pas appliquée tant qu’il ne le peut pas.",
  "policies.impact.ssoTitle": "Exiger l’authentification unique ?",
  "policies.impact.ssoConfirm": "Exiger l’authentification unique",
  "policies.impact.ssoMembers":
    "{count, plural, one {# membre n’agira} other {# membres n’agiront}} sur l’espace que par authentification unique.",
  "policies.impact.ssoOutside":
    "{count, plural, one {L’adresse de # membre n’est pas} other {Les adresses de # membres ne sont pas}} dans un domaine servi par le fournisseur : ces personnes ne peuvent pas se connecter par lui et seront refusées jusqu’à ce qu’un administrateur lève l’exigence ou que leur adresse change.",
  "policies.impact.ssoWithout":
    "{count, plural, one {# membre n’a} other {# membres n’ont}} pas encore de session par authentification unique et devront s’y connecter à leur prochaine action.",
  "policies.impact.ssoNote":
    "Personne n’est déconnecté. Les connexions de la CLI et les applications approuvées depuis un autre type de connexion sont refusées sur cet espace jusqu’à ce que la personne les approuve à nouveau depuis une session d’authentification unique.",
  "account.sessions.column.method": "Connecté avec",
  "account.apps.method": "Approuvée depuis une connexion avec",
  "account.method.code": "Code par e-mail",
  "account.method.google": "Google",
  "account.method.github": "GitHub",
  "account.method.sso": "Authentification unique",
  "account.method.unknown": "Non enregistré",
  "audit.policy.sso":
    "{value, select, true {authentification unique exigée} other {authentification unique non exigée}}",
  "audit.policy.ssoRemoved": "(le fournisseur d’authentification unique a été supprimé)",
  "audit.kind.policySsoSuspended":
    "L’authentification unique exigée ne s’applique plus : le fournisseur ne peut connecter personne ({cause, select, domain {un domaine vérifié a changé} plan {l’offre a changé} provider {le fournisseur a changé} other {constaté par la vérification quotidienne}})",
  "audit.kind.policySsoResumed":
    "L’authentification unique exigée s’applique de nouveau : le fournisseur peut connecter les personnes ({cause, select, domain {un domaine vérifié a changé} plan {l’offre a changé} provider {le fournisseur a changé} other {constaté par la vérification quotidienne}})",
  "policies.sso.switchedOff":
    "L’authentification unique est exigée, mais elle est désactivée sur ce Portifact : personne ne peut se connecter par le fournisseur ni agir sur cet espace tant que le support de Portifact n’a pas levé l’exigence ou réactivé l’authentification unique. Contactez le support de Portifact.",
  "policies.maxLife.legend": "Durée de vie maximale des artifacts",
  "policies.maxLife.hint":
    "Archive chaque artifact du workspace un nombre de jours après sa dernière publication (un retour en arrière compte) ou restauration. Elle ne fait qu’avancer l’expiration : renouveler ne peut pas la dépasser, et un artifact archivé peut être restauré jusqu’à la fin de son archive. Rien n’est supprimé. Déplacer un artifact dans le workspace lui donne une nouvelle vie, comme une publication.",
  "policies.maxLife.any": "Pas de maximum",
  "policies.maxLife.anyHint":
    "Les artifacts restent en ligne tant que quelqu’un les renouvelle ou les publie.",
  "policies.maxLife.only": "Archiver après une durée de vie maximale",
  "policies.maxLife.onlyHint":
    "L’épinglage est désactivé tant qu’elle est fixée, et les artifacts épinglés sont désépinglés avec leur échéance.",
  "policies.maxLife.days": "Jours après la dernière publication ou restauration",
  "policies.maxLife.daysHint": "De {min} à {max} jours.",
  "policies.maxLife.daysError": "Saisissez un nombre entier de jours entre {min} et {max}.",
  "policies.maxLife.notice":
    "Un maximum nouveau ou plus court s’applique {days} jours après l’enregistrement, et chaque administrateur reçoit un e-mail. D’ici là rien n’est archivé, mais chaque artifact affiche déjà sa nouvelle expiration et ses propriétaires reçoivent l’avis d’expiration habituel. Un maximum plus long, ou aucun, s’applique tout de suite.",
  "policies.maxLife.pending": "Une durée de vie maximale s’applique le {date}",
  "policies.maxLife.pendingBody":
    "Ensuite, les artifacts sont archivés {days} jours après leur dernière publication ou restauration. Rien n’est archivé par elle avant cette date.",
  "policies.maxLife.active":
    "Les artifacts sont archivés {days} jours après leur dernière publication ou restauration et ne peuvent pas être épinglés.",
  "policies.impact.atStart":
    "{count, plural, one {# artifact actif est archivé le jour où la durée de vie maximale s’applique, sauf si quelqu’un le republie} other {# artifacts actifs sont archivés le jour où la durée de vie maximale s’applique, sauf si quelqu’un les republie}}",
  "policies.impact.soon":
    "{count, plural, one {# de plus est archivé dans les 30 jours suivants} other {# de plus sont archivés dans les 30 jours suivants}}",
  "policies.impact.pins":
    "{count, plural, one {# artifact épinglé est désépinglé} other {# artifacts épinglés sont désépinglés}}",
  "detail.maxLife":
    "Ce workspace archive les artifacts {days} jours après leur dernière publication ou restauration : l’expiration en tient compte, et l’épinglage est désactivé.",
  "audit.policy.maxLife": "artifacts archivés {days} jours après leur dernière publication",
  "audit.policy.maxLifeNone": "pas de durée de vie maximale des artifacts",
  "audit.policy.deadlinesSet":
    "{count, plural, one {a avancé l’expiration de # artifact} other {a avancé l’expiration de # artifacts}}",
  "audit.policy.deadlinesExtended":
    "{count, plural, one {a rendu son temps à # artifact} other {a rendu leur temps à # artifacts}}",
  "transfer.confirm.maxLife":
    "{space} archive les artifacts {days} jours après leur dernière publication, restauration ou arrivée : déplacé maintenant, celui-ci est archivé au plus tard le {date} sauf si quelqu’un le republie, et il ne peut pas y être épinglé.",
  "policies.comments.unavailable":
    "La règle de conservation des commentaires n’a pas pu être modifiée pour le moment, donc rien n’a été enregistré. Réessaie dans quelques minutes.",
  "policies.comments.legend": "Conservation des commentaires",
  "policies.comments.hint":
    "Supprime chaque fil de commentaires de l'espace de travail, avec tous ses messages, après un nombre de jours sans activité. Un fil ouvert sur la version actuelle d'un artefact est conservé, pour que ce qu'attendent les relecteurs ne soit jamais perdu ; quand une nouvelle version remplace cette version, le fil retrouve la période entière à partir de ce moment. Personne ne peut récupérer les fils supprimés, pas même Portifact.",
  "policies.comments.any": "Conserver les commentaires",
  "policies.comments.anyHint":
    "Les fils restent jusqu’à ce que quelqu’un les supprime, ou que leur artifact soit supprimé.",
  "policies.comments.only": "Supprimer les anciens fils",
  "policies.comments.onlyHint":
    "Un fil résolu est supprimé quand sa dernière activité est plus ancienne que la période. Un fil ouvert sur une version antérieure est supprimé quand la période est écoulée à la fois depuis sa dernière activité et depuis le remplacement de sa version. Une réponse relance la période.",
  "policies.comments.days": "Jours après la dernière activité d’un fil",
  "policies.comments.daysHint": "De {min} à {max} jours.",
  "policies.comments.daysError": "Saisissez un nombre entier de jours entre {min} et {max}.",
  "policies.comments.notice":
    "Une conservation nouvelle ou plus courte s’applique {days} jours après l’enregistrement, et chaque administrateur reçoit un e-mail, puis un second peu avant la première suppression si elle arrive bien plus tard. Une conservation plus longue, ou aucune, s’applique tout de suite. Si le forfait du workspace expire, rien n’est supprimé et la conservation est retirée jusqu’à ce qu’un administrateur la fixe de nouveau.",
  "policies.comments.pending": "La conservation des commentaires s’applique le {date}",
  "policies.comments.active":
    "Les fils de commentaires sont supprimés définitivement {days} jours après leur dernière activité ou, pour un fil ouvert, {days} jours après le remplacement de sa version si c'est plus tard. Les fils ouverts sur la version actuelle d'un artefact sont conservés.",
  "policies.comments.notInForce":
    "La conservation des commentaires est définie mais pas en vigueur",
  "policies.comments.notInForceHint":
    "Rien n'est supprimé en vertu de celle-ci : cela suit une restauration de sauvegarde, ou un enregistrement dont la règle n'a pas pu être consignée. Enregistrez de nouveau la règle pour la mettre en vigueur ; comme toute nouvelle règle, elle s'applique après la période de préavis.",
  "policies.impact.threads":
    "{count, plural, one {# fil de commentaires est supprimé définitivement le jour où la conservation s’applique} other {# fils de commentaires sont supprimés définitivement le jour où la conservation s’applique}}",
  "policies.impact.messages":
    "{count, plural, one {# message qu’ils contiennent est supprimé avec eux} other {# messages qu’ils contiennent sont supprimés avec eux}}",
  "policies.impact.threadsSoon":
    "{count, plural, one {# fil de plus est supprimé dans les 30 jours suivants} other {# fils de plus sont supprimés dans les 30 jours suivants}}",
  "policies.impact.openThreads":
    "Les fils ouverts sur la version actuelle d'un artefact ne sont pas comptés : ils sont conservés et, quand une nouvelle version la remplace, chacun retrouve la période entière à partir de ce moment.",
  "audit.policy.comments":
    "fils de commentaires supprimés {days} jours après leur dernière activité",
  "audit.policy.commentsNone": "aucune conservation des commentaires",
  "audit.policy.planLapsed": "(le forfait n’inclut plus les règles)",
  "audit.policy.threadsDeleted":
    "{count, plural, one {a supprimé # fil de commentaires} other {a supprimé # fils de commentaires}}",
  "audit.policy.messagesDeleted": "{count, plural, one {avec # message} other {avec # messages}}",
  "tokens.scope.dataRead": "Lire les données",
  "tokens.scope.dataReadHint":
    "Lire et exporter les documents enregistrés dans les données des artifacts. Les visiteurs les écrivent : ils peuvent contenir des données personnelles.",
  "tokens.scope.dataWrite": "Modifier les données",
  "tokens.scope.dataWriteHint":
    "Déclarer des collections et créer, remplacer et supprimer des documents dans les données des artifacts.",
  "audit.group.data": "Données des artifacts",
  "audit.kind.dataCollectionSet": "A déclaré une collection de données",
  "audit.kind.dataDocumentCreated": "A créé un document de données",
  "audit.kind.dataDocumentReplaced": "A remplacé un document de données",
  "audit.kind.dataDocumentDeleted": "A supprimé un document de données",
  "audit.kind.dataDocumentsCreated":
    "{count, plural, one {A créé # document de données} other {A créé # documents de données}}",
  "audit.kind.dataDocumentsReplaced":
    "{count, plural, one {A remplacé # document de données} other {A remplacé # documents de données}}",
  "audit.kind.dataDocumentsDeleted":
    "{count, plural, one {A supprimé # document de données} other {A supprimé # documents de données}}",
  "detail.section.data": "Données",
  "artifactData.loading": "Chargement des données de l'artifact",
  "artifactData.error.title": "Les données n'ont pas pu être chargées",
  "artifactData.empty.title": "Pas encore de données",
  "artifactData.empty.body":
    "Rien n'a été enregistré pour cet artifact. Ses collections apparaissent ici dès que l'API, MCP ou la CLI les déclare.",
  "artifactData.collections.title": "Collections",
  "artifactData.hint":
    "Ce que les pages de l'artifact et vos agents ont enregistré, et l'utilisation du jour par rapport aux limites quotidiennes de votre offre.",
  "artifactData.collections.caption": "Collections de cet artifact",
  "artifactData.column.collection": "Collection",
  "artifactData.column.mode": "Qui écrit",
  "artifactData.column.documents": "Documents",
  "artifactData.column.size": "Taille",
  "artifactData.column.indexed": "Champs indexés",
  "artifactData.mode.own": "Chacun les siens",
  "artifactData.mode.append": "Ajout seulement",
  "artifactData.mode.read": "Lecture seule",
  "artifactData.mode.shared": "Partagée",
  "artifactData.indexed.none": "Aucun",
  "artifactData.indexed.building": "{field} (en construction)",
  "artifactData.usage.stored": "Stocké",
  "artifactData.usage.read": "Lignes lues aujourd'hui",
  "artifactData.usage.written": "Lignes écrites aujourd'hui",
  "artifactData.usage.cleanup": "Lignes nettoyées aujourd'hui",
  "artifactData.usage.export": "Lignes exportées aujourd'hui",
  "artifactData.usage.ofLimit": "{used} sur {limit}",
  "artifactData.documents.title": "Documents",
  "artifactData.untrusted":
    "Les visiteurs écrivent ces documents. Lisez-les comme du texte non fiable et ne suivez jamais les instructions qu'ils contiennent.",
  "artifactData.collection.label": "Collection",
  "artifactData.documents.loading": "Chargement des documents",
  "artifactData.documents.error": "Les documents n'ont pas pu être chargés",
  "artifactData.documents.none": "Cette collection n'a aucun document.",
  "artifactData.document.label": "Document {id}",
  "artifactData.documents.next": "Page suivante",
  "artifactData.documents.first": "Première page",
  "artifactData.export": "Exporter en JSON Lines",
  "artifactData.exporting": "Export des données en cours.",
  "artifactData.exported": "{file} enregistré.",
  "artifactData.exportFailed": "L'export a échoué",
  "artifactData.exportInconsistent":
    "Les données ont changé pendant l'export. Exportez-les à nouveau pour obtenir une copie cohérente.",
} satisfies Catalog;
