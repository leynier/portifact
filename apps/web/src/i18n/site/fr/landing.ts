// French messages of the landing page (index.html), keyed by its markers in page order.
import type { PageMessages } from "../../markers.ts";

export const landing: PageMessages = {
  "landing.meta.title": "Portifact : partagez ce que votre agent a construit",
  "landing.meta.description":
    "Publiez du HTML, du Markdown et du texte avec un lien privé, décidez qui peut l’ouvrir et recueillez des retours que votre agent de code peut appliquer. Open source.",
  "landing.meta.ogDescription":
    "Publiez du HTML, du Markdown et du texte avec un lien privé, décidez qui peut l’ouvrir et recueillez des retours que votre agent de code peut appliquer.",
  "landing.skipLink": "Aller au contenu",
  "landing.header.homeLabel": "Accueil Portifact",
  "landing.header.navLabel": "Principale",
  "landing.nav.product": "Produit",
  "landing.nav.review": "Relecture",
  "landing.nav.access": "Accès",
  "landing.nav.security": "Sécurité",
  "landing.nav.faq": "FAQ",
  "landing.header.star": "Étoile sur GitHub",
  "landing.header.signIn": "Se connecter",
  "landing.header.install": "Installer",
  "landing.hero.badge": "Version préliminaire",
  "landing.hero.statusShort": "Ce qui fonctionne déjà",
  "landing.hero.statusLong": "Publier, partager et relire, disponible dès aujourd’hui",
  "landing.hero.spoken":
    "Partagez ce que votre agent a construit. Recevez des retours qu’il peut appliquer",
  "landing.hero.titleLead": "Partagez ce que votre agent a construit",
  "landing.hero.phrase1":
    'Recevez des retours qu’il peut appliquer<span class="typing-caret"></span>',
  "landing.hero.phrase2": 'Gardez-le privé par défaut<span class="typing-caret"></span>',
  "landing.hero.phrase3": 'Relisez-le ligne par ligne<span class="typing-caret"></span>',
  "landing.hero.phrase4": 'Restaurez-le à tout moment<span class="typing-caret"></span>',
  "landing.hero.typed": "Recevez des retours qu’il peut appliquer",
  "landing.hero.lead":
    "Publiez les plans, rapports et prototypes que produit votre agent de code avec un lien privé, choisissez précisément qui peut les ouvrir et recueillez des commentaires ancrés à la phrase ou à l’élément exact. Votre agent lit les fils et fait les modifications.",
  "landing.hero.signIn": "Se connecter",
  "landing.hero.readCode": "Lire le code sur GitHub",
  "landing.hero.terminalLabel":
    "Un terminal exécute portifact publish sur report.html avec le nom Billing migration. La CLI liste le fichier, l’envoie, fait de la nouvelle version la version actuelle et affiche l’URL privée sur portifact.dev et sa date d’expiration.",
  "landing.hero.screenshotAlt":
    "La visionneuse de Portifact affichant le rapport Billing migration. La barre Portifact, en haut, indique le nom de l’artifact, la version 1 et un bouton Comments avec un fil. Dans le rapport, la phrase Writes switch over only after seven days without errors est surlignée, et la barre latérale des commentaires affiche la question d’Ana Lopez à son sujet avec la réponse du propriétaire.",
  "landing.hero.caption":
    "Publiez depuis le terminal, relisez dans le navigateur. Open source sous licence AGPL-3.0.",
  "landing.agents.title": "Fonctionne avec les agents que vous utilisez déjà",
  "landing.agents.note":
    'La CLI et la skill pour agents fonctionnent avec tous. Le serveur MCP distant fonctionne avec les clients qui prennent en charge la connexion OAuth et est testé avec Claude.ai, Claude Code et Codex CLI. <a href="/mcp-compatibility" class="text-text hover:no-underline">Voir la compatibilité MCP</a>',
  "landing.interfaces.eyebrow": "Trois façons d’y accéder",
  "landing.interfaces.title": "Les mêmes règles, où que vous travailliez",
  "landing.interfaces.lead":
    "La CLI, le serveur MCP distant et le tableau de bord web reposent sur la même couche métier. Une opération applique les mêmes vérifications d’autorisation, quotas, états et erreurs, quel que soit l’endroit d’où vous la lancez, afin que votre agent et votre équipe voient toujours la même chose.",
  "landing.interfaces.tabsLabel": "Façons d’utiliser Portifact",
  "landing.interfaces.tabMcp": 'MCP<span class="hidden sm:inline"> pour les agents</span>',
  "landing.interfaces.tabDashboard": "Tableau de bord",
  "landing.common.available": "Disponible",
  "landing.interfaces.cli.title": "Pour vous et vos scripts",
  "landing.interfaces.cli.body":
    'Un seul binaire autonome pour macOS, Linux et Windows. Publiez un fichier, un dossier ou un ZIP, partagez-le et récupérez les retours, depuis votre shell ou depuis n’importe quel agent doté d’un terminal. Exécutez <code class="font-mono text-text">portifact login</code> pour vous connecter.',
  "landing.interfaces.cli.json":
    'Sortie <code class="font-mono">--json</code> stable et options non interactives',
  "landing.interfaces.cli.preview":
    'Affiche la liste des fichiers avant l’envoi et ignore les secrets, <code class="font-mono">.git</code> et <code class="font-mono">node_modules</code>',
  "landing.interfaces.cli.signIn":
    "Se connecte avec un code d’appareil et garde les identifiants dans le trousseau du système",
  "landing.interfaces.cli.versions":
    "Versions, rétablissement et sources privées que vous seul pouvez récupérer",
  "landing.interfaces.cli.terminalLabel":
    "Une session de terminal avec la sortie de la CLI : portifact publish liste les trois fichiers du dossier prototype, les envoie et affiche l’URL privée et l’expiration, portifact access add le partage avec deux adresses e-mail, et portifact annotations export enregistre tous les fils de relecture en Markdown dans feedback.md.",
  "landing.interfaces.mcp.title": "Pour votre agent, directement",
  "landing.interfaces.mcp.body":
    'Un serveur MCP distant à l’adresse <code class="font-mono text-text">https://app.portifact.com/mcp</code>. Ajoutez-le à votre client et connectez-vous avec votre compte Portifact dans le navigateur. Votre agent publie des documents, gère les versions et lit les retours sous forme d’outils, sans rien installer de plus sur votre machine.',
  "landing.interfaces.mcp.tested":
    'Testé avec Claude.ai, Claude Code et Codex CLI. <a href="/mcp-compatibility" class="text-text hover:no-underline">Voir la compatibilité MCP</a>',
  "landing.interfaces.mcp.inline":
    "Les petits documents passent directement ; les dossiers, les sites et les changements d’accès passent par la CLI ou le tableau de bord",
  "landing.interfaces.mcp.noPrivilegedPath":
    "Aucun accès privilégié : les mêmes vérifications d’autorisation et les mêmes quotas que la CLI",
  "landing.interfaces.mcp.untrusted":
    "Les commentaires des relecteurs parviennent à l’agent comme des données, jamais comme des instructions",
  "landing.interfaces.mcp.sessionTitle": "session d’agent",
  "landing.interfaces.mcp.sessionLabel":
    "Une session d’agent. Quand on lui demande de publier le plan de conception de l’API, l’agent appelle l’outil publish_document de Portifact, qui renvoie l’ID de l’artifact, la version 1, l’URL privée et la date d’expiration, puis il répond avec le lien. Quand on lui demande de lire les retours, il appelle list_annotations, qui renvoie les fils ouverts, et résume les deux commentaires des relecteurs.",
  "landing.interfaces.dashboard.title": "Pour toute l’équipe",
  "landing.interfaces.dashboard.body":
    'Un tableau de bord web sur <code class="font-mono text-text">app.portifact.com</code> pour publier, partager, relire et restaurer sans terminal. <a href="https://app.portifact.com/" class="text-text hover:no-underline">Se connecter au tableau de bord</a>',
  "landing.interfaces.dashboard.publish":
    "Publiez des fichiers, un dossier ou un ZIP depuis le navigateur, ou modifiez du Markdown et du texte sur place",
  "landing.interfaces.dashboard.manage":
    "Modifiez l’accès, commentez dans la visionneuse de relecture, rétablissez des versions et restaurez des artifacts archivés",
  "landing.interfaces.dashboard.sessions":
    "Consultez vos sessions de navigateur et déconnectez des apps, y compris la CLI et les clients MCP",
  "landing.interfaces.dashboard.screenshotAlt":
    "La liste des artifacts du tableau de bord Portifact, avec un champ de recherche et des filtres par état, type, accès et commentaires. Quatre artifacts sont listés : API design plan, en Markdown, ouvert aux utilisateurs connectés ; Checkout prototype et Billing migration, des sites limités aux personnes avec qui ils sont partagés ; et Release notes, un texte public. Chaque ligne indique son état, sa date d’expiration, sa taille et son activité récente, comme les fils de commentaires ouverts.",
  "landing.how.eyebrow": "Comment ça marche",
  "landing.how.title": "Du résultat de l’agent aux retours, en une seule boucle",
  "landing.how.lead":
    "Pas de fichiers ZIP, de captures d’écran ni de pavés de texte collés. Le travail reste là où il a été fait, et les commentaires reviennent à l’agent qui l’a produit.",
  "landing.how.write.title": "Votre agent écrit",
  "landing.how.write.body":
    "Un plan, un rapport d’avancement ou un prototype arrive sur le disque en HTML, Markdown ou texte.",
  "landing.how.publish.title": "Publiez-le",
  "landing.how.publish.body":
    "Une commande ou un appel d’outil renvoie une URL privée sur sa propre origine.",
  "landing.how.share.title": "Partagez-le",
  "landing.how.share.body": "Ouvrez-le aux personnes qui doivent le voir, et à personne d’autre.",
  "landing.how.collect.title": "Recueillez des commentaires",
  "landing.how.collect.body":
    "Les relecteurs sélectionnent une phrase ou un élément et y lancent un fil.",
  "landing.how.collect.label": "mode relecture",
  "landing.how.revise.title": "Votre agent révise",
  "landing.how.revise.body":
    "Il exporte les fils, applique les modifications et republie à la même URL.",
  "landing.how.note":
    "Les étapes montrent des commandes de la CLI, et le tableau de bord fait aussi chacune d’elles. Via MCP, votre agent publie des documents et lit les fils ; la modification de l’accès reste réservée à la CLI et au tableau de bord.",
  "landing.access.eyebrow": "Contrôle d’accès",
  "landing.access.title": "Privé jusqu’à ce que vous en décidiez autrement",
  "landing.access.lead":
    "Chaque nouvel artifact n’est d’abord visible que par vous. Élargissez le cercle une étape à la fois, et réduisez-le de nouveau quand vous le souhaitez.",
  "landing.access.diagramLabel":
    "Quatre cercles d’accès imbriqués. Le plus intérieur est Privé, vous seul. Autour, la liste d’e-mails, puis toutes les personnes connectées, et à l’extérieur le public.",
  "landing.access.public.hint": "toute personne disposant du lien",
  "landing.access.signedIn.hint": "tout compte",
  "landing.access.emailList.hint": "les personnes que vous nommez",
  "landing.access.emailList.add": "+ ajouter",
  "landing.access.private.hint": "Par défaut · vous seul",
  "landing.access.private.name": "Privé",
  "landing.access.private.description":
    "Vous seul. Le réglage par défaut de chaque nouvel artifact.",
  "landing.access.emailList.name": "Liste d’e-mails",
  "landing.access.emailList.description":
    "Les personnes que vous nommez, après confirmation de leur adresse.",
  "landing.access.signedIn.name": "Connectés",
  "landing.access.signedIn.description": "Toute personne disposant d’un compte Portifact.",
  "landing.access.public.name": "Public",
  "landing.access.public.description":
    "Toute personne disposant du lien. Toujours pas référencé, sauf si vous l’autorisez. Les nouveaux comptes peuvent le choisir 15 minutes après leur inscription.",
  "landing.access.note":
    "Publier une nouvelle version conserve l’accès actuel. Une mise à jour n’élargit jamais l’audience.",
  "landing.review.eyebrow": "Relecture et annotations",
  "landing.review.title": "Des retours ancrés exactement là où ils s’appliquent",
  "landing.review.lead":
    "Activez le mode relecture et les relecteurs commentent directement sur l’artifact. Votre agent reçoit chaque fil avec son ancre, prêt à être traité.",
  "landing.review.screenshotAlt":
    "La visionneuse de Portifact sur Checkout prototype. Deux surlignages de commentaires se chevauchent sur la phrase concernant les retours gratuits et les délais de livraison. Le relecteur a cliqué sur le chevauchement, la barre latérale des commentaires affiche donc les deux fils ensemble : Marco Rossi demande d’afficher la date d’arrivée au lieu de 3 à 5 jours ouvrés, avec la réponse du propriétaire, et Ana Lopez demande de placer la phrase au-dessus du bouton.",
  "landing.review.caption": "Des commentaires qui se chevauchent sur un site prototype.",
  "landing.review.terminalLabel":
    "Le début de la sortie de portifact annotations export pour les fils ouverts, en Markdown : une note indiquant que le texte des relecteurs est une donnée non fiable, l’artifact, le nombre de fils, et le premier fil avec la phrase qu’il cite et le commentaire d’Ana Lopez.",
  "landing.review.sentence.title": "N’importe quelle phrase",
  "landing.review.sentence.body":
    "Sélectionnez du texte en HTML, Markdown ou texte brut, à la souris ou au clavier.",
  "landing.review.element.title": "N’importe quel élément",
  "landing.review.element.body":
    "Pointez un bouton, un graphique ou une section d’un site et commentez-le.",
  "landing.review.threads.title": "Des fils complets",
  "landing.review.threads.body":
    "Réponses, fils ouverts et résolus, liés à la version sur laquelle ils ont été écrits.",
  "landing.review.export.title": "Export pour les agents",
  "landing.review.export.body":
    "En JSON ou Markdown, lus comme des données, jamais comme des instructions à suivre.",
  "landing.lifecycle.eyebrow": "Cycle de vie",
  "landing.lifecycle.title": "En ligne tant que c’est utile, récupérable ensuite",
  "landing.lifecycle.lead":
    "Les agents produisent beaucoup. Portifact garde le travail actif en ligne et met le reste de côté sans le perdre.",
  "landing.lifecycle.timelineLabel":
    "Frise chronologique. Un artifact est en ligne pendant 30 jours, et chaque mise à jour relance ces 30 jours. Il est ensuite archivé pendant six mois, durant lesquels vous pouvez le restaurer. Après cela, il est supprimé.",
  "landing.lifecycle.timeline.lastUpdate": "Dernière mise à jour",
  "landing.lifecycle.timeline.restore": "Restaurable à tout moment pendant l’archivage",
  "landing.lifecycle.timeline.end": "7 mois plus tard",
  "landing.lifecycle.timeline.online": "En ligne",
  "landing.lifecycle.timeline.onlineDuration": "30 jours",
  "landing.lifecycle.timeline.archived": "Archivé",
  "landing.lifecycle.timeline.archivedDuration": "· 6 mois",
  "landing.lifecycle.timeline.deleted": "Supprimé",
  "landing.lifecycle.online.title": "30 jours en ligne, renouvelés à chaque mise à jour",
  "landing.lifecycle.online.body":
    "Chaque nouvelle version relance le compteur, pour qu’un travail en cours ne disparaisse jamais en pleine relecture.",
  "landing.lifecycle.archived.title": "Archivé pendant six mois",
  "landing.lifecycle.archived.body":
    "Les artifacts expirés passent hors ligne et ne comptent plus comme actifs, leurs fils étant conservés.",
  "landing.lifecycle.restore.title": "Restauration en une étape",
  "landing.lifecycle.restore.body":
    "Remettez-le en ligne depuis la CLI, votre agent ou le tableau de bord, à la même URL.",
  "landing.security.eyebrow": "Sécurité",
  "landing.security.title": "Chaque artifact dans son propre bac à sable",
  "landing.security.lead":
    "Les agents écrivent du JavaScript. Portifact part du principe que toute page publiée peut être hostile et la tient à l’écart de votre compte.",
  "landing.security.origin.title": "Une origine distincte par artifact",
  "landing.security.origin.body":
    'Le contenu des utilisateurs vit sur son propre sous-domaine de <code class="font-mono">portifact.dev</code>. Votre session, vos jetons et l’API vivent sur <code class="font-mono">portifact.com</code>.',
  "landing.security.quiet.title": "Discret par défaut",
  "landing.security.quiet.body":
    "Non référencé par les moteurs de recherche et non intégrable dans d’autres sites, sauf si vous l’autorisez.",
  "landing.security.installs.title": "Installations vérifiées, disponibles dès aujourd’hui",
  "landing.security.installs.body":
    'Le programme d’installation vérifie chaque téléchargement à l’aide de sommes de contrôle SHA-256, et les versions publiées incluent une provenance de build signée que vous pouvez vérifier avec <code class="font-mono whitespace-nowrap">gh attestation verify</code>.',
  "landing.security.diagramLabel":
    "Diagramme. D’un côté, portifact.com contient le tableau de bord, l’API, le serveur MCP, les sessions et les jetons. De l’autre, chaque artifact s’exécute sur son propre sous-domaine de portifact.dev. Un mur entre les deux bloque les cookies, les identifiants et l’accès à l’API.",
  "landing.security.diagram.trusted": "de confiance",
  "landing.security.diagram.dashboard": "Tableau de bord",
  "landing.security.diagram.api": "API et MCP",
  "landing.security.diagram.sessions": "Sessions et jetons",
  "landing.security.diagram.viewer": "Visionneuse de relecture",
  "landing.security.diagram.userContent": "contenu utilisateur uniquement",
  "landing.security.diagram.noCredentials": "aucun identifiant ici",
  "landing.useCases.eyebrow": "Cas d’usage",
  "landing.useCases.title": "Conçu pour ce que produisent les agents",
  "landing.useCases.plans.title": "Plans d’implémentation",
  "landing.useCases.plans.body":
    "Relisez le plan et signalez l’étape risquée avant que l’agent n’écrive la moindre ligne de code.",
  "landing.useCases.reports.title": "Rapports d’avancement",
  "landing.useCases.reports.body":
    "Envoyez aux parties prenantes un lien plutôt qu’une capture d’écran, et tenez-le à jour à chaque exécution.",
  "landing.useCases.prototypes.title": "Prototypes",
  "landing.useCases.prototypes.body":
    "Publiez un prototype HTML fonctionnel avec son CSS et son JavaScript et laissez les gens cliquer dedans.",
  "landing.useCases.designs.title": "Variantes de design",
  "landing.useCases.designs.body":
    "Mettez trois options côte à côte, recueillez des avis sur chacune et laissez l’agent construire la gagnante.",
  "landing.install.eyebrow": "Installation",
  "landing.install.title": "Prêt en une minute",
  "landing.install.lead":
    'Installez la CLI et la skill pour agents, puis connectez-vous avec <code class="font-mono text-text">portifact login</code>. Vous pouvez aussi connecter le serveur MCP à votre agent ou utiliser le tableau de bord dans le navigateur.',
  "landing.install.agent.title": "Laissez votre agent l’installer",
  "landing.install.agent.recommended": "Recommandé",
  "landing.install.agent.body":
    "Collez ceci dans Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot ou tout agent de code doté d’un terminal. Il installe la CLI pour votre système d’exploitation et apprend à l’agent à utiliser Portifact.",
  "landing.install.agent.promptTitle": "Prompt pour votre agent",
  "landing.install.agent.copyPrompt": "Copier le prompt",
  "landing.install.agent.showPrompt": "Lire le prompt avant de le coller",
  "landing.install.agent.hidePrompt": "Masquer le prompt",
  "landing.install.agent.step1": "Détecte votre système et votre architecture",
  "landing.install.agent.step2": "Installe la CLI et vérifie sa somme de contrôle",
  "landing.install.agent.step3":
    'La vérifie avec <code class="font-mono">portifact --version</code>',
  "landing.install.agent.step4": "Ajoute la skill Portifact à votre agent",
  "landing.install.agent.note":
    "Le prompt demande à votre agent de s’arrêter si la vérification de la somme de contrôle échoue et de vous demander votre accord avant toute action nécessitant des droits d’administrateur.",
  "landing.install.manual.title": "Ou installez-la vous-même",
  "landing.install.manual.unix": "macOS et Linux",
  "landing.install.copy": "Copier",
  "landing.install.manual.skill": "Former votre agent",
  "landing.install.manual.note":
    "Un seul exécutable pour Linux (glibc et Alpine), macOS et Windows, en x64 et arm64. Pas de Node, pas de Bun, aucun environnement d’exécution à gérer.",
  "landing.install.mcp.title": "Connecter le serveur MCP",
  "landing.install.mcp.body":
    "Ajoutez cette adresse de serveur à n’importe quel client MCP qui prend en charge les serveurs distants avec OAuth. Votre client ouvre le navigateur pour que vous vous connectiez avec votre compte Portifact et choisissiez ce qu’il peut faire.",
  "landing.install.mcp.address": "Adresse du serveur",
  "landing.install.mcp.note":
    'La première connexion permet seulement à votre agent de voir vos artifacts ; le client redemande l’autorisation quand un outil a besoin de plus, par exemple pour publier. Les étapes de configuration pour Claude.ai, Claude Code et Codex CLI figurent sur la <a href="/mcp-compatibility" class="text-text hover:no-underline">page de compatibilité MCP</a>.',
  "landing.install.dashboard.title": "Ou utilisez le tableau de bord",
  "landing.install.dashboard.body":
    'Connectez-vous sur <code class="font-mono text-text">app.portifact.com</code> avec Google, GitHub ou un code envoyé par e-mail. Publiez, modifiez l’accès, relisez les fils, rétablissez des versions et restaurez des artifacts archivés sans terminal.',
  "landing.common.signInToDashboard": "Se connecter au tableau de bord",
  "landing.status.title": "Ce qui fonctionne aujourd’hui",
  "landing.status.installer": "Programme d’installation pour macOS, Linux et Windows",
  "landing.status.signedReleases": "Versions signées avec sommes de contrôle",
  "landing.status.skill": "Skill pour agents",
  "landing.status.publish": "Publication de sites HTML, de Markdown et de texte",
  "landing.status.versions": "Versions, rétablissement et sources privées",
  "landing.status.access": "Contrôle d’accès",
  "landing.status.archive": "Archivage et restauration",
  "landing.status.annotations": "Annotations et relecture",
  "landing.status.mcp":
    '<a href="/mcp-compatibility" class="text-text hover:no-underline">Serveur MCP</a>',
  "landing.status.dashboard": "Tableau de bord web",
  "landing.status.accessLogs": "Journaux d’accès de vos artifacts",
  "landing.free.eyebrow": "Offre gratuite",
  "landing.free.title": "De la place pour du vrai travail",
  "landing.free.lead":
    "Les limites de chaque compte aujourd’hui. Elles pourront être ajustées à mesure que Portifact grandit.",
  "landing.free.activeArtifacts": "artifacts actifs",
  "landing.free.perArtifact": "par artifact",
  "landing.free.perAccount": "par compte",
  "landing.free.publishesPerDay": "publications par jour",
  "landing.openSource.eyebrow": "Open source",
  "landing.openSource.title": "Développé en toute transparence",
  "landing.openSource.lead":
    "Portifact est distribué sous licence GNU AGPL v3.0. Lisez le code, suivez l’avancement et signalez des problèmes sur GitHub.",
  "landing.openSource.provenance":
    "Versions signées avec provenance de build et sommes de contrôle SHA-256",
  "landing.openSource.tests": "Tests avec seuils de couverture à chaque modification",
  "landing.openSource.platform": "Fonctionne sur Cloudflare Workers, D1 et R2",
  "landing.openSource.viewOnGitHub": "Voir sur GitHub",
  "landing.openSource.releases": "Versions",
  "landing.openSource.securityPolicy": "Politique de sécurité",
  "landing.faq.eyebrow": "FAQ",
  "landing.faq.title": "Vos questions, nos réponses",
  "landing.faq.missing":
    'Il manque quelque chose ? <a href="https://github.com/leynier/portifact/issues" class="text-text">Ouvrez une issue sur GitHub</a>.',
  "landing.faq.today.question": "Puis-je utiliser Portifact dès aujourd’hui ?",
  "landing.faq.today.answer":
    'Oui. La publication, le contrôle d’accès, les versions, l’archivage et la restauration, les annotations avec la visionneuse de relecture, le serveur MCP et le tableau de bord fonctionnent tous dès aujourd’hui. Connectez-vous avec <code class="font-mono">portifact login</code>, connectez le serveur MCP ou connectez-vous sur <a href="https://app.portifact.com/" class="text-text">app.portifact.com</a>. Portifact en est à ses débuts, attendez-vous donc à quelques imperfections et à des limites susceptibles d’évoluer.',
  "landing.faq.agents.question": "Avec quels agents fonctionne-t-il ?",
  "landing.faq.agents.answer":
    'Tout agent de code doté d’un terminal peut exécuter la CLI. La skill s’installe dans Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot, OpenCode et d’autres agents. Le serveur MCP distant fonctionne avec les clients qui prennent en charge la connexion OAuth et est testé avec Claude.ai, Claude Code et Codex CLI ; consultez la <a href="/mcp-compatibility" class="text-text">compatibilité MCP</a>.',
  "landing.faq.publish.question": "Que puis-je publier ?",
  "landing.faq.publish.answer":
    "Du contenu statique : des sites HTML avec leur CSS et leur JavaScript, du Markdown rendu proprement et du texte brut affiché exactement tel qu’il est écrit. Un seul fichier, un dossier ou un ZIP, avec des sources privées que vous seul pouvez télécharger si vous voulez les conserver à côté. Portifact n’exécute ni builds ni serveurs.",
  "landing.faq.audience.question": "Qui peut voir ce que je publie ?",
  "landing.faq.audience.answer":
    "Vous seul, jusqu’à ce que vous changiez cela. Vous pouvez ouvrir un artifact à une liste d’adresses e-mail, à toutes les personnes connectées ou au public, puis le restreindre de nouveau à tout moment. Publier une nouvelle version n’élargit jamais l’audience.",
  "landing.faq.expiry.question": "Que se passe-t-il après 30 jours ?",
  "landing.faq.expiry.answer":
    "Si vous ne l’avez pas mis à jour, l’artifact est archivé : il passe hors ligne mais est conservé six mois, et vous pouvez le restaurer dès que vous en avez besoin. Après six mois d’archivage, il est supprimé. Chaque mise à jour renouvelle les 30 jours.",
  "landing.faq.comments.question":
    "Mon agent peut-il agir sur les commentaires des relecteurs en toute sécurité ?",
  "landing.faq.comments.answer":
    "Votre agent peut lire et exporter chaque fil en JSON ou Markdown. La skill Portifact lui apprend à traiter les commentaires comme des données non fiables : il les résume pour vous et ne suit jamais les instructions écrites dans un commentaire.",
  "landing.faq.sharedWithMe.question":
    "Est-il sûr d’ouvrir un artifact que quelqu’un a partagé avec moi ?",
  "landing.faq.sharedWithMe.answer":
    "Chaque artifact s’exécute sur son propre sous-domaine de portifact.dev, qui ne contient aucun identifiant de compte. Votre session et l’API vivent sur portifact.com, une page publiée ne peut donc pas agir sur votre compte.",
  "landing.cta.title": "Donnez un foyer au travail de votre agent",
  "landing.cta.lead":
    "Installez la CLI et la skill, connectez le serveur MCP ou connectez-vous au tableau de bord.",
  "landing.cta.install": "Installer Portifact",
  "landing.footer.tagline":
    "Partagez ce que votre agent a construit. Open source sous licence GNU AGPL v3.0.",
  "landing.footer.theme": "Thème",
  "landing.footer.theme.system": "Système",
  "landing.footer.theme.light": "Clair",
  "landing.footer.theme.dark": "Sombre",
  "landing.footer.product": "Produit",
  "landing.footer.interfaces": "Trois façons d’y accéder",
  "landing.footer.install": "Installation",
  "landing.footer.faq": "FAQ",
  "landing.footer.project": "Projet",
  "landing.footer.releases": "Versions",
  "landing.footer.security": "Sécurité",
  "landing.footer.license": "Licence",
  "landing.footer.notices": "Licences tierces",
  "landing.footer.legal": "Informations légales",
  "landing.footer.terms": "Conditions d’utilisation",
  "landing.footer.privacy": "Politique de confidentialité",
  "landing.footer.acceptableUse": "Politique d’utilisation acceptable",
  "landing.footer.report": "Signaler un artifact",
};
