// German catalog of the auth and report pages: the scripts' messages and the pages' markers.
// German (Germany) with informal "du". The sign-in notices keep every condition of the English
// (docs/legal.md, "Acceptance at sign-in") and the same three links.
import type { AuthMessages } from "./en.ts";
import type { AuthCatalog } from "./types.ts";

const messages = {
  network: "Portifact war nicht erreichbar. Prüfe deine Verbindung und versuch es noch einmal.",
  unexpected: "Etwas ist schiefgelaufen. Versuch es noch einmal.",
  rateLimited: "Zu viele Versuche. Warte eine Minute und versuch es noch einmal.",
  emailRequired: "Gib deine E-Mail-Adresse ein.",
  emailInvalid: "Gib eine gültige E-Mail-Adresse ein, zum Beispiel name@example.com.",
  codeRequired: "Gib den 6-stelligen Code aus der E-Mail ein.",
  codeInvalid:
    "Dieser Code ist ungültig oder abgelaufen. Prüfe ihn oder lass dir einen neuen Code senden.",
  codeSent: (email: string) => `Wir haben einen 6-stelligen Code an ${email} gesendet.`,
  codeSentStatus: "Code gesendet. Gib den 6-stelligen Code aus der E-Mail ein.",
  codeResent: "Ein neuer Code ist unterwegs.",
  resendCode: "Neuen Code senden",
  resendIn: (seconds: number) => `Neuen Code senden in ${seconds} s`,
  humanCheckNeeded:
    "Noch ein Schritt: Cloudflare braucht eine kurze Prüfung, dass du ein Mensch bist. Schließ sie unter den Anmeldeoptionen ab, um fortzufahren.",
  emailSuppressed:
    "Wir können keine E-Mails an diese Adresse senden, weil frühere Nachrichten an sie unzustellbar waren oder als Spam gemeldet wurden. Melde dich mit Google oder GitHub an oder schreib an privacy@portifact.com, damit wir sie prüfen.",
  emailCapacity:
    "Codes per E-Mail sind vorerst pausiert, weil Portifact sein monatliches E-Mail-Limit erreicht hat. Melde dich mit Google oder GitHub an oder versuch es später noch einmal.",
  signedInAs: (email: string) => `Angemeldet als ${email}`,
  signedOut: "Du bist abgemeldet.",
  methodConnected: "Verbunden",
  methodNotUsed: "Noch nicht verwendet",
  redirecting: "Du wirst angemeldet.",
  ssoFor: (email: string) =>
    `${email} meldet sich über den Identitätsanbieter deiner Organisation an.`,
  ssoShown:
    "Deine Organisation nutzt Single Sign-on. Fahre damit fort, oder lass dir stattdessen einen Code per E-Mail schicken.",
  termsUpdateFor: (email: string) => `Angemeldet als ${email}`,
  providerErrors: {
    human_verification_required:
      "Neue Konten brauchen eine kurze Prüfung, dass du ein Mensch bist, und sie wurde nicht abgeschlossen. Versuch es noch einmal; wenn unter den Anmeldeoptionen eine Prüfung erscheint, schließ sie ab. Wenn nichts erscheint, lade die Seite neu oder erlaube challenges.cloudflare.com.",
    terms_not_accepted:
      "Deine Zustimmung zu den Bedingungen hat Portifact nicht erreicht oder ist nach 30 Minuten abgelaufen. Wähl erneut eine Anmeldeoption, um fortzufahren.",
    account_not_linked:
      "Dein Anbieter hat diese E-Mail-Adresse nicht bestätigt, daher kann sie das Portifact-Konto, das sie verwendet, nicht öffnen. Bestätige sie dort oder melde dich mit einem Code per E-Mail an.",
    email_not_verified:
      "Dein Anbieter hat diese E-Mail-Adresse nicht bestätigt. Bestätige sie dort oder melde dich mit einem Code per E-Mail an.",
    email_not_found:
      "Dein Anbieter hat keine E-Mail-Adresse übermittelt. Melde dich mit einem Code per E-Mail an.",
    state_mismatch:
      "Die Anmeldung hat zu lange gedauert oder wurde in einem anderen Tab begonnen. Versuch es noch einmal.",
    artifact_unavailable:
      "Dieses Artifact existiert nicht, ist nicht mehr verfügbar oder kann mit diesem Konto nicht geöffnet werden. Um ein anderes Konto zu verwenden, melde dich ab und öffne den Link erneut.",
    sso_required:
      "Dieser Workspace verlangt die Anmeldung über das Single Sign-on deiner Organisation. Fahre unten mit deiner geschäftlichen Adresse fort; deine aktuelle Anmeldung bleibt bestehen und du kehrst dorthin zurück, wo du warst.",
    session_age:
      "Dieser Workspace verlangt nach einer Weile eine neue Anmeldung, und deine ist älter als erlaubt. Melde dich erneut an, um fortzufahren; du kommst dorthin zurück, wo du warst.",
    network_refused:
      "Dieser Workspace erlaubt den Zugriff nur aus seinen freigegebenen Netzwerken, und du bist gerade in keinem davon. Verbinde dich mit einem freigegebenen Netzwerk und öffne den Link erneut, oder wende dich an einen Workspace-Admin.",
    read_rate_limited:
      "Dieses Konto hat in kurzer Zeit zu viele Artifacts geöffnet. Warte ein paar Minuten und öffne den Link erneut.",
    sso_unavailable:
      "Single Sign-on ist für diese Adresse gerade nicht verfügbar. Melde dich anders an, oder frag den Admin deines Workspace.",
    sso_email_outside_domain:
      "Der Identitätsanbieter deiner Organisation hat eine Adresse außerhalb ihrer bestätigten Domains gemeldet, daher kann Portifact sie nicht verwenden. Frag den Admin deines Workspace.",
    sso_failed:
      "Single Sign-on wurde nicht abgeschlossen. Versuch es noch einmal; wenn es weiter scheitert, melde dich mit einem Code per E-Mail an und sag dem Admin deines Workspace Bescheid.",
    sso_workspace_full:
      "Der Workspace deiner Organisation hat keinen freien Platz, daher konntest du ihm nicht beitreten. Bitte den Admin um einen Platz und melde dich dann erneut an.",
    sso_email_unverified:
      "Der Identitätsanbieter deiner Organisation hat diese Adresse nicht bestätigt, daher kann Portifact sie nicht verwenden. Frag den Admin deines Workspace.",
    sso_link_required:
      "Diese Adresse hat bereits ein Portifact-Konto. Melde dich einmal mit einem Code per E-Mail oder wie gewohnt an und wähle dann auf dieser Seite Single Sign-on verknüpfen.",
    sso_removed:
      "Ein Admin des Workspace hat dich entfernt, daher kannst du ihm nicht per Single Sign-on wieder beitreten. Bitte einen Admin, dich erneut einzuladen.",
  },
  providerErrorFallback: "Die Anmeldung wurde nicht abgeschlossen. Versuch es noch einmal.",
  /** The read entry's confirmation before a code goes to an artifact's custom host. */
  readConfirm: {
    heading: "Unter eigener Adresse öffnen",
    body: (host: string) =>
      `Dieses Artifact liegt unter ${host}, einer Adresse, die sein Eigentümer verwaltet. Fahre nur fort, wenn du es dort öffnen wolltest.`,
    continue: "Weiter",
    missing: "Der Link war unvollständig. Öffne ihn noch einmal dort, wo du ihn gefunden hast.",
  },
  deviceCodeRequired: "Gib den Code ein, den dein Terminal anzeigt.",
  deviceCodeInvalid: "Dieser Code ist ungültig oder abgelaufen. Führ den Login-Befehl erneut aus.",
  deviceCodeTaken: "Ein anderes Konto prüft diesen Code bereits.",
  deviceProcessed: "Dieser Code wurde bereits verwendet. Führ den Login-Befehl erneut aus.",
  deviceApproved: "Gerät verbunden. Du kannst zu deinem Terminal zurückkehren.",
  deviceDenied: "Anfrage abgelehnt. Das Gerät hat keinen Zugriff erhalten.",
  consentMissing:
    "Diese Seite braucht eine Autorisierungsanfrage. Beginne erneut in der App, die dich hierher geschickt hat.",
  consentClientUnknown:
    "Die App, die dich hierher geschickt hat, ist nicht registriert oder deaktiviert.",
  redirectHost: (host: string) => `Nach deiner Entscheidung kehrst du zu ${host} zurück.`,
  scopes: {
    "artifacts:read": "Deine Artifacts, ihre Einstellungen und ihre Versionen sehen",
    "artifacts:write": "Artifacts veröffentlichen und aktualisieren",
    "artifacts:share": "Ändern, wer deine Artifacts öffnen darf",
    "artifacts:delete": "Deine Artifacts archivieren und löschen",
    "annotations:read": "Kommentare zu deinen Artifacts lesen",
    "annotations:write": "In deinem Namen kommentieren und auf Kommentare antworten",
    "annotations:moderate": "Kommentare zu deinen Artifacts erledigen, ausblenden und löschen",
    "credentials:manage": "Die mit deinem Konto verbundenen Apps sehen und trennen",
    offline_access: "Verbunden bleiben, bis du den Zugriff widerrufst",
  },
  unknownScope: (name: string) => `Die Berechtigung „${name}“ verwenden`,
  languageLabel: "Sprache",
  report: {
    artifactRequired: "Geben Sie die genaue Adresse oder die ID des Artifacts ein.",
    artifactInvalid:
      "Gib eine Adresse wie https://abcdefghij.portifact.dev/ oder eine 10-stellige ID ein.",
    reasonRequired: "Wähle aus, was mit dem Artifact nicht stimmt.",
    detailsInvalid: "Entferne Steuerzeichen oder kürze die Details.",
    emailInvalid: "Gib eine gültige E-Mail-Adresse ein oder lass das Feld leer.",
    nameInvalid:
      "Geben Sie Ihren Namen in einer Zeile mit höchstens 200 Zeichen ein oder lassen Sie das Feld leer.",
    confirmRequired:
      "Bestätigen Sie, dass die Angaben richtig und vollständig sind und Sie sie in gutem Glauben senden.",
    rateLimited:
      "Zu viele Meldungen von hier. Versuch es später noch einmal oder schreib an abuse@portifact.com.",
    network: "Portifact war nicht erreichbar. Prüfe deine Verbindung und versuch es noch einmal.",
    failed:
      "Die Meldung konnte nicht gesendet werden. Versuch es noch einmal oder schreib an abuse@portifact.com.",
    sent: "Meldung gesendet.",
  },
  /** The share link entry page (src/share/share.ts). */
  share: {
    checking: "Der Link wird geprüft.",
    opening: "Das Artifact wird geöffnet.",
    passwordRequired: "Gib das Passwort ein.",
    refused: "Das Passwort ist falsch, oder der Link ist abgelaufen oder wurde widerrufen.",
    humanCheckShown:
      "Bestätige unten, dass du ein Mensch bist. Das Passwort wird danach erneut geprüft.",
    humanCheckUnavailable:
      "Die Prüfung, ob du ein Mensch bist, konnte nicht geladen werden. Erlaube challenges.cloudflare.com oder versuche es später erneut.",
    rateLimited: "Zu viele Versuche. Warte ein paar Minuten und versuche es erneut.",
    network: "Portifact ist nicht erreichbar. Prüfe deine Verbindung und versuche es erneut.",
    failed: "Der Link konnte nicht geöffnet werden. Versuche es erneut.",
  },
  /** The comment notice unsubscribe page (src/unsubscribe/unsubscribe.ts). */
  unsubscribe: {
    missing:
      "Dieser Link ist unvollständig. Öffne den Link aus der E-Mail erneut oder schalte die Kommentarhinweise in deinen Einstellungen ab.",
    invalid:
      "Dieser Link funktioniert nicht mehr. Schalte die Kommentarhinweise in deinen Einstellungen ab.",
    rateLimited: "Zu viele Versuche von hier. Versuche es in ein paar Minuten erneut.",
    network: "Portifact ist nicht erreichbar. Prüfe deine Verbindung und versuche es erneut.",
    failed:
      "Die Kommentarhinweise konnten nicht abgeschaltet werden. Versuche es erneut oder schalte sie in deinen Einstellungen ab.",
    done: "Kommentar- und Review-Hinweise abgeschaltet.",
  },
} satisfies AuthMessages;

