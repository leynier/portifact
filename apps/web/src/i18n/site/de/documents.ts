// German messages of the MCP compatibility page and the chrome of the legal pages, keyed by
// their markers. The legal texts themselves stay in English.
import type { PageMessages } from "../../markers.ts";

export const documents: PageMessages = {
  // Chrome of the legal pages (terms, privacy, acceptable-use), shared across the three.
  "legal.skip": "Zum Inhalt springen",
  "legal.home": "Portifact-Startseite",
  "legal.footer.license": "Portifact ist Open Source unter der GNU AGPL v3.0.",
  "legal.footer.nav": "Rechtliches",
  "legal.footer.terms": "Nutzungsbedingungen",
  "legal.footer.privacy": "Datenschutz",
  "legal.footer.acceptableUse": "Zulässige Nutzung",
  "legal.footer.dpa": "Auftragsverarbeitung",
  "legal.terms.title": "Nutzungsbedingungen: Portifact",
  "legal.terms.description":
    "Die Bedingungen für die Nutzung von Portifact, dem Dienst, der statische Artifacts mit Zugriffskontrolle und Review veröffentlicht.",
  "legal.privacy.title": "Datenschutzerklärung: Portifact",
  "legal.privacy.description":
    "Welche Daten Portifact speichert, warum, wie lange, wer sie verarbeitet und wie du deine Rechte ausübst.",
  "legal.acceptableUse.title": "Richtlinie zur zulässigen Nutzung: Portifact",
  "legal.acceptableUse.description":
    "Was du auf Portifact nicht veröffentlichen oder tun darfst, wie du Missbrauch meldest und was bei Regelverstößen passiert.",
  "legal.dpa.title": "Auftragsverarbeitungsvertrag: Portifact",
  "legal.dpa.description":
    "Die Bedingungen, unter denen Portifact personenbezogene Daten im Auftrag seiner Kunden verarbeitet, mit den Standardvertragsklauseln und der Liste der Unterauftragsverarbeiter.",

  // MCP compatibility page.
  "mcp.meta.title": "MCP-Kompatibilität: Portifact",
  "mcp.meta.description":
    "Welche MCP-Clients mit dem Remote-MCP-Server von Portifact funktionieren, wie sie sich anmelden und was du von jedem erwarten kannst.",
  "mcp.chrome.skip": "Zum Inhalt springen",
  "mcp.chrome.home": "Portifact-Startseite",
  "mcp.intro.title": "MCP-Kompatibilität",
  "mcp.intro.tested":
    'Zuletzt getestet am <time datetime="2026-11-08">8. November 2026</time> mit Portifact 0.11.0. Die Token-Erneuerung von Codex CLI und die Kommentarwerkzeuge wurden am selben Tag mit Portifact 0.13.0 erneut geprüft.',
  "mcp.intro.server":
    "Portifact betreibt einen Remote-MCP-Server unter <code>https://app.portifact.com/mcp</code> (Streamable HTTP). Füge ihn zu deinem Client hinzu und melde dich im Browser mit deinem Portifact-Konto an. Die erste Anmeldung fragt nur nach dem Zugriff auf deine Artifacts; dein Client fragt erneut, wenn ein Werkzeug mehr braucht, etwa zum Veröffentlichen oder Löschen.",
  "mcp.toc.title": "Auf dieser Seite",
  "mcp.matrix.title": "Getestete Clients",
  "mcp.matrix.intro":
    "Jeder Client hat ein Dokument aufgelistet, veröffentlicht, wieder gelesen und gelöscht. Alle drei melden sich mit OAuth und PKCE an und weisen sich mit einem veröffentlichten Client-Metadatendokument aus.",
  "mcp.matrix.caption": "Mit Portifact getestete MCP-Clients",
  "mcp.matrix.client": "Client",
  "mcp.matrix.version": "Version",
  "mcp.matrix.protocol": "Protokoll",
  "mcp.matrix.moreAccess": "Wenn ein Werkzeug mehr Zugriff braucht",
  "mcp.matrix.status": "Status",
  "mcp.matrix.claudeAiVersion": "Web, November 2026",
  "mcp.matrix.notRecorded": "Nicht erfasst",
  "mcp.matrix.claudeAiMoreAccess": "Bittet dich, es im Browser zu erlauben",
  "mcp.matrix.claudeCodeMoreAccess":
    "Fordert dich auf, <code>/mcp</code> auszuführen und dich erneut anzumelden",
  "mcp.matrix.codexMoreAccess":
    "Der Aufruf schlägt fehl; melde dich erneut mit den benötigten Scopes an",
  "mcp.matrix.works": "Funktioniert",
  "mcp.claudeAi.body":
    "Füge einen benutzerdefinierten Connector mit der Serveradresse hinzu und melde dich an. Wenn Claude zum ersten Mal veröffentlicht, bittet es dich, auch das Veröffentlichen zu erlauben. Der Connector zeigt 24 Werkzeuge: 9, die nur lesen, und 15, die schreiben oder löschen.",
  "mcp.claudeCode.body":
    "Füge den Server mit <code>claude mcp add --transport http portifact https://app.portifact.com/mcp</code> hinzu, wähle ihn dann in <code>/mcp</code> aus und melde dich an. Wenn ein Werkzeug Zugriff braucht, den du noch nicht gewährt hast, schlägt der Aufruf mit einer Meldung fehl, die die fehlende Berechtigung nennt. Führ <code>/mcp</code> aus, wähle Re-authenticate und erlaube sie; Claude Code behält, was du vorher erlaubt hast. Nicht interaktive Läufe (<code>claude -p</code>) können sich nicht anmelden, also erledige das zuerst in einer interaktiven Sitzung.",
  "mcp.codex.body":
    "Füge den Server mit <code>codex mcp add portifact --url https://app.portifact.com/mcp</code> hinzu; Codex startet die Anmeldung sofort. Codex fragt nicht von selbst nach mehr Zugriff, melde dich also mit allem an, was dein Agent brauchen wird, zum Beispiel:",
  "mcp.codex.comments":
    "Füge <code>annotations:read</code>, <code>annotations:write</code> oder <code>annotations:moderate</code> für die Kommentarwerkzeuge hinzu; mit allen dreien hat Codex Kommentare eingeschaltet, kommentiert, geantwortet, erledigt und die Kommentare eines Dokuments exportiert. Codex bittet dich, Werkzeuge zum Löschen zu bestätigen, bevor es sie ausführt. Es erneuert seinen Zugriff von selbst, wenn das eine Stunde gültige Token abläuft.",
  "mcp.other.title": "Andere Clients",
  "mcp.other.body":
    'Jeder Client, der Remote-MCP-Server mit OAuth unterstützt, sollte funktionieren: Portifact folgt der MCP-Autorisierungsspezifikation vom 2026-07-28 und akzeptiert auch die dynamische Client-Registrierung und die Protokollrevisionen von 2025. Wenn deiner nicht funktioniert, laufen die <code>portifact</code>-CLI und der Agent-Skill in jedem Agenten mit einer Shell. Erzähl uns davon auf <a href="https://github.com/leynier/portifact/issues">GitHub</a>.',
  "mcp.footer.license": "Portifact ist Open Source unter der GNU AGPL v3.0.",
  "mcp.footer.nav": "Rechtliches",
  "mcp.footer.terms": "Nutzungsbedingungen",
  "mcp.footer.privacy": "Datenschutz",
  "mcp.footer.acceptableUse": "Zulässige Nutzung",
  "mcp.footer.dpa": "Auftragsverarbeitung",
};
