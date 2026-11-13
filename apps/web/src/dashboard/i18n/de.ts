// German messages of the dashboard (Germany, informal "du"), with the same keys as en.ts.
// Titles and buttons have no trailing period; no em dashes.
import { planTextDe } from "../../plans/i18n/de.ts";
import type { Catalog } from "./en.ts";

export const de = {
  ...planTextDe,
  "app.title": "Portifact",
  "app.pageTitle": "{page} · Portifact",
  "shell.skipLink": "Zum Inhalt springen",
  "shell.navigation": "Hauptnavigation",
  "shell.home": "Portifact-Dashboard",
  "shell.artifacts": "Artifacts",
  "shell.usageLink": "Nutzung",
  "shell.appsLink": "Apps",
  "shell.webhooksLink": "Webhooks",
  "shell.settingsLink": "Einstellungen",
  "shell.profileLink": "Profil",
  "shell.openNavigation": "Navigation öffnen",
  "shell.closeNavigation": "Navigation schließen",
  "shell.collapseSidebar": "Seitenleiste einklappen",
  "shell.expandSidebar": "Seitenleiste ausklappen",
  "shell.resizeSidebar": "Größe der Seitenleiste ändern",
  "shell.signOut": "Abmelden",
  "shell.signingOut": "Du wirst abgemeldet.",
  "shell.signOutFailed": "Die Abmeldung wurde nicht abgeschlossen. Versuch es noch einmal.",
  "shell.publishLink": "Veröffentlichen",
  "shell.dismiss": "Meldung schließen",
  "theme.legend": "Design",
  "theme.system": "System",
  "theme.light": "Hell",
  "theme.dark": "Dunkel",
  "copy.done": "In die Zwischenablage kopiert",
  "copy.failed":
    "Der Browser hat die Zwischenablage blockiert. Markiere den Text und kopiere ihn von Hand.",
  "copy.copied": "Kopiert",
  "shell.loadingAccount": "Dein Konto wird geladen",
  "shell.capacity.title": "Portifact schützt gerade seine Kapazität",
  "shell.capacity.new_artifacts":
    "Neue Artifacts können vorerst nicht erstellt werden. Updates deiner Artifacts funktionieren weiterhin, und deine Artifacts bleiben online.",
  "shell.capacity.publishing":
    "Neue Uploads sind vorerst pausiert, neue Kommentare eventuell auch. Deine Artifacts bleiben online, und du kannst weiterhin lesen, exportieren, löschen, verlängern und den Zugriff einschränken.",

  "language.title": "Sprache",
  "language.hint":
    "Die Sprache des Dashboards, der Anmeldeseiten und der E-Mails, die Portifact dir schickt.",
  "language.label": "Sprache",
  "language.description":
    "Wird in deinem Konto gespeichert, damit auch deine anderen Geräte sie verwenden.",
  "language.changed": "Das Dashboard ist jetzt auf Deutsch.",
  "language.loadFailed":
    "Die Sprache konnte nicht geladen werden. Prüfe deine Verbindung und versuch es noch einmal.",
  "language.saveFailed":
    "Die Sprache wurde in diesem Browser geändert, aber dein Konto konnte sie nicht speichern. Versuch es später noch einmal.",

  "list.title": "Artifacts",
  "list.description":
    "Alles, was du veröffentlicht hast. Die Liste wird aktualisiert, solange dieser Tab offen ist.",
  "list.loading": "Deine Artifacts werden geladen",
  "list.caption": "Deine Artifacts",
  "list.column.name": "Name",
  "list.column.state": "Status",
  "list.column.expires": "Läuft ab",
  "list.column.usage": "Größe",
  "list.column.activity": "Aktivität",
  "list.column.actions": "Schnellaktionen",
  "list.noVersion": "Keine Version",
  "list.versions": "{count, plural, one {# Version aufbewahrt} other {# Versionen aufbewahrt}}",
  "list.updated": "Aktualisiert {date}",
  "list.openThreads":
    "{count, plural, =0 {Keine offenen Threads} one {# offener Thread} other {# offene Threads}}",
  "list.lastComment": "Kommentare geändert {date}",
  "list.trafficNote": "Traffic wird für dein ganzes Konto gezählt, nicht pro Artifact.",
  "list.trafficLink": "Nutzung ansehen",
  "list.loadMore": "Mehr laden",
  "list.loadingMore": "Weitere Artifacts werden geladen",
  "list.count": "{count, plural, one {# Artifact angezeigt} other {# Artifacts angezeigt}}",
  "list.empty.title": "Noch keine Artifacts",
  "list.empty.body":
    "Veröffentliche eine HTML-Datei, einen Ordner, ein ZIP oder ein Dokument über den Button Veröffentlichen oder in deinem Terminal, dann erscheint es hier.",
  "list.error.title": "Deine Artifacts konnten nicht geladen werden",
  "list.refreshFailed.title": "Die Liste konnte nicht aktualisiert werden",
  "list.refreshFailed.body":
    "Sie zeigt den zuletzt geladenen Stand. Portifact versucht es gleich noch einmal.",
  "list.never": "Nie",
  "list.pinned": "Angeheftet",
  "list.column.access": "Zugriff",
  "list.captionFiltered": "Deine Artifacts, die zur Suche und zu den Filtern passen",
  "list.countFiltered":
    "{count, plural, one {# passendes Artifact angezeigt} other {# passende Artifacts angezeigt}}",
  "list.searching": "Deine Artifacts werden durchsucht",
  "list.noMatch.title": "Keine passenden Artifacts",
  "list.noMatch.body":
    "Versuch eine andere Suche oder setz die Filter zurück, um alle Artifacts zu sehen.",
  "list.access.public": "Öffentlich",
  "list.access.authenticated": "Angemeldete Nutzer",
  "list.access.restricted": "Eingeschränkt",
  "list.annotations.off": "Kommentare aus",
  "list.annotations.open": "Kommentare offen",
  "list.annotations.locked": "Kommentare gesperrt",
  "list.filter.label": "Artifacts durchsuchen und filtern",
  "list.filter.search": "Suche",
  "list.filter.searchPlaceholder": "Name oder ID",
  "list.filter.clearSearch": "Suche löschen",
  "list.filter.searchTooLong": "Suche nach höchstens {max} Zeichen",
  "list.filter.state": "Status",
  "list.filter.type": "Typ",
  "list.filter.access": "Zugriff",
  "list.filter.annotations": "Kommentare",
  "list.filter.expiring": "Ablauf",
  "list.expiring.soon": "Läuft in höchstens 3 Tagen ab",
  "list.filter.any": "Alle",
  "list.filter.open": "Filter",
  "list.filter.activeCount": "aktiv",
  "list.filter.sheetTitle": "Artifacts filtern",
  "list.filter.close": "Filter schließen",
  "list.filter.done": "Fertig",
  "list.filter.clear": "Filter zurücksetzen",
  "list.content.toggle": "Im Inhalt suchen",
  "list.content.toggleHint": "Findet Wörter im Text aktiver Artifacts, nicht nur in ihren Namen.",
  "list.content.search": "Im Inhalt suchen",
  "list.content.placeholder": "Wörter im Text",
  "list.content.caption": "Artifacts, deren Text zur Suche passt",
  "list.content.column.match": "Treffer",
  "list.content.file": "In {path}",
  "list.content.partial": "Teilweise indexiert: Ein Teil des Texts war zu groß für die Suche.",
  "list.content.count":
    "{count, plural, one {# Artifact, dessen Text passt} other {# Artifacts, deren Text passt}}",
  "list.content.searching": "Suche in deinen Artifacts",
  "list.content.noMatch.title": "Kein Text passt",
  "list.content.noMatch.body":
    "Jedes Wort muss im Text vorkommen. Archivierte Artifacts werden nicht durchsucht.",
  "list.content.error": "Die Suche ist fehlgeschlagen",
  "list.open": "Öffnen",
  "list.openLabel": "Veröffentlichtes {name} öffnen",
  "list.review": "Review",
  "list.reviewLabel": "{name} reviewen und kommentieren",
  "list.onboarding.lead":
    "Jedes Artifact bekommt einen eigenen Link, der privat bleibt, bis du festlegst, wer es sonst noch öffnen darf. Wähl den Weg, der zu deiner Arbeitsweise passt.",
  "list.onboarding.browser.title": "Im Browser hochladen",
  "list.onboarding.browser.body":
    "Zieh eine HTML-Datei, einen Ordner, ein ZIP oder ein Markdown-Dokument hierher.",
  "list.onboarding.browser.action": "Im Browser veröffentlichen",
  "list.onboarding.cli.title": "Im Terminal veröffentlichen",
  "list.onboarding.cli.body":
    "Installier die CLI, melde dich einmal an und veröffentliche dann eine Datei oder einen Ordner.",
  "list.onboarding.cli.install": "CLI installieren",
  "list.onboarding.cli.publish": "Datei veröffentlichen",
  "list.onboarding.cli.copy": "Befehl kopieren",
  "list.onboarding.mcp.title": "Lass deinen Agenten veröffentlichen",
  "list.onboarding.mcp.body":
    "Füge Portifact als Remote-MCP-Server in Claude, Codex, Cursor oder einem anderen MCP-Client hinzu und bitte deinen Agenten dann, zu veröffentlichen, was er gebaut hat.",
  "list.onboarding.mcp.url": "URL des MCP-Servers",
  "list.onboarding.mcp.copy": "URL kopieren",

  "detail.loading": "Das Artifact wird geladen",
  "detail.back": "Alle Artifacts",
  "detail.notFound.title": "Artifact nicht gefunden",
  "detail.notFound.body": "Es existiert nicht, wurde gelöscht oder gehört zu einem anderen Konto.",
  "detail.error.title": "Das Artifact konnte nicht geladen werden",
  "detail.facts": "Details",
  "detail.url": "URL",
  "detail.type": "Typ",
  "detail.state": "Status",
  "detail.access": "Zugriff",
  "detail.created": "Erstellt",
  "detail.updated": "Aktualisiert",
  "detail.expires": "Läuft ab",
  "detail.archived": "Archiviert",
  "detail.purge": "Endgültig gelöscht am",
  "detail.notSet": "Nicht festgelegt",
  "detail.link": "Link",
  "detail.copyLink": "Link kopieren",
  "detail.linkCopied": "Link kopiert",
  "detail.open": "Öffnen",
  "detail.lifecycleHint":
    "Eine Verlängerung hält es 30 weitere Tage online. Archivierte Artifacts gehen offline und werden später endgültig gelöscht; stell sie vorher wieder her.",
  "detail.comments.title": "Kommentare",
  "detail.comments.body":
    "Reviewer kommentieren genau bestimmte Sätze und Elemente. Lies, beantworte und erledige die Kommentare im Review-Viewer, wo auch dein Agent sie lesen kann.",
  "detail.comments.unavailable":
    "Kommentare können gelesen und hinzugefügt werden, solange das Artifact aktiv ist.",
  "detail.versions.title": "Versionen",
  "detail.versions.body":
    "Jede Veröffentlichung ist eine neue Version. Lade aufbewahrte Versionen im Verlauf herunter, vergleiche sie und setz auf sie zurück.",
  "detail.actions": "Aktionen",
  "detail.sectionsNav": "Bereiche des Artifacts",
  "sections.title": "Auf dieser Seite",
  "detail.section.overview": "Übersicht",
  "detail.section.sharing": "Freigabe",
  "detail.section.comments": "Kommentare",
  "detail.section.activity": "Aktivität",
  "detail.section.danger": "Gefahrenbereich",
  "detail.danger.body":
    "Beim Archivieren geht das Artifact offline; es wird später endgültig gelöscht, wenn du es nicht vorher wiederherstellst. Beim Löschen werden es und alle Versionen sofort und endgültig entfernt.",
  "detail.keepOnline.body": "Eine Verlängerung hält es 30 weitere Tage online.",
  "detail.restore.body":
    "Stell es wieder her, bevor es endgültig gelöscht wird, um es wieder online zu bringen.",
  "detail.noActions": "In diesem Status sind keine Aktionen verfügbar.",
  "detail.renew": "Um 30 Tage verlängern",
  "detail.pin": "Anheften",
  "detail.unpin": "Lösen",
  "detail.pinned.body": "Angeheftet: Es bleibt ohne Ablaufdatum online, bis du es löst.",
  "detail.pin.paid":
    "Anheften hält ein Artifact ohne Ablaufdatum online. Es ist Teil des Plans {plan}.",
  "detail.expiresNever": "Nie, es ist angeheftet",
  "detail.pinnedDone": "Artifact angeheftet. Es bleibt ohne Ablaufdatum online.",
  "detail.unpinnedDone": "Artifact gelöst. Es läuft jetzt am {date} ab.",
  "detail.archive": "Archivieren",
  "detail.restore": "Wiederherstellen",
  "detail.delete": "Löschen",
  "detail.renewed": "Artifact verlängert. Es läuft jetzt am {date} ab.",
  "detail.archivedDone":
    "Artifact archiviert. Es wird am {date} endgültig gelöscht, wenn du es nicht wiederherstellst.",
  "detail.restored": "Artifact wiederhergestellt. Es läuft am {date} ab.",
  "detail.deleted": "Artifact {name} gelöscht.",
  "detail.working": "Wird bearbeitet.",
  "detail.actionFailed.title": "Die Aktion wurde nicht abgeschlossen",
  "detail.confirmDelete.title": "{name} löschen?",
  "detail.confirmDelete.body":
    "Das Artifact wird sofort nicht mehr ausgeliefert und seine Dateien werden entfernt. Das kann nicht rückgängig gemacht werden.",
  "detail.confirmDelete.confirm": "Artifact löschen",
  "detail.confirmDelete.cancel": "Behalten",

  "accessSettings.title": "Zugriff",
  "accessSettings.loading": "Wird geladen, wer dieses Artifact öffnen darf",
  "accessSettings.loadFailed.title": "Die Zugriffseinstellungen konnten nicht geladen werden",
  "accessSettings.republish":
    "Eine neue Version ändert diese Einstellungen nie, eine erneute Veröffentlichung öffnet ein Artifact also nie für mehr Personen. Nur du kannst den Zugriff erweitern: hier, in der CLI oder über einen Agenten, dem du das Teilen erlaubt hast.",
  "accessSettings.suspended":
    "Dieses Artifact ist gesperrt, daher kann sein Zugriff nicht geändert werden.",
  "detail.suspended.title":
    "Gesperrt wegen eines möglichen Verstoßes gegen die Richtlinie zur zulässigen Nutzung",
  "detail.suspended.body":
    "Portifact hat dieses Artifact nach einer Prüfung gesperrt. Es wird niemandem ausgeliefert und kann weder geändert noch neu veröffentlicht werden. Grund: {reason}. Wenn du das für einen Fehler hältst, schreib an abuse@portifact.com und nenne die Adresse des Artifacts.",
  "detail.suspended.facts": "Die Tatsachen, auf die wir uns stützen",
  "detail.suspended.ground":
    "Die Grundlage (das Gesetz oder die Regel unserer Bedingungen) und warum sie gilt",
  "detail.suspended.notice":
    "Am {date} aufgrund einer erhaltenen Meldung entschieden. Ein Mensch hat diese Entscheidung getroffen.",
  "detail.suspended.review":
    "Am {date} nach unserer eigenen Prüfung entschieden. Ein Mensch hat diese Entscheidung getroffen.",
  "settings.suspended.title": "Ihr Konto ist gesperrt",
  "settings.suspended.body":
    "Portifact hat Ihr Konto gesperrt. Es kann nicht veröffentlichen, und seine Artifacts sind mit ihm gesperrt. Sie können sich weiterhin anmelden, Ihre Daten exportieren und Ihr Konto löschen. Grund: {reason}. Für eine Überprüfung schreiben Sie an abuse@portifact.com.",
  "branding.suspendedReason": "Grund: {reason}.",
  "reason.phishing": "Phishing oder eine gefälschte Anmeldeseite",
  "reason.malware": "Malware, Exploits oder Kryptomining",
  "reason.sexual_content": "sexuell explizite Inhalte",
  "reason.child_safety": "Inhalte, die Minderjährige sexualisieren",
  "reason.copyright": "Verletzung von Urheber- oder Markenrechten",
  "reason.impersonation": "Identitätsbetrug",
  "reason.harassment": "Drohungen, Belästigung oder gewalttätiger Extremismus",
  "reason.private_information": "private Informationen über eine Person",
  "reason.spam": "Spam",
  "reason.other": "ein anderer Regelverstoß",
  "accessSettings.mode.legend": "Wer dieses Artifact öffnen darf",
  "accessSettings.mode.restricted":
    "Du und die unten aufgeführten E-Mail-Adressen. Jede Person meldet sich mit dieser Adresse an, bevor es sich öffnet.",
  "accessSettings.mode.authenticated":
    "Alle mit dem Link, die sich bei Portifact anmelden, mit einem beliebigen Konto.",
  "accessSettings.mode.public": "Alle mit dem Link, ohne Anmeldung.",
  "accessSettings.mode.publicSlack":
    "Wenn dieser Bereich Slack verbunden hat, zeigt ein dort geposteter Link darauf seinen Namen und Typ, und Slack behält diese Vorschau, auch wenn das Artifact nicht mehr öffentlich ist.",
  "accessSettings.mode.publicFrom":
    "Verfügbar ab {date}. Neue Konten warten {minutes} Minuten, bevor sie ein Artifact öffentlich machen können.",
  "accessSettings.indexable.label": "Suchmaschinen dürfen es listen",
  "accessSettings.indexable.hint": "Gilt nur, solange das Artifact öffentlich ist.",
  "accessSettings.embeddable.label": "Andere Websites dürfen es einbetten",
  "accessSettings.embeddable.hint":
    "Andere Websites können es in einem Frame anzeigen. Gilt nur, solange das Artifact öffentlich ist.",
  "accessSettings.bar.label": "Portifact-Leiste anzeigen",
  "accessSettings.bar.hint":
    "Links öffnen sich im Viewer von Portifact, mit der Leiste oben und den Kommentaren neben dem Artifact. Schalte sie für Apps und Seiten aus, die das ganze Fenster brauchen; der Link öffnet dann nur das Artifact.",
  "accessSettings.comments.legend": "Wer Kommentare sieht",
  "accessSettings.comments.owner": "Nur du, und jede Person ihre eigenen",
  "accessSettings.comments.owner.hint":
    "Jede Person sieht die Threads, die sie begonnen hat, und die Threads, die du begonnen hast, jeweils mit allen Antworten. Du siehst alle Threads.",
  "accessSettings.comments.everyone": "Alle, die das Artifact öffnen können",
  "accessSettings.comments.everyone.hint":
    "Alle, die das Artifact öffnen können, sehen jeden Thread und können darauf antworten.",
  "accessSettings.comments.exceptions":
    "Für eine Person, die du hinzugefügt hast, kannst du neben ihrer Adresse unter Freigabe eine Ausnahme festlegen.",
  "accessSettings.comments.confirm.title": "Alle Kommentare für alle sichtbar machen?",
  "accessSettings.comments.confirm.body":
    "Auch bereits geschriebene Kommentare werden für alle sichtbar, die das Artifact öffnen können, nicht nur neue.",
  "accessSettings.comments.confirm.action": "Alle Kommentare zeigen",
  "accessSettings.cancel": "Abbrechen",
  "accessSettings.save": "Zugriff speichern",
  "accessSettings.saved":
    "Zugriff gespeichert. Wer das Artifact nicht mehr öffnen darf, verliert den Zugriff innerhalb einer Minute.",
  "accessSettings.unchanged": "Nichts zu speichern: Der Zugriff ist bereits so eingestellt.",
  "accessSettings.saveFailed.title": "Der Zugriff wurde nicht gespeichert",
  "accessSettings.conflict":
    "Der Zugriff wurde inzwischen an anderer Stelle geändert. Jetzt werden die neuesten Einstellungen angezeigt; prüf sie und versuch es noch einmal.",
  "accessSettings.tooNew":
    "Neue Konten können ein Artifact {minutes} Minuten nach ihrer Erstellung öffentlich machen, ab {date}.",
  "accessSettings.tooNewNoDate":
    "Neue Konten können ein Artifact {minutes} Minuten nach ihrer Erstellung öffentlich machen.",
  "accessSettings.readersFull":
    "Ein Artifact kann höchstens {max} Personen aufführen. Entferne jemanden, um eine weitere Person hinzuzufügen.",

  "settings.unsaved": "Nicht gespeicherte Änderungen",
  "linkSettings.title": "Link-Einstellungen",
  "linkSettings.description":
    "Wie sich der Link öffnet und ob Suchmaschinen und andere Websites ihn verwenden dürfen.",
  "linkSettings.save": "Link-Einstellungen speichern",
  "linkSettings.saved": "Link-Einstellungen gespeichert.",
  "linkSettings.unchanged": "Nichts zu speichern: Der Link ist bereits so eingestellt.",
  "linkSettings.saveFailed.title": "Die Link-Einstellungen wurden nicht gespeichert",
  "commentSettings.title": "Kommentar-Einstellungen",
  "commentSettings.mode.legend": "Kommentare zu diesem Artifact",
  "commentSettings.mode.open": "Offen",
  "commentSettings.mode.open.hint":
    "Wer das Artifact öffnen kann, darf kommentieren und antworten.",
  "commentSettings.mode.locked": "Gesperrt",
  "commentSettings.mode.locked.hint": "Kommentare bleiben lesbar; niemand kann neue hinzufügen.",
  "commentSettings.mode.off": "Aus",
  "commentSettings.mode.off.hint": "Kommentare sind ausgeblendet und niemand kann kommentieren.",
  "commentSettings.save": "Kommentar-Einstellungen speichern",
  "commentSettings.saved": "Kommentar-Einstellungen gespeichert.",
  "commentSettings.unchanged": "Nichts zu speichern: Die Kommentare sind bereits so eingestellt.",
  "commentSettings.saveFailed.title": "Die Kommentar-Einstellungen wurden nicht gespeichert",

  "readers.title": "Von dir hinzugefügte Personen",
  "readers.hint":
    "Sie können das Artifact öffnen, solange der Zugriff auf dich und die Personen, die du hinzufügst, eingestellt ist.",
  "readers.count": "{count} von {max} Personen",
  "readers.empty": "Noch niemand. Füge unten eine E-Mail-Adresse hinzu.",
  "readers.list": "Personen, die dieses Artifact öffnen dürfen",
  "readers.email.label": "E-Mail-Adresse",
  "readers.email.hint":
    "Die Person meldet sich mit genau dieser Adresse an, um das Artifact zu öffnen.",
  "readers.add": "Person hinzufügen",
  "readers.added": "{email} hinzugefügt.",
  "readers.remove": "Entfernen",
  "readers.removeLabel": "{email} entfernen",
  "readers.removed": "{email} entfernt. Der Zugriff endet innerhalb einer Minute.",
  "readers.invalid": "Gib eine E-Mail-Adresse ein, zum Beispiel ana@example.com.",
  "readers.duplicate": "{email} steht bereits auf der Liste.",
  "readers.full": "Die Liste ist voll: Ein Artifact kann höchstens {max} Personen haben.",
  "readers.failed.title": "Die Liste wurde nicht geändert",
  "readers.comments.label": "Kommentare, die {email} sieht",
  "readers.comments.inherit.owner": "Standard: eigene und deine",
  "readers.comments.inherit.everyone": "Standard: alle Kommentare",
  "readers.comments.all": "Alle Kommentare",
  "readers.comments.own": "Nur eigene und deine",
  "readers.comments.hint":
    "Im Menü neben jeder Person legst du fest, welche Kommentare sie sieht. Das gilt immer, wenn sie sich mit dieser Adresse anmeldet, in jedem Zugriffsmodus.",
  "readers.comments.changed": "{email} sieht jetzt: {choice}.",
  "readers.comments.confirm.title": "{email} alle Kommentare zeigen?",
  "readers.comments.confirm.body":
    "{email} sieht dann jeden Thread zu diesem Artifact, auch Kommentare, die andere Personen bereits geschrieben haben.",

  "profile.title": "Profil",
  "profile.description":
    "Wer du bei Portifact bist, wie du dich anmeldest und wo du angemeldet bist.",
  "profile.details": "Dein Konto",
  "profile.sectionsNav": "Bereiche des Profils",
  "account.name": "Name",
  "account.email": "E-Mail",
  "account.memberSince": "Mitglied seit",
  "account.methods.title": "Anmeldemethoden",
  "account.methods.hint":
    "Eine Anmeldung mit Google oder GitHub wird automatisch mit diesem Konto verknüpft, wenn sie dieselbe E-Mail-Adresse bestätigt.",
  "account.methods.loading": "Deine Anmeldemethoden werden geladen",
  "account.methods.error": "Die Anmeldemethoden konnten nicht geladen werden",
  "account.methods.email": "Code per E-Mail",
  "account.methods.emailDetail": "Codes werden an {email} gesendet",
  "account.methods.connected": "Verbunden am {date}",
  "provider.google": "Google",
  "provider.github": "GitHub",
  "account.sessions.title": "Browser-Sitzungen",
  "account.sessions.hint":
    "Browser, die in deinem Konto angemeldet sind. Geschützte Artifacts, die in einem Browser geöffnet sind, schließen sich innerhalb einer Minute, nachdem er abgemeldet wurde.",
  "account.sessions.loading": "Deine Browser-Sitzungen werden geladen",
  "account.sessions.error": "Die Browser-Sitzungen konnten nicht geladen werden",
  "account.sessions.caption": "Browser, die in deinem Konto angemeldet sind",
  "account.sessions.column.browser": "Browser",
  "account.sessions.column.lastActive": "Zuletzt aktiv",
  "account.sessions.column.expires": "Abgemeldet am",
  "account.sessions.this": "Dieser Browser",
  "account.sessions.device": "{browser} auf {system}",
  "account.sessions.unknown": "Unbekannter Browser",
  "account.sessions.signOutOthers": "Andere Sitzungen abmelden",
  "account.sessions.onlyThis": "Nur dieser Browser ist angemeldet.",
  "account.sessions.confirm.title": "Andere Sitzungen abmelden?",
  "account.sessions.confirm.body":
    "Alle anderen Browser werden sofort abgemeldet. Verbundene Apps wie die CLI und deine Agenten funktionieren weiter, bis du sie unten trennst.",
  "account.sessions.confirm.confirm": "Andere abmelden",
  "account.sessions.signedOut":
    "{count, plural, =0 {Kein anderer Browser war angemeldet.} one {# andere Sitzung abgemeldet.} other {# andere Sitzungen abgemeldet.}}",
  "apps.title": "Apps",
  "apps.description":
    "Die CLI und die Agenten, die in deinem Namen handeln dürfen. Du kannst jede davon jederzeit trennen.",
  "apps.connect.title": "App verbinden",
  "apps.connect.hint":
    "Jede App bittet beim ersten Mal im Browser um deine Zustimmung und erscheint danach hier.",
  "apps.connect.cli": "In der CLI anmelden",
  "apps.connect.mcp": "URL des MCP-Servers für deinen Agenten",
  "apps.connect.copyCommand": "Befehl kopieren",
  "apps.connect.copyUrl": "URL kopieren",
  "account.apps.title": "Verbundene Apps",
  "account.apps.hint":
    "Die CLI und die Agenten, die du über MCP verbunden hast. Jede darf tun, was in ihren Details steht, bis du sie trennst.",
  "account.apps.loading": "Deine verbundenen Apps werden geladen",
  "account.apps.error": "Die verbundenen Apps konnten nicht geladen werden",
  "account.apps.empty.title": "Keine Apps verbunden",
  "account.apps.empty.body":
    "Führ portifact login in einem Terminal aus oder füge den MCP-Server von Portifact zu deinem Agenten hinzu. Jede App bittet hier um deine Zustimmung und erscheint in dieser Liste, bis du sie trennst.",
  "account.apps.unnamed": "Unbenannte App",
  "account.apps.firstParty": "Von Portifact",
  "account.apps.thirdParty": "Drittanbieter-App",
  "account.apps.resources": "Verbindet sich mit",
  "account.apps.connectsTo": "Verbindet sich mit {resources}",
  "account.apps.access.full": "Vollzugriff",
  "account.apps.access.readOnly": "Nur lesen",
  "account.apps.access.partial":
    "{count, plural, one {# von {total} Berechtigungen} other {# von {total} Berechtigungen}}",
  "account.apps.lastUsed": "Zuletzt verwendet {when}",
  "account.apps.expiresOn": "Zugriff läuft ab am {date}",
  "account.apps.details": "Details",
  "account.apps.detailsOf": "Details zu {name}",
  "account.apps.resource.api": "Portifact-API",
  "account.apps.resource.mcp": "Portifact-MCP",
  "account.apps.scopes": "Darf",
  "account.apps.approved": "Zugestimmt am",
  "account.apps.lastIssued": "Letzter Token ausgestellt",
  "account.apps.expires": "Zugriff läuft ab",
  "account.apps.noExpiry": "Läuft nicht ab",
  "account.apps.disconnect": "Trennen",
  "account.apps.disconnectLabel": "{name} trennen",
  "account.apps.confirm.title": "{name} trennen?",
  "account.apps.confirm.body":
    "Die App verliert sofort den Zugriff und muss für eine neue Verbindung erneut um deine Zustimmung bitten.",
  "account.apps.disconnected": "{name} getrennt.",
  "settings.title": "Einstellungen",
  "settings.sectionsNav": "Bereiche der Einstellungen",
  "settings.description":
    "Deine Sprache, wie Portifact aussieht, wie neue Artifacts starten, welche E-Mails du bekommst, deine Daten und das Löschen deines Kontos.",
  "settings.appearance.title": "Darstellung",
  "settings.appearance.hint":
    "Wie Portifact in diesem Browser aussieht. System folgt der Einstellung deines Geräts. Artifacts behalten das Aussehen, das ihre Ersteller ihnen gegeben haben.",
  "settings.defaults.title": "Standards für neue Artifacts",
  "settings.defaults.hint":
    "Jedes Artifact, das du ab jetzt erstellst, startet so, egal ob du im Dashboard, in der CLI oder über einen Agenten veröffentlichst. Bestehende Artifacts behalten ihre eigenen Einstellungen; ändere sie auf der Seite des jeweiligen Artifacts.",
  "settings.defaults.loading": "Deine Einstellungen werden geladen",
  "settings.defaults.error": "Deine Einstellungen konnten nicht geladen werden",
  "settings.defaults.access": "Wer ein neues Artifact öffnen darf",
  "settings.defaults.access.restricted":
    "Nur du, bis du Personen hinzufügst. Das ist die sicherste Wahl.",
  "settings.defaults.comments": "Kommentare zu einem neuen Artifact",
  "settings.defaults.comments.off": "Aus",
  "settings.defaults.comments.off.hint":
    "Niemand kann kommentieren, bis du Kommentare einschaltest.",
  "settings.defaults.comments.open": "Offen",
  "settings.defaults.comments.open.hint":
    "Alle, die das Artifact öffnen können, dürfen kommentieren.",
  "settings.defaults.bar.label": "Portifact-Leiste bei neuen Artifacts anzeigen",
  "settings.defaults.save": "Standards speichern",
  "settings.defaults.saved": "Standards gespeichert. Neue Artifacts starten so.",
  "settings.defaults.unchanged":
    "Nichts zu speichern: Deine Standards sind bereits so eingestellt.",
  "settings.defaults.failed": "Deine Standards wurden nicht gespeichert",
  "settings.notices.title": "E-Mail-Hinweise",
  "settings.notices.hint":
    "Artifacts werden 30 Tage nach deiner letzten Veröffentlichung oder Verlängerung nicht mehr ausgeliefert. Portifact kann dich ein paar Tage vorher daran erinnern.",
  "settings.notices.expiry.label": "E-Mail, bevor meine Artifacts ablaufen",
  "settings.notices.expiry.hint":
    "Höchstens eine E-Mail pro Tag mit allen Artifacts, die innerhalb von 3 Tagen ablaufen, und je einem Link zum Verlängern.",
  "settings.notices.save": "E-Mail-Hinweise speichern",
  "settings.notices.saved": "E-Mail-Hinweise gespeichert.",
  "settings.notices.unchanged":
    "Nichts zu speichern: Deine E-Mail-Hinweise sind bereits so eingestellt.",
  "settings.notices.failed": "Deine E-Mail-Hinweise wurden nicht gespeichert",
  "settings.notices.comments.label": "E-Mail bei neuen Kommentaren und Reviews",
  "settings.notices.comments.hint":
    "Höchstens eine E-Mail alle 10 Minuten, mit der Zahl neuer Threads, Antworten und erledigter Threads je Artifact, nie mit dem, was geschrieben wurde. Nur für Artifacts, deren Eigentümer einen Plan mit Kommentarhinweisen hat. Dieselbe Einstellung gilt für Review-E-Mails: wenn jemand dein Review anfragt und wenn eine Version, die du verwaltest, freigegeben wird oder Änderungen angefordert werden.",
  "commentNotices.label": "E-Mail bei neuen Kommentaren zu diesem Artifact",
  "commentNotices.hint":
    "Höchstens eine E-Mail alle 10 Minuten, nur mit Zahlen. Alle Kommentar-E-Mails schaltest du in deinen Einstellungen ab.",
  "commentNotices.muted": "Kommentar-E-Mails für dieses Artifact abgeschaltet.",
  "commentNotices.unmuted": "Kommentar-E-Mails für dieses Artifact eingeschaltet.",
  "commentNotices.failed": "Deine Auswahl wurde nicht gespeichert",
  "commentNotices.planRequired": "E-Mail-Hinweise zu neuen Kommentaren sind Teil des Plans {plan}.",
  "settings.danger.title": "Gefahrenbereich",
  "settings.danger.hint": "Diese Aktionen können nicht rückgängig gemacht werden.",
  "account.data.title": "Deine Daten",
  "account.data.hint":
    "Lade alles, was dein Konto enthält, als JSON herunter: dein Profil, deine Artifacts mit ihrem Zugriff, ihren Versionen und Dateilisten sowie Kommentare. Jede Version enthält einen Link, über den sich ihre Dateien herunterladen lassen.",
  "account.data.download": "Die Daten deines Kontos herunterladen (JSON)",
  "account.data.spacePersonal":
    "Um mitzunehmen, was dein persönlicher Bereich enthält (die aufbewahrten Versionen und Quellen jedes Artefakts, die Zugriffsprotokolle, die Datensätze jedes Artefakts und des Bereichs und das Audit-Protokoll), nutze die Download-Seite des Bereichs.",
  "account.data.spaceWorkspace":
    "Um mitzunehmen, was der Arbeitsbereich {workspace} enthält (die aufbewahrten Versionen und Quellen jedes Artefakts, die Zugriffsprotokolle, die Datensätze jedes Artefakts und des Bereichs und das Audit-Protokoll), nutze die Download-Seite des Bereichs.",
  "account.data.spaceLink": "Daten dieses Bereichs herunterladen",
  "account.delete.title": "Konto löschen",
  "account.delete.hint":
    "Wenn du dein Konto löschst, werden deine Artifacts, Sitzungen, Apps und Anmeldemethoden entfernt, ebenso deine Kommentare zu Artifacts anderer Personen. Ein Kommentar, auf den jemand geantwortet hat, wird zu einem Hinweis „Nachricht gelöscht“. Adressen von Artifacts werden nie an andere vergeben. Das kann nicht rückgängig gemacht werden, lade also zuerst deine Daten herunter.",
  "account.delete.confirmLabel": "Gib zur Bestätigung deine E-Mail-Adresse ein",
  "account.delete.confirmHint": "Gib {email} ein",
  "account.delete.mismatch": "Gib zur Bestätigung genau die E-Mail-Adresse deines Kontos ein.",
  "account.delete.button": "Konto löschen",
  "account.delete.dialog.title": "Dein Konto endgültig löschen?",
  "account.delete.dialog.body":
    "Deine Artifacts funktionieren sofort nicht mehr und alles oben Aufgeführte wird gelöscht. Du wirst abgemeldet.",
  "account.delete.dialog.confirm": "Mein Konto löschen",
  "account.delete.reauth.title": "Melde dich erneut an, um dein Konto zu löschen",
  "account.delete.reauth.body":
    "Zu deiner Sicherheit braucht das Löschen eine Anmeldung aus den letzten 10 Minuten. Melde dich erneut an und komm dann hierher zurück.",
  "account.delete.reauth.action": "Erneut anmelden",
  "account.delete.done": "Dein Konto wurde gelöscht.",
  "account.actionFailed.title": "Die Aktion wurde nicht abgeschlossen",
  "accessLog.title": "Wer es geöffnet hat",
  "accessLog.hint":
    "Angemeldete Besucher, die dieses Artifact in den letzten {days, plural, one {# Tag} other {# Tagen}} geöffnet haben, neueste zuerst, ein Eintrag pro Besucher alle 30 Minuten. Nur du siehst diese Liste. Nur Artifacts, die auf die von dir aufgeführten Personen eingeschränkt sind, zeichnen Aufrufe auf, deine eigenen Besuche werden nicht erfasst, und einige Aufrufe können fehlen.",
  "accessLog.loading": "Wird geladen, wer das Artifact geöffnet hat",
  "accessLog.error.title": "Das Zugriffsprotokoll konnte nicht geladen werden",
  "accessLog.empty.title": "Noch keine Besucher",
  "accessLog.empty.body":
    "In den letzten {days, plural, one {# Tag} other {# Tagen}} hat niemand mit Anmeldung dieses Artifact geöffnet.",
  "accessLog.caption": "Aufrufe dieses Artifacts durch angemeldete Besucher",
  "accessLog.column.opened": "Geöffnet",
  "accessLog.column.visitor": "Besucher",
  "accessLog.loadMore": "Mehr anzeigen",
  "accessLog.export.hint":
    "Exporte enthalten alle Einträge der letzten {days, plural, one {# Tag} other {# Tage}}, nicht nur die angezeigten.",
  "accessLog.export.csv": "Als CSV exportieren",
  "accessLog.export.json": "Als JSON exportieren",
  "accessLog.export.doneCsv": "Das Zugriffsprotokoll wurde als CSV exportiert.",
  "accessLog.export.doneJson": "Das Zugriffsprotokoll wurde als JSON exportiert.",
  "accessLog.export.failed": "Das Zugriffsprotokoll konnte nicht exportiert werden",

  "analytics.title": "Statistiken",
  "analytics.hint":
    "Seitenaufrufe pro Tag (UTC) und, bei Artifacts, die auf die von dir aufgeführten Personen eingeschränkt sind, wie viele von ihnen es geöffnet haben. Nur Zahlen: Hier wird niemand identifiziert.",
  "analytics.loading": "Statistiken des Artifacts werden geladen",
  "analytics.error.title": "Die Statistiken konnten nicht geladen werden",
  "analytics.planRequired":
    "Statistiken pro Artifact und ein Zugriffsprotokoll über ein Jahr sind Teil des Plans {plan}.",
  "analytics.range.label": "Zeitraum",
  "analytics.range.days": "Letzte {count, plural, one {# Tag} other {# Tage}}",
  "analytics.total.views": "Aufrufe",
  "analytics.total.signedIn": "Aufrufe angemeldeter Besucher",
  "analytics.total.visitors": "Verschiedene angemeldete Besucher",
  "analytics.visitors.notKept":
    "Nur bei Artifacts gezählt, die auf die von dir aufgeführten Personen eingeschränkt sind",
  "analytics.chart.label": "Aufrufe pro Tag",
  "analytics.chart.summary":
    "Aufrufe: {views} in {days, plural, one {# Tag} other {# Tagen}}. Stärkster Tag: {busiest} mit {most}.",
  "analytics.chart.summaryEmpty":
    "Keine Aufrufe in den letzten {days, plural, one {# Tag} other {# Tagen}}.",
  "analytics.chart.day": "{day}. Aufrufe: {views}. Angemeldet: {signedIn}.",
  "analytics.chart.dayWithVisitors":
    "{day}. Aufrufe: {views}. Angemeldet: {signedIn}. Verschiedene Besucher: {visitors}.",
  "analytics.chart.keyboard": "Fokussiere das Diagramm und lies mit den Pfeiltasten jeden Tag.",
  "analytics.table.show": "Zahlen als Tabelle anzeigen",
  "analytics.table.caption": "Aufrufe pro Tag dieses Artifacts",
  "analytics.column.day": "Tag",
  "analytics.column.views": "Aufrufe",
  "analytics.column.signedIn": "Angemeldet",
  "analytics.column.visitors": "Verschiedene Besucher",
  "analytics.note":
    "Aufbewahrt: {days, plural, one {# Tag} other {# Tage}}. Deine eigenen Besuche und Linkvorschauen werden nicht gezählt, automatisierte Browser aber schon. Die Zahlen sind daher ein Anhaltspunkt, keine Prüfung.",

  "usage.title": "Nutzung",
  "usage.description":
    "Deine Kontingente und was deine Artifacts in diesem Monat ausgeliefert haben. Traffic wird alle paar Sekunden gezählt und kann daher etwas hinterherhinken.",
  "usage.meterPercent": "{used} von {limit} ({percent})",
  "usage.plan.section": "Tarif",
  "usage.plan.hint": "Dein Tarif legt die Grenzen auf dieser Seite fest.",
  "usage.plan.name": "Aktueller Tarif",
  "usage.plan.free": "Free",
  "usage.plan.pro": "Pro",
  "usage.plan.team": "Team",
  "usage.plan.enterprise": "Enterprise",
  "usage.plan.seats": "Plätze",
  "usage.plan.until": "Gültig bis",
  "usage.traffic.section": "Traffic in diesem Monat",
  "usage.traffic.hint":
    "Gezählt für dein ganzes Konto, über alle deine Artifacts. Wird eines der Limits erreicht, sind alle Artifacts bis zum Zurücksetzen pausiert.",
  "usage.trafficRequests.hint":
    "Jede Seite, jede Datei und jeder Download, den deine Artifacts beantwortet haben.",
  "usage.trafficBytes.hint": "Die Größe von allem, was deine Artifacts an Besucher gesendet haben.",
  "usage.storage.section": "Artifacts und Speicher",
  "usage.activeArtifacts.hint":
    "Artifacts, die gerade online sind. Archivierte und gelöschte Artifacts zählen nicht.",
  "usage.storage.hint":
    "Eindeutige Dateien, die du über alle Versionen hinweg aufbewahrst, jeweils einmal gezählt. Laufende Uploads zählen, solange sie laufen.",
  "usage.publishing.section": "Veröffentlichen",
  "usage.publishing.hint":
    "Limits dafür, wie schnell du veröffentlichen kannst. Die 24-Stunden-Fenster sind gleitend und werden nach und nach wieder frei.",
  "usage.publishes.hint": "Versionen, die du veröffentlicht oder auf die du zurückgesetzt hast.",
  "usage.newFiles": "Neue Dateien, letzte 24 Stunden",
  "usage.newFiles.hint":
    "Dateien, die du vorher noch nicht hochgeladen hattest; bereits aufbewahrte Dateien zählen nicht.",
  "usage.newBytes": "Neue Daten, letzte 24 Stunden",
  "usage.newBytes.hint": "Die Größe dieser neuen Dateien.",
  "usage.newObjects": "Neue Dateien in diesem Monat",
  "usage.newObjects.hint": "Wird am {date} zurückgesetzt.",
  "usage.openUploads": "Laufende Uploads",
  "usage.openUploads.hint": "Begonnene, aber noch nicht abgeschlossene Veröffentlichungen.",
  "usage.versions.section": "Limits pro Version",
  "usage.versions.hint": "Für jedes Artifact gleich.",
  "usage.versions.publishedBytes": "Veröffentlichte Größe",
  "usage.versions.files": "Dateien",
  "usage.versions.documentBytes": "Markdown- oder Textdokument",
  "usage.public.title": "Öffentliche Artifacts bald verfügbar",
  "usage.public.body":
    "Neue Konten können ein Artifact {minutes} Minuten nach ihrer Erstellung öffentlich machen. Du kannst das ab {date}.",
  "usage.loading": "Deine Nutzung wird geladen",
  "usage.error": "Die Nutzung konnte nicht geladen werden",
  "usage.meter": "{used} von {limit}",
  "usage.activeArtifacts": "Aktive Artifacts",
  "usage.storage": "Speicher",
  "usage.publishes": "Veröffentlichungen, letzte 24 Stunden",
  "usage.trafficRequests": "Anfragen in diesem Monat",
  "usage.trafficBytes": "Ausgelieferte Daten in diesem Monat",
  "usage.trafficResets": "Traffic wird zurückgesetzt am",
  "usage.blocks": "Derzeit blockiert",
  "usage.lifts": "{message} Aufgehoben am {date}.",
  "usage.traffic.title": "Deine Artifacts haben den Traffic dieses Monats verbraucht",
  "usage.traffic.body":
    "Deine Artifacts haben in diesem Monat 1 Million Anfragen oder 25 GB ausgeliefert, daher bekommen Besucher bis {date} bei allen einen Fehler (HTTP 429). Deine anderen Kontingente sind nicht betroffen: Du kannst weiterhin veröffentlichen, den Zugriff ändern und deine Artifacts verwalten. Die Artifacts anderer Personen funktionieren weiter.",
  "usage.traffic.link": "Deine Nutzung ansehen",
  "usage.nearLimit": "Fast am Limit",
  "usage.atLimit": "Limit erreicht",
  "account.cancel": "Abbrechen",

  "scope.artifacts:read": "Deine Artifacts, ihre Einstellungen und ihre Versionen sehen",
  "scope.artifacts:write": "Artifacts veröffentlichen und aktualisieren",
  "scope.artifacts:share": "Ändern, wer deine Artifacts öffnen darf",
  "scope.artifacts:delete": "Deine Artifacts archivieren und löschen",
  "scope.annotations:read": "Kommentare zu deinen Artifacts lesen",
  "scope.annotations:write": "In deinem Namen kommentieren und auf Kommentare antworten",
  "scope.annotations:moderate": "Kommentare zu deinen Artifacts erledigen, ausblenden und löschen",
  "scope.credentials:manage": "Die mit deinem Konto verbundenen Apps sehen und trennen",
  "scope.offline_access": "Verbunden bleiben, bis du die Verbindung trennst",
  "scope.unknown": "Die Berechtigung {name} verwenden",

  "list.publish": "Veröffentlichen",

  "content.title": "Inhalt",
  "content.publishVersion": "Neue Version veröffentlichen",
  "content.edit": "Dokument bearbeiten",
  "content.history": "Versionsverlauf",

  "publish.title": "Veröffentlichen",
  "publish.description":
    "Lade eine HTML-Datei, einen Ordner, ein ZIP oder ein Dokument hoch. Nichts wird hochgeladen, bevor du es geprüft hast.",
  "publish.versionTitle": "Neue Version von {name}",
  "publish.versionDescription":
    "Die gewählten Dateien ersetzen die aktuelle Version. Besucher sehen sie weiter, bis die neue veröffentlicht ist.",
  "publish.loading": "Das Artifact wird geladen",
  "publish.unavailable":
    "Dieses Artifact kann in seinem aktuellen Status keine neue Version bekommen. Stell es zuerst wieder her, falls es archiviert ist.",
  "publish.step.choose": "Wähle, was du veröffentlichen möchtest",
  "publish.steps.label": "Schritte der Veröffentlichung",
  "publish.steps.choose": "Auswählen",
  "publish.steps.review": "Prüfen",
  "publish.steps.publish": "Veröffentlichen",
  "steps.done": "erledigt",
  "steps.upcoming": "nicht begonnen",
  "publish.drop.site": "Zieh Dateien, einen Ordner oder ein ZIP hierher oder wähle sie aus",
  "publish.drop.document": "Zieh ein Dokument hierher oder wähle es aus",
  "publish.drop.active": "Loslassen, um diese Dateien auszuwählen",
  "publish.done.review": "Reviewen und kommentieren",
  "publish.type.legend": "Typ",
  "publish.type.site": "Eine HTML-Datei, ein Ordner mit statischen Dateien oder ein ZIP davon.",
  "publish.type.markdown": "Ein Markdown-Dokument, von Portifact gerendert.",
  "publish.type.text": "Ein reines Textdokument, genau so angezeigt, wie es geschrieben ist.",
  "publish.name.label": "Name",
  "publish.name.hint":
    "Wird in deiner Liste und als Seitentitel angezeigt. Standardmäßig der Name der Datei oder des Ordners.",
  "publish.entry.label": "Startseite",
  "publish.entry.hint":
    "Die Seite, die Besucher zuerst öffnen. Eine einzelne HTML-Datei wird immer zu dieser Seite.",
  "publish.pick.files": "Dateien auswählen",
  "publish.pick.filesHint": "Eine HTML-Seite oder mehrere Dateien, nebeneinander veröffentlicht.",
  "publish.pick.folder": "Ordner auswählen",
  "publish.pick.folderHint": "Alle Dateien darin, mit ihrer Struktur.",
  "publish.pick.zip": "ZIP-Datei auswählen",
  "publish.pick.zipHint":
    "Ein ZIP deiner Website. Nutze es, wenn dein Browser keine Ordner auswählen kann.",
  "publish.pick.zipOnly":
    "Dieser Browser kann keine Ordner auswählen. Pack den Ordner in eine ZIP-Datei und wähle stattdessen diese aus.",
  "publish.pick.document": "Datei auswählen",
  "publish.pick.documentHint": "Eine UTF-8-Textdatei mit bis zu 5 MB.",
  "publish.text.label": "Oder schreib es hier",
  "publish.text.hint": "Füge das Dokument ein oder tippe es. Es wird als {file} veröffentlicht.",
  "publish.text.use": "Diesen Text prüfen",
  "publish.text.required": "Schreib das Dokument zuerst oder füge es ein.",
  "publish.untitled": "Ohne Titel",
  "publish.building": "Dateien werden gelesen und geprüft",
  "publish.buildingProgress": "{done} von {total}",
  "publish.cancel": "Abbrechen",
  "publish.buildCancelled": "Lesen der Dateien abgebrochen. Es wurde nichts hochgeladen.",
  "publish.buildFailed.title": "Diese Dateien können nicht veröffentlicht werden",
  "publish.step.review": "Vor dem Veröffentlichen prüfen",
  "publish.review.summary": "Zusammenfassung",
  "publish.review.files": "Dateien",
  "publish.review.filesValue": "{count, plural, one {# Datei} other {# Dateien}}, {size}",
  "publish.review.entry": "Startseite",
  "publish.review.access": "Wer es öffnen darf",
  "publish.review.accessNew":
    "Nur du. Nach dem Veröffentlichen kannst du es auf der Seite des Artifacts teilen.",
  "publish.review.accessVersion": "{mode}. Eine neue Version ändert nie, wer es öffnen darf.",
  "publish.review.caption": "Zu veröffentlichende Dateien",
  "publish.review.column.path": "Pfad",
  "publish.review.column.size": "Größe",
  "publish.review.column.type": "Inhaltstyp",
  "publish.review.excluded":
    "{count, plural, one {# Eintrag ausgelassen} other {# Einträge ausgelassen}}",
  "publish.review.excludedHint":
    "Diese werden nie veröffentlicht, genau wie in der CLI. Entferne sie aus der Quelle, wenn du meinst, dass einer veröffentlicht werden sollte.",
  "publish.reason.default": "Versionsverwaltung, Abhängigkeiten oder Caches",
  "publish.reason.secret": "kann Geheimnisse enthalten",
  "publish.review.publish": "Veröffentlichen",
  "publish.review.back": "Andere Dateien auswählen",
  "publish.phase.preparing": "Upload wird vorbereitet",
  "publish.phase.uploading": "Wird hochgeladen",
  "publish.phase.committing": "Dateien werden geprüft und veröffentlicht",
  "publish.uploadProgress": "{sent} von {total}, {done} von {count} Dateien",
  "publish.uploadStarted":
    "{count, plural, =0 {Alle Dateien sind bereits gespeichert. Wird veröffentlicht.} one {# neue Datei wird hochgeladen.} other {# neue Dateien werden hochgeladen.}}",
  "publish.uploadCancelled": "Upload abgebrochen. Es wurde nichts veröffentlicht.",
  "publish.failed.title": "Die Veröffentlichung wurde nicht abgeschlossen",
  "publish.resume": "Upload fortsetzen",
  "publish.startOver": "Neu beginnen",
  "publish.done.title": "Version {number} veröffentlicht",
  "publish.done.body": "Es ist unter {url} online und läuft am {date} ab.",
  "publish.done.pinned": "Es ist unter {url} online. Es ist angeheftet und läuft daher nicht ab.",
  "publish.done.open": "Seite des Artifacts öffnen",
  "publish.done.another": "Etwas anderes veröffentlichen",
  "publish.announce.done": "Version {number} von {name} veröffentlicht.",

  "manifest.empty":
    "Es gibt nichts zu veröffentlichen: Alle Dateien wurden ausgelassen oder die Quelle ist leer.",
  "manifest.too_many_files": "Eine Version kann höchstens {detail} Dateien enthalten.",
  "manifest.too_large": "Eine Version kann höchstens {detail} enthalten.",
  "manifest.invalid_path": "Ein Dateipfad ist nicht erlaubt: {detail}",
  "manifest.missing_entry":
    "Die Startseite {detail} ist nicht unter den Dateien. Ändere die Startseite oder füge sie hinzu.",
  "manifest.document_files": "Ein Dokument ist eine einzelne Datei. Wähle eine Datei aus.",
  "manifest.document_too_large": "Dokumente sind auf 5 MB begrenzt.",
  "manifest.not_text":
    "Das ist keine UTF-8-Textdatei und kann daher nicht als Dokument veröffentlicht werden.",
  "manifest.not_zip": "Das ist keine ZIP-Datei, oder sie ist beschädigt.",
  "manifest.unsupported":
    "Dieses ZIP verwendet ein Format, das Portifact nicht liest (ZIP64, geteilte Archive oder ungewöhnliche Komprimierung). Erstell es mit Standardeinstellungen neu.",
  "manifest.encrypted": "{detail} ist verschlüsselt. Verwende ein ZIP ohne Passwort.",
  "manifest.symlink":
    "{detail} ist ein Link. Links werden nicht veröffentlicht; ersetze ihn durch die Datei selbst.",
  "manifest.special_file": "{detail} ist keine reguläre Datei.",
  "manifest.corrupt":
    "Das ZIP ist beschädigt: {detail} entpackt sich nicht zu dem, was das Archiv angibt.",
  "manifest.unexpected": "Die Dateien konnten nicht gelesen werden. Versuch es noch einmal.",

  "upload.integrity":
    "{path} ist nicht unversehrt angekommen: Der Speicher hat die Datei wegen ihrer Größe oder Prüfsumme abgelehnt. Beginne neu, um die Dateien erneut zu lesen.",
  "upload.storage":
    "Der Speicher hat {path} abgelehnt. Setz den Upload fort, um es noch einmal zu versuchen.",
  "upload.network":
    "Der Speicher war nicht erreichbar. Prüfe deine Verbindung und setz dann den Upload fort.",
  "upload.missing": "Der Upload verlangt eine Datei, die diese Seite nicht hat. Beginne neu.",
  "publish.error.quota_exceeded":
    "Das passt nicht in die Limits deines Kontos: aktive Artifacts, Speicher, Dateien oder Veröffentlichungen pro Tag. Archiviere oder lösche etwas oder versuch es später noch einmal.",
  "publish.error.version_conflict":
    "Inzwischen wurde eine neuere Version veröffentlicht. Beginne neu, damit deine Änderungen darauf aufbauen.",
  "publish.error.upload_incomplete":
    "Nicht alle Dateien sind unversehrt im Speicher angekommen. Setz den Upload fort, um das Fehlende zu senden.",
  "publish.error.invalid_input":
    "Portifact hat diese Dateien abgelehnt. Prüfe Pfade, Größen und Typ und beginne dann neu.",

  "editor.title": "{name} bearbeiten",
  "editor.description":
    "Beim Speichern wird eine neue Version veröffentlicht. Bis dahin sehen Besucher die aktuelle.",
  "editor.loading": "Das Dokument wird geladen",
  "editor.loadFailed.title": "Das Dokument konnte nicht geladen werden",
  "editor.notDocument":
    "Nur Markdown- und Text-Artifacts können hier bearbeitet werden. Veröffentliche stattdessen eine neue Version.",
  "editor.unavailable":
    "Dieses Artifact kann in seinem aktuellen Status keine neue Version bekommen. Stell es zuerst wieder her, falls es archiviert ist.",
  "editor.source.markdown": "Markdown",
  "editor.source.text": "Text",
  "editor.source.hint": "{path}, bis zu 5 MB.",
  "editor.preview": "Vorschau",
  "editor.previewTitle": "Vorschau von {name}",
  "editor.previewHeading": "Vorschau",
  "editor.previewHint":
    "Von Portifact genau so gerendert, wie es veröffentlicht wird. Links und Bilder darin öffnen sich hier nicht.",
  "editor.previewEmpty": "Wähle Vorschau, um das gerenderte Dokument zu sehen.",
  "editor.previewStale": "Der Text hat sich seit dieser Vorschau geändert.",
  "editor.previewFailed.title": "Die Vorschau konnte nicht gerendert werden",
  "editor.save": "Speichern und veröffentlichen",
  "editor.unchanged": "Nichts zu speichern: Das Dokument ist unverändert.",
  "editor.saving": "Eine neue Version wird veröffentlicht.",
  "editor.saved": "Als Version {number} gespeichert.",
  "editor.saveFailed.title": "Das Dokument wurde nicht gespeichert",
  "editor.reload": "Neueste Version laden",
  "editor.tooLarge": "Dokumente sind auf 5 MB begrenzt.",

  "history.title": "Verlauf von {name}",
  "history.versionsTitle": "Aufbewahrte Versionen",
  "history.description": "Die Versionen, die du noch herunterladen oder wiederherstellen kannst.",
  "history.retention":
    "Der Tarif des Eigentümers behält {count, plural, one {# frühere Version} other {# frühere Versionen}} für {days, plural, one {# Tag} other {# Tage}}, nachdem sie ersetzt wurde.",
  "compare.title": "Versionen vergleichen",
  "compare.description":
    "Wähle zwei Versionen, um zu sehen, welche Dateien sich wie geändert haben.",
  "compare.paid": "Versionen vergleichen und mehr davon länger behalten gehören zum Tarif {plan}.",
  "compare.needTwo": "Veröffentliche eine weitere Version, um sie mit dieser zu vergleichen.",
  "compare.from": "Frühere Version",
  "compare.to": "Spätere Version",
  "compare.currentOption": "Version {number} (aktuell)",
  "compare.submit": "Vergleichen",
  "compare.loading": "Versionen werden verglichen",
  "compare.error.title": "Die Versionen konnten nicht verglichen werden",
  "compare.summary":
    "Version {from} verglichen mit Version {to}. Hinzugefügt: {added}. Entfernt: {removed}. Geändert: {changed}. Unverändert: {unchanged}.",
  "compare.none": "Beide Versionen haben dieselben Dateien.",
  "compare.caption": "Dateien, die sich zwischen Version {from} und Version {to} unterscheiden",
  "compare.column.file": "Datei",
  "compare.column.change": "Änderung",
  "compare.column.size": "Größe",
  "compare.change.added": "Hinzugefügt",
  "compare.change.removed": "Entfernt",
  "compare.change.changed": "Geändert",
  "compare.source": "Quelle",
  "compare.sizes": "{before} vorher, {after} nachher",
  "compare.noFile": "keine",
  "compare.show": "Änderungen anzeigen",
  "compare.showLabel": "Änderungen anzeigen: {path}",
  "compare.loadMore": "Weitere Dateien anzeigen",
  "diff.title": "Änderungen an {path}",
  "diff.close": "Änderungen ausblenden",
  "diff.loading": "Änderungen werden geladen",
  "diff.counts": "Hinzugefügte Zeilen: {added}. Entfernte Zeilen: {removed}.",
  "diff.layout": "Darstellung",
  "diff.unified": "Zusammengeführt",
  "diff.split": "Nebeneinander",
  "diff.caption": "Änderungen an {path} von Version {from} zu Version {to}",
  "diff.column.before": "Vorher",
  "diff.column.after": "Nachher",
  "diff.column.change": "Änderung",
  "diff.column.text": "Text",
  "diff.added": "Hinzugefügt",
  "diff.removed": "Entfernt",
  "diff.unchanged": "Unverändert",
  "diff.noNewline": "kein Zeilenumbruch am Ende",
  "diff.hunk": "Ab Zeile {before} vorher und Zeile {after} nachher",
  "diff.more": "Weitere Änderungen anzeigen",
  "diff.status.identical": "Diese Datei ist in beiden Versionen gleich.",
  "diff.status.binary": "Diese Datei ist kein Text, daher wird nur ihre Größe verglichen.",
  "diff.status.too_large": "Diese Datei ist zu groß für einen zeilenweisen Vergleich.",
  "diff.status.too_many_lines": "Diese Datei hat zu viele Zeilen für einen zeilenweisen Vergleich.",
  "diff.status.too_many_changes":
    "Diese Datei hat sich zu stark geändert, um sie zeilenweise anzuzeigen.",
  "history.loading": "Versionen werden geladen",
  "history.error.title": "Die Versionen konnten nicht geladen werden",
  "history.caption": "Versionen, neueste zuerst",
  "history.column.version": "Version",
  "history.column.published": "Veröffentlicht",
  "history.column.files": "Dateien",
  "history.column.kept": "Aufbewahrt bis",
  "history.column.actions": "Aktionen",
  "history.version": "Version {number}",
  "history.current": "Aktuell",
  "history.whileCurrent": "Solange aktuell",
  "history.files": "{count, plural, one {# Datei} other {# Dateien}}, {size}",
  "history.sources": "{count, plural, one {# Quelle} other {# Quellen}}, {size}",
  "history.empty.title": "Noch keine Versionen",
  "history.empty.body": "Veröffentliche die erste Version, dann erscheint sie hier.",
  "history.loadMore": "Ältere Versionen laden",
  "history.download": "Dateien herunterladen",
  "history.downloadLabel": "Dateien von Version {number} herunterladen",
  "history.downloadSources": "Quellen herunterladen",
  "history.downloadSourcesLabel": "Quellen von Version {number} herunterladen",
  "history.downloading": "Dateien werden heruntergeladen und geprüft.",
  "history.downloaded": "{file} ist bereit.",
  "history.downloadFailed.title": "Der Download wurde nicht abgeschlossen",
  "download.integrity":
    "{path} passte nicht zu seiner Prüfsumme und wurde daher nicht gespeichert. Versuch es noch einmal.",
  "download.network": "{path} konnte nicht heruntergeladen werden. Versuch es noch einmal.",
  "history.rollback": "Zurücksetzen",
  "history.rollbackLabel": "Auf Version {number} zurücksetzen",
  "history.rollbackUnavailable": "Zurücksetzen ist möglich, solange das Artifact aktiv ist.",
  "history.confirmRollback.title": "Auf Version {number} zurücksetzen?",
  "history.confirmRollback.body":
    "Ihre Dateien werden erneut als neue Version veröffentlicht, und die 30-tägige Laufzeit beginnt von vorn. Wer das Artifact öffnen darf, ändert sich nicht.",
  "history.confirmRollback.confirm": "Zurücksetzen",
  "history.rolledBack": "Version {from} ist erneut als Version {number} veröffentlicht.",
  "history.actionFailed.title": "Die Aktion wurde nicht abgeschlossen",
  "history.archive.title": "Archiviert",
  "history.archive.body":
    "Dieses Artifact ist archiviert und niemand kann es öffnen. Es wird am {date} endgültig gelöscht, wenn du es nicht wiederherstellst. Du kannst seine Versionen weiterhin herunterladen.",
  "history.archive.noDate":
    "Es wird nach sechs Monaten endgültig gelöscht, wenn du es nicht wiederherstellst.",
  "history.conversations.title": "Unterhaltungen zu früheren Versionen",
  "history.conversations.description":
    "Kommentar-Threads bleiben bei der Version, zu der sie geschrieben wurden. Nur du siehst die früheren, hier und schreibgeschützt; Besucher sehen die Threads der aktuellen Version.",
  "history.conversations.loading": "Unterhaltungen werden geladen",
  "history.conversations.error": "Die Unterhaltungen konnten nicht geladen werden",
  "history.conversations.refreshFailed": "Die Unterhaltungen konnten nicht aktualisiert werden",
  "history.conversations.empty": "Keine frühere Version hat Kommentar-Threads.",
  "history.conversations.counts":
    "{count, plural, one {# Thread} other {# Threads}}, {open, plural, =0 {keiner offen} other {# offen}}",
  "history.conversations.version": "Version {number}: {counts}",
  "history.conversations.unlisted": "Nicht mehr aufgeführte Versionen: {counts}",
  "review.open": "Reviewen und kommentieren",
  "viewer.loading": "Das Artifact wird geöffnet",
  "viewer.unavailable.title": "Dieses Artifact kann nicht geöffnet werden",
  "viewer.unavailable.body":
    "Es existiert nicht, ist gerade nicht verfügbar oder dein Konto darf es nicht öffnen.",
  "viewer.failed.title": "Das Artifact konnte nicht geöffnet werden",
  "viewer.dashboard": "Deine Artifacts",
  "viewer.skipLink": "Zum Artifact springen",
  "viewer.brand": "Portifact",
  "viewer.version": "Version {number}",
  "viewer.withoutBar": "Ohne Portifact-Leiste öffnen",
  "viewer.copyLink": "Link kopieren",
  "viewer.copied": "Link kopiert.",
  "viewer.copyFailed": "Der Link konnte nicht kopiert werden: {url}",
  "viewer.manage": "Verwalten",
  "viewer.comments": "Kommentare",
  "viewer.comments.open": "{count, plural, one {(# offener Thread)} other {(# offene Threads)}}",
  "viewer.closeComments": "Kommentare schließen",
  "viewer.more": "Mehr",
  "viewer.account": "Dein Konto",
  "viewer.signIn": "Anmelden",
  "viewer.frame.label": "Artifact",
  "viewer.frame.title": "{name}, veröffentlicht mit Portifact",
  "viewer.anonymous.body":
    "Melde dich an, um die Kommentare zu diesem Artifact zu lesen und eigene hinzuzufügen. Nach der Anmeldung kommst du auf diese Seite zurück.",
  "viewer.anonymous.signIn": "Zum Kommentieren anmelden",
  "review.startFailed.title": "Die Kommentare konnten nicht mit dem Artifact verbunden werden",
  "review.frame.connecting": "Verbindung zur Seite wird hergestellt",
  "review.frame.isolated":
    "Das Artifact läuft auf einer eigenen Website und kann weder dein Konto noch deine E-Mail-Adresse noch die Kommentare anderer Personen sehen. Eine Auswahl darin veröffentlicht nie einen Kommentar: Du schreibst und bestätigst jeden einzelnen hier.",
  "review.status.unavailable.title": "Review-Werkzeuge sind in diesem Browser nicht verfügbar",
  "review.status.unavailable.body":
    "Dieser Browser blockiert das Cookie, das das Review im Frame braucht. Du kannst trotzdem allgemeine Kommentare zur Seite hinterlassen.",
  "review.status.silent.title": "Die Seite antwortet den Review-Werkzeugen nicht",
  "review.status.silent.body":
    "Ihre eigene Sicherheitsrichtlinie blockiert sie möglicherweise. Du kannst trotzdem allgemeine Kommentare zur Seite hinterlassen.",
  "review.tab.title": "Review in einem separaten Tab",
  "review.tab.body":
    "Öffne das Artifact in einem eigenen Tab, um es im Review-Modus zu sehen. Der Tab zeigt das Artifact selbst, geschrieben von seinem Autor, nicht von Portifact: Melde dich dort nicht an und gib dort nichts ein, auch wenn es wie Portifact aussieht. Er hat keine Review-Werkzeuge, also schreib deine Kommentare hier. Seine Review-Sitzung endet nach {minutes} Minuten oder wenn du im Tab Review beenden wählst.",
  "review.tab.prepare": "Review-Tab vorbereiten",
  "review.tab.open": "Review-Tab öffnen",
  "review.tab.ready": "Der Link zum Review-Tab ist bereit.",
  "review.tab.opened":
    "Der Review-Tab wurde geöffnet. Wähl im Tab Review beenden, wenn du fertig bist; die Kommentare bleiben hier.",
  "review.tab.expired":
    "Der Link ist abgelaufen, bevor er geöffnet wurde. Bereite einen neuen vor.",
  "review.status.ended.title": "Diese Review-Sitzung ist beendet",
  "review.status.ended.body":
    "Das meldet die Seite im Frame. Die Kommentare hier funktionieren weiter; lade das Review neu, um die Review-Werkzeuge in der Seite wieder zu nutzen.",
  "review.status.failed.title": "Der Review-Link ist abgelaufen",
  "review.status.failed.body":
    "Das meldet die Seite im Frame. Die Kommentare hier funktionieren weiter; lade das Review neu, um die Seite wieder zu öffnen.",
  "review.status.foreign.title": "Im Frame läuft nicht deine Review-Sitzung",
  "review.status.foreign.body":
    "Etwas, möglicherweise ein anderes Artifact, hat im Frame eine andere Review-Sitzung geöffnet, daher sind die Review-Werkzeuge dafür ausgeschaltet. Lade das Review neu, um deine wieder zu starten. Die Kommentare hier sind nicht betroffen.",
  "review.status.lost.title": "Der Frame antwortet nicht mehr vom Artifact",
  "review.status.lost.body":
    "Er zeigt jetzt möglicherweise eine andere Website, ein anderes Artifact oder eine Datei ohne Review-Werkzeuge, also vertrau nicht darauf, dass er dieses Artifact zeigt. Lade das Review neu, um das Artifact wieder anzuzeigen. Die Kommentare hier sind nicht betroffen.",
  "review.reload": "Review neu laden",
  "review.newVersion.title": "Eine neuere Version wurde veröffentlicht",
  "review.newVersion.body":
    "Du siehst eine ältere Version. Neue Kommentare gehen an die neueste Version.",
  "review.newVersion.action": "Neue Version reviewen",
  "review.mode.off.owner.title": "Kommentare sind aus",
  "review.mode.off.owner.body":
    "Schalte sie ein, damit die Personen, die dieses Artifact öffnen dürfen, kommentieren können.",
  "review.mode.off.turnOn": "Kommentare einschalten",
  "review.mode.off.turnedOn": "Kommentare sind an.",
  "review.mode.off.visitor.title": "Kommentare sind für dieses Artifact aus",
  "review.mode.off.visitor.body": "Der Eigentümer hat sie nicht eingeschaltet.",
  "review.mode.locked.title": "Kommentare sind gesperrt",
  "review.mode.locked.body": "Du kannst die Kommentare lesen, aber keine neuen hinzufügen.",
  "review.comments.heading": "Kommentare",
  "review.comments.loading": "Kommentare werden geladen",
  "review.comments.error.title": "Die Kommentare konnten nicht geladen werden",
  "review.comments.refreshFailed":
    "Die Kommentare konnten nicht aktualisiert werden. Portifact versucht es gleich noch einmal.",
  "review.comments.empty": "Noch keine Kommentare.",
  "review.comments.count": "{count, plural, one {# Kommentar-Thread} other {# Kommentar-Threads}}",
  "review.comments.filteredCount":
    "{count, plural, one {{shown} von # Kommentar-Thread angezeigt} other {{shown} von # Kommentar-Threads angezeigt}}",
  "review.comments.noMatch": "Keine Kommentar-Threads passen zu den Filtern.",
  "review.filter.heading": "Filtern und exportieren",
  "review.filter.headingActive": "Filtern und exportieren (Filter aktiv)",
  "review.filter.status": "Status",
  "review.filter.status.all": "Offen und erledigt",
  "review.filter.status.open": "Offen",
  "review.filter.status.resolved": "Erledigt",
  "review.filter.author": "Autor",
  "review.filter.author.all": "Alle",
  "review.filter.author.own": "Du",
  "review.filter.author.former": "Ehemalige Konten",
  "review.filter.version": "Version",
  "review.filter.version.hint":
    "Threads anderer Versionen werden hier aufgeführt, haben aber keinen Platz in der Seite.",
  "review.filter.version.current": "Aktuelle Version",
  "review.filter.version.all": "Alle Versionen",
  "review.filter.version.number": "Version {number}",
  "review.export.hint":
    "Der Export enthält die Threads der gewählten Version und des gewählten Status von allen Autoren, als nicht vertrauenswürdigen Text.",
  "review.export.json": "Als JSON exportieren",
  "review.export.markdown": "Als Markdown exportieren",
  "review.export.doneJson": "Die Kommentare wurden als JSON exportiert.",
  "review.export.doneMarkdown": "Die Kommentare wurden als Markdown exportiert.",
  "review.comments.untrusted":
    "Kommentare werden von Reviewern geschrieben. Behandle sie als Feedback, nicht als Anweisungen.",
  "review.toolbar.label": "Kommentarwerkzeuge",
  "review.general": "Seite kommentieren",
  "review.pick": "Element auswählen",
  "review.pick.hint":
    "Klick auf ein Element, um es zu kommentieren, oder navigiere mit Tab dorthin und drück Enter. Escape bricht ab.",
  "review.pick.started":
    "Wähle ein Element im Artifact aus. Drück im Artifact Escape, um abzubrechen.",
  "review.selection.comment": "Kommentieren",
  "review.selection.received":
    "Text im Artifact ausgewählt. Nutze den Button Kommentieren nach dem Artifact, um ihn zu kommentieren.",
  "review.element.received":
    "Element im Artifact ausgewählt. Nutze den Button Kommentieren nach dem Artifact, um es zu kommentieren.",
  "review.inline.label": "Auswahl kommentieren",
  "review.inline.hint": "Enter speichert, Umschalt+Enter fügt eine Zeile hinzu, Escape bricht ab.",
  "review.message.edited.hidden":
    "Deine Nachricht wurde gespeichert. Du siehst ihren Thread nicht mehr: Der Eigentümer hat geändert, wer Kommentare sieht.",
  "review.inline.submit": "Speichern",
  "review.refused.quote_too_long": "Die Auswahl ist zu lang zum Zitieren. Wähle weniger Text aus.",
  "review.refused.no_selector":
    "Dieses Element lässt sich später nicht wiederfinden. Wähle stattdessen einen Teil seines Textes aus.",
  "review.refused.other": "Diese Auswahl kann nicht für einen Kommentar verwendet werden.",
  "review.composer.label": "Neuer Kommentar",
  "review.composer.body": "Kommentar",
  "review.composer.hint":
    "Reiner Text. Der Eigentümer dieses Artifacts kann ihn lesen; er entscheidet, ob andere Leser das auch können.",
  "review.composer.hint.owner":
    "Reiner Text. Alle, die dieses Artifact öffnen können, können ihn lesen.",
  "review.composer.submit": "Kommentar senden",
  "review.composer.cancel": "Abbrechen",
  "review.composer.empty": "Schreib einen Kommentar.",
  "review.composer.invalid": "Der Kommentar ist zu lang oder enthält nicht erlaubte Zeichen.",
  "review.composer.posted": "Kommentar gesendet.",
  "review.humanCheck.body":
    "Eine kurze Prüfung, dass du ein Mensch bist, bevor dein Kommentar gesendet wird. Er wird gesendet, sobald die Prüfung abgeschlossen ist.",
  "review.humanCheck.needed":
    "Eine kurze Prüfung, dass du ein Mensch bist, bevor dein Kommentar gesendet wird.",
  "review.humanCheck.retry":
    "Die Prüfung, dass du ein Mensch bist, hat nicht geklappt. Schließ sie ab und speichere dann erneut.",
  "review.humanCheck.unavailable":
    "Die Prüfung, dass du ein Mensch bist, konnte auf dieser Seite nicht geladen werden. Lade die Seite neu und versuch es noch einmal.",
  "review.report": "Dieses Artifact melden",
  "review.target.general": "Allgemeiner Kommentar zu {path}",
  "review.target.element": "Element {tag}",
  "review.target.quote": "Zitierter Text",
  "review.thread.title": "Thread {number}",
  "review.thread.titlePrefix": "Thread ",
  "review.thread.more": "Weitere Aktionen für Thread {number}",
  "review.thread.showMessages":
    "{count, plural, one {Kommentar anzeigen} other {Die # Kommentare anzeigen}}",
  "review.thread.hideMessages": "Kommentare einklappen",
  "review.thread.open": "Offen",
  "review.thread.resolved": "Erledigt",
  "review.thread.replies": "{count, plural, one {# Antwort} other {# Antworten}}",
  "review.thread.hideReplies": "Antworten ausblenden",
  "review.thread.otherVersion": "Frühere Version",
  "review.thread.orphaned": "Ohne Position",
  "review.thread.otherPage": "Auf {path}",
  "review.thread.show": "Im Artifact zeigen",
  "review.thread.resolve": "Erledigen",
  "review.thread.reopen": "Wieder öffnen",
  "review.thread.reply": "Antworten",
  "review.thread.delete": "Thread löschen",
  "review.thread.resolvedDone": "Thread {number} erledigt.",
  "review.thread.reopenedDone": "Thread {number} wieder geöffnet.",
  "review.thread.deletedDone": "Thread {number} gelöscht.",
  "review.thread.activated": "Thread {number} ausgewählt.",
  "review.thread.activatedMany": "Threads {numbers} ausgewählt.",
  "review.group.heading":
    "{count, plural, one {# Thread zum angeklickten Text} other {# Threads zum angeklickten Text}}",
  "review.group.clear": "Alle Threads zeigen",
  "review.thread.confirmDelete.title": "Thread {number} löschen?",
  "review.thread.confirmDelete.body":
    "Alle Nachrichten darin werden für alle entfernt. Das kann nicht rückgängig gemacht werden.",
  "review.thread.confirmDelete.confirm": "Thread löschen",
  "review.thread.confirmDelete.cancel": "Behalten",
  "review.message.formerAccount": "Ehemaliges Konto",
  "review.message.you": "Du",
  "review.message.hidden": "Vom Eigentümer ausgeblendet",
  "review.message.deleted": "Nachricht gelöscht",
  "review.message.edited": "Bearbeitet",
  "review.message.hide": "Ausblenden",
  "review.message.unhide": "Wieder zeigen",
  "review.message.delete": "Löschen",
  "review.message.more": "Weitere Aktionen für die Nachricht von {author}",
  "review.message.moderated": "Nachricht aktualisiert.",
  "review.message.edit": "Bearbeiten",
  "review.message.editLabel": "Deine Nachricht bearbeiten",
  "review.message.editBody": "Nachricht",
  "review.message.editSave": "Speichern",
  "review.message.edited.done": "Nachricht bearbeitet.",
  "review.message.editConflict":
    "Diese Nachricht wurde inzwischen an anderer Stelle geändert. Die neueste Fassung wird angezeigt; bearbeite sie erneut.",
  "review.reply.label": "Auf Thread {number} antworten",
  "review.reply.body": "Antwort",
  "review.reply.hint.owner":
    "Der Eigentümer hat diesen Thread begonnen, daher sehen alle, die die Kommentare sehen, deine Antwort.",
  "review.reply.submit": "Antwort senden",
  "review.reply.posted": "Antwort gesendet.",
  "review.actionFailed.title": "Die Aktion wurde nicht abgeschlossen",

  "notFound.title": "Seite nicht gefunden",
  "notFound.body": "Diese Adresse passt zu keiner Seite des Dashboards.",

  "action.retry": "Erneut versuchen",

  "type.site": "Website",
  "type.markdown": "Markdown",
  "type.text": "Text",

  "state.draft": "Entwurf",
  "state.active": "Aktiv",
  "state.archived": "Archiviert",
  "state.suspended": "Gesperrt",
  "state.purging": "Wird gelöscht",
  "state.deleted": "Gelöscht",

  "access.public": "Öffentlich: alle mit dem Link",
  "access.authenticated": "Alle, die bei Portifact angemeldet sind",
  "access.restricted": "Nur du und die Personen, die du hinzufügst",

  "error.network":
    "Portifact war nicht erreichbar. Prüfe deine Verbindung und versuch es noch einmal.",
  "error.unexpected": "Etwas ist schiefgelaufen. Versuch es noch einmal.",
  "error.invalid_input": "Die Anfrage war ungültig.",
  "error.unauthenticated": "Deine Sitzung ist abgelaufen. Melde dich erneut an.",
  "error.forbidden": "Das darfst du nicht.",
  "error.not_found": "Das Artifact existiert nicht mehr.",
  "error.version_conflict":
    "Das Artifact wurde inzwischen geändert. Lade neu und versuch es noch einmal.",
  "error.quota_exceeded":
    "Du hast das Limit für aktive Artifacts erreicht. Archiviere oder lösche eines und versuch es dann noch einmal.",
  "error.traffic_exceeded":
    "Deine Artifacts haben den Traffic dieses Monats verbraucht. Nächsten Monat funktionieren sie wieder.",
  "error.upload_incomplete": "Der Upload ist noch nicht abgeschlossen.",
  "error.artifact_archived": "Das Artifact ist archiviert. Stell es zuerst wieder her.",
  "error.account_too_new_for_public": "Neue Konten können Artifacts noch nicht öffentlich machen.",
  "error.capacity_unavailable": "Portifact ist gerade ausgelastet. Versuch es später noch einmal.",
  "error.sole_workspace_admin":
    "Ein Workspace braucht eine Person mit Adminrechten, und du bist die einzige. Mach zuerst ein anderes Mitglied zum Admin oder bitte Portifact unter hello@portifact.com, den Workspace zu löschen.",
  "error.seats_exhausted":
    "Der Workspace nutzt alle seine Plätze. Entferne ein Mitglied oder widerrufe eine Einladung, oder frag nach mehr Plätzen.",
  "error.rate_limited": "Zu viele Anfragen. Warte einen Moment und versuch es noch einmal.",
  "error.reauthentication_required": "Melde dich erneut an, um das zu tun.",
  "error.human_verification_required":
    "Deine ersten Kommentare zu Artifacts anderer Personen brauchen eine kurze Prüfung, dass du ein Mensch bist. Schließ sie ab und sende dann erneut.",
  "error.plan_required":
    "Diese Funktion ist nicht im Plan des Eigentümers des Artifacts enthalten.",
  "shareLinks.title": "Freigabelinks",
  "shareLinks.description":
    "Links, mit denen alle, die sie haben, dieses Artifact ohne Konto lesen können. Besucher lesen nur die aktuelle Version: Sie können nicht kommentieren und werden nie identifiziert.",
  "shareLinks.loading": "Freigabelinks werden geladen",
  "shareLinks.loadFailed": "Die Freigabelinks wurden nicht geladen",
  "shareLinks.paidTitle": "Freigabelinks gehören zu einem kostenpflichtigen Tarif",
  "shareLinks.paid":
    "Dein Tarif enthält keine Freigabelinks. Personen hinzufügen und öffentlicher Zugriff funktionieren wie bisher.",
  "shareLinks.paused":
    "Dein Tarif enthält keine Freigabelinks mehr, daher öffnen sich diese Links nicht. Sie bleiben erhalten und funktionieren wieder, wenn der Tarif Freigabelinks enthält. Du kannst sie weiterhin widerrufen.",
  "shareLinks.publicNote":
    "Dieses Artifact ist öffentlich, also kann es schon jeder öffnen. Freigabelinks zählen, wenn du den Zugriff später einschränkst.",
  "shareLinks.created.title": "Link „{label}“ erstellt",
  "shareLinks.created.once":
    "Kopiere ihn jetzt: Zu deiner Sicherheit wird er nur dieses eine Mal angezeigt. Alle mit diesem Link können das Artifact lesen.",
  "shareLinks.created.label": "Freigabelink",
  "shareLinks.created.copy": "Link kopieren",
  "shareLinks.created.done": "Fertig",
  "shareLinks.created.announce":
    "Freigabelink erstellt. Kopiere ihn jetzt; er wird nur einmal angezeigt.",
  "shareLinks.empty": "Noch keine Freigabelinks.",
  "shareLinks.list": "Freigabelinks dieses Artifacts",
  "shareLinks.expired": "Abgelaufen",
  "shareLinks.noExpiry": "Ohne Ablauf",
  "shareLinks.expires": "Läuft am {date} ab",
  "shareLinks.withPassword": "Passwort",
  "shareLinks.noPassword": "Ohne Passwort",
  "shareLinks.neverUsed": "Noch nicht benutzt",
  "shareLinks.lastUsed": "Zuletzt benutzt am {date}",
  "shareLinks.revoke": "Widerrufen",
  "shareLinks.revokeLabel": "Den Link {label} widerrufen",
  "shareLinks.revoked": "Der Link {label} wurde widerrufen.",
  "shareLinks.revokeFailed": "Der Link wurde nicht widerrufen",
  "shareLinks.confirm.title": "„{label}“ widerrufen?",
  "shareLinks.confirm.body":
    "Alle mit diesem Link verlieren den Zugriff innerhalb einer Minute. Das lässt sich nicht rückgängig machen; ein neuer Link hat eine neue Adresse.",
  "shareLinks.cancel": "Abbrechen",
  "shareLinks.create": "Link erstellen",
  "shareLinks.createFailed": "Der Link wurde nicht erstellt",
  "shareLinks.full":
    "Dieses Artifact hat {max} aktive Links, das Maximum. Widerrufe einen, um einen weiteren zu erstellen.",
  "shareLinks.label.label": "Bezeichnung",
  "shareLinks.label.hint": "Nur du siehst sie, zum Beispiel für wen der Link ist.",
  "shareLinks.label.invalid": "Gib dem Link eine Bezeichnung mit 1 bis {max} Zeichen.",
  "shareLinks.expiry.label": "Läuft ab nach",
  "shareLinks.expiry.never": "Nie",
  "shareLinks.expiry.days": "{count, plural, one {# Tag} other {# Tagen}}",
  "shareLinks.password.label": "Passwort (optional)",
  "shareLinks.password.hint":
    "Mindestens {min} Zeichen. Besucher geben es ein, bevor sich das Artifact öffnet. Schick es getrennt vom Link.",
  "shareLinks.password.short": "Verwende mindestens {min} Zeichen oder lass das Feld leer.",
  "domains.title": "Eigene Domain",
  "domains.description":
    "Liefern Sie dieses Artifact unter einer eigenen Domain aus, etwa docs.example.com. Die Portifact-Adresse funktioniert weiterhin.",
  "domains.loading": "Eigene Domain wird geladen",
  "domains.loadFailed": "Die eigene Domain wurde nicht geladen",
  "domains.paidTitle": "Eigene Domains gehören zu einem kostenpflichtigen Tarif",
  "domains.paid":
    "Mit einem kostenpflichtigen Tarif können Sie dieses Artifact unter Ihrer eigenen Domain ausliefern.",
  "domains.unavailableTitle": "Eigene Domains sind noch nicht verfügbar",
  "domains.unavailable":
    "Portifact liefert noch keine eigenen Domains aus. Dieser Bereich wird freigeschaltet, sobald es so weit ist.",
  "domains.removingNote": "{hostname} wird entfernt.",
  "domains.cardLabel": "Eigene Domain {hostname}",
  "domains.state.pending": "Warten auf DNS",
  "domains.state.provisioning": "Wird eingerichtet",
  "domains.state.active": "Aktiv",
  "domains.state.removing": "Wird entfernt",
  "domains.next.pending":
    "Legen Sie die beiden Einträge unten bei Ihrem DNS-Anbieter an und prüfen Sie dann erneut.",
  "domains.next.provisioning":
    "Ihre Domain ist bestätigt. Das Zertifikat dauert meist ein paar Minuten; prüfen Sie gleich erneut.",
  "domains.next.active":
    "Ihr Artifact wird unter dieser Domain ausgeliefert. Behalten Sie den TXT-Eintrag: Er wird täglich geprüft.",
  "domains.next.removing": "Die Domain wird entfernt.",
  "domains.problem.txt_missing": "Der TXT-Eintrag wurde nicht gefunden",
  "domains.problem.txt_missing.hint":
    "Prüfen Sie, ob Name und Wert des Eintrags genau übereinstimmen. DNS-Änderungen können einige Minuten brauchen.",
  "domains.problem.certificate_pending": "Das Zertifikat ist noch nicht bereit",
  "domains.problem.certificate_pending.hint":
    "Prüfen Sie, ob der CNAME-Eintrag auf den Wert unten zeigt, und prüfen Sie in ein paar Minuten erneut.",
  "domains.problem.cloudflare_unavailable": "Der Zertifikatsdienst hat nicht geantwortet",
  "domains.problem.cloudflare_unavailable.hint":
    "Auf Ihrer Seite ist alles in Ordnung. Es wird gleich erneut versucht.",
  "domains.problem.cname_elsewhere": "Die Domain zeigt nicht auf Portifact",
  "domains.problem.cname_elsewhere.hint":
    "Ihr DNS führt nicht mehr zum CNAME-Ziel unten. Richten Sie es wieder darauf aus; eine aktive Domain wird nach 3 solchen täglichen Prüfungen in Folge entfernt.",
  "domains.missedChecks":
    "{count, plural, one {Der TXT-Eintrag fehlte bei der letzten täglichen Prüfung. Nach 3 Fehlschlägen in Folge wird die Domain entfernt.} other {Der TXT-Eintrag fehlte bei den letzten # täglichen Prüfungen. Nach 3 Fehlschlägen in Folge wird die Domain entfernt.}}",
  "domains.records": "Anzulegende Einträge",
  "domains.records.type": "{type}-Eintrag",
  "domains.records.txtHint":
    "Beweist, dass Sie die Domain kontrollieren. Behalten Sie ihn, wenn die Domain aktiv ist.",
  "domains.records.cnameHint": "Lässt Ihre Domain auf Portifact zeigen.",
  "domains.records.name": "Name",
  "domains.records.value": "Wert",
  "domains.records.copy": "Kopieren",
  "domains.claimExpires":
    "Legen Sie die Einträge vor dem {date} an oder fügen Sie die Domain erneut hinzu.",
  "domains.check": "Erneut prüfen",
  "domains.checkFailed": "Die Domain wurde nicht geprüft",
  "domains.remove": "Domain entfernen",
  "domains.removed": "{hostname} wurde entfernt.",
  "domains.removeFailed": "Die Domain wurde nicht entfernt",
  "domains.confirm.title": "{hostname} entfernen?",
  "domains.confirm.body":
    "Das Artifact wird sofort nicht mehr unter dieser Domain ausgeliefert und behält seine Portifact-Adresse. Ein erneutes Hinzufügen erfordert eine neue DNS-Prüfung.",
  "domains.cancel": "Abbrechen",
  "domains.bar.title": "Besuche öffnen sich im Viewer, solange die Portifact-Leiste aktiv ist",
  "domains.bar.body":
    "Solange die Leiste aktiv ist, landen Besucher Ihrer Domain im Viewer auf app.portifact.com. Schalten Sie die Leiste aus, damit Ihre Domain in der Adressleiste bleibt.",
  "domains.bar.turnOff": "Leiste ausschalten",
  "domains.bar.done": "Die Portifact-Leiste ist ausgeschaltet.",
  "domains.add": "Domain hinzufügen",
  "domains.added": "{hostname} wurde hinzugefügt. Legen Sie jetzt die DNS-Einträge an.",
  "domains.addFailed": "Die Domain wurde nicht hinzugefügt",
  "domains.full":
    "{count, plural, one {Ihr Tarif umfasst # eigene Domain, und sie wird bereits genutzt.} other {Ihr Tarif umfasst # eigene Domains, und alle werden genutzt.}}",
  "domains.hostname.label": "Hostname",
  "domains.hostname.hint":
    "Eine Subdomain, die Sie kontrollieren, etwa docs.example.com. Stammdomains und Platzhalter werden nicht unterstützt.",
  "domains.hostname.invalid": "Geben Sie einen Hostnamen wie docs.example.com ein.",
  "accessLog.shareLink": "Freigabelink: {label}",
  "webhooks.title": "Webhooks",
  "webhooks.description":
    "Sende Ereignisse deiner Artifacts an deine eigenen Systeme, an Slack oder an Discord.",
  "webhooks.planTitle": "Webhooks sind Teil eines kostenpflichtigen Plans",
  "webhooks.planRequired":
    "Webhooks sind Teil des Plans {plan}. Webhooks, die du hinzugefügt hast, bleiben hier pausiert und funktionieren wieder, sobald dein Plan sie enthält.",
  "webhooks.add.title": "Webhook hinzufügen",
  "webhooks.add.hint":
    "Ereignisse zu jedem deiner Artifacts gehen an diese Adresse. Kommentartexte und E-Mail-Adressen von Lesern werden nie gesendet.",
  "webhooks.add.url": "URL",
  "webhooks.add.urlHint": "Eine öffentliche HTTPS-Adresse auf dem Standardport.",
  "webhooks.add.format": "Format",
  "webhooks.format.generic": "Allgemeines JSON, signiert",
  "webhooks.format.genericHint":
    "Prüfe den Header webhook-signature jeder Zustellung mit dem Signaturgeheimnis.",
  "webhooks.format.slack": "Slack",
  "webhooks.format.slackHint": "Eine URL eines eingehenden Slack-Webhooks (hooks.slack.com).",
  "webhooks.format.discord": "Discord",
  "webhooks.format.discordHint":
    "Eine Webhook-URL eines Discord-Kanals (discord.com/api/webhooks).",
  "webhooks.add.events": "Ereignisse",
  "webhooks.event.comment.created": "Neue Kommentare und Antworten",
  "webhooks.event.thread.resolved": "Erledigte Threads",
  "webhooks.event.artifact.published": "Neue Versionen",
  "webhooks.event.artifact.expiring": "Artifacts, die bald ablaufen",
  "webhooks.event.artifact.access_changed": "Zugriffsänderungen",
  "webhooks.event.review.requested": "Review-Anfragen",
  "webhooks.event.review.completed": "Freigegebene Reviews oder angeforderte Änderungen",
  "webhooks.add.submit": "Webhook hinzufügen",
  "webhooks.add.noEvents": "Wähle mindestens ein Ereignis.",
  "webhooks.add.limit":
    "Du kannst höchstens {limit} Webhooks haben. Entferne einen, um einen weiteren hinzuzufügen.",
  "webhooks.added": "Webhook für {host} hinzugefügt.",
  "webhooks.secret.title": "Kopiere jetzt das Signaturgeheimnis",
  "webhooks.secret.body":
    "Es wird nur einmal angezeigt. Bewahre es in der Konfiguration deines Empfängers auf, um jede Zustellung zu prüfen.",
  "webhooks.secret.label": "Signaturgeheimnis für {host}",
  "webhooks.secret.copy": "Geheimnis kopieren",
  "webhooks.secret.done": "Ich habe es gespeichert",
  "webhooks.list.title": "Deine Webhooks",
  "webhooks.list.loading": "Deine Webhooks werden geladen",
  "webhooks.list.error": "Die Webhooks konnten nicht geladen werden",
  "webhooks.empty.title": "Noch keine Webhooks",
  "webhooks.empty.body":
    "Füge einen hinzu, um die Ereignisse deiner Artifacts dort zu erhalten, wo dein Team arbeitet.",
  "webhooks.state.active": "Aktiv",
  "webhooks.state.paused": "Durch den Plan pausiert",
  "webhooks.state.disabled": "Deaktiviert",
  "webhooks.reason.manual": "Von einem Admin deaktiviert",
  "webhooks.reason.failures": "Nach wiederholten Fehlern deaktiviert",
  "webhooks.reason.gone": "Deaktiviert: Der Empfänger meldet, dass es ihn nicht mehr gibt",
  "webhooks.reason.invalid_url": "Deaktiviert: Die URL ist nicht mehr erlaubt",
  "webhooks.failures": "{count} fehlgeschlagene Versuche in Folge",
  "webhooks.lastAttempt": "Letzter Versuch {when}: {outcome}",
  "webhooks.outcome.delivered": "zugestellt",
  "webhooks.outcome.failed": "fehlgeschlagen",
  "webhooks.outcome.skipped": "übersprungen",
  "webhooks.noAttempts": "Noch keine Versuche",
  "webhooks.test": "Test senden",
  "webhooks.testLabel": "Test senden an {host}",
  "webhooks.testQueued": "Testereignis für {host} eingereiht. Es geht in etwa zwei Minuten raus.",
  "webhooks.enable": "Aktivieren",
  "webhooks.enableLabel": "Den Webhook für {host} aktivieren",
  "webhooks.disable": "Deaktivieren",
  "webhooks.disableLabel": "Den Webhook für {host} deaktivieren",
  "webhooks.enabled": "Webhook für {host} aktiviert.",
  "webhooks.disabled": "Webhook für {host} deaktiviert.",
  "webhooks.remove": "Entfernen",
  "webhooks.removeLabel": "Den Webhook für {host} entfernen",
  "webhooks.removed": "Webhook für {host} entfernt.",
  "webhooks.confirm.title": "Den Webhook für {host} entfernen?",
  "webhooks.confirm.body":
    "Er erhält keine Ereignisse mehr und sein Zustellprotokoll wird gelöscht. Das lässt sich nicht rückgängig machen.",
  "webhooks.deliveries": "Zustellungen",
  "webhooks.deliveriesOf": "Zustellungen des Webhooks für {host}",
  "webhooks.deliveries.loading": "Zustellungen werden geladen",
  "webhooks.deliveries.error": "Die Zustellungen konnten nicht geladen werden",
  "webhooks.deliveries.empty": "Keine Versuche in den letzten {days} Tagen.",
  "webhooks.deliveries.time": "Zeit",
  "webhooks.deliveries.attempt": "Versuch",
  "webhooks.deliveries.outcome": "Ergebnis",
  "webhooks.error.timeout": "Zeitüberschreitung",
  "webhooks.error.network": "keine Verbindung",
  "webhooks.error.redirect": "weitergeleitet, nicht gefolgt",
  "webhooks.error.invalid_url": "URL nicht erlaubt",
  "webhooks.error.daily_cap": "Tageslimit erreicht",
  "webhooks.actionFailed": "Das hat nicht geklappt",
  "webhooks.notOfferedTitle": "Webhooks sind noch nicht verfügbar",
  "webhooks.notOffered":
    "Portifact sendet noch keine Webhooks. Sie erscheinen hier, sobald sie angeboten werden.",
  "webhooks.reason.key_unavailable":
    "Deaktiviert: Der Schlüssel, der ihn schützt, ist nicht mehr verfügbar. Entferne ihn und füge ihn neu hinzu.",
  "webhooks.reason.unavailable": "Deaktiviert: Portifact hat Webhooks vorerst abgeschaltet",
  "webhooks.error.key_unavailable": "Schlüssel nicht verfügbar",
  "webhooks.via.dashboard": "Im Dashboard hinzugefügt",
  "webhooks.via.cli": "Mit der Portifact-CLI hinzugefügt",
  "webhooks.via.other": "Über eine andere App hinzugefügt",
  "webhooks.via.by": "von {name}",
  "webhooks.probation":
    "Nach Fehlern wieder aktiviert: Wenige weitere Fehler deaktivieren ihn, bis eine Zustellung gelingt.",
  "shell.brandingLink": "Branding",
  "branding.title": "Branding",
  "branding.description":
    "Zeig deinen Namen, dein Logo, deine Farbe und deinen Link in der Leiste über deinen Artifacts im Viewer. Der Hinweis auf Portifact, die Adresse des Artifacts und der Link zum Melden bleiben immer in der Leiste.",
  "branding.loading": "Dein Branding wird geladen",
  "branding.error": "Dein Branding konnte nicht geladen werden",
  "branding.paidTitle": "Branding gehört zu einem kostenpflichtigen Plan",
  "branding.paid":
    "Branding in der Leiste des Viewers gehört zum Plan {plan}. Deine Artifacts zeigen die Standardleiste, und ein gespeichertes Branding bleibt hier, bis dein Plan es wieder enthält.",
  "branding.suspendedTitle": "Dein Branding ist gesperrt",
  "branding.suspended":
    "Deine Artifacts zeigen die Standardleiste, solange die Sperre gilt. Schreib dazu an abuse@portifact.com.",
  "branding.form.title": "Branding",
  "branding.form.hint":
    "Wird als Text und Link gezeigt. Nichts hier ändert, wie die Artifacts selbst aussehen.",
  "branding.form.name": "Name",
  "branding.form.nameHint": "Bis zu {max} Zeichen. Er darf sich nicht wie Portifact lesen.",
  "branding.form.nameRequired": "Gib den Namen ein, der gezeigt wird.",
  "branding.form.nameTooLong": "Verwende höchstens {max} Zeichen.",
  "branding.form.link": "Link (optional)",
  "branding.form.linkHint":
    "Deine eigene Website, in einem neuen Tab geöffnet. Sie beginnt mit https://.",
  "branding.form.linkInvalid": "Gib eine Adresse ein, die mit https:// beginnt.",
  "branding.form.color": "Akzentfarbe (optional)",
  "branding.form.colorHint":
    "Eine Farbe wie #1a2b3c. Sie füllt das Feld des Brandings, und der Text darauf wird schwarz oder weiß, damit er lesbar bleibt.",
  "branding.form.colorPicker": "Akzentfarbe auswählen",
  "branding.form.colorInvalid": "Verwende eine Farbe wie #1a2b3c.",
  "branding.form.save": "Branding speichern",
  "branding.form.saved": "Branding gespeichert.",
  "branding.form.failed": "Das Branding konnte nicht gespeichert werden",
  "branding.form.invalid":
    "Prüf den Namen und den Link: Der Name darf sich nicht wie Portifact lesen, und der Link muss die https-Adresse deiner eigenen Website sein.",
  "branding.logo.title": "Logo",
  "branding.logo.hint":
    "Ein PNG-, JPEG- oder WebP-Bild mit höchstens {kb} KB und {px} mal {px} Pixeln, ohne Animation. Es zählt zu deinem Speicher.",
  "branding.logo.needsName":
    "Speichere zuerst den Namen des Brandings und füg dann ein Logo hinzu.",
  "branding.logo.none": "Noch kein Logo.",
  "branding.logo.current": "{type}, {width} mal {height} Pixel, {size}.",
  "branding.logo.choose": "Logo auswählen",
  "branding.logo.replace": "Logo ersetzen",
  "branding.logo.remove": "Logo entfernen",
  "branding.logo.uploaded": "Logo gespeichert.",
  "branding.logo.removed": "Logo entfernt.",
  "branding.logo.failed": "Das Logo konnte nicht gespeichert werden",
  "branding.logo.invalid":
    "Verwende ein PNG-, JPEG- oder WebP-Bild mit höchstens {kb} KB und {px} mal {px} Pixeln, ohne Animation und ohne darin gespeicherten Text.",
  "branding.logo.full": "Dein Speicher ist voll. Lösch zuerst etwas.",
  "branding.preview.title": "Vorschau",
  "branding.preview.hint":
    "Die Leiste in jedem Design mit dem Inhalt des Formulars, gespeichert oder nicht.",
  "branding.preview.light": "Helles Design",
  "branding.preview.dark": "Dunkles Design",
  "branding.preview.sample": "Quartalsbericht",
  "branding.preview.noName": "Dein Name",
  "branding.preview.origin": "a1b2c3d4e5.portifact.dev",
  "branding.delete.title": "Branding löschen",
  "branding.delete.hint":
    "Deine Artifacts zeigen wieder die Standardleiste, und das Logo wird gelöscht.",
  "branding.delete.action": "Branding löschen",
  "branding.delete.confirm": "Branding löschen?",
  "branding.delete.body":
    "Name, Farbe, Link und Logo werden entfernt, und der Viewer zeigt bei all deinen Artifacts die Standardleiste.",
  "branding.delete.done": "Branding gelöscht.",
  "branding.delete.failed": "Das Branding konnte nicht gelöscht werden",
  "branding.delete.cancel": "Abbrechen",
  "viewer.brandNewTab": "(öffnet sich in einem neuen Tab)",
  "viewer.hosting.poweredBy": "Bereitgestellt von Portifact",
  "viewer.hosting.origin": "Veröffentlicht unter",
  // Workspaces (premium plan T1): the space menu, members, invitations and transfers.
  "space.label": "Bereich",
  "space.personal": "Persönlich",
  "space.personalDetail": "Dein eigener Bereich",
  "space.invitations": "{count, plural, one {# offene Einladung} other {# offene Einladungen}}",
  "space.missing.title": "Workspace nicht gefunden",
  "space.missing.body":
    "Diesen Workspace gibt es nicht, oder du bist kein Mitglied. Bitte eine Person mit Adminrechten dort um eine Einladung.",
  "space.missing.personal": "Zu deinem persönlichen Bereich",
  "space.notAllowed.title": "Mit deiner Rolle nicht verfügbar",
  "space.notAllowed.back": "Zurück zu den Artifacts",
  "space.notAllowed.list":
    "Als Mitglied von {workspace} liest und kommentierst du die Artifacts, die mit dir geteilt werden, über ihre Links. Alle Artifacts des Workspace sehen und verwalten können nur Editoren und Admins: Frag eine Person mit Adminrechten.",
  "space.notAllowed.publish":
    "Zum Veröffentlichen in {workspace} brauchst du die Rolle Editor oder Admin. Frag eine Person mit Adminrechten.",
  "space.notAllowed.usage": "Die Nutzung von {workspace} sehen seine Editoren und Admins.",
  "space.notAllowed.branding": "Nur die Admins von {workspace} legen seine Marke fest.",
  "role.admin": "Admin",
  "role.editor": "Editor",
  "role.member": "Mitglied",
  "role.admin.hint":
    "verwaltet Mitglieder, die Marke und alle Artifacts und kann Artifacts aus dem Workspace verschieben",
  "role.editor.hint": "veröffentlicht und verwaltet die Artifacts des Workspace",
  "role.member.hint": "liest und kommentiert, was mit ihm geteilt wird",
  "shell.membersLink": "Mitglieder",
  "list.descriptionWorkspace":
    "Alles, was in {workspace} veröffentlicht ist, mit Status, Zugriff und Aktivität.",
  "publish.descriptionWorkspace":
    "Veröffentliche in {workspace}: eine HTML-Datei, einen Ordner, ein ZIP oder ein Dokument. Hochgeladen wird erst nach deiner Prüfung.",
  "publish.review.accessNewWorkspace":
    "Die Admins und Editoren von {workspace}. Nach dem Veröffentlichen kannst du es auf der Seite des Artifact teilen.",
  "usage.descriptionWorkspace":
    "Die Kontingente von {workspace}, die alle teilen, die dort veröffentlichen, und der Traffic dieses Monats.",
  "branding.descriptionWorkspace":
    "Die Marke, die die Viewer-Leiste auf den Artifacts von {workspace} zeigt.",
  "detail.section.space": "Bereich",
  "transfer.title": "In einen anderen Bereich verschieben",
  "transfer.description":
    "Dieses Artifact liegt in {space}. Verschieb es in deinen persönlichen Bereich oder in einen Workspace, in dem du Editor oder Admin bist.",
  "transfer.destination": "Ziel",
  "transfer.move": "Artifact verschieben",
  "transfer.blocked": "Dieses Artifact kann gerade nicht verschoben werden",
  "transfer.notAdmin": "Nur Admins von {workspace} können seine Artifacts herausverschieben.",
  "transfer.domain":
    "Dieses Artifact hat eine eigene Domain, aktiv oder ausstehend. Entferne sie unter Teilen und verschieb dann das Artifact.",
  "transfer.none":
    "Es gibt keinen anderen Bereich, in den du es verschieben kannst. Du kannst Artifacts in deinen persönlichen Bereich und in Workspaces verschieben, in denen du Editor oder Admin bist.",
  "transfer.noneInRegion":
    "Dieser Bereich speichert seine Daten in der EU, daher kann das Artifact nur in einen anderen EU-Bereich verschoben werden, und du hast keinen.",
  "transfer.confirm.title": "{name} nach {space} verschieben?",
  "transfer.confirm.stays":
    "Bleibt gleich: die ID, der Link, die Versionen, die Personen, die du hinzugefügt hast, und die Kommentare.",
  "transfer.confirm.changes":
    "Ändert sich: Die Admins und Editoren von {space} verwalten es und sehen, wer es geöffnet hat, auch vor dem Verschieben, und es zählt zur Nutzung von {space}.",
  "transfer.confirm.plan":
    "Fixierungen und Freigabelinks folgen dem Tarif von {space}: Enthält er sie nicht, funktionieren sie nicht mehr.",
  "transfer.confirm.blocks":
    "Es wird nicht verschoben, wenn {space} keinen Platz dafür hat oder noch ein Upload offen ist.",
  "transfer.confirm.action": "Verschieben",
  "transfer.done": "{name} wurde nach {space} verschoben.",
  "transfer.failed": "Das Artifact wurde nicht verschoben",
  "transfer.error.quota_exceeded":
    "{space} hat keinen Platz für dieses Artifact. Gib dort zuerst einen aktiven Platz oder Speicher frei.",
  "transfer.error.version_conflict":
    "Ein Upload zu diesem Artifact ist noch offen, oder es hat sich inzwischen geändert. Schließ den Upload ab oder brich ihn ab, lade neu und versuch es noch einmal.",
  "transfer.error.invalid_input":
    "Dieses Artifact hat eine eigene Domain oder liegt schon in diesem Bereich. Entferne zuerst die Domain.",
  "transfer.error.forbidden":
    "Deine Rolle erlaubt nicht, dieses Artifact aus seinem Bereich oder in diesen zu verschieben.",
  "transfer.error.artifact_archived":
    "Nur ein aktives oder archiviertes Artifact kann verschoben werden.",
  "transfer.error.not_found":
    "Dieser Bereich oder dieses Artifact ist für dich nicht mehr verfügbar.",
  "members.title": "Mitglieder",
  "members.description":
    "Die Personen in {workspace} und was jede tun kann. Admins verwalten Mitglieder und Einladungen.",
  "members.personal.title": "Dein persönlicher Bereich hat keine Mitglieder",
  "members.personal.body":
    "Mitglieder gehören zu Workspaces. Wähl im Bereichsmenü einen Workspace, um seine Mitglieder zu sehen.",
  "members.loading": "Mitglieder werden geladen",
  "members.loadFailed": "Mitglieder konnten nicht geladen werden",
  "members.seats": "Plätze",
  "members.seatsUsed": "Belegte Plätze",
  "members.seatsValue": "{used} von {limit} ({percent})",
  "members.seatsHint":
    "Jedes Mitglied und jede offene Einladung belegt einen Platz. Wie viele es gibt, legt der Tarif des Workspace fest.",
  "members.listTitle": "Personen",
  "members.count": "{count, plural, one {# Mitglied} other {# Mitglieder}}",
  "members.caption": "Mitglieder von {workspace}",
  "members.you": "Du",
  "members.joined": "Dabei seit {date}",
  "members.roleLabel": "Rolle von {name}",
  "members.remove": "Entfernen",
  "members.removeNamed": "{name} entfernen",
  "members.leave": "Workspace verlassen",
  "members.lastAdmin":
    "Einziger Admin: Mach zuerst ein anderes Mitglied zum Admin, bevor du diese Rolle änderst, die Person entfernst oder gehst.",
  "members.confirmRemove.title": "{name} aus {workspace} entfernen?",
  "members.confirmRemove.body":
    "Die Person verliert sofort den Zugriff auf die Artifacts des Workspace. Was sie veröffentlicht hat, bleibt im Workspace.",
  "members.confirmRemove.action": "Mitglied entfernen",
  "members.confirmLeave.title": "{workspace} verlassen?",
  "members.confirmLeave.body":
    "Du verlierst sofort den Zugriff auf seine Artifacts. Um zurückzukommen, muss dich ein Admin neu einladen.",
  "members.roleChanged": "{name} ist jetzt {role}.",
  "members.removed": "{name} wurde entfernt.",
  "members.left": "Du hast {workspace} verlassen.",
  "members.actionFailed": "Die Änderung wurde nicht gespeichert",
  "members.error.forbidden":
    "Deine Rolle hat sich inzwischen geändert: Nur Admins verwalten Mitglieder und Einladungen. Lade die Seite neu.",
  "members.error.version_conflict":
    "Das Mitglied hat sich inzwischen geändert. Lade neu und versuch es noch einmal.",
  "members.error.not_found": "Diese Person ist nicht mehr im Workspace.",
  "invite.title": "Jemanden einladen",
  "invite.description":
    "Wir schicken per E-Mail einen Link, der 7 Tage gilt. Die Person tritt bei, indem sie sich mit dieser Adresse anmeldet.",
  "invite.email": "E-Mail",
  "invite.role": "Rolle",
  "invite.send": "Einladung senden",
  "invite.sent": "Einladung an {email} gesendet.",
  "invite.emailInvalid": "Gib eine E-Mail-Adresse ein, etwa name@beispiel.de.",
  "invite.alreadyMember": "{email} ist schon Mitglied.",
  "invite.full.title": "Kein freier Platz",
  "invite.failed": "Die Einladung wurde nicht gesendet",
  "invite.error.invalid_input":
    "Diese Adresse gehört schon einem Mitglied, oder sie ist keine gültige E-Mail-Adresse.",
  "invite.error.rate_limited":
    "Gerade zu viele Einladungen. Warte eine Weile und versuch es noch einmal.",
  "invite.error.capacity_unavailable":
    "Portifact hat diesen Monat alle möglichen Einladungs-E-Mails verschickt. Versuch es nächsten Monat noch einmal.",
  "invite.error.not_found": "Diese Einladung gibt es nicht mehr. Lade die Seite neu.",
  "pending.title": "Offene Einladungen",
  "pending.description":
    "Jede belegt einen Platz, bis sie angenommen, abgelehnt, widerrufen wird oder abläuft.",
  "pending.loading": "Einladungen werden geladen",
  "pending.loadFailed": "Einladungen konnten nicht geladen werden",
  "pending.empty": "Keine offenen Einladungen.",
  "pending.detail": "{role}, eingeladen von {inviter}, läuft am {date} ab",
  "pending.unknownInviter": "einem früheren Mitglied",
  "pending.resend": "Erneut einladen",
  "pending.resendNamed": "Erneut einladen: {email}",
  "pending.revoke": "Widerrufen",
  "pending.revokeNamed": "Widerrufen: {email}",
  "pending.confirmRevoke.title": "Einladung von {email} widerrufen?",
  "pending.confirmRevoke.body": "Der Link funktioniert nicht mehr, und der Platz ist wieder frei.",
  "pending.confirmRevoke.action": "Einladung widerrufen",
  "pending.revoked": "Die Einladung von {email} wurde widerrufen.",
  "pending.resent":
    "Eine neue Einladung wurde an {email} gesendet. Der frühere Link funktioniert nicht mehr.",
  "invitation.title": "Einladung in einen Workspace",
  "invitation.signedOut.body":
    "Jemand hat dich in einen Workspace auf Portifact eingeladen. Melde dich mit der E-Mail-Adresse an, an die die Einladung ging, und nimm sie dann hier an oder lehn sie ab.",
  "invitations.signedOut.body":
    "Melde dich an, um die Einladungen in Workspaces zu sehen, die an deine E-Mail-Adresse gingen.",
  "invitation.signIn": "Zum Antworten anmelden",
  "invitation.loading": "Einladung wird geladen",
  "invitation.loadFailed": "Die Einladung konnte nicht geladen werden",
  "invitation.invited.body": "{inviter} hat dich als {role} in {workspace} eingeladen.",
  "invitation.invited.bodyNoInviter": "Du bist als {role} in {workspace} eingeladen.",
  "invitation.expiresTerm": "Läuft ab",
  "invitation.accept": "Annehmen",
  "invitation.acceptNamed": "Annehmen: Einladung in {workspace}",
  "invitation.decline": "Ablehnen",
  "invitation.declineNamed": "Ablehnen: Einladung in {workspace}",
  "invitation.confirmDecline.title": "Einladung in {workspace} ablehnen?",
  "invitation.confirmDecline.body":
    "Der Link funktioniert dann nicht mehr. Ein Admin kann dich später erneut einladen.",
  "invitation.confirmDecline.action": "Einladung ablehnen",
  "invitation.accepted": "Du bist {workspace} beigetreten.",
  "invitation.declined": "Du hast die Einladung in {workspace} abgelehnt.",
  "invitation.failed": "Deine Antwort wurde nicht gespeichert",
  "invitation.other.title": "Diese Einladung gilt einer anderen Adresse",
  "invitation.other.body":
    "Sie ging an {email}, und du bist als {current} angemeldet. Melde dich mit {email} an, um zu antworten.",
  "invitation.other.unverified":
    "Sie ging an {email}, die Adresse dieses Kontos, die noch nicht bestätigt ist. Melde dich ab und mit einem Code an {email} wieder an.",
  "invitation.switch": "Mit einem anderen Konto anmelden",
  "invitation.missing.title": "Diese Einladung funktioniert nicht mehr",
  "invitation.missing.body":
    "Sie ist abgelaufen, wurde widerrufen oder schon verwendet. Bitte einen Admin des Workspace, dich erneut einzuladen.",
  "invitations.title": "Einladungen",
  "invitations.description": "Einladungen in Workspaces an deine bestätigte E-Mail-Adresse.",
  "invitations.loading": "Einladungen werden geladen",
  "invitations.loadFailed": "Einladungen konnten nicht geladen werden",
  "invitations.empty.title": "Keine offenen Einladungen",
  "invitations.empty.body":
    "Wenn ein Admin deine Adresse in einen Workspace einlädt, erscheint die Einladung hier und in deinem Postfach.",
  "invitations.others": "Weitere Einladungen",
  "invitations.notice.title": "Du bist in einen Workspace eingeladen",
  "invitations.notice.body":
    "{count, plural, one {Du hast # offene Einladung.} other {Du hast # offene Einladungen.}}",
  "invitations.notice.link": "Einladungen ansehen",
  "workspaces.title": "Workspaces",
  "workspaces.description":
    "Die Workspaces, zu denen du gehörst, und deine Rolle in jedem. Admins laden Personen ein und ändern Rollen auf der Mitglieder-Seite des Workspace.",
  "workspaces.loading": "Workspaces werden geladen",
  "workspaces.loadFailed": "Workspaces konnten nicht geladen werden",
  "workspaces.none":
    "Du gehörst zu keinem Workspace. Portifact richtet Workspaces für Teams ein, und ein Admin lädt dich per E-Mail ein.",
  "workspaces.leave": "Verlassen",
  "workspaces.leaveNamed": "Verlassen: {workspace}",
  "account.delete.soleAdmin.title": "Du bist der einzige Admin eines Workspace",
  "account.delete.soleAdmin.body":
    "Ein Workspace braucht einen Admin. Mach in jedem dieser Workspaces ein anderes Mitglied zum Admin oder bitte Portifact unter hello@portifact.com, sie zu löschen, und lösch dann dein Konto.",
  "account.delete.soleAdmin.members": "Mitglieder von {workspace}",
  "webhooks.adminOnly.title": "Nur Admins verwalten Webhooks",
  "webhooks.adminOnly.body":
    "Webhooks senden die Ereignisse der Artifacts dieses Workspace an andere Systeme, deshalb können nur die Admins von {workspace} sie sehen und verwalten. Frag eine dieser Personen, wenn du einen Webhook brauchst.",
  "shell.planLink": "Plan",
  "plan.title": "Plan",
  "plan.description":
    "Der Plan deines persönlichen Bereichs, seine Limits und Funktionen und die anderen Pläne.",
  "plan.descriptionWorkspace":
    "Der Plan von {workspace}, seine Limits und Funktionen und die anderen Pläne.",
  "plan.current.hint":
    "Was dieser Bereich jetzt hat. Die Seite Nutzung zeigt, wie viel davon genutzt wird.",
  "plan.current.limits": "Limits des aktuellen Plans",
  "plan.current.usageLink": "Nutzung ansehen",
  "plan.grace.title": "Was der Tarif {plan} aufbewahrte, bleibt bis {date} erhalten",
  "plan.grace.body":
    "Bis dahin wird nichts gelöscht: bis zu {versions} frühere Versionen jedes Artefakts für {days} Tage sowie das Zugriffsprotokoll und die Analysen für {log} Tage. Nach diesem Datum wird gelöscht, was der Tarif dieses Bereichs nicht aufbewahrt.",
  "plan.grace.reads": "Bis dahin weiterhin lesbar: {features}.",
  "plan.grace.download":
    "Lade vorher herunter, was du brauchst: Der Verlauf jedes Artefakts enthält seine Versionen, und Zugriffs- und Auditprotokoll haben ihre Exporte. Oder fordere den Tarif erneut an, um alles zu behalten.",
  "data.title": "Daten herunterladen",
  "data.description":
    "Alles, was dieser Bereich enthält und du mitnehmen kannst: die aufbewahrten Versionen jedes Artefakts und ihre Quellen, Zugriffsprotokolle und Datensätze (Einstellungen, Zugriffsregeln, Freigabelinks, Prüfungen, Analysen und Kommentare), die Datensätze des Bereichs, das Audit-Protokoll und für deinen persönlichen Bereich die Daten deines Kontos. Dateien kommen direkt aus dem Speicher; auf dem Server wird nichts gebündelt.",
  "data.adminsOnly": "Alle Daten von {workspace} herunterzuladen, ist Sache seiner Admins.",
  "data.grace.title": "Was wann gelöscht wird",
  "data.grace.hint":
    "Ein Tarif, der abgelaufen ist, entfernt oder herabgestuft wurde, bewahrt 60 Tage lang auf, was er aufbewahrte. Danach wird gelöscht, was der Tarif dieses Bereichs nicht aufbewahrt.",
  "data.grace.body":
    "Lade vor diesen Daten herunter, was du brauchst, oder fordere den Tarif erneut an, um alles zu behalten.",
  "data.grace.loading": "Lade, was wann gelöscht wird",
  "data.grace.error": "Was wann gelöscht wird, konnte nicht geladen werden.",
  "data.grace.nothing": "Nichts Aufbewahrtes wird gelöscht, wenn die Schonfrist endet.",
  "data.grace.caption": "Was am Ende der Schonfrist gelöscht wird, und ab wann",
  "data.grace.column.kind": "Was",
  "data.grace.column.count": "Anzahl",
  "data.grace.column.from": "Ab",
  "data.kind.versions": "Frühere Versionen",
  "data.kind.accessLog": "Einträge im Zugriffsprotokoll",
  "data.kind.analytics": "Tägliche Analysezähler",
  "data.kind.auditEvents": "Audit-Ereignisse",
  "data.kind.pins": "Angeheftete Artefakte (gelöst, dann wie üblich archiviert)",
  "data.artifacts.title": "Artefakte",
  "data.artifacts.hint":
    "Öffne ein Artefakt, um jede aufbewahrte Version herunterzuladen, veröffentlichte Dateien oder Quellen.",
  "data.artifacts.loading": "Lade Artefakte",
  "data.artifacts.error": "Die Artefakte konnten nicht geladen werden.",
  "data.artifacts.none": "Dieser Bereich hat keine Artefakte.",
  "data.artifacts.more": "Weitere Artefakte anzeigen",
  "data.artifact.summary":
    "{name}: {count, plural, one {# aufbewahrte Version} other {# aufbewahrte Versionen}}",
  "data.versions.title": "Versionen von {name}",
  "data.versions.caption": "Aufbewahrte Versionen von {name}, neueste zuerst",
  "data.versions.size": "Größe",
  "data.accessLog.csv": "Zugriffsprotokoll als CSV",
  "data.accessLog.json": "Zugriffsprotokoll als JSON",
  "data.accessLog.csvLabel": "Zugriffsprotokoll als CSV von {name}",
  "data.accessLog.jsonLabel": "Zugriffsprotokoll als JSON von {name}",
  "data.accessLog.saved": "Das Zugriffsprotokoll ist bereit.",
  "data.records.button": "Datensätze (JSON)",
  "data.records.label": "Datensätze (JSON) von {name}",
  "data.records.saved": "Die Datensätze sind bereit.",
  "data.records.later":
    "Einige Teile fehlen, weil der Server um Geduld gebeten hat. Lade sie in ein paar Minuten erneut herunter.",
  "data.records.failed": "Die Datensätze konnten nicht heruntergeladen werden.",
  "data.space.title": "Datensätze des Bereichs",
  "data.space.hint":
    "Die Einstellungen des Bereichs, ohne Geheimnisse: für einen Workspace seine Mitglieder und Rollen, Gruppen und ihre Mitglieder, Einladungen, E-Mail-Domains, Richtlinien, Single Sign-on und Dienst-Tokens; für jeden Bereich Branding, Webhooks, Integrationen und Audit-Streams.",
  "data.space.download": "Datensätze des Bereichs herunterladen (JSON)",
  "data.space.logo": "Logo der Marke herunterladen",
  "data.logs.title": "Protokolle und Konto",
  "data.logs.hint":
    "Das Auditprotokoll des Bereichs hat einen eigenen Export, und dein persönlicher Bereich enthält die Daten deines Kontos.",
  "data.logs.audit": "Exportiere das Auditprotokoll auf der Seite Auditprotokoll",
  "data.logs.account": "Lade die Daten deines Kontos herunter (JSON)",
  "data.logs.cli":
    "Um alles auf einmal mitzunehmen, führe portifact export <Ordner> in einem Terminal aus: Es lädt jede aufbewahrte Version und die Datensätze jedes Artefakts, setzt nach einer Unterbrechung fort und schreibt ein Manifest. Mitglieder, Einladungen und andere Einstellungen, die nur das Dashboard liest, stehen oben in den Datensätzen des Bereichs.",
  "shell.grace.title": "Was der Tarif {plan} aufbewahrte, bleibt bis {date} erhalten",
  "shell.grace.download": "Daten herunterladen",
  "shell.grace.request": "{plan} erneut anfordern",
  "shell.grace.hide": "Für heute ausblenden",
  "shell.grace.body":
    "Nach diesem Datum wird gelöscht, was der Tarif dieses Bereichs nicht aufbewahrt. Lade herunter, was du brauchst, oder fordere den Tarif erneut an, um alles zu behalten.",
  "shell.grace.bodyAskAdmin":
    "Nach diesem Datum wird gelöscht, was der Tarif dieses Bereichs nicht aufbewahrt. Bitte einen Admin dieses Bereichs, herunterzuladen, was du brauchst, oder den Tarif erneut anzufordern.",
  "plan.loading": "Plan wird geladen",
  "plan.error": "Der Plan konnte nicht geladen werden.",
  "plan.compare.section": "Alle Pläne",
  "plan.requestNote": "Nur die Admins von {workspace} können einen anderen Plan anfragen.",
  "plan.hidden": "Der Plan von {workspace} wird seinen Editoren und Admins angezeigt.",
  "usage.plan.compare": "Pläne vergleichen",
  "shell.auditLink": "Audit-Log",
  "audit.title": "Audit-Log",
  "audit.description":
    "Wer in diesem Bereich was geändert hat. Änderungen werden {days} Tage aufbewahrt.",
  "audit.planTitle": "Das Audit-Log gehört zu einem kostenpflichtigen Tarif",
  "audit.planRequired":
    "Das Audit-Log gehört zum Tarif {plan}. Änderungen werden bereits aufgezeichnet, daher erscheinen hier die letzten 90 Tage, sobald der Tarif es enthält.",
  "audit.forbidden.title": "Nur Admins können das Audit-Log lesen",
  "audit.forbidden.body":
    "Frag einen Admin dieses Workspaces, wenn du wissen musst, wer etwas geändert hat.",
  "audit.loading": "Audit-Log wird geladen",
  "audit.error.title": "Das Audit-Log konnte nicht geladen werden",
  "audit.empty.title": "Keine Änderungen aufgezeichnet",
  "audit.empty.body": "In den letzten {days} Tagen passt nichts zu diesen Filtern.",
  "audit.caption": "Änderungen in diesem Bereich, neueste zuerst",
  "audit.column.when": "Wann",
  "audit.column.who": "Wer",
  "audit.column.what": "Was",
  "audit.column.on": "Bei",
  "audit.loadMore": "Ältere Änderungen anzeigen",
  "audit.filters": "Audit-Log filtern",
  "audit.filter.kind": "Art der Änderung",
  "audit.filter.actor": "Wer",
  "audit.filter.period": "Zeitraum",
  "audit.group.all": "Alle Änderungen",
  "audit.group.access": "Zugriff und Teilen",
  "audit.group.lifecycle": "Veröffentlichen und Lebenszyklus",
  "audit.group.integrations": "Domains, Webhooks und Marke",
  "audit.group.members": "Mitglieder, Tokens und Tarif",
  "audit.actor.all": "Alle",
  "audit.period.day": "Letzte 24 Stunden",
  "audit.period.week": "Letzte 7 Tage",
  "audit.period.month": "Letzte 30 Tage",
  "audit.period.all": "Alles Aufbewahrte",
  "audit.actor.removed": "Entferntes Mitglied",
  "audit.actor.token": "{label} (Service-Token)",
  "audit.actor.tokenGone": "Widerrufenes Service-Token",
  "audit.actor.operator": "Portifact-Betreiber",
  "audit.actor.system": "Portifact",
  "audit.artifact.gone": "Gelöschtes Artifact",
  "audit.target.space": "Dieser Bereich",
  "audit.target.invitation": "Eine Einladung",
  "audit.kind.published": "Hat Version {version} veröffentlicht",
  "audit.kind.publishedFirst": "Hat es mit Version {version} erstellt",
  "audit.kind.rolledBack":
    "Hat die Dateien von Version {from} wiederhergestellt, jetzt Version {version}",
  "audit.kind.renewed": "Hat es verlängert",
  "audit.kind.archived": "Hat es archiviert",
  "audit.kind.restored": "Hat es wiederhergestellt",
  "audit.kind.deleted": "Hat es gelöscht",
  "audit.kind.pinned": "Hat es angeheftet",
  "audit.kind.unpinned": "Hat es losgelöst",
  "audit.kind.transferredIn":
    "Hat es hierher verschoben aus {from, select, workspace {einem Workspace} other {einem persönlichen Bereich}}",
  "audit.kind.transferredOut":
    "Hat es verschoben in {to, select, workspace {einen Workspace} other {einen persönlichen Bereich}}",
  "audit.kind.accessChanged": "Hat den Zugriff geändert: {changes}",
  "audit.access.mode":
    "{mode, select, public {öffentlich gemacht} authenticated {für alle Angemeldeten geöffnet} other {auf gelistete Leser beschränkt}}",
  "audit.access.readersAdded":
    "{count, plural, one {# Leser hinzugefügt} other {# Leser hinzugefügt}}",
  "audit.access.readersRemoved": "{count, plural, one {# Leser entfernt} other {# Leser entfernt}}",
  "audit.access.domains": "bei {domains}",
  "audit.access.exceptions":
    "{count, plural, one {Kommentarsicht für # Leser geändert} other {Kommentarsicht für # Leser geändert}}",
  "audit.access.bar":
    "{on, select, true {Portifact-Leiste eingeschaltet} other {Portifact-Leiste ausgeschaltet}}",
  "audit.access.comments":
    "{visibility, select, everyone {Kommentare für alle sichtbar} other {Kommentare nur für die Eigentümerseite sichtbar}}",
  "audit.access.indexable": "{on, select, true {Indexierung erlaubt} other {Indexierung beendet}}",
  "audit.access.embeddable": "{on, select, true {Einbetten erlaubt} other {Einbetten beendet}}",
  "audit.kind.shareLinkCreated":
    "Hat einen Freigabelink erstellt{password, select, true { mit Passwort} other {}}{expires, select, true {, der abläuft} other {}}",
  "audit.kind.shareLinkRevoked": "Hat einen Freigabelink widerrufen",
  "detail.section.reviews": "Prüfungen",
  "approval.title": "Freigabeprüfungen",
  "approval.description":
    "Bitten Sie Personen, die aktuelle Version freizugeben. Prüfende müssen dieses Artifact bereits öffnen und kommentieren können: Eine Anfrage gibt niemandem Zugriff. Eine neue Version startet die Prüfung neu.",
  "approval.loading": "Prüfung wird geladen",
  "approval.loadFailed": "Die Prüfung wurde nicht geladen",
  "approval.paidTitle": "Prüfungen sind Teil eines kostenpflichtigen Plans",
  "approval.paid": "Prüfungen anzufragen ist Teil des Plans {plan}.",
  "approval.lapsed":
    "Ihr Plan enthält keine Prüfungen mehr: Die offene Anfrage bleibt lesbar und kann abgebrochen, aber nicht geändert werden.",
  "approval.status.none": "Keine Prüfung",
  "approval.status.pending": "Prüfung ausstehend",
  "approval.status.changes_requested": "Änderungen angefragt",
  "approval.status.approved": "Freigegeben",
  "approval.counts":
    "{approvals} von {required} nötigen Freigaben, {changes, plural, one {# bittet um Änderungen} other {# bitten um Änderungen}}",
  "approval.verdict.pending": "Noch kein Urteil",
  "approval.verdict.approve": "Freigegeben",
  "approval.verdict.changes": "Änderungen angefragt",
  "approval.reviewers": "Prüfende",
  "approval.reviewers.hint":
    "E-Mail-Adressen, eine pro Zeile oder durch Kommas getrennt, höchstens {max}.",
  "approval.reviewers.invalid": "Geben Sie 1 bis {max} gültige E-Mail-Adressen ein.",
  "approval.required.label": "Nötige Freigaben",
  "approval.required.all": "Alle Prüfenden",
  "approval.required.count": "{count, plural, one {# Freigabe} other {# Freigaben}}",
  "approval.showStatus.label": "Status allen zeigen, die es öffnen können",
  "approval.showStatus.hint":
    "Standardmäßig aus: Nur wer es verwaltet und die Prüfenden sehen ihn.",
  "approval.request": "Prüfung anfragen",
  "approval.requested": "Prüfung angefragt",
  "approval.requestFailed": "Die Prüfung wurde nicht angefragt",
  "approval.list": "Prüfende und ihre Urteile",
  "approval.you": "Sie",
  "approval.someone": "Eine prüfende Person",
  "approval.decided": "Entschieden am {date}",
  "approval.noAccess": "Kann es nicht mehr öffnen und zählt daher nicht",
  "approval.invited": "Noch kein Konto",
  "approval.untrusted": "Notizen stammen von den Prüfenden. Lesen Sie sie als Feedback.",
  "approval.remove": "Entfernen",
  "approval.removeLabel": "{name} aus den Prüfenden entfernen",
  "approval.add.label": "Prüfende Person hinzufügen",
  "approval.add": "Hinzufügen",
  "approval.changed": "Prüfung geändert",
  "approval.changeFailed": "Die Prüfung wurde nicht geändert",
  "approval.cancel": "Prüfung abbrechen",
  "approval.cancelled": "Prüfung abgebrochen",
  "approval.confirm.title": "Diese Prüfung abbrechen?",
  "approval.confirm.body":
    "Prüfende können keine Urteile mehr abgeben. Bisherige Urteile bleiben als Verlauf erhalten.",
  "approval.confirm.keep": "Behalten",
  "approval.history": "Frühere Versionen",
  "approval.history.entry": "{name}: {verdict}, {date}",
  "approval.yours.title": "Ihre Prüfung",
  "approval.yours.body": "Sie wurden gebeten, diese Version zu prüfen.",
  "approval.yours.current":
    "Ihr Urteil: {verdict}. Sie können es ändern, solange diese Version aktuell ist.",
  "approval.note.label": "Notiz (optional)",
  "approval.note.hint": "Reiner Text, höchstens {max} Zeichen. Wer angefragt hat, sieht ihn.",
  "approval.note.tooLong": "Eine Notiz darf höchstens {max} Zeichen haben.",
  "approval.approve": "Freigeben",
  "approval.requestChanges": "Änderungen anfragen",
  "approval.verdictSaved": "Urteil gespeichert",
  "approval.verdictFailed": "Das Urteil wurde nicht gespeichert",
  "approval.newVersion": "Es gibt eine neuere Version. Laden Sie die Seite neu, um sie zu prüfen.",
  "audit.kind.reviewRequested":
    "{reviewers, plural, one {Hat # Person um eine Prüfung gebeten} other {Hat # Personen um eine Prüfung gebeten}}",
  "audit.kind.reviewChanged": "Hat eine Prüfungsanfrage geändert",
  "audit.kind.reviewCancelled": "Hat eine Prüfungsanfrage abgebrochen",
  "audit.kind.suggestionAccepted":
    "Hat einen Vorschlag als Version {version} angenommen: {applied} angewendet, {listed} in die Änderungsliste",
  "audit.kind.suggestionAcceptedNothing":
    "Hat einen Vorschlag angenommen, ohne etwas anzuwenden: {listed} in die Änderungsliste",
  "audit.kind.draftPublished":
    "Hat einen Entwurf als Version {version} veröffentlicht: {applied} angewendet, {listed} in die Änderungsliste",
  "audit.kind.draftPublishedNothing":
    "Hat einen Entwurf veröffentlicht, ohne etwas anzuwenden: {listed} in die Änderungsliste",
  "audit.kind.suggestionRejected": "Hat einen Vorschlag abgelehnt",
  "audit.kind.suggestionWithdrawn": "Hat einen Vorschlag zurückgezogen",
  "audit.kind.changeItemApplied": "Hat einen Eintrag der Änderungsliste als angewendet markiert",
  "audit.kind.changeItemDismissed": "Hat einen Eintrag der Änderungsliste verworfen",
  "audit.kind.changeItemReopened": "Hat einen Eintrag der Änderungsliste wieder geöffnet",
  "audit.kind.reviewVerdict":
    "{verdict, select, approve {Hat Version {version} freigegeben} other {Hat Änderungen an Version {version} angefragt}}",
  "audit.kind.domainAttached": "Hat die Domain {hostname} verbunden",
  "audit.kind.domainRemoved":
    "{reason, select, removed {Hat die Domain {hostname} entfernt} operator {Portifact hat die Domain {hostname} entfernt} other {Die Domain {hostname} wurde automatisch getrennt}}",
  "audit.kind.webhookCreated":
    "Hat einen {format, select, slack {Slack-} discord {Discord-} other {signierten }}Webhook an {host} hinzugefügt",
  "audit.kind.webhookChanged":
    "{enabled, select, true {Hat einen Webhook eingeschaltet} false {Hat einen Webhook ausgeschaltet} other {Hat die Ereignisse eines Webhooks geändert}}",
  "audit.kind.webhookRemoved": "Hat einen Webhook entfernt",
  "audit.kind.brandChanged":
    "{logo, select, true {Hat das Logo der Marke geändert} other {Hat Name, Farbe oder Link der Marke geändert}}",
  "audit.kind.brandRemoved":
    "{logo, select, true {Hat das Logo der Marke entfernt} other {Hat die Marke entfernt}}",
  "audit.kind.memberInvited": "Hat jemanden bei {domain} als {role} eingeladen",
  "audit.kind.invitationRevoked": "Hat eine Einladung widerrufen",
  "audit.kind.memberJoined": "{member} ist als {role} beigetreten",
  "audit.kind.roleChanged": "Hat {member} von {from} zu {to} geändert",
  "audit.kind.memberRemoved": "Hat {member} entfernt",
  "audit.kind.memberLeft": "{member} hat den Workspace verlassen",
  "audit.kind.planGranted":
    "Hat den Tarif {plan} mit {seats, plural, one {# Platz} other {# Plätzen}} festgelegt",
  "audit.kind.planGrantedUntil":
    "Hat den Tarif {plan} mit {seats, plural, one {# Platz} other {# Plätzen}} bis {until} festgelegt",
  "audit.kind.graceStarted":
    "Schonfrist begonnen ({reason}): was der Tarif {plan} aufbewahrte, bleibt bis {until} erhalten",
  "audit.kind.graceEnded":
    "Schonfrist für das, was der Tarif {plan} aufbewahrte, beendet ({reason})",
  "audit.graceStart.lowered": "Tarif herabgestuft",
  "audit.graceStart.removed": "Tarif entfernt",
  "audit.graceStart.expired": "Tarif abgelaufen",
  "audit.graceStart.unreadable": "Schonfrist unlesbar",
  "audit.graceEnd.renewed": "Tarif erneuert",
  "audit.graceEnd.operator": "von Portifact beendet",
  "audit.graceEnd.expired": "Frist abgelaufen",
  "audit.graceEnd.folded": "mit einer späteren zusammengeführt",
  "audit.kind.planRemoved": "Hat den Tarif entfernt, der Bereich ist wieder auf Free",
  "audit.kind.tokenCreated":
    "Hat ein Service-Token erstellt, das in {days, plural, one {# Tag} other {# Tagen}} abläuft",
  "audit.kind.tokenRevoked": "Hat ein Service-Token widerrufen",
  "audit.export.label": "Audit-Log exportieren",
  "audit.export.csv": "Als CSV exportieren",
  "audit.export.jsonl": "Als JSON Lines exportieren",
  "audit.export.hint":
    "Lädt alle gespeicherten Änderungen herunter, die zu den Filtern passen, die neuesten zuerst. Mitglieder erscheinen mit Namen, nie mit Adresse.",
  "audit.export.doneCsv": "Das Audit-Log wurde als CSV exportiert.",
  "audit.export.doneJsonl": "Das Audit-Log wurde als JSON Lines exportiert.",
  "audit.export.failed": "Das Audit-Log konnte nicht exportiert werden",
  "audit.export.planRequired": "Das Exportieren des Audit-Logs ist Teil des {plan}-Plans.",
  "audit.kind.exported":
    "{format, select, csv {Hat das Audit-Log als CSV exportiert} other {Hat das Audit-Log als JSON Lines exportiert}}",
  "audit.kind.emailDomainVerified": "Hat die E-Mail-Domain {domain} verifiziert",
  "audit.kind.emailDomainRemoved":
    "{reason, select, removed {Hat die E-Mail-Domain {domain} entfernt} claimed {Die E-Mail-Domain {domain} wurde entfernt, weil ein anderer Workspace sie nachgewiesen hat} other {Die E-Mail-Domain {domain} wurde entfernt, weil ihr DNS-Eintrag fehlt}}",
  "shell.serviceTokensLink": "Service-Tokens",
  "tokens.title": "Service-Tokens",
  "tokens.description":
    "Zugangsdaten, mit denen Automatisierung wie CI in {workspace} veröffentlicht, ohne die Anmeldung einer Person. Jedes Token hat eine Rolle, Berechtigungen und ein Ablaufdatum und funktioniert nicht mehr, sobald du es widerrufst.",
  "tokens.personal.title": "Service-Tokens gehören zu einem Workspace",
  "tokens.personal.body":
    "Wechsle zu einem Workspace, den du verwaltest, um Tokens dafür zu erstellen.",
  "tokens.adminOnly.title": "Nur Admins verwalten Service-Tokens",
  "tokens.adminOnly.body": "Bitte einen Admin dieses Workspace um ein Token.",
  "tokens.planTitle": "Service-Tokens sind nicht im Plan dieses Workspace",
  "tokens.planRequired":
    "Service-Tokens zu erstellen gehört zum Plan {plan}. Vorhandene Tokens werden angezeigt und können widerrufen werden, funktionieren aber erst wieder, wenn der Plan sie enthält.",
  "tokens.list.title": "Tokens",
  "tokens.loading": "Service-Tokens werden geladen",
  "tokens.loadFailed": "Service-Tokens konnten nicht geladen werden",
  "tokens.empty.title": "Noch keine Service-Tokens",
  "tokens.empty.body":
    "Erstelle eins für einen CI-Job, speichere es als Secret PORTIFACT_TOKEN und führe die portifact-CLI aus.",
  "tokens.secret.title": "Kopiere das Token jetzt",
  "tokens.secret.body":
    "Es wird nur dieses eine Mal angezeigt. Speichere es als Secret deiner CI, zum Beispiel PORTIFACT_TOKEN. Wer es hat, kann tun, was seine Berechtigungen erlauben, bis es abläuft oder du es widerrufst.",
  "tokens.secret.label": "Service-Token {label}",
  "tokens.secret.copy": "Token kopieren",
  "tokens.secret.done": "Ich habe es gespeichert",
  "tokens.create.title": "Token erstellen",
  "tokens.create.hint": "Es handelt für den Workspace, nie für dich, und ist nie Mitglied.",
  "tokens.create.limit":
    "Dieser Workspace hat die maximale Anzahl Tokens ({limit}). Widerrufe eins, um ein neues zu erstellen.",
  "tokens.create.label": "Bezeichnung",
  "tokens.create.labelHint": "Wo es verwendet wird, zum Beispiel GitHub-Vorschauen",
  "tokens.create.labelError": "Gib eine Bezeichnung mit 1 bis 80 Zeichen ein.",
  "tokens.create.scopes": "Was es darf",
  "tokens.create.scopesError": "Wähle mindestens eine aus.",
  "tokens.create.expiry": "Läuft ab nach",
  "tokens.create.expiryHint": "Wenn es abläuft, ersetzt es ein neues Token.",
  "tokens.create.days": "{days, plural, one {# Tag} other {# Tagen}}",
  "tokens.create.restriction": "Beschränken auf",
  "tokens.create.prefix": "Schlüsselpräfix",
  "tokens.create.prefixHint":
    "Jedes Artifact, das es veröffentlicht, braucht einen Schlüssel mit diesem Anfang, zum Beispiel pr-.",
  "tokens.create.prefixError":
    "Verwende Buchstaben, Ziffern, Punkte, Unterstriche, Schrägstriche oder Bindestriche, beginnend mit einem Buchstaben oder einer Ziffer.",
  "tokens.create.submit": "Token erstellen",
  "tokens.scope.read": "Lesen",
  "tokens.scope.readHint": "Artifacts und ihre Versionen auflisten",
  "tokens.scope.write": "Veröffentlichen",
  "tokens.scope.writeHint":
    "Neue Artifacts und Versionen veröffentlichen, verlängern und archivieren",
  "tokens.scope.share": "Teilen",
  "tokens.scope.shareHint":
    "Ändern, wer ein Artifact öffnen kann, auch öffentlich machen. Ein geleaktes Token könnte Artifacts offenlegen.",
  "tokens.scope.delete": "Löschen",
  "tokens.scope.deleteHint":
    "Artifacts endgültig löschen. Ein geleaktes Token könnte sie zerstören; beschränke es auf ein Schlüsselpräfix.",
  "tokens.restriction.none": "Alle Artifacts des Workspace",
  "tokens.restriction.noneHint": "Das Token erreicht jedes Artifact des Workspace.",
  "tokens.restriction.own": "Artifacts, die es erstellt hat",
  "tokens.restriction.ownHint":
    "Was Personen oder andere Tokens veröffentlichen, erscheint ihm als nicht vorhanden.",
  "tokens.restriction.key": "Artifacts mit einem Schlüsselpräfix",
  "tokens.restriction.keyHint":
    "Nur Artifacts, die mit einem Schlüssel unter dem gewählten Präfix veröffentlicht wurden.",
  "tokens.created": "Token {label} erstellt",
  "tokens.actionFailed": "Das hat nicht funktioniert",
  "tokens.reach.none": "Erreicht jedes Artifact des Workspace",
  "tokens.reach.own": "Erreicht nur die Artifacts, die es erstellt hat",
  "tokens.reach.key": "Erreicht nur Schlüssel, die mit {prefix} beginnen",
  "tokens.expired": "Abgelaufen",
  "tokens.revoke": "Widerrufen",
  "tokens.revokeLabel": "{label} widerrufen",
  "tokens.scopes": "Berechtigungen: {scopes}",
  "tokens.expiresOn": "Läuft am {date} ab",
  "tokens.expiredOn": "Am {date} abgelaufen",
  "tokens.lastUsed": "Zuletzt verwendet {when}",
  "tokens.neverUsed": "Nie verwendet",
  "tokens.createdBy": "Erstellt von {name} am {date}",
  "tokens.createdOn": "Erstellt am {date}",
  "tokens.revoked": "Token {label} widerrufen",
  "tokens.confirm.title": "{label} widerrufen?",
  "github.title": "GitHub Actions",
  "github.hint":
    "Workflows eines vertrauenswürdigen Repositorys veröffentlichen Vorschauen ohne gespeichertes Token.",
  "github.off":
    "Die Anmeldung mit GitHub Actions ist auf Portifact noch nicht verfügbar. Die hier aufgeführten Repositorys können Sie trotzdem entfernen.",
  "github.audience": "Audience",
  "github.audienceCopy": "Audience kopieren",
  "github.audienceHint":
    "Der Workflow fordert bei GitHub ein ID-Token mit dieser Audience an. Die Vorschau-Action und die CLI erledigen das für Sie.",
  "github.loading": "Vertrauenswürdige Repositorys werden geladen",
  "github.loadFailed": "Die vertrauenswürdigen Repositorys konnten nicht geladen werden.",
  "github.empty.title": "Keine vertrauenswürdigen Repositorys",
  "github.empty.body":
    "Vertrauen Sie einem Repository, damit seine Workflows ohne Token Vorschauen in diesem Workspace veröffentlichen.",
  "github.create.title": "Einem Repository vertrauen",
  "github.create.hint":
    "Das Vertrauen hängt an den numerischen IDs von GitHub: Ein umbenanntes Repository bleibt vertrauenswürdig, ein gelöschtes und neu angelegtes nicht.",
  "github.create.repository": "Repository",
  "github.create.repositoryHint": "Als Besitzer/Name. Nur zur Anzeige; wird nie geprüft.",
  "github.create.repositoryError": "Verwenden Sie Besitzer/Name, etwa acme/site.",
  "github.create.repositoryId": "Repository-ID",
  "github.create.ownerId": "Besitzer-ID",
  "github.create.idsHint":
    "Beide finden Sie mit gh api repos/OWNER/REPO --jq .id,.owner.id oder in GITHUB_REPOSITORY_ID und GITHUB_REPOSITORY_OWNER_ID eines Laufs.",
  "github.create.idError": "Verwenden Sie die Zahl, die GitHub anzeigt.",
  "github.create.events": "Ereignisse, die veröffentlichen dürfen",
  "github.create.eventsError": "Wählen Sie mindestens ein Ereignis.",
  "github.event.push": "push",
  "github.event.pushHint":
    "Pushes in das Repository. Nur Personen mit Schreibzugriff können pushen.",
  "github.event.pull_request": "pull_request",
  "github.event.pull_requestHint":
    "Pull Requests. In einem öffentlichen Repository erhält der Lauf eines Forks kein ID-Token, daher veröffentlichen nur Branches des Repositorys selbst. In einem privaten Repository mit Schreib-Tokens für Forks kann auch der Lauf eines Forks veröffentlichen.",
  "github.event.workflow_dispatch": "workflow_dispatch",
  "github.event.workflow_dispatchHint": "Von Personen mit Schreibzugriff manuell gestartete Läufe.",
  "github.event.merge_group": "merge_group",
  "github.event.merge_groupHint": "Läufe der Merge-Queue, die GitHub für das Repository startet.",
  "github.event.release": "release",
  "github.event.releaseHint": "Im Repository veröffentlichte Releases.",
  "github.event.schedule": "schedule",
  "github.event.scheduleHint": "Geplante Läufe des Standard-Branches.",
  "github.event.pull_request_target": "pull_request_target",
  "github.event.pull_request_targetHint":
    "Privilegierte Läufe, die der Pull Request eines Forks starten kann. Nur sicher, wenn der Workflow den Code des Forks nie baut.",
  "github.event.workflow_run": "workflow_run",
  "github.event.workflow_runHint":
    "Privilegierte Läufe, die ein anderer Workflow startet und die der Pull Request eines Forks auslösen kann. Nur sicher, wenn der Workflow den Code des Forks nie baut.",
  "github.create.privileged":
    "Mir ist klar, dass der Pull Request eines Forks diese Läufe starten kann und der Workflow dessen Code nie baut",
  "github.create.privilegedError":
    "Bestätigen Sie dies, um pull_request_target oder workflow_run zu vertrauen.",
  "github.create.ref": "Ref (optional)",
  "github.create.refHint":
    "Exakt, etwa refs/heads/main. Die Ref eines Pull-Request-Laufs ist refs/pull/NUMMER/merge, mit einer Branch-Ref veröffentlicht also kein Pull Request.",
  "github.create.refError": "Verwenden Sie eine vollständige Ref, die mit refs/ beginnt.",
  "github.create.environment": "Umgebung (optional)",
  "github.create.environmentHint":
    "Exakter Name. GitHub wendet die Schutzregeln der Umgebung an, etwa erforderliche Reviewer, bevor der Job sein Token erhält.",
  "github.create.scopes": "Was seine Läufe dürfen",
  "github.create.scopesError": "Wählen Sie mindestens eins.",
  "github.create.submit": "Repository vertrauen",
  "github.create.limit": "Ein Workspace kann höchstens {limit} Repositorys vertrauen.",
  "github.created": "{repository} ist jetzt vertrauenswürdig.",
  "github.rule.ids": "Repository-ID {repositoryId}, Besitzer-ID {ownerId}",
  "github.rule.events": "Ereignisse: {events}",
  "github.rule.prefix": "Veröffentlicht nur Schlüssel, die mit {prefix} beginnen",
  "github.rule.ref": "Ref: {ref}",
  "github.rule.environment": "Umgebung: {environment}",
  "github.rule.live":
    "{count, plural, =0 {Keine aktiven Zugangsdaten} one {# aktive Zugangsdaten} other {# aktive Zugangsdaten}}",
  "github.remove": "Entfernen",
  "github.removeLabel": "Entfernen {repository}",
  "github.confirm.title": "{repository} nicht mehr vertrauen?",
  "github.confirm.body":
    "Seine Workflows können nicht mehr veröffentlichen, und bereits ausgegebene Zugangsdaten seiner Läufe funktionieren sofort nicht mehr.",
  "github.removed": "{repository} ist nicht mehr vertrauenswürdig.",
  "audit.kind.githubTrusted": "Hat dem GitHub-Repository {repository} vertraut",
  "audit.kind.githubTrustChanged":
    "Hat das Vertrauen in das GitHub-Repository {repository} geändert",
  "audit.kind.githubTrustRemoved": "Vertraut dem GitHub-Repository {repository} nicht mehr",
  "audit.kind.githubExchanged": "GitHub-Lauf {run} von {repository} hat Zugangsdaten erhalten",
  "tokens.confirm.body":
    "Alles, was es verwendet, funktioniert ab der nächsten Anfrage nicht mehr. Das lässt sich nicht rückgängig machen.",
  "access.workspace": "Der ganze Workspace",
  "access.domain": "Der Workspace und seine E-Mail-Domains",
  "list.access.workspace": "Workspace",
  "list.access.domain": "E-Mail-Domain",
  "accessSettings.mode.workspace":
    "{count, plural, one {Das # Mitglied dieses Workspaces} other {Alle # Mitglieder dieses Workspaces}}, nach der Anmeldung, in jeder Rolle.",
  "accessSettings.mode.domain":
    "{count, plural, one {Das # Mitglied dieses Workspaces} other {Alle # Mitglieder dieses Workspaces}} und alle, die mit einer bestätigten Adresse bei {domains} angemeldet sind.",
  "accessSettings.mode.domainNone":
    "{count, plural, one {Das # Mitglied dieses Workspaces} other {Alle # Mitglieder dieses Workspaces}} und alle, die mit einer bestätigten Adresse bei den E-Mail-Domains des Workspaces angemeldet sind. Noch ist keine Domain bestätigt: Ein Admin fügt eine auf der Seite Mitglieder hinzu.",
  "accessSettings.mode.listOnlyRestricted":
    "Die unten aufgeführten Personen können es nur öffnen, solange es eingeschränkt ist.",
  "accessSettings.mode.workspacePlan": "Teil des Plans {plan}.",
  "accessSettings.lapsed.title": "Vorerst können nur Mitglieder dieses Artifact öffnen",
  "accessSettings.lapsed.body":
    "Der Plan des Workspaces umfasst gerade kein Teilen mit E-Mail-Domains, daher können nur seine Mitglieder dieses Artifact öffnen, bis der Plan es wieder umfasst. Es wurde nichts geändert.",
  "emailDomains.title": "E-Mail-Domains",
  "emailDomains.description":
    "Wer bei Portifact mit einer bestätigten Adresse bei einer dieser Domains angemeldet ist, kann die Artifacts des Workspaces öffnen, die mit seinen E-Mail-Domains geteilt sind. Es zählt nur die genaue Domain, keine Subdomains.",
  "emailDomains.loading": "E-Mail-Domains werden geladen",
  "emailDomains.loadFailed": "E-Mail-Domains konnten nicht geladen werden",
  "emailDomains.rules":
    "Weisen Sie jede Domain mit einem DNS-Eintrag nach. Öffentliche E-Mail-Anbieter (etwa gmail.com), geteilte Suffixe und die Domains von Portifact werden abgelehnt. Portifact prüft den Eintrag täglich und entfernt eine Domain nach 3 fehlgeschlagenen Prüfungen in Folge.",
  "emailDomains.addFailed": "Die Domain wurde nicht hinzugefügt",
  "emailDomains.add": "Domain hinzufügen",
  "emailDomains.domain": "Domain",
  "emailDomains.domainHint":
    "Die eigene Domain Ihrer Organisation, etwa example.com. Bis zu {limit} Domains.",
  "emailDomains.domainRequired": "Geben Sie eine Domain ein.",
  "emailDomains.empty": "Noch keine E-Mail-Domain.",
  "emailDomains.added":
    "{domain} wurde hinzugefügt. Legen Sie den TXT-Eintrag an und bestätigen Sie ihn dann.",
  "emailDomains.planTitle": "E-Mail-Domains gehören zu einem kostenpflichtigen Plan",
  "emailDomains.plan":
    "Das Bestätigen von E-Mail-Domains gehört zum Plan {plan}. Bereits aufgeführte Domains bleiben, und Sie können sie weiterhin entfernen.",
  "emailDomains.state.verified": "Bestätigt",
  "emailDomains.state.pending": "Wartet auf den DNS-Eintrag",
  "emailDomains.verifiedOn": "Bestätigt am {date}.",
  "emailDomains.pendingUntil":
    "Legen Sie den Eintrag vor dem {date} an, sonst verfällt die Anfrage.",
  "emailDomains.failing.title": "Der DNS-Eintrag fehlt",
  "emailDomains.failing.body":
    "{count, plural, one {Der Eintrag fehlte bei der letzten täglichen Prüfung.} other {Der Eintrag fehlte bei den letzten # täglichen Prüfungen in Folge.}} {left, plural, one {Nach # weiteren fehlgeschlagenen Prüfung wird die Domain entfernt.} other {Nach # weiteren fehlgeschlagenen Prüfungen wird die Domain entfernt.}}",
  "emailDomains.actionFailed": "Die Änderung wurde nicht gespeichert",
  "emailDomains.recordHint":
    "Legen Sie diesen Eintrag bei Ihrem DNS-Anbieter an. Es kann etwas dauern, bis er erscheint.",
  "emailDomains.verify": "Bestätigen",
  "emailDomains.verifyNamed": "{domain} bestätigen",
  "emailDomains.remove": "Entfernen",
  "emailDomains.removeNamed": "{domain} entfernen",
  "emailDomains.verified": "{domain} ist bestätigt.",
  "emailDomains.removed": "{domain} wurde entfernt.",
  "emailDomains.confirmRemove.title": "{domain} entfernen?",
  "emailDomains.confirmRemove.body":
    "Wer Artifacts nur über diese Domain öffnet, verliert den Zugang innerhalb einer Minute. Sie können sie später mit einem neuen Eintrag wieder hinzufügen.",
  "emailDomains.confirmRemove.action": "Domain entfernen",
  "emailDomains.error.quota_exceeded":
    "Der Workspace hat bereits die höchste Zahl an E-Mail-Domains.",
  "emailDomains.error.version_conflict":
    "Die Domain hat sich inzwischen geändert, oder ein anderer Workspace weist sie noch in seinem DNS nach. Laden Sie neu und versuchen Sie es noch einmal.",
  "emailDomains.error.capacity_unavailable":
    "Das DNS konnte gerade nicht geprüft werden. Versuchen Sie es gleich noch einmal.",
  "emailDomains.error.not_found": "Diese Domain ist nicht mehr aufgeführt.",
  "emailDomains.error.refused":
    "Diese Domain kann nicht hinzugefügt werden. Verwenden Sie die eigene Domain Ihrer Organisation: Öffentliche E-Mail-Anbieter, geteilte Suffixe, reservierte Namen und die Domains von Portifact werden abgelehnt.",
  "emailDomains.error.recordMissing":
    "Der TXT-Eintrag mit dem Wert dieser Domain wurde noch nicht gefunden. DNS-Änderungen können eine Weile brauchen; versuchen Sie es später noch einmal. Eine Anfrage, die älter als 7 Tage ist, muss neu hinzugefügt werden.",
  "transfer.confirm.accessReset":
    "Es ist gerade mit seinem Workspace oder einer E-Mail-Domain geteilt und wird daher eingeschränkt: Nur die Personen auf seiner Leseliste können es weiter lesen.",
  "shell.groupsLink": "Gruppen",
  "groups.title": "Gruppen",
  "groups.description":
    "Benannte Gruppen von Mitgliedern von {workspace}. Fügen Sie eine Gruppe zu einem eingeschränkten Artifact hinzu, und ihre Mitglieder können es öffnen, wie Leser auf der Liste.",
  "groups.personal.title": "Gruppen gehören zu einem Workspace",
  "groups.personal.body":
    "Wechseln Sie zu einem Workspace, den Sie verwalten, um seine Gruppen zu verwalten.",
  "groups.adminOnly.title": "Nur Admins verwalten Gruppen",
  "groups.adminOnly.body":
    "Editoren wählen Gruppen in den Freigabe-Einstellungen eines Artifacts. Bitten Sie einen Admin dieses Workspaces, eine Gruppe anzulegen oder zu ändern.",
  "groups.planTitle": "Gruppen sind nicht im Plan dieses Workspaces",
  "groups.planRequired":
    "Gruppen sind Teil des Plans {plan}. Bestehende Gruppen lassen sich umbenennen, leeren und löschen, gewähren aber niemandem Zugriff, bis der Plan sie wieder enthält.",
  "groups.list.title": "Gruppen",
  "groups.loading": "Gruppen werden geladen",
  "groups.loadFailed": "Die Gruppen wurden nicht geladen",
  "groups.empty.title": "Noch keine Gruppen",
  "groups.empty.body":
    "Legen Sie eine Gruppe an, fügen Sie Mitglieder hinzu und fügen Sie sie dann in den Freigabe-Einstellungen eines eingeschränkten Artifacts hinzu.",
  "groups.create.title": "Gruppe anlegen",
  "groups.create.hint":
    "Admins und Editoren sehen ihren Namen, wenn sie wählen, wer ein Artifact öffnen darf.",
  "groups.create.limit":
    "Ein Workspace kann höchstens {limit} Gruppen haben. Löschen Sie zuerst eine.",
  "groups.create.name": "Name",
  "groups.create.submit": "Gruppe anlegen",
  "groups.nameError": "Verwenden Sie eine Zeile mit 1 bis {max} Zeichen.",
  "groups.actionFailed": "Die Gruppe wurde nicht geändert",
  "groups.created": "Gruppe {name} angelegt.",
  "groups.memberCount": "{count, plural, one {# Mitglied} other {# Mitglieder}}",
  "groups.showMembers": "Mitglieder",
  "groups.hideMembers": "Mitglieder ausblenden",
  "groups.rename": "Umbenennen",
  "groups.renameLabel": "{name} umbenennen",
  "groups.renameField": "Neuer Name für {name}",
  "groups.save": "Namen speichern",
  "groups.renamed": "Die Gruppe heißt jetzt {name}.",
  "groups.delete": "Löschen",
  "groups.deleteLabel": "{name} löschen",
  "groups.deleted": "Gruppe {name} gelöscht.",
  "groups.confirm.title": "{name} löschen?",
  "groups.confirm.body":
    "Ihre Mitglieder können die Artifacts, die sie enthalten, innerhalb einer Minute nicht mehr lesen, sofern ihnen nichts anderes Zugriff gibt. Das lässt sich nicht rückgängig machen.",
  "groups.membersLoading": "Mitglieder der Gruppe werden geladen",
  "groups.noMembers": "Noch niemand ist in dieser Gruppe.",
  "groups.membersOf": "Mitglieder von {name}",
  "groups.removeMember": "Entfernen",
  "groups.removeMemberLabel": "{name} aus {group} entfernen",
  "groups.memberRemoved": "{name} wurde aus {group} entfernt.",
  "groups.addMember": "Mitglied zu {name} hinzufügen",
  "groups.chooseMember": "Mitglied wählen",
  "groups.add": "Hinzufügen",
  "groups.memberAdded": "{name} wurde zu {group} hinzugefügt.",
  "groupAccess.title": "Gruppen",
  "groupAccess.hint":
    "Mitglieder dieser Gruppen des Workspaces können es nach der Anmeldung öffnen, wie Leser auf der Liste.",
  "groupAccess.onlyRestricted":
    "Gruppen geben ihren Mitgliedern nur Zugriff, solange der Zugriff eingeschränkt ist; in anderen Modi behalten sie nur ihre Kommentar-Ausnahmen.",
  "groupAccess.count": "{count} von {max} Gruppen",
  "groupAccess.planTitle": "Gruppen sind nicht im Plan dieses Workspaces",
  "groupAccess.planRequired":
    "Gruppen hinzuzufügen ist Teil des Plans {plan}. Bereits hinzugefügte Gruppen gewähren niemandem Zugriff, bis der Plan sie wieder enthält, und Sie können sie weiterhin entfernen.",
  "groupAccess.failed.title": "Die Gruppen wurden nicht geändert",
  "groupAccess.empty": "Keine Gruppen hinzugefügt.",
  "groupAccess.list": "Gruppen, die dieses Artifact öffnen können",
  "groupAccess.removeLabel": "Gruppe {name} entfernen",
  "groupAccess.removed": "Gruppe {name} entfernt.",
  "groupAccess.full": "Ein Artifact kann höchstens {max} Gruppen enthalten.",
  "groupAccess.none":
    "Dieser Workspace hat noch keine Gruppen. Seine Admins legen sie auf der Seite Gruppen an.",
  "groupAccess.added": "Gruppe {name} hinzugefügt.",
  "groupAccess.pick": "Gruppe hinzufügen",
  "groupAccess.choose": "Gruppe wählen",
  "groupAccess.option": "{name} ({count, plural, one {# Mitglied} other {# Mitglieder}})",
  "groupAccess.add": "Gruppe hinzufügen",
  "groupAccess.comments.label": "Kommentare, die die Gruppe {name} sieht",
  "groupAccess.comments.changed": "Die Gruppe {name} sieht jetzt: {choice}.",
  "groupAccess.comments.confirm.title": "{name} alle Kommentare zeigen?",
  "groupAccess.comments.confirm.body":
    "Jedes Mitglied von {name} sieht alle Kommentar-Threads dieses Artifacts, auch die, die andere Leser vorher begonnen haben.",
  "audit.group.groups": "Gruppen",
  "audit.kind.groupCreated": "Hat die Gruppe {group} angelegt",
  "audit.kind.groupRenamed": "Hat eine Gruppe umbenannt, jetzt {group}",
  "audit.kind.groupDeleted": "Hat die Gruppe {group} gelöscht",
  "audit.kind.groupMemberAdded": "Hat {member} zur Gruppe {group} hinzugefügt",
  "audit.kind.groupMemberRemoved": "Hat {member} aus der Gruppe {group} entfernt",
  "audit.target.groupGone": "eine gelöschte Gruppe",
  "audit.access.groupsAdded":
    "{count, plural, one {# Gruppe hinzugefügt} other {# Gruppen hinzugefügt}}",
  "audit.access.groupsRemoved":
    "{count, plural, one {# Gruppe entfernt} other {# Gruppen entfernt}}",
  "audit.access.groupExceptions":
    "{count, plural, one {Kommentar-Sichtbarkeit von # Gruppe geändert} other {Kommentar-Sichtbarkeit von # Gruppen geändert}}",
  // Single sign-on (premium plan E1, decision 0016).
  "sso.title": "Single Sign-on",
  "sso.description":
    "Personen mit einer Adresse in den bestätigten E-Mail-Domains des Workspace können sich über den Identitätsanbieter deiner Organisation mit OpenID Connect anmelden.",
  "sso.loadFailed": "Single Sign-on konnte nicht geladen werden",
  "sso.stateLabel": "Status",
  "sso.state.off": "Nicht eingerichtet",
  "sso.state.on": "Aktiv",
  "sso.state.plan": "Pausiert: nicht in diesem Tarif",
  "sso.state.domains": "Pausiert: keine bestätigte Domain",
  "sso.planTitle": "Nicht in diesem Tarif",
  "sso.plan":
    "Single Sign-on gehört zum Tarif {plan}. Ein bereits eingerichteter Anbieter bleibt, und du kannst ihn weiterhin entfernen.",
  "sso.lapsedTitle": "Eine Domain ist nicht mehr bestätigt",
  "sso.lapsed":
    "{domains} ist nicht mehr bestätigt, daher können sich Adressen dort so nicht anmelden, bis die Domain wieder bestätigt ist.",
  "sso.membership":
    "Wer sich so anmeldet, tritt dem Workspace als Mitglied bei, oder mit der Rolle einer offenen Einladung, solange ein Platz frei ist. Bestehende Mitglieder behalten ihre Rolle.",
  "sso.removalNote":
    "Wer von einem Admin entfernt wurde, kann nicht per Single Sign-on zurückkehren, bis ein Admin die Person erneut einlädt. Wer selbst gegangen ist, kann es.",
  "sso.redirectUri": "Weiterleitungs-URI",
  "sso.redirectPending":
    "Speichere den Anbieter, um die Weiterleitungs-URI zu erhalten, die du beim Identitätsanbieter einträgst. Sie sieht so aus: {pattern}.",
  "sso.saveFailed": "Die Änderung wurde nicht gespeichert",
  "sso.testOkTitle": "Discovery funktioniert",
  "sso.testOk":
    "Die Anmeldung läuft über {authorization}, Tokens kommen von {token} und Schlüssel von {keys}.",
  "sso.testOkShort": "Discovery funktioniert.",
  "sso.testFailed": "Discovery ist fehlgeschlagen",
  "sso.formLabel": "Single-Sign-on-Anbieter",
  "sso.issuer": "Issuer-URL",
  "sso.issuerHint":
    "Der Issuer deines Identitätsanbieters, zum Beispiel https://login.example.com. Portifact liest sein Discovery-Dokument. Nach dem Speichern lässt er sich nicht mehr ändern.",
  "sso.clientId": "Client-ID",
  "sso.clientSecret": "Client-Secret",
  "sso.secretHint": "Wird verschlüsselt gespeichert und nie wieder angezeigt.",
  "sso.secretKeep": "Leer lassen, um das gespeicherte Secret zu behalten.",
  "sso.domains": "Domains für die Anmeldung",
  "sso.domainsHint":
    "Nur die bestätigten E-Mail-Domains des Workspace. Eine Adresse aus einer anderen Domain kann sich so nicht anmelden.",
  "sso.noDomains": "Bestätige zuerst oben eine E-Mail-Domain.",
  "sso.issuerRequired": "Gib die Issuer-URL ein.",
  "sso.clientIdRequired": "Gib die Client-ID ein.",
  "sso.secretRequired": "Gib das Client-Secret ein.",
  "sso.domainsRequired": "Wähle mindestens eine Domain.",
  "sso.save": "Speichern",
  "sso.saveChanges": "Änderungen speichern",
  "sso.test": "Issuer prüfen",
  "sso.remove": "Single Sign-on entfernen",
  "sso.saved": "Single Sign-on gespeichert.",
  "sso.removed": "Single Sign-on entfernt.",
  "sso.scim":
    "Wer beim Identitätsanbieter entfernt wird, bleibt hier: entferne die Person in der Mitgliederliste.",
  "sso.confirmRemove.title": "Single Sign-on entfernen?",
  "sso.confirmRemove.body":
    "Niemand kann sich mehr über diesen Anbieter anmelden. Mitglieder bleiben Mitglieder und behalten ihre Konten; sie melden sich mit einem Code per E-Mail, Google oder GitHub an. Ein neuer Anbieter bekommt eine neue Weiterleitungs-URI.",
  "sso.confirmRemove.action": "Entfernen",
  "sso.problem.invalid_issuer":
    "Der Issuer muss eine öffentliche https-URL ohne Abfrage oder Fragment sein.",
  "sso.problem.unreachable": "Der Identitätsanbieter war nicht erreichbar.",
  "sso.problem.timeout": "Der Identitätsanbieter hat zu lange gebraucht.",
  "sso.problem.redirect":
    "Der Identitätsanbieter hat mit einer Weiterleitung geantwortet, der Portifact nicht folgt. Nutze den Issuer, auf den er weiterleitet.",
  "sso.problem.http_error": "Der Identitätsanbieter hat mit einem Fehler geantwortet.",
  "sso.problem.too_large": "Die Antwort des Identitätsanbieters ist zu groß.",
  "sso.problem.not_json": "Das Discovery-Dokument ist kein gültiges JSON.",
  "sso.problem.issuer_mismatch":
    "Das Discovery-Dokument nennt einen anderen Issuer. Nutze den Issuer genau so, wie ihn das Dokument angibt.",
  "sso.problem.missing_endpoint":
    "Im Discovery-Dokument fehlt der Endpunkt für Autorisierung, Tokens oder Schlüssel.",
  "sso.problem.invalid_endpoint":
    "Ein Endpunkt im Discovery-Dokument ist keine öffentliche https-URL.",
  "sso.problem.no_code_flow": "Der Identitätsanbieter bietet den Authorization-Code-Flow nicht an.",
  "sso.problem.no_pkce": "Der Identitätsanbieter unterstützt PKCE mit S256 nicht.",
  "sso.problem.no_signing_algorithm":
    "Der Identitätsanbieter signiert ID-Tokens mit keinem Algorithmus, den Portifact akzeptiert (Familien RS256, PS256, ES256 oder EdDSA).",
  "sso.error.invalid_input":
    "Prüfe Issuer, Client und Domains. „Issuer prüfen“ zeigt, was bei der Discovery fehlgeschlagen ist.",
  "sso.error.capacity_unavailable": "Single Sign-on ist gerade nicht verfügbar.",
  "sso.error.version_conflict":
    "Single Sign-on wurde inzwischen geändert. Lade neu und versuch es noch einmal.",
  "sso.error.not_found": "Single Sign-on ist nicht eingerichtet.",
  "audit.kind.memberJoinedSso": "{member} ist als {role} per Single Sign-on beigetreten",
  "audit.kind.ssoCreated":
    "Hat Single Sign-on mit {host} für {count, plural, one {# Domain} other {# Domains}} eingerichtet",
  "audit.kind.ssoChanged": "Hat Single Sign-on geändert",
  "audit.kind.ssoRemoved": "Hat Single Sign-on entfernt",
  "shell.policiesLink": "Richtlinien",
  "policies.title": "Richtlinien",
  "policies.description":
    "Regeln für alle Artefakte von {workspace}. Sie gelten für alle, die mit seinen Artefakten arbeiten, auch für Admins und Service-Tokens.",
  "policies.personal.title": "Richtlinien gibt es für Workspaces",
  "policies.personal.body":
    "Ein persönlicher Bereich hat keine Richtlinien. Wechsle zu einem Workspace, um seine zu sehen.",
  "policies.loading": "Richtlinien werden geladen",
  "policies.loadFailed": "Die Richtlinien konnten nicht geladen werden",
  "policies.planTitle": "Richtlinien festlegen ist Teil des Tarifs {plan}",
  "policies.planRequired":
    "Der Tarif des Workspace enthält keine Richtlinien. Bereits gesetzte gelten weiter, und Admins können sie weiterhin lockern oder entfernen.",
  "policies.readOnly.title": "Von den Admins festgelegt",
  "policies.readOnly.body": "Nur Admins ändern die Richtlinien. Sie gelten auch für dich.",
  "policies.adminsToo": "Diese Richtlinien gelten auch für Admins.",
  "policies.public.legend": "Öffentlicher Zugriff",
  "policies.public.allowed": "Erlaubt",
  "policies.public.allowedHint":
    "Admins und Bearbeiter können ein Artefakt öffentlich machen, dann kann es jeder mit dem Link öffnen.",
  "policies.public.forbidden": "Verboten",
  "policies.public.forbiddenHint":
    "Kein Artefakt des Workspace kann öffentlich sein. Öffentliche Artefakte werden mit dem Workspace geteilt.",
  "policies.default.legend": "Zugriff neuer Artefakte",
  "policies.default.hint":
    "Womit ein neues Artefakt des Workspace startet. Bestehende Artefakte behalten ihren Zugriff.",
  "policies.default.restricted": "Nur die Eigentümerseite und hinzugefügte Leser können es öffnen.",
  "policies.default.workspace": "Jedes Mitglied des Workspace kann es öffnen.",
  "policies.default.domain":
    "Mitglieder und alle, die mit einer bestätigten Adresse der E-Mail-Domains des Workspace angemeldet sind, können es öffnen.",
  "policies.default.domainNone": "Bestätige zuerst eine E-Mail-Domain auf der Seite Mitglieder.",
  "policies.readers.legend": "Leser-Domains",
  "policies.readers.any": "Jede Adresse",
  "policies.readers.anyHint": "Leser können mit jeder E-Mail-Adresse hinzugefügt werden.",
  "policies.readers.only": "Nur diese Domains",
  "policies.readers.onlyHint":
    "Leser können nur mit Adressen dieser E-Mail-Domains hinzugefügt werden. Mitglieder und Gruppen sind nicht betroffen.",
  "policies.readers.domains": "Erlaubte Domains",
  "policies.readers.domainsHint": "Eine pro Zeile, etwa example.com, höchstens {max}.",
  "policies.readers.domainsError": "Gib 1 bis {max} einfache Domains ein, etwa example.com.",
  "policies.links.legend": "Freigabelinks",
  "policies.links.allowed": "Erlaubt",
  "policies.links.allowedHint":
    "Admins und Bearbeiter können Freigabelinks erstellen, mit oder ohne Passwort.",
  "policies.links.password_required": "Passwort erforderlich",
  "policies.links.password_requiredHint":
    "Jeder Freigabelink braucht ein Passwort. Links ohne Passwort öffnen sich nicht mehr.",
  "policies.links.disabled": "Deaktiviert",
  "policies.links.disabledHint": "Keine Freigabelinks. Bestehende werden widerrufen.",
  "policies.lifetime.label": "Längste Lebensdauer eines Freigabelinks in Tagen",
  "policies.lifetime.hint": "Leer lassen für kein Limit. Ältere Links öffnen sich nicht mehr.",
  "policies.lifetime.error":
    "Gib eine ganze Zahl von 1 bis {max} Tagen ein oder lass das Feld leer.",
  "policies.save": "Richtlinien speichern",
  "policies.saved": "Die Richtlinien wurden gespeichert.",
  "policies.saveFailed": "Die Richtlinien wurden nicht gespeichert",
  "policies.conflict":
    "Jemand hat die Richtlinien inzwischen geändert. Sie wurden neu geladen: prüfe sie und speichere.",
  "policies.impact.title": "Diese Richtlinien auf bestehende Artefakte anwenden?",
  "policies.impact.body": "Speichern ändert, was es in {workspace} schon gibt:",
  "policies.impact.public":
    "{count, plural, one {# öffentliches Artefakt wird mit dem Workspace geteilt} other {# öffentliche Artefakte werden mit dem Workspace geteilt}}",
  "policies.impact.readers":
    "{count, plural, one {# Leser außerhalb der erlaubten Domains wird entfernt} other {# Leser außerhalb der erlaubten Domains werden entfernt}}",
  "policies.impact.revoked":
    "{count, plural, one {# Freigabelink wird widerrufen} other {# Freigabelinks werden widerrufen}}",
  "policies.impact.password":
    "{count, plural, one {# Freigabelink ohne Passwort öffnet sich nicht mehr} other {# Freigabelinks ohne Passwort öffnen sich nicht mehr}}",
  "policies.impact.lifetime":
    "{count, plural, one {# Freigabelink über der Lebensdauer öffnet sich nicht mehr} other {# Freigabelinks über der Lebensdauer öffnen sich nicht mehr}}",
  "policies.impact.note":
    "Das geschieht im Hintergrund in kleinen Schritten und wird im Audit-Log festgehalten.",
  "policies.impact.confirm": "Anwenden und speichern",
  "policies.impact.cancel": "Weiter bearbeiten",
  "policies.note.publicForbidden": "Die Richtlinie des Workspace verbietet öffentlichen Zugriff.",
  "policies.note.readerDomains": "Die Richtlinie des Workspace erlaubt nur Leser von {domains}.",
  "policies.note.linksDisabled": "Die Richtlinie des Workspace erlaubt keine Freigabelinks.",
  "policies.note.linksPassword":
    "Die Richtlinie des Workspace verlangt für jeden Freigabelink ein Passwort.",
  "policies.note.linksLifetime":
    "Die Richtlinie des Workspace begrenzt Freigabelinks auf {days, plural, one {# Tag} other {# Tage}}.",
  "error.policy_refused": "Eine Richtlinie des Workspace erlaubt das nicht.",
  "error.terms_not_accepted":
    "Akzeptiere die aktuellen Bedingungen, um fortzufahren. Lade die Seite neu, um sie zu prüfen.",
  "audit.group.policies": "Richtlinien",
  "audit.kind.policyChanged": "Richtlinien des Workspace geändert: {changes}",
  "audit.kind.policyEnforced": "Richtlinien des Workspace angewendet: {changes}",
  "audit.policy.public":
    "{value, select, forbidden {öffentlicher Zugriff verboten} other {öffentlicher Zugriff erlaubt}}",
  "audit.policy.default":
    "{mode, select, workspace {neue Artefakte mit dem Workspace geteilt} domain {neue Artefakte mit den E-Mail-Domains geteilt} other {neue Artefakte eingeschränkt}}",
  "audit.policy.readers": "Leser nur von {domains}",
  "audit.policy.readersAny": "Leser jeder Domain",
  "audit.policy.links":
    "{value, select, disabled {Freigabelinks deaktiviert} password_required {Freigabelinks mit Passwort} other {Freigabelinks erlaubt}}",
  "audit.policy.lifetime": "Freigabelinks höchstens {days, plural, one {# Tag} other {# Tage}}",
  "audit.policy.lifetimeNone": "keine Lebensdauergrenze für Freigabelinks",
  "audit.policy.narrowed":
    "{count, plural, one {# Artefakt auf den Workspace beschränkt} other {# Artefakte auf den Workspace beschränkt}}",
  "audit.policy.readersRemoved": "{count, plural, one {# Leser entfernt} other {# Leser entfernt}}",
  "audit.policy.linksRevoked":
    "{count, plural, one {# Freigabelink widerrufen} other {# Freigabelinks widerrufen}}",
  "audit.policy.sessionsEnded":
    "{count, plural, one {# Link-Sitzung beendet} other {# Link-Sitzungen beendet}}",
  "policies.impact.stale":
    "Was diese Richtlinie an bestehenden Artefakten ändert, ist seit deiner Prüfung gewachsen. Speichere erneut, um die neuen Zahlen zu prüfen.",
  "policies.savedWithChanges":
    "Bestehende Artefakte werden an die Richtlinien angepasst. Ihre Seiten und das Audit-Log zeigen, was sich geändert hat.",
  "policies.default.domainLapsed":
    "Keine E-Mail-Domain ist bestätigt, daher starten neue Artefakte mit dem Workspace geteilt, bis wieder eine bestätigt ist.",
  "audit.access.byPolicy": "durch die Richtlinie des Workspace",
  "audit.actor.directory": "{label} (Verzeichnis)",
  "audit.actor.directoryGone": "Verzeichnis (widerrufenes SCIM-Token)",
  "audit.kind.memberJoinedDirectory": "{member} ist als {role} über das Verzeichnis beigetreten",
  "audit.kind.memberProvisioned":
    "Jemanden bei {domain} als {role} bereitgestellt; tritt bei der Anmeldung bei",
  "audit.kind.scimTokenCreated": "SCIM-Token erstellt ({days, plural, one {# Tag} other {# Tage}})",
  "audit.kind.scimTokenRevoked": "SCIM-Token widerrufen",
  "audit.kind.scimEmailsOn": "Einladungs-E-Mails für bereitgestellte Personen eingeschaltet",
  "audit.kind.scimEmailsOff": "Einladungs-E-Mails für bereitgestellte Personen ausgeschaltet",
  "pending.directory": "Aus dem Verzeichnis",
  "pending.directoryDetail":
    "{role}, vom Verzeichnis bereitgestellt: tritt bei der ersten Anmeldung bei, belegt einen Platz bis {date}",
  "scim.title": "Verzeichnissynchronisierung (SCIM)",
  "scim.description":
    "Lass deinen Identitätsanbieter Personen zum Workspace hinzufügen und entfernen. Er stellt Adressen aus deinen bestätigten E-Mail-Domains bereit; wer kein Portifact-Konto hat, tritt bei der ersten Anmeldung mit dieser Adresse bei.",
  "scim.loadFailed": "Die Verzeichnissynchronisierung konnte nicht geladen werden",
  "scim.baseUrl": "SCIM-Basis-URL",
  "scim.baseUrlCopy": "URL kopieren",
  "scim.baseUrlHint":
    "Füge sie bei deinem Identitätsanbieter als SCIM-Basis-URL oder Mandanten-URL ein und ein Token unten als Bearer-Token.",
  "scim.planTitle": "Nicht in diesem Tarif",
  "scim.plan":
    "Die Verzeichnissynchronisierung braucht den Tarif {plan}. Bis dahin werden die Anfragen des Verzeichnisses abgelehnt; seine Tokens kannst du trotzdem widerrufen.",
  "scim.rules":
    "Neue Personen treten als Mitglieder bei. Wer im Verzeichnis deaktiviert wird, verlässt den Workspace und wird überall abgemeldet; Konto und persönlicher Bereich bleiben bei der Person. Wer hier von Hand entfernt wurde, wird von der nächsten Synchronisierung nicht wieder hinzugefügt.",
  "scim.lastSync": "Letzte Synchronisierung",
  "scim.lastSyncNever": "Das Verzeichnis hat sich noch nicht gemeldet.",
  "scim.pendingLabel": "Warten auf Anmeldung",
  "scim.pending":
    "{count, plural, =0 {Niemand} one {# Person, bei den offenen Einladungen} other {# Personen, bei den offenen Einladungen}}",
  "scim.tokens": "Tokens",
  "scim.tokensEmpty": "Noch kein Token.",
  "scim.tokenExpires": "Läuft am {date} ab",
  "scim.tokenExpired": "Am {date} abgelaufen",
  "scim.tokenUsed": "zuletzt verwendet am {date}",
  "scim.tokenUnused": "nie verwendet",
  "scim.create": "SCIM-Token erstellen",
  "scim.label": "Bezeichnung",
  "scim.labelHint": "Zum Beispiel der Name des Identitätsanbieters.",
  "scim.labelRequired": "Gib eine Bezeichnung mit höchstens 80 Zeichen ein.",
  "scim.expiry": "Läuft ab nach",
  "scim.days": "{count, plural, one {# Tag} other {# Tagen}}",
  "scim.limit":
    "Ein Workspace hat höchstens {count} SCIM-Tokens, damit eines ein anderes ohne Unterbrechung ersetzen kann. Widerrufe eines, um ein neues zu erstellen.",
  "scim.secret.title": "Kopiere das Token jetzt",
  "scim.secret.body":
    "Es wird nur einmal angezeigt. Füge es bei deinem Identitätsanbieter als Bearer-Token ein.",
  "scim.secret.label": "SCIM-Token {label}",
  "scim.secret.copy": "Token kopieren",
  "scim.secret.done": "Ich habe es gespeichert",
  "scim.revoke": "Widerrufen",
  "scim.revokeNamed": "Widerrufen: {label}",
  "scim.confirmRevoke.title": "{label} widerrufen?",
  "scim.confirmRevoke.body":
    "Die nächste Anfrage des Verzeichnisses damit wird abgelehnt. Von ihm bereitgestellte Personen bleiben, wie sie sind.",
  "scim.confirmRevoke.action": "Token widerrufen",
  "scim.revoked": "Das Token {label} wurde widerrufen.",
  "scim.created": "Das Token {label} wurde erstellt. Kopiere es jetzt.",
  "scim.emails":
    "Personen, die das Verzeichnis ohne Portifact-Konto bereitstellt, die Einladungs-E-Mail senden",
  "scim.emailsHint":
    "Standardmäßig aus: Identitätsanbieter informieren meist selbst über neue Apps. So oder so tritt die Person bei der ersten Anmeldung mit dieser Adresse bei.",
  "scim.emailsSaved": "Gespeichert.",
  "scim.actionFailed": "Die Änderung wurde nicht gespeichert",
  "audit.kind.scimRoleOn": "Hat den Mitgliedern einer Verzeichnisgruppe die Rolle {role} gegeben",
  "audit.kind.scimRoleOff": "Gibt die Rolle {role} nicht mehr über eine Verzeichnisgruppe",
  "groups.directory": "Von Ihrem Verzeichnis verwaltet",
  "groups.directoryNote":
    "Das Verzeichnis Ihrer Organisation verwaltet diese Gruppe über SCIM: Ändern Sie Namen und Mitglieder dort.",
  "members.directoryRole": "In einer Verzeichnisgruppe mit Rolle",
  "scim.roles.title": "Rollen aus Verzeichnisgruppen",
  "scim.roles.description":
    "Mitglieder der gewählten Gruppe erhalten diese Rolle, wenn sie mehr ist als ihre jetzige. Das Verzeichnis nimmt nur eine Rolle zurück, die es vergeben hat: Es senkt nie eine Rolle, die ein Admin von Hand gesetzt hat, und eine Rolle, die Sie von Hand ändern, gehört ab dann Ihnen.",
  "scim.roles.access":
    "Eine Gruppe, die bei einem Artifact eingetragen ist, lässt ihre Mitglieder es lesen: Ihr Verzeichnis entscheidet jetzt, wer diese Artifacts liest.",
  "scim.roles.editor": "Gruppe, deren Mitglieder Editoren sind",
  "scim.roles.admin": "Gruppe, deren Mitglieder Admins sind",
  "scim.roles.none": "Keine Gruppe",
  "scim.roles.option": "{name} ({count, plural, one {# Mitglied} other {# Mitglieder}})",
  "scim.roles.noGroups": "Ihr Verzeichnis hat noch keine Gruppe übertragen.",
  "scim.roles.save": "Rollen speichern",
  "scim.roles.saved": "Rollen gespeichert.",
  "scim.roles.confirm.title": "Die Mitglieder von {name} zu Admins machen?",
  "scim.roles.confirm.body":
    "In {name} {count, plural, one {ist jetzt # Person} other {sind jetzt # Personen}}, und {pending, plural, =0 {niemand sonst kommt dazu} one {# weitere kommt dazu} other {# weitere kommen dazu}}, sobald sie sich anmelden. Wer Ihr Verzeichnis kontrolliert, entscheidet, wer diesen Workspace verwaltet: seine Mitglieder, Richtlinien, Tokens und Einstellungen.",
  "scim.roles.confirm.action": "Zu Admins machen",
  "groups.stopSync": "Synchronisierung beenden",
  "groups.stopSyncLabel": "Synchronisierung von {name} beenden",
  "groups.stopSync.title": "{name} nicht mehr aus Ihrem Verzeichnis synchronisieren?",
  "groups.stopSync.body":
    "Ihr Verzeichnis verwaltet diese Gruppe nicht mehr: Admins bearbeiten sie ab jetzt hier. Ihre Rollenzuordnung wird entfernt, und Personen, die sie zu Editoren oder Admins gemacht hat, behalten ihre Rolle. Überträgt das Verzeichnis später eine Gruppe mit demselben Namen, wird sie abgelehnt.",
  "groups.stopSync.done": "{name} wird nicht mehr aus Ihrem Verzeichnis synchronisiert.",
  "audit.kind.groupSyncStopped":
    "Hat die Synchronisierung der Gruppe {group} aus dem Verzeichnis beendet",
  "shell.integrationsLink": "Integrationen",
  "integrations.title": "Integrationen",
  "integrations.description":
    "Machen Sie aus einem Kommentar-Thread ein Issue in GitHub, Linear oder Jira. Eine Verbindung handelt mit Zugangsdaten, die ein Admin einfügt, daher erscheinen Issues als von diesem Konto erstellt.",
  "integrations.adminOnly.title": "Nur Admins verwalten Integrationen",
  "integrations.adminOnly.body":
    "Bitten Sie einen Admin von {workspace}, GitHub, Linear oder Jira zu verbinden.",
  "integrations.planTitle": "Nicht in diesem Tarif",
  "integrations.planRequired":
    "Integrationen gehören zum Tarif {plan}. Bestehende Verbindungen bleiben erhalten, aber über sie können keine Issues erstellt werden.",
  "integrations.list.title": "Verbindungen",
  "integrations.list.loading": "Verbindungen werden geladen",
  "integrations.list.error": "Die Verbindungen konnten nicht geladen werden.",
  "integrations.empty.title": "Noch keine Verbindungen",
  "integrations.empty.body":
    "Verbinden Sie GitHub, Linear oder Jira, damit Admins und Bearbeiter Issues aus Kommentar-Threads erstellen können.",
  "integrations.service.github": "GitHub",
  "integrations.service.linear": "Linear",
  "integrations.service.jira": "Jira",
  "integrations.service.other": "Anderer Dienst",
  "integrations.add.title": "Dienst verbinden",
  "integrations.add.hint":
    "Die Zugangsdaten werden beim Dienst geprüft, verschlüsselt gespeichert und nie wieder angezeigt: Portifact zeigt nur die letzten vier Zeichen.",
  "integrations.add.service": "Dienst",
  "integrations.add.label": "Bezeichnung",
  "integrations.add.labelHint": "Ein Name, den Ihr Team erkennt, etwa Produkt-Repository.",
  "integrations.add.credential.github": "Feingranulares persönliches Zugriffstoken",
  "integrations.add.credential.linear": "Linear-API-Schlüssel",
  "integrations.add.credential.jira": "Atlassian-API-Token mit Bereichen",
  "integrations.add.targets.github": "Repositorys",
  "integrations.add.targets.linear": "Team-IDs",
  "integrations.add.targets.jira": "Projektschlüssel",
  "integrations.add.targetsHint.github": "Ein Besitzer/Repository pro Zeile, höchstens {limit}.",
  "integrations.add.targetsHint.linear":
    "Eine Team-ID pro Zeile, höchstens {limit}. Linear zeigt sie in den Team-Einstellungen.",
  "integrations.add.targetsHint.jira":
    "Ein Projektschlüssel pro Zeile, etwa ENG, höchstens {limit}.",
  "integrations.add.account": "E-Mail des Atlassian-Kontos",
  "integrations.add.accountHint":
    "Die E-Mail des Kontos, das das Token erstellt hat. Sie wird mit dem Token verschlüsselt gespeichert und nie wieder angezeigt.",
  "integrations.add.site": "Jira-Website",
  "integrations.add.siteHint": "Zum Beispiel acme.atlassian.net.",
  "integrations.add.cloudId": "Cloud-ID",
  "integrations.add.cloudIdHint":
    "Öffnen Sie ihre-website.atlassian.net/_edge/tenant_info im Browser und kopieren Sie den Wert von cloudId.",
  "integrations.add.failed":
    "Der Dienst hat die Zugangsdaten oder eines der Repositorys, Teams oder Projekte nicht akzeptiert. Prüfen Sie sie anhand der Schritte oben und versuchen Sie es erneut.",
  "integrations.add.submit": "Verbinden",
  "integrations.add.limit":
    "Ein Bereich kann höchstens {limit} Verbindungen haben. Entfernen Sie eine, um eine weitere hinzuzufügen.",
  "integrations.howto.github.title": "Ein GitHub-Token mit minimalen Rechten erstellen",
  "integrations.howto.github.1":
    "Öffnen Sie in GitHub Settings, Developer settings, Personal access tokens, Fine-grained tokens und wählen Sie Generate new token.",
  "integrations.howto.github.2":
    "Wählen Sie als Ressourcenbesitzer das Konto oder die Organisation, der die Repositorys gehören, und geben Sie ein Ablaufdatum an.",
  "integrations.howto.github.3":
    "Wählen Sie unter Repository access Only select repositories und die hier aufgeführten Repositorys.",
  "integrations.howto.github.4":
    "Setzen Sie unter Repository permissions Issues auf Read and write. Lassen Sie alle anderen Rechte auf No access; Metadata bleibt schreibgeschützt.",
  "integrations.howto.github.5":
    "Erstellen Sie das Token und fügen Sie es hier ein. Issues erscheinen als vom Konto des Tokens erstellt.",
  "integrations.howto.linear.title": "Einen Linear-API-Schlüssel erstellen",
  "integrations.howto.linear.1":
    "Öffnen Sie in Linear Settings, dann Security and access, und erstellen Sie einen persönlichen API-Schlüssel.",
  "integrations.howto.linear.2":
    "Wenn Linear das Einschränken des Schlüssels erlaubt, erlauben Sie nur das Erstellen von Issues und nur in den hier aufgeführten Teams.",
  "integrations.howto.linear.3":
    "Fügen Sie den Schlüssel hier ein. Issues erscheinen als von Ihrem Linear-Konto erstellt.",
  "integrations.howto.jira.title": "Ein Jira-Token mit minimalen Rechten erstellen",
  "integrations.howto.jira.1":
    "Melden Sie sich bei Atlassian mit dem Konto an, von dem die Issues kommen sollen (am besten ein eigenes Konto), öffnen Sie die Kontoeinstellungen, dann Sicherheit, und wählen Sie API-Token mit Bereichen erstellen.",
  "integrations.howto.jira.2":
    "Geben Sie ihm einen Namen und ein Ablaufdatum und wählen Sie Jira als App.",
  "integrations.howto.jira.3":
    "Wählen Sie nur die Bereiche read:jira-user, read:jira-work und write:jira-work.",
  "integrations.howto.jira.4":
    "Erstellen Sie das Token und fügen Sie es hier mit der E-Mail des Kontos, der Website und ihrer Cloud-ID ein. Ein Token ohne Bereiche funktioniert nicht.",
  "integrations.howto.jira.5":
    "Issues erscheinen als von diesem Konto erstellt, in den Projekten, die Sie hier angeben.",
  "integrations.connected": "{label} verbunden.",
  "integrations.identity": "Handelt als {identity}",
  "integrations.credential": "Zugangsdaten enden auf {hint}",
  "integrations.site": "Website {site}",
  "integrations.attention.credential_rejected":
    "Der Dienst hat diese Zugangsdaten abgelehnt. Fügen Sie neue ein und testen Sie sie.",
  "integrations.attention.key_unavailable":
    "Die gespeicherten Zugangsdaten lassen sich nicht mehr öffnen. Fügen Sie sie erneut ein.",
  "integrations.attention.site_mismatch":
    "Die Cloud-ID gehört nicht mehr zu dieser Jira-Website: Die Website hat ihre Adresse geändert. Entfernen Sie diese Verbindung und verbinden Sie die Website erneut mit ihrem aktuellen Namen.",
  "integrations.state.ready": "Bereit",
  "integrations.state.attention": "Prüfen nötig",
  "integrations.test": "Testen",
  "integrations.testLabel": "{label} testen",
  "integrations.testPassed":
    "{label} funktioniert. Es handelt als {identity}, und jedes Repository, Team oder Projekt ist erreichbar.",
  "integrations.testRefreshed":
    "Portifact erstellt Issues in {targets} jetzt mit dem aktuellen Issue-Typ des Projekts.",
  "integrations.problem.credential_rejected":
    "Der Dienst hat die Zugangsdaten abgelehnt: Sie sind falsch, abgelaufen oder widerrufen.",
  "integrations.problem.missing_permission":
    "Der Dienst hat die Zugangsdaten angenommen, aber sie können das eigene Konto nicht lesen.",
  "integrations.problem.target_unreachable":
    "Die Zugangsdaten erreichen {target} nicht. Prüfen Sie den Zugriff dort.",
  "integrations.problem.issues_disabled": "Issues sind in {target} ausgeschaltet.",
  "integrations.problem.service_unavailable":
    "Der Dienst hat nicht geantwortet. Versuchen Sie es später erneut.",
  "integrations.problem.rate_limited":
    "Der Dienst begrenzt Anfragen dieser Zugangsdaten. Versuchen Sie es später erneut.",
  "integrations.problem.site_mismatch":
    "Die Cloud-ID gehört nicht zu dieser Jira-Website. Kopieren Sie beide erneut von der Website.",
  "integrations.edit": "Ändern",
  "integrations.editLabel": "{label} ändern",
  "integrations.edit.title": "{label} ändern",
  "integrations.edit.credentialHint": "Leer lassen, um die aktuellen Zugangsdaten zu behalten.",
  "integrations.edit.accountHint":
    "Mit einem neuen Token nötig: die E-Mail seines Atlassian-Kontos.",
  "integrations.edit.save": "Speichern",
  "integrations.saved": "{label} gespeichert.",
  "integrations.remove": "Entfernen",
  "integrations.removeLabel": "{label} entfernen",
  "integrations.confirm.title": "{label} entfernen?",
  "integrations.confirm.body":
    "Die Zugangsdaten werden aus Portifact gelöscht. Bereits erstellte Issues behalten ihre Links; Issues, die noch erstellt werden, schlagen fehl. Widerrufen Sie das Token oder den Schlüssel auch beim Dienst.",
  "integrations.removed": "{label} entfernt.",
  "integrations.actionFailed": "Das hat nicht geklappt",
  "integrations.service.slack": "Slack",
  "integrations.state.pending": "Nicht abgeschlossen",
  "integrations.attention.pending":
    "Schließe die Verbindung ab: Füge das Bot-Token und das Signing Secret der Slack-App ein.",
  "integrations.attention.app_uninstalled":
    "Slack meldet, dass die App deinstalliert oder ihre Tokens widerrufen wurden. Installiere sie in Slack erneut und füge ihr neues Bot-Token und Signing Secret ein.",
  "integrations.howto.slack.title": "So wird Slack verbunden",
  "integrations.howto.slack.1":
    "Beginne hier mit einer Bezeichnung. Portifact zeigt dann ein Manifest für eine eigene Slack-App; noch wird nichts an Slack gesendet.",
  "integrations.howto.slack.2":
    "Öffne den Link, um die App in Slack aus diesem Manifest zu erstellen, und installiere sie dann in deinem Slack-Workspace. Dafür brauchst du dort die Berechtigung, Apps zu erstellen und zu installieren.",
  "integrations.howto.slack.3":
    "Kopiere das Bot User OAuth Token (es beginnt mit xoxb-) unter OAuth & Permissions und das Signing Secret unter Basic Information und füge beide hier ein.",
  "integrations.howto.slack.4":
    "Öffne in den Einstellungen der App in Slack Event Subscriptions und klicke neben der Request URL auf Verify.",
  "integrations.slack.start": "Starten",
  "integrations.slack.started":
    "{label} gestartet. Erstelle die Slack-App aus ihrem Manifest, um abzuschließen.",
  "integrations.slack.previews":
    "Wenn jemand in Ihrem Slack-Workspace einen Link zu einem öffentlichen Artifact dieses Bereichs postet, zeigt die App darunter den Namen und den Typ des Artifacts. Sonst wird nichts gesendet: kein Inhalt und nichts über Artifacts, die nicht öffentlich sind.",
  "integrations.slack.previewsStay":
    "Slack behält eine Vorschau in ihrer Nachricht: Ist ein Artifact nicht mehr öffentlich, zeigen frühere Vorschauen weiter seinen Namen und Typ, und neue Posts seines Links bekommen keine.",
  "integrations.slack.notices":
    "Hinweise in einem Kanal kommen über Webhooks: Füge derselben Slack-App einen Incoming Webhook hinzu und trage seine URL auf der Seite Webhooks ein.",
  "integrations.slack.noticesLink": "Webhooks öffnen",
  "integrations.slack.pending.title": "Slack-Verbindung abschließen",
  "integrations.slack.pending.body":
    "Erstelle die App aus diesem Manifest und installiere sie in deinem Slack-Workspace, dann füge unten ihr Bot-Token und Signing Secret ein. Eine Verbindung, die nicht innerhalb von 24 Stunden abgeschlossen wird, wird gelöscht.",
  "integrations.slack.create": "App in Slack erstellen",
  "integrations.slack.manifest": "App-Manifest",
  "integrations.slack.requestUrl": "Request URL",
  "integrations.slack.copyRequestUrl": "Request URL kopieren",
  "integrations.slack.copyManifest": "Manifest kopieren",
  "integrations.slack.copied": "Kopiert",
  "integrations.slack.botToken": "Bot User OAuth Token",
  "integrations.slack.botTokenHint":
    "Unter OAuth & Permissions in den Einstellungen der App in Slack. Es beginnt mit xoxb-.",
  "integrations.slack.signingSecret": "Signing Secret",
  "integrations.slack.signingSecretHint":
    "Unter Basic Information in den Einstellungen der App in Slack, bei App Credentials.",
  "integrations.slack.finish": "Verbindung abschließen",
  "integrations.slack.verify":
    "Öffne als Nächstes Event Subscriptions in den Einstellungen der App in Slack und klicke neben der Request URL auf Verify. Kann Slack sie nicht bestätigen, ist das Signing Secret falsch: Füge es hier erneut ein.",
  "integrations.slack.rename":
    "Die App heißt Portifact. Um zwei Bereiche zu unterscheiden, die mit demselben Slack-Workspace verbunden sind, benenne die App in ihren Einstellungen in Slack um (Basic Information, Display Information).",
  "integrations.slack.team": "Slack-Workspace {team}",
  "integrations.slack.outdatedTitle": "Älteres Manifest",
  "integrations.slack.outdated":
    "Diese App wurde aus einem älteren Manifest erstellt. Aktualisiere das Manifest der App in Slack mit dem unten stehenden.",
  "integrations.slack.setup": "Manifest und Request URL",
  "integrations.slack.eu":
    "Die Daten dieses Bereichs werden in der EU gespeichert. Eine verbundene Slack-App erhält, was Portifact ihr sendet, etwa die Namen öffentlicher Artifacts, deren Links gepostet werden, und Slack kann es außerhalb der EU speichern.",
  "integrations.edit.slackHint":
    "Lass beide leer, um das aktuelle Token und Secret zu behalten. Ein neues Bot-Token kommt mit dem Signing Secret.",
  "integrations.confirm.slackBody":
    "Bot-Token und Signing Secret werden aus Portifact gelöscht, und Portifact widerruft das Bot-Token bei Slack. Lösche die App auch in Slack.",
  "issues.create": "Issue erstellen",
  "issues.dialog.title": "Issue aus Thread {number} erstellen",
  "issues.dialog.close": "Schließen",
  "issues.dialog.connection": "Verbindung",
  "issues.dialog.target": "Repository, Team oder Projekt",
  "issues.dialog.issueTitle": "Titel des Issues",
  "issues.dialog.parts": "Was gesendet wird",
  "issues.dialog.part.link": "Ein Link zu diesem Thread",
  "issues.dialog.part.artifactName": "Der Name des Artifacts",
  "issues.dialog.part.quote": "Der zitierte Text",
  "issues.dialog.part.quoteHint": "Eine Auswahl aus dem Artifact. Sie verlässt Portifact.",
  "issues.dialog.part.message": "Die erste Nachricht des Threads",
  "issues.dialog.part.messageHint":
    "Die Worte einer Person. Sie verlassen Portifact und bleiben im Issue, auch wenn der Kommentar später gelöscht wird.",
  "issues.dialog.preview": "Genau das wird gesendet",
  "issues.dialog.previewHint":
    "Kommentartext geht als reiner Text: Erwähnungen, Links und Bilder darin bewirken nichts. Er wird beim Erstellen des Issues neu gelesen, also wird eine spätere Änderung gesendet.",
  "issues.dialog.never":
    "Nie gesendet: E-Mail-Adressen der Lesenden, der Inhalt des Artifacts, andere Nachrichten des Threads oder Prüfnotizen.",
  "issues.dialog.visible":
    "Alle, die diesen Thread sehen, auch Leser außerhalb Ihres Teams, sehen den Link des erstellten Issues und den Namen seines Repositorys, Teams oder Projekts, auch wenn es privat ist.",
  "issues.failure.target_removed":
    "ein Admin hat dieses Repository, Team oder Projekt aus der Verbindung entfernt.",
  "issues.failure.artifact_moved": "das Artifact wurde in einen anderen Bereich verschoben.",
  "issues.failure.requester_left": "Sie können für diesen Bereich keine Issues mehr erstellen.",
  "issues.failure.thread_gone": "der Thread wurde gelöscht.",
  "issues.failure.site_changed": "die Adresse der Jira-Website hat sich geändert.",
  "issues.failure.other": "es konnte nicht erstellt werden.",
  "issues.dialog.eu":
    "Dieser Bereich speichert seine Daten in der EU. Was Sie senden, geht an {service}, außerhalb der EU.",
  "issues.dialog.submit": "Issue erstellen",
  "issues.dialog.noConnections":
    "Keine Verbindung kann verwendet werden. Bitten Sie einen Admin, GitHub, Linear oder Jira zu verbinden oder eine Verbindung zu reparieren, die Aufmerksamkeit braucht.",
  "issues.requested": "Issue angefordert. Der Link erscheint in wenigen Minuten am Thread.",
  "issues.list": "Issues",
  "issues.link": "Issue {key} in {target}",
  "issues.pending": "Das Issue in {target} wird erstellt",
  "issues.failed": "Das Issue in {target} wurde nicht erstellt: {reason}",
  "issues.failure.credential_rejected": "die Zugangsdaten der Verbindung funktionieren nicht mehr.",
  "issues.failure.target_unreachable": "die Zugangsdaten können dort keine Issues erstellen.",
  "issues.failure.rejected": "der Dienst hat es abgelehnt.",
  "issues.failure.connection_removed": "die Verbindung wurde entfernt.",
  "issues.failure.unavailable": "Integrationen sind nicht verfügbar.",
  "issues.failure.plan_lapsed": "der Tarif enthält keine Integrationen mehr.",
  "issues.failure.service_unavailable": "der Dienst hat nicht geantwortet.",
  "issues.failure.invalid_response":
    "der Dienst hat so geantwortet, dass Portifact es nicht verwenden konnte.",
  "audit.kind.integrationConnected":
    "Hat {service, select, github {GitHub} linear {Linear} jira {Jira} slack {Slack} other {{service}}} mit {targets, plural, one {# Repository oder Team} other {# Repositorys oder Teams}} verbunden",
  "audit.kind.integrationConnectedOnly":
    "Hat {service, select, github {GitHub} linear {Linear} jira {Jira} slack {Slack} other {{service}}} verbunden",
  "audit.kind.integrationChanged":
    "{credential, select, true {Hat die Zugangsdaten einer Verbindung ersetzt} other {Hat Bezeichnung oder Ziele einer Verbindung geändert}}",
  "audit.kind.integrationRemoved":
    "Hat eine {service, select, github {GitHub} linear {Linear} jira {Jira} slack {Slack} other {{service}}}-Verbindung entfernt",
  "audit.kind.integrationFailing":
    "{reason, select, app_uninstalled {Die Slack-App einer Verbindung wurde deinstalliert} site_mismatch {Die Jira-Website einer Verbindung hat ihre Adresse geändert} key_unavailable {Die Zugangsdaten einer Verbindung lassen sich nicht mehr öffnen} other {{service, select, github {GitHub} linear {Linear} jira {Jira} slack {Slack} other {{service}}} hat die Zugangsdaten einer Verbindung abgelehnt}}",
  "audit.kind.issueCreated":
    "Hat ein {service, select, github {GitHub} linear {Linear} jira {Jira} slack {Slack} other {{service}}}-Issue in {target} aus einem Thread erstellt {message, select, true {mit der ersten Nachricht} other {ohne Kommentartext}}",
  "policies.networks.legend": "Netzwerke für Personen",
  "policies.networks.hint":
    "Mitglieder, Admins eingeschlossen, handeln im Workspace und lesen seine nur für den Workspace freigegebenen Artifacts nur aus diesen Netzwerken. Öffentliche Artifacts, Freigabelinks und Personen außerhalb, mit denen du geteilt hast, sind nicht betroffen.",
  "policies.networks.any": "Jedes Netzwerk",
  "policies.networks.anyHint": "Personen erreichen den Workspace von überall.",
  "policies.networks.only": "Nur diese Netzwerke",
  "policies.networks.onlyHint":
    "Anfragen von anderen Adressen werden mit einer Meldung abgelehnt, die den Grund nennt.",
  "policies.networks.ranges": "Erlaubte IP-Adressen und -Bereiche",
  "policies.networks.rangesHint":
    "Eine pro Zeile, etwa 192.0.2.0/24 oder 2001:db8::/32, höchstens {max}. Eine einzelne Adresse steht für ein Gerät.",
  "policies.networks.rangesError":
    "Gib 1 bis {max} IP-Adressen oder -Bereiche an, etwa 192.0.2.0/24. Ein Bereich aller Adressen (/0) ist nicht erlaubt.",
  "policies.networks.yourIp":
    "Deine aktuelle Adresse ist {ip}. Die Liste muss sie enthalten, sonst würdest du dich beim Speichern aussperren.",
  "policies.networks.notStored":
    "Portifact prüft die Adresse, die Cloudflare für jede Anfrage meldet, und speichert sie nie.",
  "policies.networks.hidden":
    "Personen erreichen diesen Workspace nur aus freigegebenen Netzwerken. Seine Admins sehen die Liste.",
  "policies.networks.limits":
    "Das hält niemanden auf, der ein freigegebenes Netzwerk erreicht, etwa über ein gemeinsames VPN, und es bindet die Konten der Personen, nicht Artifacts, die bereits außerhalb des Workspace geteilt sind.",
  "policies.tokenNetworks.legend": "Netzwerke für Service-Tokens",
  "policies.tokenNetworks.hint":
    "Service-Tokens sind nicht an die Liste für Personen gebunden. Gib ihnen eine eigene Liste, etwa die Adressen deiner CI-Runner.",
  "policies.tokenNetworks.anyHint": "Service-Tokens funktionieren von überall.",
  "policies.tokenNetworks.onlyHint":
    "Service-Tokens, die von anderen Adressen verwendet werden, werden abgelehnt.",
  "policies.tokenNetworks.hidden":
    "Service-Tokens funktionieren nur aus freigegebenen Netzwerken. Die Admins des Workspace sehen die Liste.",
  "policies.impact.networksTitle": "Netzwerke einschränken, die diesen Workspace erreichen?",
  "policies.impact.members":
    "{count, plural, one {# Mitglied erreicht} other {# Mitglieder erreichen}} den Workspace nur noch aus den erlaubten Netzwerken",
  "policies.impact.tokens":
    "{count, plural, one {# Service-Token funktioniert} other {# Service-Tokens funktionieren}} nur noch aus den erlaubten Netzwerken",
  "policies.impact.networksNote":
    "Portifact speichert niemandes Adresse und kann daher nicht sagen, wer gerade außerhalb dieser Netzwerke ist. Deine eigene Adresse ist enthalten.",
  "policies.impact.networksConfirm": "Netzwerke einschränken",
  "space.blocked.title": "Aus diesem Netzwerk nicht erreichbar",
  "space.blocked.body":
    "{workspace} erlaubt den Zugriff nur aus seinen freigegebenen Netzwerken, und dieses Netzwerk gehört nicht dazu. Verbinde dich mit einem freigegebenen Netzwerk oder wende dich an einen Workspace-Admin. Deine anderen Bereiche funktionieren weiter.",
  "audit.policy.networks":
    "Personen nur aus {count, plural, one {# Netzwerk} other {# Netzwerken}}",
  "audit.policy.networksAny": "Personen aus jedem Netzwerk",
  "audit.policy.tokenNetworks":
    "Service-Tokens nur aus {count, plural, one {# Netzwerk} other {# Netzwerken}}",
  "audit.policy.tokenNetworksAny": "Service-Tokens aus jedem Netzwerk",
  "policies.networks.bothFamilies":
    "Netzwerke mit IPv4 und IPv6 brauchen beide Bereiche: Ein Browser kann Portifact über beide erreichen, und Anfragen über eine Familie, die nicht in der Liste steht, werden abgelehnt.",
  "policies.impact.singleFamily":
    "{list, select, people {Die Liste für Personen} other {Die Liste für Service-Tokens}} enthält nur {family, select, ipv4 {IPv4} other {IPv6}}-Bereiche: Anfragen über {family, select, ipv4 {IPv6} other {IPv4}} werden abgelehnt, auch aus diesen Netzwerken",
  "policies.impact.unboundTokens":
    "{count, plural, one {# Service-Token funktioniert} other {# Service-Tokens funktionieren}} weiterhin aus jedem Netzwerk. Lege eine Liste für Service-Tokens fest, um sie ebenfalls einzuschränken",
  "policies.impact.familiesConfirm": "Verstanden, speichern",
  "audit.group.exports": "Exporte und Streams",
  "audit.kind.streamCreated":
    "Hat begonnen, das Protokoll an {host} zu senden{start, select, oldest {, ab dem ältesten aufbewahrten Ereignis} other {}}",
  "audit.kind.streamChanged":
    "{state, select, active {Hat den Stream an {host} fortgesetzt} paused {Hat den Stream an {host} pausiert} other {{secret, select, true {Hat dem Stream an {host} ein neues Signaturgeheimnis gegeben} other {Hat den Stream an {host} geändert}}}}",
  "audit.kind.streamRemoved": "Hat den Stream an {host} entfernt",
  "audit.kind.streamPaused":
    "{reason, select, failures {Stream an {host} pausiert: Der Endpunkt ist immer wieder fehlgeschlagen} plan {Stream an {host} pausiert: Der Tarif enthält ihn nicht mehr} invalid_url {Stream an {host} pausiert: Seine URL besteht die Prüfungen nicht mehr} other {Stream an {host} pausiert: URL und Geheimnis lassen sich nicht mehr öffnen}}",
  "audit.stream.title": "An Ihr SIEM senden",
  "audit.stream.description":
    "Portifact sendet jedes Ereignis dieses Protokolls an einen HTTPS-Endpunkt, den Sie betreiben, als signierte JSON Lines, in Reihenfolge und mindestens einmal: Speichern Sie jede Ereignis-ID nur einmal. Ein Ereignis wird gesendet, sobald es {minutes} Minuten alt ist.",
  "region.leaves.title": "Das Ziel kann außerhalb der EU liegen",
  "region.leaves.webhooks":
    "Die Daten dieses Bereichs werden in der EU gespeichert. Webhook-Zustellungen gehen an die Adressen, die du einträgst, und die können überall sein: Was sie enthalten, verlässt die EU.",
  "region.leaves.integrations":
    "Die Daten dieses Bereichs werden in der EU gespeichert. Issues, die du erstellst, gehen an GitHub, Linear oder Jira, die sie überall speichern können: Was du sendest, verlässt die EU.",
  "audit.stream.euTitle": "Ihr Endpunkt kann außerhalb der EU liegen",
  "audit.stream.eu":
    "Die Daten dieses Bereichs werden in der EU gespeichert. Der gewählte Endpunkt kann überall liegen: Die Ereignisse, die er empfängt, verlassen die EU.",
  "audit.stream.planTitle": "Nicht in Ihrem Tarif",
  "audit.stream.planRequired":
    "Das Senden des Audit-Protokolls gehört zum Tarif {plan}. Bestehende Streams bleiben pausiert und behalten ihre Position.",
  "audit.stream.list": "Ihre Audit-Streams",
  "audit.stream.empty": "Noch kein Stream",
  "audit.stream.emptyBody":
    "Fügen Sie einen Endpunkt hinzu, um jedes neue Ereignis dieses Protokolls zu empfangen.",
  "audit.stream.add.title": "Stream hinzufügen",
  "audit.stream.add.label": "Name",
  "audit.stream.add.url": "Endpunkt-URL",
  "audit.stream.add.urlHint": "Nur HTTPS. Nach dem Speichern wird nur der Host angezeigt.",
  "audit.stream.add.start": "Beginnen ab",
  "audit.stream.add.submit": "Stream hinzufügen",
  "audit.stream.add.limit":
    "Ein Bereich kann höchstens {limit} Streams haben. Entfernen Sie einen, um einen weiteren hinzuzufügen.",
  "audit.stream.start.now": "Jetzt",
  "audit.stream.start.nowHint": "Nur Ereignisse ab jetzt.",
  "audit.stream.start.oldest": "Dem ältesten aufbewahrten Ereignis",
  "audit.stream.start.oldestHint":
    "Alles, was das Protokoll noch aufbewahrt (bis zu {days} Tage), danach neue Ereignisse.",
  "audit.stream.added": "Stream an {host} hinzugefügt",
  "audit.stream.secret.title": "Kopieren Sie jetzt das Signaturgeheimnis",
  "audit.stream.secret.body":
    "Es wird nur dieses eine Mal angezeigt. Ihr Endpunkt prüft damit, dass jede Anfrage von Portifact kommt.",
  "audit.stream.secret.label": "Signaturgeheimnis von {label} ({host})",
  "audit.stream.secret.copy": "Geheimnis kopieren",
  "audit.stream.secret.done": "Gespeichert",
  "audit.stream.rotate.body":
    "Das alte Geheimnis signiert 24 Stunden lang neben dem neuen weiter, damit Ihr Endpunkt ohne verlorene Anfrage wechseln kann.",
  "audit.stream.verify.title": "Jede Anfrage prüfen",
  "audit.stream.verify.body":
    "Jede Anfrage trägt webhook-id, webhook-timestamp und webhook-signature, dasselbe Verfahren wie bei den Webhooks von Portifact. Berechnen Sie die Signatur über den unveränderten Body neu, lehnen Sie Zeitstempel ab, die mehr als 5 Minuten abweichen, und überspringen Sie Ereignisse, deren ID Sie schon gespeichert haben. Zeilen mit einem Feld record sind keine Ereignisse: eine Lücke oder ein Test.",
  "audit.stream.verify.sample": "Signaturprüfung in Node.js",
  "audit.stream.state.active": "Aktiv",
  "audit.stream.state.paused": "Pausiert",
  "audit.stream.state.attention": "Braucht Aufmerksamkeit",
  "audit.stream.reason.manual": "Von einem Admin pausiert.",
  "audit.stream.reason.plan":
    "Pausiert: Der Tarif enthält das Senden des Protokolls nicht mehr. Setzen Sie ihn fort, sobald er es wieder enthält; er macht dort weiter, wo er stand.",
  "audit.stream.reason.failures":
    "Pausiert, nachdem der Endpunkt 3 Tage lang fehlgeschlagen ist. Beheben Sie das Problem, senden Sie einen Test und setzen Sie ihn dann fort.",
  "audit.stream.reason.invalid_url":
    "Pausiert: Seine URL besteht die Prüfungen von Portifact nicht mehr. Ändern Sie die URL.",
  "audit.stream.reason.key_unavailable":
    "Pausiert: URL und Geheimnis lassen sich nicht mehr öffnen. Entfernen Sie ihn und fügen Sie ihn neu hinzu.",
  "audit.stream.through": "Zugestellt bis {when}",
  "audit.stream.notYet": "Noch nichts zugestellt",
  "audit.stream.failures":
    "{count, plural, one {# Anfrage fehlgeschlagen} other {# Anfragen nacheinander fehlgeschlagen}}",
  "audit.stream.lastAttempt": "Letzte Anfrage {when}: {outcome}",
  "audit.stream.noAttempts": "Noch keine Anfrage",
  "audit.stream.testPending": "Ein Test wartet darauf, gesendet zu werden.",
  "audit.stream.gapTitle": "Einige Ereignisse erreichen diesen Endpunkt vielleicht nie",
  "audit.stream.gap":
    "Die zwischen {from} und {to} erfassten Ereignisse wurden oder werden durch die Aufbewahrung des Protokolls gelöscht, bevor dieser Endpunkt sie erhielt; was noch aufbewahrt war, wurde gesendet. Der Endpunkt hat einen Lückeneintrag erhalten, der das meldet.",
  "audit.stream.test": "Test senden",
  "audit.stream.testLabel": "Test senden an {label}",
  "audit.stream.testQueued": "Test für {label} eingereiht",
  "audit.stream.pause": "Pausieren",
  "audit.stream.pauseLabel": "Den Stream {label} pausieren",
  "audit.stream.paused": "Stream {label} pausiert",
  "audit.stream.resume": "Fortsetzen",
  "audit.stream.resumeLabel": "Den Stream {label} fortsetzen",
  "audit.stream.resumed": "Stream {label} fortgesetzt",
  "audit.stream.rotate": "Neues Geheimnis",
  "audit.stream.rotateLabel": "Neues Geheimnis für {label}",
  "audit.stream.rotated": "Neues Geheimnis für {label} erstellt",
  "audit.stream.remove": "Entfernen",
  "audit.stream.removeLabel": "Den Stream {label} entfernen",
  "audit.stream.removed": "Stream {label} entfernt",
  "audit.stream.confirm.title": "Den Stream {label} entfernen?",
  "audit.stream.confirm.body":
    "Portifact hört sofort auf zu senden. Ihr Endpunkt behält, was er erhalten hat; ein neuer Stream würde wieder ab jetzt beginnen.",
  "audit.stream.failed": "Das hat nicht geklappt",
  "audit.stream.deliveries": "Anfragen",
  "audit.stream.deliveriesOf": "Anfragen des Streams {label}",
  "audit.stream.deliveries.loading": "Anfragen werden geladen",
  "audit.stream.deliveries.error": "Die Anfragen konnten nicht geladen werden.",
  "audit.stream.deliveries.empty": "Keine Anfrage in den letzten {days} Tagen.",
  "audit.stream.deliveries.time": "Zeit",
  "audit.stream.deliveries.events": "Ereignisse",
  "audit.stream.deliveries.outcome": "Ergebnis",
  "audit.stream.outcome.delivered": "zugestellt",
  "audit.stream.outcome.failed": "fehlgeschlagen",
  "audit.stream.outcome.skipped": "übersprungen",
  "audit.stream.outcome.test": "Test",
  "audit.stream.error.unreachable": "keine Verbindung",
  "audit.stream.error.certificate": "Zertifikat nicht akzeptiert",
  "audit.stream.error.timeout": "Zeitüberschreitung",
  "audit.stream.error.redirect": "umgeleitet, nicht gefolgt",
  "audit.stream.error.refused": "abgelehnt",
  "audit.stream.error.invalid_url": "URL nicht mehr akzeptiert",
  "audit.stream.error.key_unavailable": "lässt sich nicht öffnen",
  "audit.stream.error.daily_cap": "Tageslimit erreicht",
  "audit.stream.revokeNow": "Jetzt ersetzen",
  "audit.stream.revokeNowLabel": "Jetzt ersetzen: Geheimnis von {label}",
  "audit.stream.revokeConfirm.title": "Das Geheimnis von {label} jetzt ersetzen?",
  "audit.stream.revokeConfirm.body":
    "Das alte Geheimnis signiert sofort nicht mehr. Bis Ihr Endpunkt das neue hat, lehnt er die Anfragen von Portifact ab; nichts geht verloren, sie werden erneut gesendet, sobald er sie annimmt. Verwenden Sie dies, wenn das alte Geheimnis bekannt geworden ist.",
  "audit.stream.revokedNow": "Neues Geheimnis für {label}; das alte signiert nicht mehr",
  "audit.stream.revokeNow.body":
    "Das alte Geheimnis signiert nicht mehr. Geben Sie Ihrem Endpunkt jetzt dieses.",
  "policies.session.legend": "Sitzungsdauer",
  "policies.session.hint":
    "Wie lange nach der Anmeldung eine Person im Workspace handeln darf. Danach bitten das Dashboard, die CLI und verbundene Apps sie, sich erneut anzumelden; niemand wird abgemeldet und nichts gelöscht.",
  "policies.session.any": "Keine Grenze",
  "policies.session.anyHint": "Eine Anmeldung handelt im Workspace, solange sie besteht.",
  "policies.session.only": "Neue Anmeldung verlangen",
  "policies.session.onlyHint":
    "Personen melden sich erneut an, sobald ihre Anmeldung älter als die Grenze ist.",
  "policies.session.hours": "Stunden nach der Anmeldung",
  "policies.session.hoursHint": "Eine ganze Zahl zwischen {min} und {max}.",
  "policies.session.hoursError": "Gib eine ganze Zahl von Stunden zwischen {min} und {max} ein.",
  "policies.session.yours":
    "Du hast dich vor {count, plural, one {# Stunde} other {# Stunden}} angemeldet. Eine kürzere Grenze würde dich aussperren; melde dich also zuerst erneut an, wenn du eine brauchst.",
  "policies.session.tokens": "Service-Tokens melden sich nicht an und sind nicht betroffen.",
  "policies.session.limits":
    "Die CLI zählt ab `portifact login` und eine App ab ihrer Verbindung, egal wie oft sie ihre Tokens erneuern.",
  "policies.clients.legend": "Apps, die handeln dürfen",
  "policies.clients.hint":
    "Welche Arten von Apps mit der Anmeldung einer Person im Workspace handeln dürfen. Das Dashboard ist immer erlaubt.",
  "policies.clients.any": "Jede App",
  "policies.clients.anyHint":
    "Das Dashboard, die Portifact-CLI und Apps, die Personen verbinden, etwa MCP-Clients.",
  "policies.clients.only": "Nur die hier gewählten Apps",
  "policies.clients.onlyHint":
    "Andere Apps werden mit einer Meldung abgelehnt, die den Grund nennt.",
  "policies.clients.which": "Erlaubte Apps",
  "policies.clients.dashboard": "Das Dashboard (immer erlaubt)",
  "policies.clients.cli": "Die Portifact-CLI",
  "policies.clients.cliHint":
    "Portifacts eigene Kommandozeile, erkannt an ihrem festen Client-Eintrag.",
  "policies.clients.apps": "Andere verbundene Apps",
  "policies.clients.appsHint":
    "MCP-Clients und jede andere App, die eine Person über OAuth verbindet.",
  "policies.clients.tokens": "Service-Tokens sind nicht betroffen.",
  "policies.clients.limits":
    "Apps, die sich selbst registrieren, wählen ihren Namen selbst, daher erlaubt oder verweigert Portifact sie als eine Gruppe, nie nach Namen. Das hindert niemanden daran, Lesbares in eine andere App zu kopieren.",
  "policies.impact.signInsTitle": "Ändern, wie sich Personen in diesem Workspace anmelden?",
  "policies.impact.signInMembers":
    "{count, plural, one {# Mitglied ist} other {# Mitglieder sind}} betroffen",
  "policies.impact.staleMembers":
    "{count, plural, one {# Mitglied müsste} other {# Mitglieder müssten}} sich bei der nächsten Aktion erneut anmelden, im Dashboard, in der CLI oder in einer verbundenen App",
  "policies.impact.clientMembers":
    "{count, plural, one {# Mitglied nutzt} other {# Mitglieder nutzen}} eine App, die das ablehnen würde",
  "policies.impact.signInsNote":
    "Niemand wird abgemeldet: Personen werden bei ihrer nächsten Aktion im Workspace gebeten, sich erneut anzumelden oder eine andere App zu nutzen.",
  "policies.impact.signInsConfirm": "Speichern",
  "space.blockedSession.title": "Erneut anmelden, um fortzufahren",
  "space.blockedSession.body":
    "{workspace} verlangt nach einer Weile eine neue Anmeldung, und deine ist älter als erlaubt. Melde dich erneut an, um hierher zurückzukehren. Deine anderen Bereiche funktionieren weiter.",
  "space.blockedSession.action": "Erneut anmelden",
  "audit.policy.session": "alle {count, plural, one {# Stunde} other {# Stunden}} neu anmelden",
  "audit.policy.sessionAny": "keine Grenze für die Sitzungsdauer",
  "audit.policy.clients":
    "{kinds, select, none {nur das Dashboard darf handeln} cli {nur das Dashboard und die CLI dürfen handeln} oauth_apps {nur das Dashboard und verbundene Apps dürfen handeln} both {das Dashboard, die CLI und verbundene Apps dürfen handeln} other {jede App darf handeln}}",
  "space.blockedSso.title": "Mit Single Sign-on anmelden, um fortzufahren",
  "space.blockedSso.body":
    "{workspace} verlangt die Anmeldung über sein Single Sign-on, und dieser Browser hat sich anders angemeldet. Melde dich mit Single Sign-on an, um hierher zurückzukehren: Dein Konto bleibt dasselbe und deine anderen Bereiche funktionieren weiter. Wenn deine Adresse nicht vom Identitätsanbieter des Workspaces bedient wird, frag einen Workspace-Admin. Du kannst den Workspace weiterhin über deine Workspace-Seite verlassen.",
  "space.blockedSso.action": "Mit Single Sign-on anmelden",
  "policies.sso.legend": "Single Sign-on",
  "policies.sso.hint":
    "Ob Personen sich über den eigenen Identitätsanbieter dieses Workspaces anmelden müssen, um im Dashboard, in der CLI und in verbundenen Apps darauf zu handeln.",
  "policies.sso.any": "Jede Anmeldung",
  "policies.sso.anyHint": "E-Mail-Codes, Google, GitHub und Single Sign-on funktionieren alle.",
  "policies.sso.only": "Nur über Single Sign-on",
  "policies.sso.onlyHint":
    "Admins eingeschlossen. CLI und Apps funktionieren, wenn die Person sie aus einer Single-Sign-on-Sitzung freigegeben hat. Service-Tokens sind nicht betroffen.",
  "policies.sso.notUsable":
    "Richte zuerst Single Sign-on mit einer verifizierten E-Mail-Domain in einem Tarif ein, der es enthält. Bis dahin kann es nicht verlangt werden.",
  "policies.sso.signInFirst":
    "Melde dich zuerst in diesem Browser mit Single Sign-on an, damit du weißt, dass es funktioniert, bevor du es verlangst. Du kehrst hierher zurück.",
  "policies.sso.tradeoff":
    "Auch Admins sind gebunden, damit kein Konto den Identitätsanbieter umgehen kann. Wenn der Anbieter ausfällt oder falsch eingerichtet ist, kann niemand im Workspace handeln, bis er wieder funktioniert oder der Portifact-Support die Vorgabe auf Bitte eines Admins aufhebt; die anderen Bereiche aller funktionieren weiter.",
  "policies.sso.required":
    "Personen melden sich über das Single Sign-on dieses Workspaces an, um darauf zu handeln.",
  "policies.sso.suspended":
    "Single Sign-on wird verlangt, aber der Anbieter kann gerade niemanden anmelden (er bedient keine verifizierte Domain mehr oder der Tarif enthält es nicht mehr), daher wird die Vorgabe erst wieder angewendet, wenn er es kann.",
  "policies.impact.ssoTitle": "Single Sign-on verlangen?",
  "policies.impact.ssoConfirm": "Single Sign-on verlangen",
  "policies.impact.ssoMembers":
    "{count, plural, one {# Mitglied handelt} other {# Mitglieder handeln}} nur noch über Single Sign-on im Workspace.",
  "policies.impact.ssoOutside":
    "{count, plural, one {Die Adresse von # Mitglied liegt} other {Die Adressen von # Mitgliedern liegen}} nicht in einer Domain, die der Anbieter bedient: Sie können sich nicht darüber anmelden und werden abgewiesen, bis ein Admin die Vorgabe aufhebt oder sich ihre Adresse ändert.",
  "policies.impact.ssoWithout":
    "{count, plural, one {# Mitglied hat} other {# Mitglieder haben}} noch keine Single-Sign-on-Sitzung und {count, plural, one {wird} other {werden}} bei der nächsten Aktion gebeten, sich darüber anzumelden.",
  "policies.impact.ssoNote":
    "Niemand wird abgemeldet. CLI-Anmeldungen und verbundene Apps, die aus einer anderen Anmeldung freigegeben wurden, werden in diesem Workspace abgewiesen, bis die Person sie aus einer Single-Sign-on-Sitzung erneut freigibt.",
  "account.sessions.column.method": "Angemeldet mit",
  "account.apps.method": "Freigegeben aus einer Anmeldung mit",
  "account.method.code": "E-Mail-Code",
  "account.method.google": "Google",
  "account.method.github": "GitHub",
  "account.method.sso": "Single Sign-on",
  "account.method.unknown": "Nicht erfasst",
  "audit.policy.sso":
    "{value, select, true {Single Sign-on verlangt} other {Single Sign-on nicht verlangt}}",
  "audit.policy.ssoRemoved": "(der Single-Sign-on-Anbieter wurde entfernt)",
  "audit.kind.policySsoSuspended":
    "„Single Sign-on verlangt“ gilt nicht mehr: Der Anbieter kann niemanden anmelden ({cause, select, domain {eine verifizierte Domain hat sich geändert} plan {der Tarif hat sich geändert} provider {der Anbieter hat sich geändert} other {bei der täglichen Prüfung bemerkt}})",
  "audit.kind.policySsoResumed":
    "„Single Sign-on verlangt“ gilt wieder: Der Anbieter kann Personen anmelden ({cause, select, domain {eine verifizierte Domain hat sich geändert} plan {der Tarif hat sich geändert} provider {der Anbieter hat sich geändert} other {bei der täglichen Prüfung bemerkt}})",
  "policies.sso.switchedOff":
    "Single Sign-on wird verlangt, ist auf diesem Portifact aber abgeschaltet: Niemand kann sich über den Anbieter anmelden und niemand kann in diesem Workspace handeln, bis der Portifact-Support die Vorgabe aufhebt oder Single Sign-on wieder einschaltet. Wende dich an den Portifact-Support.",
  "policies.maxLife.legend": "Maximale Lebensdauer von Artifacts",
  "policies.maxLife.hint":
    "Archiviert jedes Artifact des Workspace eine Anzahl Tage nach seiner letzten Veröffentlichung (ein Zurücksetzen zählt) oder Wiederherstellung. Sie zieht den Ablauf nur vor: Verlängern kann ihn nicht überschreiten, und ein archiviertes Artifact lässt sich wiederherstellen, bis sein Archiv endet. Gelöscht wird nichts. Ein Artifact in den Workspace zu verschieben, beginnt ein neues Leben, wie eine Veröffentlichung.",
  "policies.maxLife.any": "Kein Maximum",
  "policies.maxLife.anyHint":
    "Artifacts bleiben online, solange jemand sie verlängert oder veröffentlicht.",
  "policies.maxLife.only": "Nach einer maximalen Lebensdauer archivieren",
  "policies.maxLife.onlyHint":
    "Solange sie gilt, ist Anheften aus, und angeheftete Artifacts werden mit ihrer Frist gelöst.",
  "policies.maxLife.days": "Tage nach der letzten Veröffentlichung oder Wiederherstellung",
  "policies.maxLife.daysHint": "Von {min} bis {max} Tagen.",
  "policies.maxLife.daysError": "Geben Sie eine ganze Zahl von Tagen zwischen {min} und {max} ein.",
  "policies.maxLife.notice":
    "Ein neues oder kürzeres Maximum gilt {days} Tage nach dem Speichern, und alle Administratoren erhalten eine E-Mail. Bis dahin wird dadurch nichts archiviert, aber jedes Artifact zeigt schon seinen neuen Ablauf und die Eigentümer erhalten den üblichen Ablaufhinweis. Ein längeres Maximum oder keines gilt sofort.",
  "policies.maxLife.pending": "Eine maximale Lebensdauer gilt ab {date}",
  "policies.maxLife.pendingBody":
    "Ab dann werden Artifacts {days} Tage nach ihrer letzten Veröffentlichung oder Wiederherstellung archiviert. Vor diesem Datum wird dadurch nichts archiviert.",
  "policies.maxLife.active":
    "Artifacts werden {days} Tage nach ihrer letzten Veröffentlichung oder Wiederherstellung archiviert und können nicht angeheftet werden.",
  "policies.impact.atStart":
    "{count, plural, one {# aktives Artifact wird an dem Tag archiviert, an dem die maximale Lebensdauer gilt, außer jemand veröffentlicht es erneut} other {# aktive Artifacts werden an dem Tag archiviert, an dem die maximale Lebensdauer gilt, außer jemand veröffentlicht sie erneut}}",
  "policies.impact.soon":
    "{count, plural, one {# weiteres wird in den 30 Tagen danach archiviert} other {# weitere werden in den 30 Tagen danach archiviert}}",
  "policies.impact.pins":
    "{count, plural, one {# angeheftetes Artifact wird gelöst} other {# angeheftete Artifacts werden gelöst}}",
  "detail.maxLife":
    "Dieser Workspace archiviert Artifacts {days} Tage nach ihrer letzten Veröffentlichung oder Wiederherstellung: Der Ablauf berücksichtigt das, und Anheften ist aus.",
  "audit.policy.maxLife": "Artifacts {days} Tage nach ihrer letzten Veröffentlichung archiviert",
  "audit.policy.maxLifeNone": "keine maximale Lebensdauer von Artifacts",
  "audit.policy.deadlinesSet":
    "{count, plural, one {den Ablauf von # Artifact vorgezogen} other {den Ablauf von # Artifacts vorgezogen}}",
  "audit.policy.deadlinesExtended":
    "{count, plural, one {# Artifact seine Zeit zurückgegeben} other {# Artifacts ihre Zeit zurückgegeben}}",
  "transfer.confirm.maxLife":
    "{space} archiviert Artifacts {days} Tage nach ihrer letzten Veröffentlichung, Wiederherstellung oder Verschiebung dorthin: Jetzt verschoben, wird dieses spätestens am {date} archiviert, außer jemand veröffentlicht es erneut, und es kann dort nicht angeheftet werden.",
  "policies.comments.unavailable":
    "Die Regel zur Aufbewahrung von Kommentaren konnte gerade nicht geändert werden, daher wurde nichts gespeichert. Versuche es in ein paar Minuten erneut.",
  "policies.comments.legend": "Aufbewahrung von Kommentaren",
  "policies.comments.hint":
    "Löscht jeden Kommentar-Thread des Arbeitsbereichs mit allen Nachrichten, sobald er eine Anzahl von Tagen inaktiv war. Ein offener Thread auf der aktuellen Version eines Artefakts bleibt erhalten, damit nie verloren geht, worauf Prüfende warten; ersetzt eine neue Version diese Version, erhält der Thread ab diesem Moment wieder den ganzen Zeitraum. Gelöschte Threads kann niemand wiederherstellen, auch Portifact nicht.",
  "policies.comments.any": "Kommentare behalten",
  "policies.comments.anyHint":
    "Threads bleiben, bis jemand sie löscht oder ihr Artifact gelöscht wird.",
  "policies.comments.only": "Alte Threads löschen",
  "policies.comments.onlyHint":
    "Ein erledigter Thread wird gelöscht, sobald seine letzte Aktivität älter als der Zeitraum ist. Ein offener Thread auf einer früheren Version wird gelöscht, sobald der Zeitraum sowohl seit seiner letzten Aktivität als auch seit dem Ersetzen seiner Version vergangen ist. Eine Antwort startet den Zeitraum neu.",
  "policies.comments.days": "Tage nach der letzten Aktivität eines Threads",
  "policies.comments.daysHint": "Von {min} bis {max} Tagen.",
  "policies.comments.daysError":
    "Geben Sie eine ganze Zahl von Tagen zwischen {min} und {max} ein.",
  "policies.comments.notice":
    "Eine neue oder kürzere Aufbewahrung gilt {days} Tage nach dem Speichern, und alle Administratoren erhalten eine E-Mail sowie eine zweite kurz vor der ersten Löschung, wenn diese viel später kommt. Eine längere Aufbewahrung oder keine gilt sofort. Läuft der Tarif des Workspace ab, wird nichts gelöscht und die Aufbewahrung entfernt, bis sie jemand aus der Administration erneut festlegt.",
  "policies.comments.pending": "Die Aufbewahrung von Kommentaren gilt ab {date}",
  "policies.comments.active":
    "Kommentar-Threads werden {days} Tage nach ihrer letzten Aktivität endgültig gelöscht, ein offener Thread {days} Tage nach dem Ersetzen seiner Version, wenn das später ist. Offene Threads auf der aktuellen Version eines Artefakts bleiben erhalten.",
  "policies.comments.notInForce":
    "Die Aufbewahrung von Kommentaren ist festgelegt, aber nicht in Kraft",
  "policies.comments.notInForceHint":
    "Danach wird nichts gelöscht: Das folgt auf eine Wiederherstellung aus einer Sicherung oder auf ein Speichern, dessen Regel nicht festgehalten werden konnte. Speichere die Regel erneut, um sie in Kraft zu setzen; wie jede neue Regel gilt sie nach der Ankündigungsfrist.",
  "policies.impact.threads":
    "{count, plural, one {# Kommentar-Thread wird an dem Tag endgültig gelöscht, an dem die Aufbewahrung gilt} other {# Kommentar-Threads werden an dem Tag endgültig gelöscht, an dem die Aufbewahrung gilt}}",
  "policies.impact.messages":
    "{count, plural, one {# Nachricht darin wird mit gelöscht} other {# Nachrichten darin werden mit gelöscht}}",
  "policies.impact.threadsSoon":
    "{count, plural, one {# weiterer Thread wird in den 30 Tagen danach gelöscht} other {# weitere Threads werden in den 30 Tagen danach gelöscht}}",
  "policies.impact.openThreads":
    "Offene Threads auf der aktuellen Version eines Artefakts werden nicht gezählt: Sie bleiben erhalten, und ersetzt eine neue Version diese, erhält jeder ab diesem Moment den ganzen Zeitraum.",
  "audit.policy.comments": "Kommentar-Threads {days} Tage nach ihrer letzten Aktivität gelöscht",
  "audit.policy.commentsNone": "keine Aufbewahrung von Kommentaren",
  "audit.policy.planLapsed": "(der Tarif enthält keine Richtlinien mehr)",
  "audit.policy.threadsDeleted":
    "{count, plural, one {# Kommentar-Thread gelöscht} other {# Kommentar-Threads gelöscht}}",
  "audit.policy.messagesDeleted":
    "{count, plural, one {mit # Nachricht} other {mit # Nachrichten}}",
} satisfies Catalog;