const TERMS_LINKS = {
  terms:
    '<a href="https://portifact.com/terms" target="_blank" rel="noopener">Nutzungsbedingungen</a>',
  acceptableUse:
    '<a href="https://portifact.com/acceptable-use" target="_blank" rel="noopener">Richtlinie zur zulässigen Nutzung</a>',
  privacy:
    '<a href="https://portifact.com/privacy" target="_blank" rel="noopener">Datenschutzerklärung</a>',
};

/** The conditions of the sign-in notices after the action that accepts them. */
const termsConditions = `bestätigst du, dass du mindestens 18 Jahre alt bist, stimmst den ${TERMS_LINKS.terms} und der ${TERMS_LINKS.acceptableUse} zu und hast die ${TERMS_LINKS.privacy} gelesen. Die Links öffnen sich in einem neuen Tab.`;

export const de: AuthCatalog = {
  messages,
  page: {
    // Shared by the four pages.
    "auth.skip": "Zum Inhalt springen",
    "auth.home": "Portifact-Startseite",
    "auth.legal": "Rechtliches",
    "auth.terms": "Nutzungsbedingungen",
    "auth.privacy": "Datenschutz",
    "auth.acceptableUse": "Zulässige Nutzung",
    "auth.dpa": "Auftragsverarbeitung",
    "auth.accessTo": "Zugriff auf",
    "auth.ableTo": "Darf dann",
    "auth.deny": "Ablehnen",

    // login.html
    "login.title": "Bei Portifact anmelden",
    "login.intro": "Neu hier? Deine erste Anmeldung erstellt dein Konto.",
    "login.signedInHint":
      "Du kannst dein Dashboard öffnen, diese Seite schließen oder dich in diesem Browser abmelden.",
    "login.openDashboard": "Dashboard öffnen",
    "login.methodsHeading": "Anmeldemethoden",
    "login.methodsHint":
      "Ein Google- oder GitHub-Konto mit dieser bestätigten E-Mail-Adresse wird bei der ersten Verwendung mit diesem Konto verknüpft.",
    "login.methodNotUsed": "Noch nicht verwendet",
    "login.signOut": "Abmelden",
    "login.termsUpdateHeading": "Prüfe die Bedingungen, um fortzufahren",
    "login.termsUpdateBody": `Dein Konto hat der aktuellen Version der Bedingungen noch nicht zugestimmt. <a href="https://portifact.com/terms#what-changed" target="_blank" rel="noopener">Sieh dir an, was sich geändert hat</a> (öffnet sich in einem neuen Tab).`,
    "login.termsUpdateNotice": `Wenn du Zustimmen und fortfahren wählst, ${termsConditions}`,
    "login.agreeAndContinue": "Zustimmen und fortfahren",
    "login.termsNotice": `Wenn du mit Google, GitHub oder einem Code per E-Mail fortfährst, ${termsConditions}`,
    "login.termsNoticeSso": `Wenn du mit Google, GitHub, einem Code per E-Mail oder Single Sign-on fortfährst, ${termsConditions}`,
    "login.ssoHeading": "Deine Organisation nutzt Single Sign-on",
    "login.ssoContinue": "Weiter mit Single Sign-on",
    "login.ssoUseCode": "Lieber einen Code per E-Mail",
    "login.ssoLinkHint":
      "Deine Organisation nutzt Single Sign-on. Verknüpfe es einmal mit diesem Konto und nutze es beim nächsten Mal.",
    "login.ssoLink": "Single Sign-on verknüpfen",
    "login.google": "Weiter mit Google",
    "login.github": "Weiter mit GitHub",
    "login.orEmail": "oder nutze deine E-Mail-Adresse",
    "login.emailLabel": "E-Mail-Adresse",
    "login.sendCode": "Code per E-Mail senden",
    "login.codeHeading": "Sieh in deinen E-Mails nach",
    "login.codeLabel": "6-stelliger Code",
    "login.codeHint":
      "Der Code läuft nach 5 Minuten ab und funktioniert einmal. Sieh in deinem Spam-Ordner nach, falls er nicht angekommen ist.",
    "login.verify": "Anmelden",
    "login.resend": "Neuen Code senden",
    "login.changeEmail": "Andere E-Mail-Adresse verwenden",
    "login.humanHeading": "Noch ein Schritt: Bestätige, dass du ein Mensch bist",
    "login.humanBody":
      "Cloudflare braucht eine kurze Prüfung, bevor Portifact weitermachen kann. Schließ sie unten ab, dann geht deine Anmeldung von selbst weiter.",

    // device.html
    "device.title": "Ein Gerät mit Portifact verbinden",
    "device.eyebrow": "Portifact-CLI und Apps",
    "device.heading": "Gerät verbinden",
    "device.intro":
      "Bestätige die Portifact-CLI oder eine andere App, die dir einen Code angezeigt hat.",
    "device.codeLabel": "Code aus deinem Terminal",
    "device.continue": "Weiter",
    "device.reviewHeading": "Diese Anmeldung bestätigen?",
    "device.app": "App",
    "device.code": "Code",
    "device.warning":
      "Bestätige nur, wenn du das in deinem eigenen Terminal gestartet hast und der Code übereinstimmt.",
    "device.approve": "Bestätigen",

    // consent.html
    "consent.title": "Zugriff auf Portifact erlauben",
    "consent.eyebrow": "Verbundene Apps",
    "consent.heading": "Zugriff erlauben",
    "consent.requestHeading":
      '<span id="client-name" class="font-semibold break-words"></span> möchte dein Portifact-Konto verwenden',
    "consent.publishedBy": "App-Details veröffentlicht von",
    "consent.loopback":
      "Sie kehrt zu einer App auf diesem Gerät zurück. Erlaube das nur, wenn du es in einer App gestartet hast, der du vertraust.",
    "consent.allow": "Erlauben",
    "consent.disconnect": "Du kannst Apps jederzeit auf der Kontoseite im Dashboard trennen.",

    // report.html
    "report.title": "Ein Artifact an Portifact melden",
    "report.heading": "Artifact melden",
    "report.intro":
      'Informiere uns über Inhalte, die gegen die <a href="https://portifact.com/acceptable-use">Richtlinie zur zulässigen Nutzung</a> verstoßen. Du brauchst kein Konto. Wir bemühen uns, innerhalb von 48 Stunden zu antworten.',
    "report.reasonLabel": "Was stimmt nicht",
    "report.reason.none": "Grund auswählen",
    "report.reason.phishing": "Phishing oder eine gefälschte Anmeldeseite",
    "report.reason.malware": "Malware, Exploits oder Kryptomining",
    "report.reason.child_safety": "Sexualisiert Minderjährige",
    "report.reason.sexual_content": "Sexuell explizite Inhalte",
    "report.reason.copyright": "Verletzung von Urheber- oder Markenrechten, raubkopierte Dateien",
    "report.reason.impersonation": "Identitätsbetrug",
    "report.reason.harassment": "Drohungen, Belästigung oder gewalttätiger Extremismus",
    "report.reason.private_information": "Private Informationen über eine Person",
    "report.reason.spam": "Spam",
    "report.reason.other": "Etwas anderes, das gegen die Regeln verstößt",
    "report.emailLabel":
      'Deine E-Mail-Adresse <span class="font-normal text-text-muted">(optional)</span>',
    "report.artifactLabel": "Genaue Adresse des Inhalts",
    "report.artifactHint":
      "Der vollständige Link, einschließlich der Seite im Artifact, etwa https://abcdefghij.portifact.dev/page.html. Die 10-stellige ID des Artifacts geht auch.",
    "report.detailsLabel":
      'Warum es rechtswidrig ist oder gegen die Regeln verstößt <span class="font-normal text-text-muted">(optional)</span>',
    "report.detailsHint":
      "Erklären Sie, was Sie gesehen haben, wo und warum Sie es für rechtswidrig oder einen Verstoß gegen die Richtlinie zur zulässigen Nutzung halten. Fügen Sie kein rechtswidriges Material ein; die Adresse genügt. Bis zu 8.000 Zeichen.",
    "report.nameLabel": 'Ihr Name <span class="font-normal text-text-muted">(optional)</span>',
    "report.nameHint":
      "Eine vollständige Meldung rechtswidriger Inhalte enthält Ihren Namen. Wir speichern ihn mit der Meldung.",
    "report.emailHint":
      'Wir nutzen sie, um Ihnen unsere Entscheidung mitzuteilen und zu antworten. Siehe die <a href="https://portifact.com/privacy">Datenschutzerklärung</a>.',
    "report.confirmLabel":
      "Ich bestätige, dass die Angaben in dieser Meldung nach bestem Wissen richtig und vollständig sind und dass ich sie in gutem Glauben sende",
    "report.send": "Meldung senden",
    "report.doneHeading": "Danke, wir haben deine Meldung erhalten",
    "report.doneBody":
      'Wir prüfen jede Meldung. Du kannst auch an <a href="mailto:abuse@portifact.com">abuse@portifact.com</a> schreiben.',
    // share.html
    "share.title": "Ein geteiltes Artifact öffnen",
    "share.heading": "Ein geteiltes Artifact öffnen",
    "share.passwordIntro":
      "Die Person, die dieses Artifact geteilt hat, hat es mit einem Passwort geschützt.",
    "share.passwordLabel": "Passwort",
    "share.humanCheckHint":
      "Nach mehreren falschen Passwörtern bestätige, dass du ein Mensch bist, um es erneut zu versuchen.",
    "share.open": "Öffnen",
    "share.unavailableHeading": "Dieser Link funktioniert nicht",
    "share.unavailableBody":
      "Er ist vielleicht abgelaufen oder wurde widerrufen, oder es ist kein Freigabelink. Bitte die Person, die ihn geteilt hat, um einen neuen Link.",
    "share.incompleteHeading": "Öffne den Link erneut",
    "share.incompleteBody":
      "Diese Seite braucht den vollständigen Freigabelink, einschließlich des Teils nach #. Zu deiner Sicherheit entfernt sie diesen Teil aus der Adressleiste, also öffne den Link nach einem Neuladen erneut von dort, wo du ihn bekommen hast.",
    "share.privacy":
      "Du liest das Artifact ohne Konto. Portifact speichert nicht, wer du bist; der Eigentümer sieht nur, dass der Link benutzt wurde. Das Artifact stammt von seinem Autor, nicht von Portifact: Gib darin keine Passwörter oder persönlichen Daten ein.",
    "share.report": "Missbrauch melden",

    // unsubscribe.html
    "unsubscribe.title": "Portifact-Kommentarhinweise abschalten",
    "unsubscribe.heading": "Kommentarhinweise abschalten",
    "unsubscribe.intro":
      "Du bekommst keine E-Mails mehr über neue Kommentare und Reviews zu Portifact-Artifacts. Ablaufhinweise und Anmelde-E-Mails ändern sich nicht.",
    "unsubscribe.confirm": "Kommentarhinweise abschalten",
    "unsubscribe.doneHeading": "Kommentarhinweise sind abgeschaltet",
    "unsubscribe.doneBody":
      'Du kannst sie in deinen <a href="/settings">Einstellungen</a> wieder einschalten.',
  },
};
