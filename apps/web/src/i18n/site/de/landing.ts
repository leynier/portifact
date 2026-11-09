// German messages of the landing page (index.html), keyed by its markers in page order.
import type { PageMessages } from "../../markers.ts";

export const landing: PageMessages = {
  "landing.meta.title": "Portifact: Teile, was dein Agent gebaut hat",
  "landing.meta.description":
    "Veröffentliche HTML, Markdown und Text mit einem privaten Link, entscheide, wer es öffnen darf, und sammle Feedback, mit dem dein Coding-Agent arbeiten kann. Open Source.",
  "landing.meta.ogDescription":
    "Veröffentliche HTML, Markdown und Text mit einem privaten Link, entscheide, wer es öffnen darf, und sammle Feedback, mit dem dein Coding-Agent arbeiten kann.",
  "landing.skipLink": "Zum Inhalt springen",
  "landing.header.homeLabel": "Portifact-Startseite",
  "landing.header.navLabel": "Hauptnavigation",
  "landing.nav.product": "Produkt",
  "landing.nav.review": "Review",
  "landing.nav.access": "Zugriff",
  "landing.nav.security": "Sicherheit",
  "landing.nav.faq": "FAQ",
  "landing.header.star": "Stern auf GitHub",
  "landing.header.signIn": "Anmelden",
  "landing.header.install": "Installieren",
  "landing.hero.badge": "Frühe Version",
  "landing.hero.statusShort": "Was heute schon geht",
  "landing.hero.statusLong": "Veröffentlichen, Teilen und Review sind heute verfügbar",
  "landing.hero.spoken":
    "Teile, was dein Agent gebaut hat. Hol dir Feedback, mit dem er arbeiten kann",
  "landing.hero.titleLead": "Teile, was dein Agent gebaut hat",
  "landing.hero.phrase1":
    'Hol dir Feedback, mit dem er arbeiten kann<span class="typing-caret"></span>',
  "landing.hero.phrase2": 'Halte es standardmäßig privat<span class="typing-caret"></span>',
  "landing.hero.phrase3": 'Reviewe es Zeile für Zeile<span class="typing-caret"></span>',
  "landing.hero.phrase4": 'Stell es jederzeit wieder her<span class="typing-caret"></span>',
  "landing.hero.typed": "Hol dir Feedback, mit dem er arbeiten kann",
  "landing.hero.lead":
    "Veröffentliche die Pläne, Berichte und Prototypen deines Coding-Agenten mit einem privaten Link, lege genau fest, wer sie öffnen darf, und sammle Kommentare, die am exakten Satz oder Element hängen. Dein Agent liest die Threads und überarbeitet.",
  "landing.hero.signIn": "Anmelden",
  "landing.hero.readCode": "Code auf GitHub lesen",
  "landing.hero.terminalLabel":
    "Ein Terminal führt portifact publish für report.html mit dem Namen Billing migration aus. Die CLI listet die Datei auf, lädt sie hoch, macht die neue Version zur aktuellen und gibt die private URL auf portifact.dev und das Ablaufdatum aus.",
  "landing.hero.screenshotAlt":
    "Der Portifact-Viewer mit dem Bericht Billing migration. Die Portifact-Leiste oben zeigt den Namen des Artifacts, Version 1 und einen Button Comments mit einem Thread. Im Bericht ist der Satz Writes switch over only after seven days without errors hervorgehoben, und die Kommentar-Seitenleiste zeigt die Frage von Ana Lopez dazu mit der Antwort des Eigentümers.",
  "landing.hero.caption":
    "Im Terminal veröffentlichen, im Browser reviewen. Open Source unter AGPL-3.0.",
  "landing.agents.title": "Funktioniert mit den Agenten, die du schon nutzt",
  "landing.agents.note":
    'Die CLI und der Agent-Skill funktionieren in allen. Der Remote-MCP-Server funktioniert in Clients, die die Anmeldung per OAuth unterstützen, und ist mit Claude.ai, Claude Code und Codex CLI getestet. <a href="/mcp-compatibility" class="text-text hover:no-underline">MCP-Kompatibilität ansehen</a>',
  "landing.interfaces.eyebrow": "Drei Zugänge",
  "landing.interfaces.title": "Dieselben Regeln, egal wo du arbeitest",
  "landing.interfaces.lead":
    "Die CLI, der Remote-MCP-Server und das Web-Dashboard sitzen auf derselben Domänenschicht. Eine Operation durchläuft dieselben Berechtigungsprüfungen, Kontingente, Status und Fehler, egal wo du sie startest, also sehen dein Agent und dein Team immer dasselbe.",
  "landing.interfaces.tabsLabel": "Wege, Portifact zu nutzen",
  "landing.interfaces.tabMcp": 'MCP<span class="hidden sm:inline"> für Agenten</span>',
  "landing.interfaces.tabDashboard": "Dashboard",
  "landing.common.available": "Verfügbar",
  "landing.interfaces.cli.title": "Für dich und deine Skripte",
  "landing.interfaces.cli.body":
    'Ein eigenständiges Binary für macOS, Linux und Windows. Veröffentliche eine Datei, einen Ordner oder ein ZIP, teile es und hol das Feedback zurück, in deiner Shell oder mit jedem Agenten, der ein Terminal hat. Führ <code class="font-mono text-text">portifact login</code> aus, um dich anzumelden.',
  "landing.interfaces.cli.json":
    'Stabile <code class="font-mono">--json</code>-Ausgabe und nicht interaktive Flags',
  "landing.interfaces.cli.preview":
    'Zeigt die Dateiliste vor dem Hochladen und lässt Geheimnisse, <code class="font-mono">.git</code> und <code class="font-mono">node_modules</code> aus',
  "landing.interfaces.cli.signIn":
    "Meldet sich mit einem Gerätecode an und speichert Zugangsdaten im Schlüsselbund des Systems",
  "landing.interfaces.cli.versions":
    "Versionen, Rollback und private Quellen, die nur du zurückholen kannst",
  "landing.interfaces.cli.terminalLabel":
    "Eine Terminalsitzung mit der Ausgabe der CLI: portifact publish listet die drei Dateien des Ordners prototype auf, lädt sie hoch und gibt die private URL und den Ablauf aus, portifact access add teilt es mit zwei E-Mail-Adressen, und portifact annotations export speichert alle Review-Threads als Markdown in feedback.md.",
  "landing.interfaces.mcp.title": "Direkt für deinen Agenten",
  "landing.interfaces.mcp.body":
    'Ein Remote-MCP-Server unter <code class="font-mono text-text">https://app.portifact.com/mcp</code>. Füge ihn zu deinem Client hinzu und melde dich im Browser mit deinem Portifact-Konto an. Dein Agent veröffentlicht Dokumente, verwaltet Versionen und liest Feedback als Werkzeuge, ohne zusätzliche Installation auf deinem Rechner.',
  "landing.interfaces.mcp.tested":
    'Getestet mit Claude.ai, Claude Code und Codex CLI. <a href="/mcp-compatibility" class="text-text hover:no-underline">MCP-Kompatibilität ansehen</a>',
  "landing.interfaces.mcp.inline":
    "Kleine Dokumente gehen direkt mit; Ordner, Websites und Zugriffsänderungen laufen über die CLI oder das Dashboard",
  "landing.interfaces.mcp.noPrivilegedPath":
    "Kein privilegierter Weg: dieselben Berechtigungsprüfungen und Kontingente wie in der CLI",
  "landing.interfaces.mcp.untrusted":
    "Kommentare von Reviewern erreichen den Agenten als Daten, nie als Anweisungen",
  "landing.interfaces.mcp.sessionTitle": "Agentensitzung",
  "landing.interfaces.mcp.sessionLabel":
    "Eine Agentensitzung. Auf die Bitte, den API-Designplan zu veröffentlichen, ruft der Agent das Portifact-Werkzeug publish_document auf, das die ID des Artifacts, Version 1, die private URL und das Ablaufdatum zurückgibt, und antwortet mit dem Link. Auf die Bitte, das Feedback zu lesen, ruft er list_annotations auf, das die offenen Threads zurückgibt, und fasst die beiden Kommentare der Reviewer zusammen.",
  "landing.interfaces.dashboard.title": "Für alle im Team",
  "landing.interfaces.dashboard.body":
    'Ein Web-Dashboard unter <code class="font-mono text-text">app.portifact.com</code> zum Veröffentlichen, Teilen, Reviewen und Wiederherstellen ohne Terminal. <a href="https://app.portifact.com/" class="text-text hover:no-underline">Im Dashboard anmelden</a>',
  "landing.interfaces.dashboard.publish":
    "Dateien, einen Ordner oder ein ZIP im Browser veröffentlichen oder Markdown und Text direkt bearbeiten",
  "landing.interfaces.dashboard.manage":
    "Zugriff ändern, im Review-Viewer kommentieren, Versionen zurücksetzen und archivierte Artifacts wiederherstellen",
  "landing.interfaces.dashboard.sessions":
    "Deine Browser-Sitzungen sehen und Apps trennen, auch die CLI und MCP-Clients",
  "landing.interfaces.dashboard.screenshotAlt":
    "Die Artifact-Liste im Portifact-Dashboard, mit einem Suchfeld und Filtern für Status, Typ, Zugriff und Kommentare. Vier Artifacts sind aufgeführt: API design plan, Markdown, offen für angemeldete Nutzer; Checkout prototype und Billing migration, Websites, die auf die Personen eingeschränkt sind, mit denen sie geteilt wurden; und Release notes, öffentlicher Text. Jede Zeile zeigt Status, Ablaufdatum, Größe und letzte Aktivität, etwa offene Kommentar-Threads.",
  "landing.how.eyebrow": "So funktioniert es",
  "landing.how.title": "Vom Ergebnis des Agenten zum Feedback, in einer Schleife",
  "landing.how.lead":
    "Keine ZIP-Dateien, Screenshots oder eingefügten Textwände. Die Arbeit bleibt, wo sie entstanden ist, und die Kommentare gehen an den Agenten zurück, der sie erstellt hat.",
  "landing.how.write.title": "Dein Agent schreibt",
  "landing.how.write.body":
    "Ein Plan, ein Fortschrittsbericht oder ein Prototyp landet als HTML, Markdown oder Text auf der Festplatte.",
  "landing.how.publish.title": "Veröffentlichen",
  "landing.how.publish.body":
    "Ein Befehl oder ein Werkzeugaufruf liefert eine private URL auf einem eigenen Origin.",
  "landing.how.share.title": "Teilen",
  "landing.how.share.body": "Öffne es für die Personen, die es sehen sollen, und sonst niemanden.",
  "landing.how.collect.title": "Kommentare sammeln",
  "landing.how.collect.body":
    "Reviewer markieren einen Satz oder ein Element und starten dazu einen Thread.",
  "landing.how.collect.label": "Review-Modus",
  "landing.how.revise.title": "Dein Agent überarbeitet",
  "landing.how.revise.body":
    "Er exportiert die Threads, übernimmt die Änderungen und veröffentlicht erneut unter derselben URL.",
  "landing.how.note":
    "Die Schritte zeigen CLI-Befehle, und das Dashboard kann jeden davon ebenfalls. Über MCP veröffentlicht dein Agent Dokumente und liest die Threads; Zugriffsänderungen bleiben bei der CLI und dem Dashboard.",
  "landing.access.eyebrow": "Zugriffskontrolle",
  "landing.access.title": "Privat, bis du es anders entscheidest",
  "landing.access.lead":
    "Jedes neue Artifact ist zunächst nur für dich sichtbar. Erweitere den Kreis Schritt für Schritt und verkleinere ihn wieder, wann immer du willst.",
  "landing.access.private.name": "Privat",
  "landing.access.private.description": "Nur du. Der Standard für jedes neue Artifact.",
  "landing.access.emailList.name": "E-Mail-Liste",
  "landing.access.emailList.description":
    "Die Personen, die du nennst, nachdem sie ihre Adresse bestätigt haben.",
  "landing.access.signedIn.name": "Angemeldet",
  "landing.access.signedIn.description": "Alle mit einem Portifact-Konto.",
  "landing.access.public.name": "Öffentlich",
  "landing.access.public.description":
    "Alle mit dem Link. Trotzdem nicht indexiert, außer du erlaubst es. Neue Konten können es 15 Minuten nach der Registrierung wählen.",
  "landing.access.note":
    "Eine neue Version behält den aktuellen Zugriff. Ein Update erweitert nie den Personenkreis.",
  "landing.access.diagramLabel":
    "Vier ineinanderliegende Zugriffskreise. Der innerste ist Privat, nur du. Um ihn herum die E-Mail-Liste, dann alle Angemeldeten und außen die Öffentlichkeit.",
  "landing.access.public.hint": "alle mit dem Link",
  "landing.access.signedIn.hint": "jedes Konto",
  "landing.access.emailList.hint": "Personen, die du nennst",
  "landing.access.emailList.add": "+ hinzufügen",
  "landing.access.private.hint": "Standard · nur du",
  "landing.review.eyebrow": "Review und Anmerkungen",
  "landing.review.title": "Feedback genau an der Stelle, um die es geht",
  "landing.review.lead":
    "Schalte den Review-Modus ein, und Reviewer kommentieren direkt im Artifact. Dein Agent bekommt jeden Thread mit seinem Anker, bereit zur Umsetzung.",
  "landing.review.screenshotAlt":
    "Der Portifact-Viewer mit Checkout prototype. Zwei Kommentar-Markierungen überlappen sich auf dem Satz über kostenlose Rücksendungen und Lieferzeiten. Der Reviewer hat auf die Überlappung geklickt, daher zeigt die Kommentar-Seitenleiste beide Threads zusammen: Marco Rossi bittet darum, statt 3 bis 5 Werktagen das Ankunftsdatum zu zeigen, mit der Antwort des Eigentümers, und Ana Lopez bittet darum, den Satz über den Button zu verschieben.",
  "landing.review.caption": "Überlappende Kommentare auf der Website eines Prototyps.",
  "landing.review.terminalLabel":
    "Der Anfang der Ausgabe von portifact annotations export für die offenen Threads, in Markdown: ein Hinweis, dass Text von Reviewern nicht vertrauenswürdige Daten sind, das Artifact, die Anzahl der Threads und der erste Thread mit dem zitierten Satz und dem Kommentar von Ana Lopez.",
  "landing.review.sentence.title": "Jeder Satz",
  "landing.review.sentence.body":
    "Markiere Text in HTML, Markdown oder reinem Text, mit der Maus oder der Tastatur.",
  "landing.review.element.title": "Jedes Element",
  "landing.review.element.body":
    "Zeig auf einen Button, ein Diagramm oder einen Abschnitt einer Website und kommentiere ihn.",
  "landing.review.threads.title": "Vollständige Threads",
  "landing.review.threads.body":
    "Antworten, offen und erledigt, gebunden an die Version, zu der sie geschrieben wurden.",
  "landing.review.export.title": "Export für Agenten",
  "landing.review.export.body":
    "JSON oder Markdown, gelesen als Daten, nie als zu befolgende Anweisungen.",
  "landing.lifecycle.eyebrow": "Lebenszyklus",
  "landing.lifecycle.title": "Online, solange es zählt, danach wiederherstellbar",
  "landing.lifecycle.lead":
    "Agenten produzieren viel. Portifact hält die aktive Arbeit online und räumt den Rest aus dem Weg, ohne ihn zu verlieren.",
  "landing.lifecycle.timelineLabel":
    "Zeitleiste. Ein Artifact ist 30 Tage online, und jedes Update startet die 30 Tage neu. Danach wird es sechs Monate archiviert, in denen du es wiederherstellen kannst. Anschließend wird es gelöscht.",
  "landing.lifecycle.timeline.lastUpdate": "Letztes Update",
  "landing.lifecycle.timeline.restore": "Jederzeit wiederherstellbar, solange archiviert",
  "landing.lifecycle.timeline.end": "7 Monate später",
  "landing.lifecycle.timeline.online": "Online",
  "landing.lifecycle.timeline.onlineDuration": "30 Tage",
  "landing.lifecycle.timeline.archived": "Archiviert",
  "landing.lifecycle.timeline.archivedDuration": "· 6 Monate",
  "landing.lifecycle.timeline.deleted": "Gelöscht",
  "landing.lifecycle.online.title": "30 Tage online, bei jedem Update verlängert",
  "landing.lifecycle.online.body":
    "Jede neue Version startet die Uhr neu, damit laufende Arbeit nie mitten im Review verschwindet.",
  "landing.lifecycle.archived.title": "Sechs Monate archiviert",
  "landing.lifecycle.archived.body":
    "Abgelaufene Artifacts gehen offline und zählen nicht mehr als aktiv, ihre Threads bleiben erhalten.",
  "landing.lifecycle.restore.title": "Wiederherstellen in einem Schritt",
  "landing.lifecycle.restore.body":
    "Hol es über die CLI, deinen Agenten oder das Dashboard zurück, unter derselben URL.",
  "landing.security.eyebrow": "Sicherheit",
  "landing.security.title": "Jedes Artifact in seiner eigenen Sandbox",
  "landing.security.lead":
    "Agenten schreiben JavaScript. Portifact geht davon aus, dass jede veröffentlichte Seite feindselig sein könnte, und hält sie von deinem Konto fern.",
  "landing.security.origin.title": "Ein eigener Origin pro Artifact",
  "landing.security.origin.body":
    'Nutzerinhalte liegen auf einer eigenen Subdomain von <code class="font-mono">portifact.dev</code>. Deine Sitzung, deine Tokens und die API liegen auf <code class="font-mono">portifact.com</code>.',
  "landing.security.quiet.title": "Standardmäßig unauffällig",
  "landing.security.quiet.body":
    "Nicht von Suchmaschinen indexiert und nicht in andere Websites einbettbar, außer du erlaubst es.",
  "landing.security.installs.title": "Verifizierte Installationen, schon heute",
  "landing.security.installs.body":
    'Der Installer prüft jeden Download gegen SHA-256-Prüfsummen, und Releases enthalten eine signierte Build-Provenienz, die du mit <code class="font-mono whitespace-nowrap">gh attestation verify</code> prüfen kannst.',
  "landing.security.diagramLabel":
    "Diagramm. Auf der einen Seite enthält portifact.com das Dashboard, die API, den MCP-Server, Sitzungen und Tokens. Auf der anderen Seite läuft jedes Artifact auf einer eigenen Subdomain von portifact.dev. Eine Wand dazwischen blockiert Cookies, Zugangsdaten und API-Zugriff.",
  "landing.security.diagram.trusted": "vertrauenswürdig",
  "landing.security.diagram.dashboard": "Dashboard",
  "landing.security.diagram.api": "API und MCP",
  "landing.security.diagram.sessions": "Sitzungen und Tokens",
  "landing.security.diagram.viewer": "Review-Viewer",
  "landing.security.diagram.userContent": "nur Nutzerinhalte",
  "landing.security.diagram.noCredentials": "keine Zugangsdaten hier",
  "landing.useCases.eyebrow": "Anwendungsfälle",
  "landing.useCases.title": "Gemacht für das, was Agenten erstellen",
  "landing.useCases.plans.title": "Umsetzungspläne",
  "landing.useCases.plans.body":
    "Prüfe den Plan und markiere den riskanten Schritt, bevor der Agent Code schreibt.",
  "landing.useCases.reports.title": "Fortschrittsberichte",
  "landing.useCases.reports.body":
    "Schick Stakeholdern einen Link statt eines Screenshots und halte ihn mit jedem Lauf aktuell.",
  "landing.useCases.prototypes.title": "Prototypen",
  "landing.useCases.prototypes.body":
    "Veröffentliche einen funktionierenden HTML-Prototyp mit CSS und JavaScript und lass andere sich durchklicken.",
  "landing.useCases.designs.title": "Designalternativen",
  "landing.useCases.designs.body":
    "Stell drei Optionen nebeneinander, sammle Meinungen zu jeder und lass den Agenten den Favoriten bauen.",
  "landing.install.eyebrow": "Installation",
  "landing.install.title": "In einer Minute eingerichtet",
  "landing.install.lead":
    'Installier die CLI und den Agent-Skill und melde dich dann mit <code class="font-mono text-text">portifact login</code> an. Du kannst auch den MCP-Server mit deinem Agenten verbinden oder das Dashboard im Browser nutzen.',
  "landing.install.agent.title": "Lass deinen Agenten es einrichten",
  "landing.install.agent.recommended": "Empfohlen",
  "landing.install.agent.body":
    "Füge das in Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot oder einen anderen Coding-Agenten mit Terminal ein. Es installiert die CLI für dein Betriebssystem und bringt dem Agenten bei, wie er Portifact nutzt.",
  "landing.install.agent.promptTitle": "Prompt für deinen Agenten",
  "landing.install.agent.copyPrompt": "Prompt kopieren",
  "landing.install.agent.showPrompt": "Lies den Prompt, bevor du ihn einfügst",
  "landing.install.agent.hidePrompt": "Prompt ausblenden",
  "landing.install.agent.step1": "Erkennt dein System und deine Architektur",
  "landing.install.agent.step2": "Installiert die CLI und prüft ihre Prüfsumme",
  "landing.install.agent.step3": 'Prüft sie mit <code class="font-mono">portifact --version</code>',
  "landing.install.agent.step4": "Fügt deinem Agenten den Portifact-Skill hinzu",
  "landing.install.agent.note":
    "Der Prompt weist deinen Agenten an, abzubrechen, wenn die Prüfsumme nicht stimmt, und dich vor allem zu fragen, was Administratorrechte braucht.",
  "landing.install.manual.title": "Oder installier es selbst",
  "landing.install.manual.unix": "macOS und Linux",
  "landing.install.copy": "Kopieren",
  "landing.install.manual.skill": "Bring es deinem Agenten bei",
  "landing.install.manual.note":
    "Eine ausführbare Datei für Linux (glibc und Alpine), macOS und Windows auf x64 und arm64. Kein Node, kein Bun, keine Runtime zu verwalten.",
  "landing.install.mcp.title": "MCP-Server verbinden",
  "landing.install.mcp.body":
    "Füge diese Serveradresse zu einem MCP-Client hinzu, der Remote-Server mit OAuth unterstützt. Dein Client öffnet den Browser, damit du dich mit deinem Portifact-Konto anmeldest und festlegst, was er tun darf.",
  "landing.install.mcp.address": "Serveradresse",
  "landing.install.mcp.note":
    'Die erste Anmeldung erlaubt deinem Agenten nur, deine Artifacts zu sehen; der Client fragt erneut, wenn ein Werkzeug mehr braucht, etwa zum Veröffentlichen. Die Einrichtung für Claude.ai, Claude Code und Codex CLI steht auf der <a href="/mcp-compatibility" class="text-text hover:no-underline">Seite zur MCP-Kompatibilität</a>.',
  "landing.install.dashboard.title": "Oder nutze das Dashboard",
  "landing.install.dashboard.body":
    'Melde dich unter <code class="font-mono text-text">app.portifact.com</code> mit Google, GitHub oder einem Code per E-Mail an. Veröffentliche, ändere den Zugriff, reviewe Threads, setz Versionen zurück und stell archivierte Artifacts wieder her, ganz ohne Terminal.',
  "landing.common.signInToDashboard": "Im Dashboard anmelden",
  "landing.status.title": "Was heute funktioniert",
  "landing.status.installer": "Installer für macOS, Linux und Windows",
  "landing.status.signedReleases": "Signierte Releases mit Prüfsummen",
  "landing.status.skill": "Agent-Skill",
  "landing.status.publish": "HTML-Websites, Markdown und Text veröffentlichen",
  "landing.status.versions": "Versionen, Rollback und private Quellen",
  "landing.status.access": "Zugriffskontrolle",
  "landing.status.archive": "Archivieren und Wiederherstellen",
  "landing.status.annotations": "Anmerkungen und Review",
  "landing.status.mcp":
    '<a href="/mcp-compatibility" class="text-text hover:no-underline">MCP-Server</a>',
  "landing.status.dashboard": "Web-Dashboard",
  "landing.status.accessLogs": "Zugriffsprotokolle für deine Artifacts",
  "landing.free.eyebrow": "Kostenloser Tarif",
  "landing.free.title": "Platz für echte Arbeit",
  "landing.free.lead":
    "Die Limits, die heute jedes Konto hat. Sie können angepasst werden, während Portifact wächst.",
  "landing.free.activeArtifacts": "aktive Artifacts",
  "landing.free.perArtifact": "pro Artifact",
  "landing.free.perAccount": "pro Konto",
  "landing.free.publishesPerDay": "Veröffentlichungen pro Tag",
  "landing.openSource.eyebrow": "Open Source",
  "landing.openSource.title": "Offen entwickelt",
  "landing.openSource.lead":
    "Portifact steht unter der GNU AGPL v3.0. Lies den Code, verfolge den Fortschritt und melde Probleme auf GitHub.",
  "landing.openSource.provenance":
    "Releases mit signierter Build-Provenienz und SHA-256-Prüfsummen",
  "landing.openSource.tests": "Tests mit Abdeckungsschwellen bei jeder Änderung",
  "landing.openSource.platform": "Läuft auf Cloudflare Workers, D1 und R2",
  "landing.openSource.viewOnGitHub": "Auf GitHub ansehen",
  "landing.openSource.releases": "Releases",
  "landing.openSource.securityPolicy": "Sicherheitsrichtlinie",
  "landing.faq.eyebrow": "FAQ",
  "landing.faq.title": "Fragen und Antworten",
  "landing.faq.missing":
    'Fehlt etwas? <a href="https://github.com/leynier/portifact/issues" class="text-text">Eröffne ein Issue auf GitHub</a>.',
  "landing.faq.today.question": "Kann ich Portifact heute schon nutzen?",
  "landing.faq.today.answer":
    'Ja. Veröffentlichen, Zugriffskontrolle, Versionen, Archivieren und Wiederherstellen, Anmerkungen mit dem Review-Viewer, der MCP-Server und das Dashboard funktionieren heute. Melde dich mit <code class="font-mono">portifact login</code> an, verbinde den MCP-Server oder melde dich unter <a href="https://app.portifact.com/" class="text-text">app.portifact.com</a> an. Portifact ist noch früh dran, rechne also mit Ecken und Kanten und Limits, die sich ändern können.',
  "landing.faq.agents.question": "Mit welchen Agenten funktioniert es?",
  "landing.faq.agents.answer":
    'Jeder Coding-Agent mit Terminal kann die CLI ausführen. Der Skill lässt sich in Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot, OpenCode und anderen Agenten installieren. Der Remote-MCP-Server funktioniert in Clients, die die Anmeldung per OAuth unterstützen, und ist mit Claude.ai, Claude Code und Codex CLI getestet; siehe <a href="/mcp-compatibility" class="text-text">MCP-Kompatibilität</a>.',
  "landing.faq.publish.question": "Was kann ich veröffentlichen?",
  "landing.faq.publish.answer":
    "Statische Inhalte: HTML-Websites mit ihrem CSS und JavaScript, sauber gerendertes Markdown und reinen Text, genau so angezeigt, wie er geschrieben ist. Eine einzelne Datei, einen Ordner oder ein ZIP, auf Wunsch mit privaten Quellen, die nur du herunterladen kannst. Portifact führt keine Builds oder Server aus.",
  "landing.faq.audience.question": "Wer kann sehen, was ich veröffentliche?",
  "landing.faq.audience.answer":
    "Nur du, bis du es änderst. Du kannst ein Artifact für eine Liste von E-Mail-Adressen, für alle Angemeldeten oder für die Öffentlichkeit öffnen und es jederzeit wieder einschränken. Eine neue Version erweitert nie den Personenkreis.",
  "landing.faq.expiry.question": "Was passiert nach 30 Tagen?",
  "landing.faq.expiry.answer":
    "Wenn du es nicht aktualisiert hast, wird das Artifact archiviert: Es geht offline, wird aber sechs Monate aufbewahrt, und du kannst es jederzeit wiederherstellen. Nach sechs Monaten im Archiv wird es gelöscht. Jedes Update verlängert die 30 Tage.",
  "landing.faq.comments.question": "Kann mein Agent sicher mit Kommentaren von Reviewern arbeiten?",
  "landing.faq.comments.answer":
    "Dein Agent kann jeden Thread lesen und als JSON oder Markdown exportieren. Der Portifact-Skill bringt ihm bei, Kommentare als nicht vertrauenswürdige Daten zu behandeln: Er fasst sie für dich zusammen und befolgt nie Anweisungen, die in einem Kommentar stehen.",
  "landing.faq.sharedWithMe.question":
    "Ist es sicher, ein Artifact zu öffnen, das jemand mit mir geteilt hat?",
  "landing.faq.sharedWithMe.answer":
    "Jedes Artifact läuft auf einer eigenen Subdomain von portifact.dev, die keine Zugangsdaten von Konten enthält. Deine Sitzung und die API liegen auf portifact.com, daher kann eine veröffentlichte Seite nicht in deinem Konto handeln.",
  "landing.cta.title": "Gib der Arbeit deines Agenten ein Zuhause",
  "landing.cta.lead":
    "Installier die CLI und den Skill, verbinde den MCP-Server oder melde dich im Dashboard an.",
  "landing.cta.install": "Portifact installieren",
  "landing.footer.tagline":
    "Teile, was dein Agent gebaut hat. Open Source unter der GNU AGPL v3.0.",
  "landing.footer.theme": "Design",
  "landing.footer.theme.system": "System",
  "landing.footer.theme.light": "Hell",
  "landing.footer.theme.dark": "Dunkel",
  "landing.footer.product": "Produkt",
  "landing.footer.interfaces": "Drei Zugänge",
  "landing.footer.install": "Installation",
  "landing.footer.faq": "FAQ",
  "landing.footer.project": "Projekt",
  "landing.footer.releases": "Releases",
  "landing.footer.security": "Sicherheit",
  "landing.footer.license": "Lizenz",
  "landing.footer.notices": "Hinweise zu Drittanbietern",
  "landing.footer.legal": "Rechtliches",
  "landing.footer.terms": "Nutzungsbedingungen",
  "landing.footer.privacy": "Datenschutzerklärung",
  "landing.footer.acceptableUse": "Richtlinie zur zulässigen Nutzung",
  "landing.footer.report": "Artifact melden",
};
