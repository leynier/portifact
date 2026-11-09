// Spanish messages of the landing page (index.html), keyed by its markers in page order.
import type { PageMessages } from "../../markers.ts";

export const landing: PageMessages = {
  "landing.meta.title": "Portifact: comparte lo que construyó tu agente",
  "landing.meta.description":
    "Publica HTML, Markdown y texto con un enlace privado, decide quién puede abrirlo y recibe comentarios que tu agente de programación puede aplicar. Código abierto.",
  "landing.meta.ogDescription":
    "Publica HTML, Markdown y texto con un enlace privado, decide quién puede abrirlo y recibe comentarios que tu agente de programación puede aplicar.",
  "landing.skipLink": "Saltar al contenido",
  "landing.header.homeLabel": "Inicio de Portifact",
  "landing.header.navLabel": "Principal",
  "landing.nav.product": "Producto",
  "landing.nav.review": "Revisión",
  "landing.nav.access": "Acceso",
  "landing.nav.security": "Seguridad",
  "landing.nav.faq": "Preguntas",
  "landing.header.star": "Estrella en GitHub",
  "landing.header.signIn": "Iniciar sesión",
  "landing.header.install": "Instalar",
  "landing.hero.badge": "Versión preliminar",
  "landing.hero.statusShort": "Mira lo que ya funciona",
  "landing.hero.statusLong": "Ya puedes publicar, compartir y revisar",
  "landing.hero.spoken":
    "Comparte lo que construyó tu agente. Recibe comentarios que puede aplicar",
  "landing.hero.titleLead": "Comparte lo que construyó tu agente",
  "landing.hero.phrase1": 'Recibe comentarios que puede aplicar<span class="typing-caret"></span>',
  "landing.hero.phrase2": 'Mantenlo privado por defecto<span class="typing-caret"></span>',
  "landing.hero.phrase3": 'Revísalo línea por línea<span class="typing-caret"></span>',
  "landing.hero.phrase4": 'Restáuralo cuando quieras<span class="typing-caret"></span>',
  "landing.hero.typed": "Recibe comentarios que puede aplicar",
  "landing.hero.lead":
    "Publica los planes, informes y prototipos que produce tu agente de programación con un enlace privado, elige exactamente quién puede abrirlos y recibe comentarios anclados a la frase o al elemento exacto. Tu agente lee los hilos y hace los cambios.",
  "landing.hero.signIn": "Iniciar sesión",
  "landing.hero.readCode": "Lee el código en GitHub",
  "landing.hero.terminalLabel":
    "Una terminal ejecuta portifact publish sobre report.html con el nombre Billing migration. La CLI lista el archivo, lo sube, convierte la nueva versión en la actual e imprime la URL privada en portifact.dev y la fecha en que vence.",
  "landing.hero.screenshotAlt":
    "El visor de Portifact con el informe Billing migration. La barra de Portifact, arriba, muestra el nombre del artifact, la versión 1 y un botón Comments con un hilo. En el informe está resaltada la frase Writes switch over only after seven days without errors, y la barra lateral de comentarios muestra la pregunta de Ana Lopez sobre ella con la respuesta del propietario.",
  "landing.hero.caption":
    "Publica desde la terminal, revisa en el navegador. Código abierto bajo AGPL-3.0.",
  "landing.agents.title": "Funciona con los agentes que ya usas",
  "landing.agents.note":
    'La CLI y la skill para agentes funcionan en todos ellos. El servidor MCP remoto funciona en clientes que admiten inicio de sesión con OAuth y está probado con Claude.ai, Claude Code y Codex CLI. <a href="/mcp-compatibility" class="text-text hover:no-underline">Ver la compatibilidad con MCP</a>',
  "landing.interfaces.eyebrow": "Tres formas de usarlo",
  "landing.interfaces.title": "Las mismas reglas, trabajes donde trabajes",
  "landing.interfaces.lead":
    "La CLI, el servidor MCP remoto y el panel web comparten la misma capa de dominio. Una operación aplica las mismas comprobaciones de permisos, cuotas, estados y errores sin importar dónde la inicies, así que tu agente y tu equipo siempre ven lo mismo.",
  "landing.interfaces.tabsLabel": "Formas de usar Portifact",
  "landing.interfaces.tabMcp": 'MCP<span class="hidden sm:inline"> para agentes</span>',
  "landing.interfaces.tabDashboard": "Panel",
  "landing.common.available": "Disponible",
  "landing.interfaces.cli.title": "Para ti y tus scripts",
  "landing.interfaces.cli.body":
    'Un único binario autónomo para macOS, Linux y Windows. Publica un archivo, una carpeta o un ZIP, compártelo y trae de vuelta los comentarios, desde tu shell o desde cualquier agente con terminal. Ejecuta <code class="font-mono text-text">portifact login</code> para iniciar sesión.',
  "landing.interfaces.cli.json":
    'Salida <code class="font-mono">--json</code> estable y opciones no interactivas',
  "landing.interfaces.cli.preview":
    'Muestra la lista de archivos antes de subirlos y omite secretos, <code class="font-mono">.git</code> y <code class="font-mono">node_modules</code>',
  "landing.interfaces.cli.signIn":
    "Inicia sesión con un código de dispositivo y guarda las credenciales en el llavero del sistema",
  "landing.interfaces.cli.versions":
    "Versiones, reversión y fuentes privadas que solo tú puedes recuperar",
  "landing.interfaces.cli.terminalLabel":
    "Una sesión de terminal con la salida de la CLI: portifact publish lista los tres archivos de la carpeta prototype, los sube e imprime la URL privada y su vencimiento, portifact access add la comparte con dos direcciones de correo y portifact annotations export guarda todos los hilos de revisión como Markdown en feedback.md.",
  "landing.interfaces.mcp.title": "Para tu agente, directamente",
  "landing.interfaces.mcp.body":
    'Un servidor MCP remoto en <code class="font-mono text-text">https://app.portifact.com/mcp</code>. Agrégalo a tu cliente e inicia sesión con tu cuenta de Portifact en el navegador. Tu agente publica documentos, gestiona versiones y lee comentarios como herramientas, sin instalar nada más en tu equipo.',
  "landing.interfaces.mcp.tested":
    'Probado con Claude.ai, Claude Code y Codex CLI. <a href="/mcp-compatibility" class="text-text hover:no-underline">Ver la compatibilidad con MCP</a>',
  "landing.interfaces.mcp.inline":
    "Los documentos pequeños van en línea; las carpetas, los sitios y los cambios de acceso pasan por la CLI o el panel",
  "landing.interfaces.mcp.noPrivilegedPath":
    "Sin vía privilegiada: las mismas comprobaciones de permisos y cuotas que la CLI",
  "landing.interfaces.mcp.untrusted":
    "Los comentarios de los revisores llegan al agente como datos, nunca como instrucciones",
  "landing.interfaces.mcp.sessionTitle": "sesión del agente",
  "landing.interfaces.mcp.sessionLabel":
    "Una sesión de agente. Cuando se le pide publicar el plan de diseño de la API, el agente llama a la herramienta publish_document de Portifact, que devuelve el ID del artifact, la versión 1, la URL privada y la fecha de vencimiento, y responde con el enlace. Cuando se le pide leer los comentarios, llama a list_annotations, que devuelve los hilos abiertos, y resume los dos comentarios de los revisores.",
  "landing.interfaces.dashboard.title": "Para todo el equipo",
  "landing.interfaces.dashboard.body":
    'Un panel web en <code class="font-mono text-text">app.portifact.com</code> para publicar, compartir, revisar y restaurar sin terminal. <a href="https://app.portifact.com/" class="text-text hover:no-underline">Inicia sesión en el panel</a>',
  "landing.interfaces.dashboard.publish":
    "Publica archivos, una carpeta o un ZIP desde el navegador, o edita Markdown y texto ahí mismo",
  "landing.interfaces.dashboard.manage":
    "Cambia el acceso, comenta en el visor de revisión, vuelve a versiones anteriores y restaura artifacts archivados",
  "landing.interfaces.dashboard.sessions":
    "Consulta tus sesiones del navegador y desconecta apps, incluidas la CLI y los clientes MCP",
  "landing.interfaces.dashboard.screenshotAlt":
    "La lista de artifacts del panel de Portifact, con un cuadro de búsqueda y filtros por estado, tipo, acceso y comentarios. Aparecen cuatro artifacts: API design plan, en Markdown, abierto a quienes tienen sesión iniciada; Checkout prototype y Billing migration, sitios restringidos a las personas con quienes se compartieron; y Release notes, un texto público. Cada fila muestra su estado, fecha de vencimiento, tamaño y actividad reciente, como hilos de comentarios abiertos.",
  "landing.how.eyebrow": "Cómo funciona",
  "landing.how.title": "Del resultado del agente a los comentarios, en un solo ciclo",
  "landing.how.lead":
    "Sin archivos zip, capturas de pantalla ni muros de texto pegados. El trabajo se queda donde se hizo, y los comentarios vuelven al agente que lo hizo.",
  "landing.how.write.title": "Tu agente escribe",
  "landing.how.write.body":
    "Un plan, un informe de avance o un prototipo queda en el disco como HTML, Markdown o texto.",
  "landing.how.publish.title": "Publícalo",
  "landing.how.publish.body":
    "Un comando o una llamada a una herramienta devuelve una URL privada en su propio origen.",
  "landing.how.share.title": "Compártelo",
  "landing.how.share.body": "Ábrelo a las personas que deben verlo, y a nadie más.",
  "landing.how.collect.title": "Recibe comentarios",
  "landing.how.collect.body":
    "Los revisores seleccionan una frase o un elemento y abren un hilo sobre él.",
  "landing.how.collect.label": "modo revisión",
  "landing.how.revise.title": "Tu agente corrige",
  "landing.how.revise.body":
    "Exporta los hilos, aplica los cambios y vuelve a publicar en la misma URL.",
  "landing.how.note":
    "Los pasos muestran comandos de la CLI, y el panel también hace cada uno de ellos. Con MCP tu agente publica documentos y lee los hilos; cambiar el acceso queda en manos de la CLI y el panel.",
  "landing.access.eyebrow": "Control de acceso",
  "landing.access.title": "Privado hasta que decidas lo contrario",
  "landing.access.lead":
    "Todo artifact nuevo empieza visible solo para ti. Amplía el círculo paso a paso y vuelve a reducirlo cuando quieras.",
  "landing.access.private.name": "Privado",
  "landing.access.private.description": "Solo tú. El valor predeterminado de todo artifact nuevo.",
  "landing.access.emailList.name": "Lista de correos",
  "landing.access.emailList.description":
    "Las personas que nombres, después de que confirmen su dirección.",
  "landing.access.signedIn.name": "Con cuenta",
  "landing.access.signedIn.description": "Cualquier persona con una cuenta de Portifact.",
  "landing.access.public.name": "Público",
  "landing.access.public.description":
    "Cualquier persona con el enlace. Sigue sin indexarse a menos que lo permitas. Las cuentas nuevas pueden elegirlo 15 minutos después de registrarse.",
  "landing.access.note":
    "Publicar una versión nueva mantiene el acceso actual. Una actualización nunca amplía la audiencia.",
  "landing.access.diagramLabel":
    "Cuatro círculos de acceso anidados. El más interno es Privado, solo tú. A su alrededor, la lista de correos, luego cualquier persona con cuenta y, por fuera, el público.",
  "landing.access.public.hint": "cualquiera con el enlace",
  "landing.access.signedIn.hint": "cualquier cuenta",
  "landing.access.emailList.hint": "personas que nombres",
  "landing.access.emailList.add": "+ agregar",
  "landing.access.private.hint": "Predeterminado · solo tú",
  "landing.review.eyebrow": "Revisión y anotaciones",
  "landing.review.title": "Comentarios anclados justo a lo que señalan",
  "landing.review.lead":
    "Activa el modo revisión y los revisores comentan directamente sobre el artifact. Tu agente recibe cada hilo con su ancla, listo para actuar.",
  "landing.review.screenshotAlt":
    "El visor de Portifact sobre Checkout prototype. Dos resaltados de comentarios se superponen en la frase sobre devoluciones gratuitas y plazos de entrega. El revisor hizo clic en la superposición, así que la barra lateral de comentarios muestra ambos hilos juntos: Marco Rossi pide mostrar la fecha de llegada en lugar de 3 a 5 días hábiles, con la respuesta del propietario, y Ana Lopez pide mover la frase encima del botón.",
  "landing.review.caption": "Comentarios superpuestos en el sitio de un prototipo.",
  "landing.review.terminalLabel":
    "El inicio de la salida de portifact annotations export para los hilos abiertos, en Markdown: una nota que indica que el texto de los revisores son datos no confiables, el artifact, el número de hilos y el primer hilo con la frase que cita y el comentario de Ana Lopez.",
  "landing.review.sentence.title": "Cualquier frase",
  "landing.review.sentence.body":
    "Selecciona texto en HTML, Markdown o texto plano, con el mouse o con el teclado.",
  "landing.review.element.title": "Cualquier elemento",
  "landing.review.element.body":
    "Señala un botón, un gráfico o una sección de un sitio y coméntalo.",
  "landing.review.threads.title": "Hilos completos",
  "landing.review.threads.body":
    "Respuestas, hilos abiertos y resueltos, vinculados a la versión sobre la que se escribieron.",
  "landing.review.export.title": "Exportación para agentes",
  "landing.review.export.body":
    "JSON o Markdown, leídos como datos, nunca como instrucciones a seguir.",
  "landing.lifecycle.eyebrow": "Ciclo de vida",
  "landing.lifecycle.title": "En línea mientras importa, recuperable después",
  "landing.lifecycle.lead":
    "Los agentes producen mucho. Portifact mantiene en línea el trabajo activo y aparta el resto sin perderlo.",
  "landing.lifecycle.timelineLabel":
    "Línea de tiempo. Un artifact está en línea durante 30 días, y cada actualización reinicia esos 30 días. Luego se archiva durante seis meses, en los que puedes restaurarlo. Después se elimina.",
  "landing.lifecycle.timeline.lastUpdate": "Última actualización",
  "landing.lifecycle.timeline.restore": "Restáuralo cuando quieras mientras esté archivado",
  "landing.lifecycle.timeline.end": "7 meses después",
  "landing.lifecycle.timeline.online": "En línea",
  "landing.lifecycle.timeline.onlineDuration": "30 días",
  "landing.lifecycle.timeline.archived": "Archivado",
  "landing.lifecycle.timeline.archivedDuration": "· 6 meses",
  "landing.lifecycle.timeline.deleted": "Eliminado",
  "landing.lifecycle.online.title": "30 días en línea, renovados al actualizar",
  "landing.lifecycle.online.body":
    "Cada versión nueva reinicia el reloj, así que el trabajo en curso nunca desaparece a mitad de una revisión.",
  "landing.lifecycle.archived.title": "Archivado durante seis meses",
  "landing.lifecycle.archived.body":
    "Los artifacts vencidos quedan fuera de línea y dejan de contar como activos, y conservan sus hilos.",
  "landing.lifecycle.restore.title": "Restauración en un paso",
  "landing.lifecycle.restore.body":
    "Recupéralo desde la CLI, tu agente o el panel, en la misma URL.",
  "landing.security.eyebrow": "Seguridad",
  "landing.security.title": "Cada artifact en su propio sandbox",
  "landing.security.lead":
    "Los agentes escriben JavaScript. Portifact asume que cualquier página publicada podría ser hostil y la mantiene lejos de tu cuenta.",
  "landing.security.origin.title": "Un origen independiente por artifact",
  "landing.security.origin.body":
    'El contenido de los usuarios vive en su propio subdominio de <code class="font-mono">portifact.dev</code>. Tu sesión, tus tokens y la API viven en <code class="font-mono">portifact.com</code>.',
  "landing.security.quiet.title": "Discreto por defecto",
  "landing.security.quiet.body":
    "Los buscadores no lo indexan y otros sitios no pueden incrustarlo, a menos que lo permitas.",
  "landing.security.installs.title": "Instalaciones verificadas, disponibles hoy",
  "landing.security.installs.body":
    'El instalador comprueba cada descarga con sumas de verificación SHA-256, y las versiones publicadas incluyen una procedencia de compilación firmada que puedes verificar con <code class="font-mono whitespace-nowrap">gh attestation verify</code>.',
  "landing.security.diagramLabel":
    "Diagrama. A un lado, portifact.com contiene el panel, la API, el servidor MCP, las sesiones y los tokens. Al otro, cada artifact se ejecuta en su propio subdominio de portifact.dev. Un muro entre ambos bloquea las cookies, las credenciales y el acceso a la API.",
  "landing.security.diagram.trusted": "de confianza",
  "landing.security.diagram.dashboard": "Panel",
  "landing.security.diagram.api": "API y MCP",
  "landing.security.diagram.sessions": "Sesiones y tokens",
  "landing.security.diagram.viewer": "Visor de revisión",
  "landing.security.diagram.userContent": "solo contenido de usuarios",
  "landing.security.diagram.noCredentials": "aquí no hay credenciales",
  "landing.useCases.eyebrow": "Casos de uso",
  "landing.useCases.title": "Hecho para lo que crean los agentes",
  "landing.useCases.plans.title": "Planes de implementación",
  "landing.useCases.plans.body":
    "Revisa el plan y señala el paso arriesgado antes de que el agente escriba código.",
  "landing.useCases.reports.title": "Informes de avance",
  "landing.useCases.reports.body":
    "Envía a los interesados un enlace en lugar de una captura de pantalla y mantenlo al día en cada ejecución.",
  "landing.useCases.prototypes.title": "Prototipos",
  "landing.useCases.prototypes.body":
    "Publica un prototipo HTML funcional con su CSS y JavaScript y deja que la gente lo recorra.",
  "landing.useCases.designs.title": "Alternativas de diseño",
  "landing.useCases.designs.body":
    "Pon tres opciones lado a lado, reúne opiniones sobre cada una y deja que el agente construya la ganadora.",
  "landing.install.eyebrow": "Instalación",
  "landing.install.title": "Listo en un minuto",
  "landing.install.lead":
    'Instala la CLI y la skill para agentes y luego inicia sesión con <code class="font-mono text-text">portifact login</code>. También puedes conectar el servidor MCP a tu agente o usar el panel en el navegador.',
  "landing.install.agent.title": "Deja que tu agente lo configure",
  "landing.install.agent.recommended": "Recomendado",
  "landing.install.agent.body":
    "Pega esto en Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot o cualquier agente de programación con terminal. Instala la CLI para tu sistema operativo y le enseña al agente a usar Portifact.",
  "landing.install.agent.promptTitle": "Prompt para tu agente",
  "landing.install.agent.copyPrompt": "Copiar prompt",
  "landing.install.agent.showPrompt": "Lee el prompt antes de pegarlo",
  "landing.install.agent.hidePrompt": "Ocultar el prompt",
  "landing.install.agent.step1": "Detecta tu sistema y tu arquitectura",
  "landing.install.agent.step2": "Instala la CLI y verifica su suma de verificación",
  "landing.install.agent.step3":
    'Lo comprueba con <code class="font-mono">portifact --version</code>',
  "landing.install.agent.step4": "Agrega la skill de Portifact a tu agente",
  "landing.install.agent.note":
    "El prompt le indica a tu agente que se detenga si falla la comprobación de la suma de verificación y que te pregunte antes de cualquier cosa que requiera permisos de administrador.",
  "landing.install.manual.title": "O instálalo tú mismo",
  "landing.install.manual.unix": "macOS y Linux",
  "landing.install.copy": "Copiar",
  "landing.install.manual.skill": "Enséñale a tu agente",
  "landing.install.manual.note":
    "Un solo ejecutable para Linux (glibc y Alpine), macOS y Windows en x64 y arm64. Sin Node, sin Bun, sin runtime que gestionar.",
  "landing.install.mcp.title": "Conecta el servidor MCP",
  "landing.install.mcp.body":
    "Agrega esta dirección de servidor a cualquier cliente MCP que admita servidores remotos con OAuth. Tu cliente abre el navegador para que inicies sesión con tu cuenta de Portifact y elijas qué puede hacer.",
  "landing.install.mcp.address": "Dirección del servidor",
  "landing.install.mcp.note":
    'El primer inicio de sesión solo le permite a tu agente ver tus artifacts; el cliente vuelve a preguntar cuando una herramienta necesita más, como publicar. Los pasos de configuración para Claude.ai, Claude Code y Codex CLI están en la <a href="/mcp-compatibility" class="text-text hover:no-underline">página de compatibilidad con MCP</a>.',
  "landing.install.dashboard.title": "O usa el panel",
  "landing.install.dashboard.body":
    'Inicia sesión en <code class="font-mono text-text">app.portifact.com</code> con Google, GitHub o un código enviado a tu correo. Publica, cambia el acceso, revisa hilos, vuelve a versiones anteriores y restaura artifacts archivados sin terminal.',
  "landing.common.signInToDashboard": "Iniciar sesión en el panel",
  "landing.status.title": "Lo que funciona hoy",
  "landing.status.installer": "Instalador para macOS, Linux y Windows",
  "landing.status.signedReleases": "Versiones firmadas con sumas de verificación",
  "landing.status.skill": "Skill para agentes",
  "landing.status.publish": "Publicación de sitios HTML, Markdown y texto",
  "landing.status.versions": "Versiones, reversión y fuentes privadas",
  "landing.status.access": "Control de acceso",
  "landing.status.archive": "Archivado y restauración",
  "landing.status.annotations": "Anotaciones y revisión",
  "landing.status.mcp":
    '<a href="/mcp-compatibility" class="text-text hover:no-underline">Servidor MCP</a>',
  "landing.status.dashboard": "Panel web",
  "landing.status.accessLogs": "Registros de acceso de tus artifacts",
  "landing.free.eyebrow": "Plan gratuito",
  "landing.free.title": "Espacio para trabajar en serio",
  "landing.free.lead":
    "Los límites que tiene hoy cada cuenta. Pueden ajustarse a medida que Portifact crezca.",
  "landing.free.activeArtifacts": "artifacts activos",
  "landing.free.perArtifact": "por artifact",
  "landing.free.perAccount": "por cuenta",
  "landing.free.publishesPerDay": "publicaciones por día",
  "landing.openSource.eyebrow": "Código abierto",
  "landing.openSource.title": "Construido en abierto",
  "landing.openSource.lead":
    "Portifact se distribuye bajo la licencia GNU AGPL v3.0. Lee el código, sigue el progreso y reporta problemas en GitHub.",
  "landing.openSource.provenance":
    "Versiones firmadas con procedencia de compilación y sumas de verificación SHA-256",
  "landing.openSource.tests": "Pruebas con umbrales de cobertura en cada cambio",
  "landing.openSource.platform": "Funciona sobre Cloudflare Workers, D1 y R2",
  "landing.openSource.viewOnGitHub": "Ver en GitHub",
  "landing.openSource.releases": "Versiones",
  "landing.openSource.securityPolicy": "Política de seguridad",
  "landing.faq.eyebrow": "Preguntas frecuentes",
  "landing.faq.title": "Tus preguntas, respondidas",
  "landing.faq.missing":
    '¿Falta algo? <a href="https://github.com/leynier/portifact/issues" class="text-text">Abre un issue en GitHub</a>.',
  "landing.faq.today.question": "¿Puedo usar Portifact hoy?",
  "landing.faq.today.answer":
    'Sí. La publicación, el control de acceso, las versiones, el archivado y la restauración, las anotaciones con el visor de revisión, el servidor MCP y el panel funcionan hoy. Inicia sesión con <code class="font-mono">portifact login</code>, conecta el servidor MCP o inicia sesión en <a href="https://app.portifact.com/" class="text-text">app.portifact.com</a>. Portifact está en una etapa temprana, así que espera algunas asperezas y límites que pueden cambiar.',
  "landing.faq.agents.question": "¿Con qué agentes funciona?",
  "landing.faq.agents.answer":
    'Cualquier agente de programación con terminal puede ejecutar la CLI. La skill se instala en Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot, OpenCode y otros agentes. El servidor MCP remoto funciona en clientes que admiten inicio de sesión con OAuth y está probado con Claude.ai, Claude Code y Codex CLI; consulta la <a href="/mcp-compatibility" class="text-text">compatibilidad con MCP</a>.',
  "landing.faq.publish.question": "¿Qué puedo publicar?",
  "landing.faq.publish.answer":
    "Contenido estático: sitios HTML con su CSS y JavaScript, Markdown renderizado de forma limpia y texto plano mostrado tal como se escribió. Un solo archivo, una carpeta o un ZIP, con fuentes privadas que solo tú puedes descargar si quieres guardarlas junto al artifact. Portifact no ejecuta compilaciones ni servidores.",
  "landing.faq.audience.question": "¿Quién puede ver lo que publico?",
  "landing.faq.audience.answer":
    "Solo tú, hasta que lo cambies. Puedes abrir un artifact a una lista de direcciones de correo, a cualquier persona con sesión iniciada o al público, y volver a restringirlo en cualquier momento. Publicar una versión nueva nunca amplía la audiencia.",
  "landing.faq.expiry.question": "¿Qué pasa después de 30 días?",
  "landing.faq.expiry.answer":
    "Si no lo actualizaste, el artifact se archiva: queda fuera de línea, pero se conserva durante seis meses y puedes restaurarlo cuando lo necesites. Después de seis meses en el archivo, se elimina. Cada actualización renueva los 30 días.",
  "landing.faq.comments.question":
    "¿Mi agente puede actuar con seguridad sobre los comentarios de los revisores?",
  "landing.faq.comments.answer":
    "Tu agente puede leer y exportar cada hilo como JSON o Markdown. La skill de Portifact le enseña a tratar los comentarios como datos no confiables: los resume para ti y nunca sigue instrucciones escritas dentro de un comentario.",
  "landing.faq.sharedWithMe.question":
    "¿Es seguro abrir un artifact que alguien compartió conmigo?",
  "landing.faq.sharedWithMe.answer":
    "Cada artifact se ejecuta en su propio subdominio de portifact.dev, que no guarda credenciales de ninguna cuenta. Tu sesión y la API viven en portifact.com, así que una página publicada no puede actuar sobre tu cuenta.",
  "landing.cta.title": "Dale un hogar al trabajo de tu agente",
  "landing.cta.lead":
    "Instala la CLI y la skill, conecta el servidor MCP o inicia sesión en el panel.",
  "landing.cta.install": "Instalar Portifact",
  "landing.footer.tagline":
    "Comparte lo que construyó tu agente. Código abierto bajo la GNU AGPL v3.0.",
  "landing.footer.theme": "Tema",
  "landing.footer.theme.system": "Sistema",
  "landing.footer.theme.light": "Claro",
  "landing.footer.theme.dark": "Oscuro",
  "landing.footer.product": "Producto",
  "landing.footer.interfaces": "Tres formas de usarlo",
  "landing.footer.install": "Instalación",
  "landing.footer.faq": "Preguntas frecuentes",
  "landing.footer.project": "Proyecto",
  "landing.footer.releases": "Versiones",
  "landing.footer.security": "Seguridad",
  "landing.footer.license": "Licencia",
  "landing.footer.notices": "Avisos de terceros",
  "landing.footer.legal": "Legal",
  "landing.footer.terms": "Términos del servicio",
  "landing.footer.privacy": "Política de privacidad",
  "landing.footer.acceptableUse": "Política de uso aceptable",
  "landing.footer.report": "Reportar un artifact",
};
