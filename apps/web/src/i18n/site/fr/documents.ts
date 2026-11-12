// French messages of the MCP compatibility page and the chrome of the legal pages, keyed by
// their markers. The legal texts themselves stay in English.
import type { PageMessages } from "../../markers.ts";

export const documents: PageMessages = {
  // Chrome of the legal pages (terms, privacy, acceptable-use), shared across the three.
  "legal.skip": "Aller au contenu",
  "legal.home": "Accueil Portifact",
  "legal.footer.license": "Portifact est open source sous licence GNU AGPL v3.0.",
  "legal.footer.nav": "Informations légales",
  "legal.footer.terms": "Conditions",
  "legal.footer.privacy": "Confidentialité",
  "legal.footer.acceptableUse": "Utilisation acceptable",
  "legal.footer.dpa": "Sous-traitance des données",
  "legal.terms.title": "Conditions d’utilisation : Portifact",
  "legal.terms.description":
    "Les conditions d’utilisation de Portifact, le service qui publie des artifacts statiques avec contrôle d’accès et relecture.",
  "legal.privacy.title": "Politique de confidentialité : Portifact",
  "legal.privacy.description":
    "Quelles données Portifact conserve, pourquoi, pendant combien de temps, qui les traite et comment exercer vos droits.",
  "legal.acceptableUse.title": "Politique d’utilisation acceptable : Portifact",
  "legal.acceptableUse.description":
    "Ce que vous ne pouvez pas publier ni faire sur Portifact, comment signaler un abus et ce qui se passe quand les règles sont enfreintes.",
  "legal.dpa.title": "Accord de traitement des données : Portifact",
  "legal.dpa.description":
    "Les conditions dans lesquelles Portifact traite des données personnelles pour le compte de ses clients, avec les clauses contractuelles types et la liste des sous-traitants ultérieurs.",

  // MCP compatibility page.
  "mcp.meta.title": "Compatibilité MCP : Portifact",
  "mcp.meta.description":
    "Quels clients MCP fonctionnent avec le serveur MCP distant de Portifact, comment ils se connectent et à quoi s’attendre avec chacun.",
  "mcp.chrome.skip": "Aller au contenu",
  "mcp.chrome.home": "Accueil Portifact",
  "mcp.intro.title": "Compatibilité MCP",
  "mcp.intro.tested":
    'Dernier test le <time datetime="2026-11-08">8 novembre 2026</time>, avec Portifact 0.11.0. Le renouvellement du jeton de Codex CLI et les outils de commentaires ont été vérifiés de nouveau le même jour avec Portifact 0.13.0.',
  "mcp.intro.server":
    "Portifact fournit un serveur MCP distant à l’adresse <code>https://app.portifact.com/mcp</code> (Streamable HTTP). Ajoutez-le à votre client et connectez-vous avec votre compte Portifact dans le navigateur. La première connexion demande seulement à voir vos artifacts ; votre client redemande l’autorisation quand un outil a besoin de plus, par exemple pour publier ou supprimer.",
  "mcp.toc.title": "Sur cette page",
  "mcp.matrix.title": "Clients testés",
  "mcp.other.title": "Autres clients",
  "mcp.matrix.intro":
    "Chaque client a listé, publié, relu et supprimé un document. Les trois se connectent avec OAuth et PKCE et s’identifient avec un document de métadonnées client publié.",
  "mcp.matrix.caption": "Clients MCP testés avec Portifact",
  "mcp.matrix.client": "Client",
  "mcp.matrix.version": "Version",
  "mcp.matrix.protocol": "Protocole",
  "mcp.matrix.moreAccess": "Quand un outil a besoin de plus d’accès",
  "mcp.matrix.status": "Statut",
  "mcp.matrix.claudeAiVersion": "Web, novembre 2026",
  "mcp.matrix.notRecorded": "Non enregistré",
  "mcp.matrix.claudeAiMoreAccess": "Vous demande de l’autoriser dans le navigateur",
  "mcp.matrix.works": "Fonctionne",
  "mcp.matrix.claudeCodeMoreAccess":
    "Vous indique d’exécuter <code>/mcp</code> et de vous reconnecter",
  "mcp.matrix.codexMoreAccess":
    "L’appel échoue ; reconnectez-vous avec les autorisations nécessaires",
  "mcp.claudeAi.body":
    "Ajoutez un connecteur personnalisé avec l’adresse du serveur et connectez-vous. La première fois que Claude publie, il vous demande d’autoriser aussi la publication. Le connecteur affiche 24 outils : 9 en lecture seule et 15 qui écrivent ou suppriment.",
  "mcp.claudeCode.body":
    "Ajoutez le serveur avec <code>claude mcp add --transport http portifact https://app.portifact.com/mcp</code>, puis choisissez-le dans <code>/mcp</code> et connectez-vous. Quand un outil a besoin d’un accès que vous n’avez pas encore accordé, l’appel échoue avec un message qui nomme l’autorisation manquante. Exécutez <code>/mcp</code>, choisissez Re-authenticate et accordez-la ; Claude Code conserve ce que vous avez autorisé auparavant. Les exécutions non interactives (<code>claude -p</code>) ne peuvent pas se connecter, faites-le donc d’abord dans une session interactive.",
  "mcp.codex.body":
    "Ajoutez le serveur avec <code>codex mcp add portifact --url https://app.portifact.com/mcp</code> ; Codex lance la connexion immédiatement. Codex ne demande pas plus d’accès de lui-même, connectez-vous donc avec tout ce dont votre agent aura besoin, par exemple :",
  "mcp.codex.comments":
    "Ajoutez <code>annotations:read</code>, <code>annotations:write</code> ou <code>annotations:moderate</code> pour les outils de commentaires ; avec les trois, Codex a activé les commentaires, commenté, répondu, résolu et exporté les commentaires d’un document. Codex vous demande d’approuver les outils qui suppriment avant de les exécuter. Il renouvelle son accès de lui-même quand le jeton, valable une heure, expire.",
  "mcp.other.body":
    'Tout client qui prend en charge les serveurs MCP distants avec OAuth devrait fonctionner : Portifact suit la spécification d’autorisation MCP du 2026-07-28 et accepte aussi l’enregistrement dynamique des clients et les révisions du protocole de 2025. Si le vôtre ne fonctionne pas, la CLI <code>portifact</code> et la skill pour agents fonctionnent dans tout agent doté d’un shell. Faites-le-nous savoir sur <a href="https://github.com/leynier/portifact/issues">GitHub</a>.',
  "mcp.footer.license": "Portifact est open source sous licence GNU AGPL v3.0.",
  "mcp.footer.nav": "Informations légales",
  "mcp.footer.terms": "Conditions",
  "mcp.footer.privacy": "Confidentialité",
  "mcp.footer.acceptableUse": "Utilisation acceptable",
  "mcp.footer.dpa": "Sous-traitance des données",
};
