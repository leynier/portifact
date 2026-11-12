// Spanish messages of the MCP compatibility page and the chrome of the legal pages, keyed by
// their markers. The legal texts themselves stay in English.
import type { PageMessages } from "../../markers.ts";

export const documents: PageMessages = {
  // Chrome of the legal pages (terms, privacy, acceptable-use), shared across the three.
  "legal.skip": "Saltar al contenido",
  "legal.home": "Inicio de Portifact",
  "legal.footer.license": "Portifact es de código abierto bajo la GNU AGPL v3.0.",
  "legal.footer.nav": "Legal",
  "legal.footer.terms": "Términos",
  "legal.footer.privacy": "Privacidad",
  "legal.footer.acceptableUse": "Uso aceptable",
  "legal.footer.dpa": "Encargo del tratamiento",
  "legal.terms.title": "Términos del servicio: Portifact",
  "legal.terms.description":
    "Los términos para usar Portifact, el servicio que publica artifacts estáticos con control de acceso y revisión.",
  "legal.privacy.title": "Política de privacidad: Portifact",
  "legal.privacy.description":
    "Qué datos guarda Portifact, por qué, durante cuánto tiempo, quién los procesa y cómo ejercer tus derechos.",
  "legal.acceptableUse.title": "Política de uso aceptable: Portifact",
  "legal.acceptableUse.description":
    "Qué no puedes publicar ni hacer en Portifact, cómo denunciar un abuso y qué pasa cuando se incumplen las reglas.",
  "legal.dpa.title": "Anexo de tratamiento de datos: Portifact",
  "legal.dpa.description":
    "Las condiciones con las que Portifact trata datos personales por cuenta de sus clientes, con las cláusulas contractuales tipo y la lista de subencargados.",

  // MCP compatibility page.
  "mcp.meta.title": "Compatibilidad con MCP: Portifact",
  "mcp.meta.description":
    "Qué clientes MCP funcionan con el servidor MCP remoto de Portifact, cómo inician sesión y qué esperar de cada uno.",
  "mcp.chrome.skip": "Saltar al contenido",
  "mcp.chrome.home": "Inicio de Portifact",
  "mcp.intro.title": "Compatibilidad con MCP",
  "mcp.intro.tested":
    'Última prueba: <time datetime="2026-11-08">8 de noviembre de 2026</time>, con Portifact 0.11.0. La renovación del token de Codex CLI y las herramientas de comentarios se volvieron a comprobar el mismo día con Portifact 0.13.0.',
  "mcp.intro.server":
    "Portifact ofrece un servidor MCP remoto en <code>https://app.portifact.com/mcp</code> (Streamable HTTP). Agrégalo a tu cliente e inicia sesión con tu cuenta de Portifact en el navegador. El primer inicio de sesión solo pide ver tus artifacts; tu cliente vuelve a pedir permiso cuando una herramienta necesita más, como publicar o eliminar.",
  "mcp.toc.title": "En esta página",
  "mcp.matrix.title": "Clientes probados",
  "mcp.matrix.intro":
    "Cada cliente listó, publicó, volvió a leer y eliminó un documento. Los tres inician sesión con OAuth y PKCE y se identifican con un documento de metadatos de cliente publicado.",
  "mcp.matrix.caption": "Clientes MCP probados con Portifact",
  "mcp.matrix.client": "Cliente",
  "mcp.matrix.version": "Versión",
  "mcp.matrix.protocol": "Protocolo",
  "mcp.matrix.moreAccess": "Cuando una herramienta necesita más acceso",
  "mcp.matrix.status": "Estado",
  "mcp.matrix.claudeAiVersion": "Web, noviembre de 2026",
  "mcp.matrix.notRecorded": "No registrado",
  "mcp.matrix.claudeAiMoreAccess": "Te pide que lo permitas en el navegador",
  "mcp.matrix.claudeCodeMoreAccess":
    "Te indica que ejecutes <code>/mcp</code> y vuelvas a iniciar sesión",
  "mcp.matrix.codexMoreAccess":
    "La llamada falla; vuelve a iniciar sesión con los permisos que necesitas",
  "mcp.matrix.works": "Funciona",
  "mcp.claudeAi.body":
    "Agrega un conector personalizado con la dirección del servidor e inicia sesión. La primera vez que Claude publica, te pide que también permitas publicar. El conector muestra 24 herramientas: 9 que solo leen y 15 que escriben o eliminan.",
  "mcp.claudeCode.body":
    "Agrega el servidor con <code>claude mcp add --transport http portifact https://app.portifact.com/mcp</code>, luego elígelo en <code>/mcp</code> e inicia sesión. Cuando una herramienta necesita un acceso que aún no diste, la llamada falla con un mensaje que nombra el permiso que falta. Ejecuta <code>/mcp</code>, elige Re-authenticate y permítelo; Claude Code conserva lo que permitiste antes. Las ejecuciones no interactivas (<code>claude -p</code>) no pueden iniciar sesión, así que hazlo primero en una sesión interactiva.",
  "mcp.codex.body":
    "Agrega el servidor con <code>codex mcp add portifact --url https://app.portifact.com/mcp</code>; Codex abre el inicio de sesión enseguida. Codex no pide más acceso por su cuenta, así que inicia sesión con todo lo que tu agente vaya a necesitar, por ejemplo:",
  "mcp.codex.comments":
    "Agrega <code>annotations:read</code>, <code>annotations:write</code> o <code>annotations:moderate</code> para las herramientas de comentarios; con los tres, Codex activó los comentarios, comentó, respondió, resolvió y exportó los comentarios de un documento. Codex te pide aprobar las herramientas que eliminan antes de ejecutarlas. Renueva su acceso por su cuenta cuando vence el token, que dura una hora.",
  "mcp.other.title": "Otros clientes",
  "mcp.other.body":
    'Cualquier cliente compatible con servidores MCP remotos con OAuth debería funcionar: Portifact sigue la especificación de autorización de MCP del 2026-07-28 y también acepta el registro dinámico de clientes y las revisiones del protocolo de 2025. Si el tuyo no funciona, la CLI <code>portifact</code> y la skill para agentes funcionan en cualquier agente con una terminal. Cuéntanos en <a href="https://github.com/leynier/portifact/issues">GitHub</a>.',
  "mcp.footer.license": "Portifact es de código abierto bajo la GNU AGPL v3.0.",
  "mcp.footer.nav": "Legal",
  "mcp.footer.terms": "Términos",
  "mcp.footer.privacy": "Privacidad",
  "mcp.footer.acceptableUse": "Uso aceptable",
  "mcp.footer.dpa": "Encargo del tratamiento",
};
