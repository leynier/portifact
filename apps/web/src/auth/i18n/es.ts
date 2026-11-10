// Spanish catalog of the auth and report pages: the scripts' messages and the pages' markers.
// Neutral Latin American Spanish with "tú". The sign-in notices keep every condition of the
// English (docs/legal.md, "Acceptance at sign-in") and the same three links.
import type { AuthMessages } from "./en.ts";
import type { AuthCatalog } from "./types.ts";

const messages = {
  network: "No se pudo conectar con Portifact. Revisa tu conexión e inténtalo de nuevo.",
  unexpected: "Algo salió mal. Inténtalo de nuevo.",
  rateLimited: "Demasiados intentos. Espera un minuto e inténtalo de nuevo.",
  emailRequired: "Escribe tu correo electrónico.",
  emailInvalid: "Escribe un correo electrónico válido, como nombre@example.com.",
  codeRequired: "Escribe el código de 6 dígitos del correo.",
  codeInvalid: "Ese código no es válido o ya venció. Revísalo o pide un código nuevo.",
  codeSent: (email: string) => `Enviamos un código de 6 dígitos a ${email}.`,
  codeSentStatus: "Código enviado. Escribe el código de 6 dígitos del correo.",
  codeResent: "Te enviamos un código nuevo.",
  resendCode: "Enviar un código nuevo",
  resendIn: (seconds: number) => `Enviar un código nuevo en ${seconds} s`,
  humanCheckNeeded:
    "Un paso más: Cloudflare necesita una verificación rápida de que eres una persona. Complétala debajo de las opciones para iniciar sesión y continuar.",
  emailSuppressed:
    "No podemos enviar correos a esta dirección porque mensajes anteriores rebotaron o se marcaron como spam. Inicia sesión con Google o GitHub, o escribe a privacy@portifact.com para que la revisemos.",
  emailCapacity:
    "Los códigos por correo están en pausa porque Portifact alcanzó su límite mensual de correos. Inicia sesión con Google o GitHub, o inténtalo más tarde.",
  signedInAs: (email: string) => `Sesión iniciada como ${email}`,
  signedOut: "Cerraste la sesión.",
  methodConnected: "Conectado",
  methodNotUsed: "Sin usar todavía",
  redirecting: "Iniciando sesión.",
  termsUpdateFor: (email: string) => `Sesión iniciada como ${email}`,
  providerErrors: {
    human_verification_required:
      "Las cuentas nuevas necesitan una verificación rápida de que eres una persona, y no terminó. Inténtalo de nuevo; si aparece una verificación debajo de las opciones para iniciar sesión, complétala. Si no aparece nada, recarga la página o permite challenges.cloudflare.com.",
    terms_not_accepted:
      "Tu aceptación de los términos no llegó a Portifact, o venció a los 30 minutos. Elige otra vez una opción para iniciar sesión y continuar.",
    account_not_linked:
      "Tu proveedor no verificó este correo electrónico, así que no puede abrir la cuenta de Portifact que lo usa. Verifícalo allí, o inicia sesión con un código por correo.",
    email_not_verified:
      "Tu proveedor no verificó este correo electrónico. Verifícalo allí, o inicia sesión con un código por correo.",
    email_not_found:
      "Tu proveedor no compartió un correo electrónico. Inicia sesión con un código por correo.",
    state_mismatch:
      "El inicio de sesión tardó demasiado o empezó en otra pestaña. Inténtalo de nuevo.",
    artifact_unavailable:
      "Este artifact no existe, ya no está disponible o no se puede abrir con esta cuenta. Para usar otra cuenta, cierra la sesión y abre el enlace de nuevo.",
    read_rate_limited:
      "Esta cuenta abrió demasiados artifacts en poco tiempo. Espera unos minutos y abre el enlace de nuevo.",
  },
  providerErrorFallback: "El inicio de sesión no terminó. Inténtalo de nuevo.",
  deviceCodeRequired: "Escribe el código que muestra tu terminal.",
  deviceCodeInvalid: "Ese código no es válido o ya venció. Ejecuta de nuevo el comando de login.",
  deviceCodeTaken: "Otra cuenta ya está revisando este código.",
  deviceProcessed: "Este código ya se usó. Ejecuta de nuevo el comando de login.",
  deviceApproved: "Dispositivo conectado. Ya puedes volver a tu terminal.",
  deviceDenied: "Solicitud rechazada. El dispositivo no obtuvo acceso.",
  consentMissing:
    "Esta página necesita una solicitud de autorización. Empieza de nuevo desde la app que te envió aquí.",
  consentClientUnknown: "La app que te envió aquí no está registrada o está desactivada.",
  redirectHost: (host: string) => `Después de decidir, vuelves a ${host}.`,
  scopes: {
    "artifacts:read": "Ver tus artifacts, su configuración y sus versiones",
    "artifacts:write": "Publicar y actualizar artifacts",
    "artifacts:share": "Cambiar quién puede abrir tus artifacts",
    "artifacts:delete": "Archivar y eliminar tus artifacts",
    "annotations:read": "Leer los comentarios de tus artifacts",
    "annotations:write": "Escribir y responder comentarios en tu nombre",
    "annotations:moderate": "Resolver, ocultar y eliminar comentarios de tus artifacts",
    "credentials:manage": "Ver las apps conectadas a tu cuenta y desconectarlas",
    offline_access: "Mantener la conexión hasta que revoques el acceso",
  },
  unknownScope: (name: string) => `Usar el permiso "${name}"`,
  languageLabel: "Idioma",
  report: {
    artifactRequired: "Escribe la dirección o el ID del artifact.",
    artifactInvalid:
      "Escribe una dirección como https://abcdefghij.portifact.dev/ o un ID de 10 caracteres.",
    reasonRequired: "Elige qué tiene de malo el artifact.",
    detailsInvalid: "Quita los caracteres de control o acorta los detalles.",
    emailInvalid: "Escribe un correo electrónico válido, o déjalo vacío.",
    rateLimited:
      "Demasiadas denuncias desde aquí. Inténtalo más tarde o escribe a abuse@portifact.com.",
    network: "No se pudo conectar con Portifact. Revisa tu conexión e inténtalo de nuevo.",
    failed: "No se pudo enviar la denuncia. Inténtalo de nuevo o escribe a abuse@portifact.com.",
    sent: "Denuncia enviada.",
  },
  /** The share link entry page (src/share/share.ts). */
  share: {
    checking: "Comprobando el enlace.",
    opening: "Abriendo el artifact.",
    passwordRequired: "Escribe la contraseña.",
    refused: "La contraseña es incorrecta, o el enlace venció o fue revocado.",
    humanCheckShown:
      "Confirma abajo que eres humano. La contraseña se vuelve a probar cuando termines.",
    humanCheckUnavailable:
      "No se pudo cargar la verificación humana. Permite challenges.cloudflare.com o inténtalo más tarde.",
    rateLimited: "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.",
    network: "No se pudo conectar con Portifact. Revisa tu conexión e inténtalo de nuevo.",
    failed: "No se pudo abrir el enlace. Inténtalo de nuevo.",
  },
} satisfies AuthMessages;

const TERMS_LINKS = {
  terms:
    '<a href="https://portifact.com/terms" target="_blank" rel="noopener">Términos del servicio</a>',
  acceptableUse:
    '<a href="https://portifact.com/acceptable-use" target="_blank" rel="noopener">Política de uso aceptable</a>',
  privacy:
    '<a href="https://portifact.com/privacy" target="_blank" rel="noopener">Política de privacidad</a>',
};

/** The conditions of the sign-in notices after the action that accepts them. */
const termsConditions = `confirmas que tienes 18 años o más, aceptas los ${TERMS_LINKS.terms} y la ${TERMS_LINKS.acceptableUse}, y que leíste la ${TERMS_LINKS.privacy}. Los enlaces se abren en una pestaña nueva.`;

export const es: AuthCatalog = {
  messages,
  page: {
    // Shared by the four pages.
    "auth.skip": "Saltar al contenido",
    "auth.home": "Inicio de Portifact",
    "auth.legal": "Legal",
    "auth.terms": "Términos",
    "auth.privacy": "Privacidad",
    "auth.acceptableUse": "Uso aceptable",
    "auth.accessTo": "Acceso a",
    "auth.ableTo": "Podrá",
    "auth.deny": "Rechazar",

    // login.html
    "login.title": "Iniciar sesión en Portifact",
    "login.intro": "¿Eres nuevo? Tu primer inicio de sesión crea tu cuenta.",
    "login.signedInHint":
      "Puedes abrir tu panel, cerrar esta página o cerrar la sesión en este navegador.",
    "login.openDashboard": "Abrir tu panel",
    "login.methodsHeading": "Formas de iniciar sesión",
    "login.methodsHint":
      "Una cuenta de Google o GitHub con este correo verificado se une a esta cuenta la primera vez que la usas.",
    "login.methodNotUsed": "Sin usar todavía",
    "login.signOut": "Cerrar sesión",
    "login.termsUpdateHeading": "Revisa los términos para continuar",
    "login.termsUpdateBody": "Tu cuenta todavía no aceptó la versión actual de los términos.",
    "login.termsUpdateNotice": `Al seleccionar Aceptar y continuar, ${termsConditions}`,
    "login.agreeAndContinue": "Aceptar y continuar",
    "login.termsNotice": `Al continuar con Google, GitHub o un código por correo, ${termsConditions}`,
    "login.google": "Continuar con Google",
    "login.github": "Continuar con GitHub",
    "login.orEmail": "o usa tu correo",
    "login.emailLabel": "Correo electrónico",
    "login.sendCode": "Envíame un código",
    "login.codeHeading": "Revisa tu correo",
    "login.codeLabel": "Código de 6 dígitos",
    "login.codeHint":
      "El código vence en 5 minutos y funciona una sola vez. Si no llegó, revisa tu carpeta de spam.",
    "login.verify": "Iniciar sesión",
    "login.resend": "Enviar un código nuevo",
    "login.changeEmail": "Usar otro correo",
    "login.humanHeading": "Un paso más: confirma que eres una persona",
    "login.humanBody":
      "Cloudflare necesita una verificación rápida antes de que Portifact pueda seguir. Complétala abajo y tu inicio de sesión continúa solo.",

    // device.html
    "device.title": "Conectar un dispositivo a Portifact",
    "device.eyebrow": "CLI y apps de Portifact",
    "device.heading": "Conectar un dispositivo",
    "device.intro": "Aprueba la CLI de Portifact u otra app que te mostró un código.",
    "device.codeLabel": "Código que muestra tu terminal",
    "device.continue": "Continuar",
    "device.reviewHeading": "¿Apruebas este inicio de sesión?",
    "device.app": "App",
    "device.code": "Código",
    "device.warning":
      "Aprueba solo si tú empezaste esto desde tu propia terminal y el código coincide.",
    "device.approve": "Aprobar",

    // consent.html
    "consent.title": "Permitir acceso a Portifact",
    "consent.eyebrow": "Apps conectadas",
    "consent.heading": "Permitir acceso",
    "consent.requestHeading":
      '<span id="client-name" class="font-semibold break-words"></span> quiere usar tu cuenta de Portifact',
    "consent.publishedBy": "Detalles de la app publicados por",
    "consent.loopback":
      "Vuelve a una app de este dispositivo. Permítelo solo si empezaste esto desde una app de confianza.",
    "consent.allow": "Permitir",
    "consent.disconnect":
      "Puedes desconectar apps cuando quieras desde la página de tu cuenta en el panel.",

    // report.html
    "report.title": "Denunciar un artifact a Portifact",
    "report.heading": "Denunciar un artifact",
    "report.intro":
      'Cuéntanos sobre contenido que no cumple la <a href="https://portifact.com/acceptable-use">Política de uso aceptable</a>. No necesitas una cuenta. Intentamos responder en 48 horas.',
    "report.artifactLabel": "Dirección o ID del artifact",
    "report.reasonLabel": "Qué tiene de malo",
    "report.reason.none": "Elige un motivo",
    "report.reason.phishing": "Phishing o una página falsa para iniciar sesión",
    "report.reason.malware": "Malware, exploits o minería de criptomonedas",
    "report.reason.child_safety": "Sexualiza a menores",
    "report.reason.sexual_content": "Contenido sexual explícito",
    "report.reason.copyright": "Infracción de derechos de autor o de marca, archivos pirateados",
    "report.reason.impersonation": "Suplantación de identidad",
    "report.reason.harassment": "Amenazas, acoso o extremismo violento",
    "report.reason.private_information": "Información privada de alguien",
    "report.reason.spam": "Spam",
    "report.reason.other": "Otra cosa que no cumple las reglas",
    "report.detailsLabel": 'Detalles <span class="font-normal text-text-muted">(opcional)</span>',
    "report.detailsHint":
      "Qué viste y dónde. No pegues material ilegal; la dirección es suficiente. Hasta 2000 caracteres.",
    "report.emailLabel": 'Tu correo <span class="font-normal text-text-muted">(opcional)</span>',
    "report.emailHint":
      'Solo si quieres que podamos responderte. Consulta la <a href="https://portifact.com/privacy">Política de privacidad</a>.',
    "report.send": "Enviar denuncia",
    "report.doneHeading": "Gracias, recibimos tu denuncia",
    "report.doneBody":
      'Revisamos cada denuncia. También puedes escribir a <a href="mailto:abuse@portifact.com">abuse@portifact.com</a>.',
    // share.html
    "share.title": "Abrir un artifact compartido",
    "share.heading": "Abrir un artifact compartido",
    "share.passwordIntro": "Quien compartió este artifact lo protegió con una contraseña.",
    "share.passwordLabel": "Contraseña",
    "share.humanCheckHint":
      "Después de varias contraseñas incorrectas, confirma que eres humano para volver a intentarlo.",
    "share.open": "Abrir",
    "share.unavailableHeading": "Este enlace no funciona",
    "share.unavailableBody":
      "Puede haber vencido o haber sido revocado, o no es un enlace para compartir. Pide un enlace nuevo a quien lo compartió.",
    "share.incompleteHeading": "Vuelve a abrir el enlace",
    "share.incompleteBody":
      "Esta página necesita el enlace completo, incluida la parte que sigue a #. Por seguridad quita esa parte de la barra de direcciones, así que después de recargar vuelve a abrir el enlace desde donde lo recibiste.",
    "share.privacy":
      "Lees el artifact sin una cuenta. Portifact no registra quién eres; el dueño solo ve que se usó el enlace. El artifact lo escribe su autor, no Portifact: no escribas contraseñas ni datos personales en él.",
    "share.report": "Denunciar abuso",
  },
};
