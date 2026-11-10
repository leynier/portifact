// Brazilian Portuguese messages of the landing page (index.html), keyed by its markers in page
// order.
import type { PageMessages } from "../../markers.ts";

export const landing: PageMessages = {
  "landing.meta.title": "Portifact: compartilhe o que seu agente criou",
  "landing.meta.description":
    "Publique HTML, Markdown e texto com um link privado, decida quem pode abrir e receba feedback que seu agente de programação consegue aplicar. Código aberto.",
  "landing.meta.ogDescription":
    "Publique HTML, Markdown e texto com um link privado, decida quem pode abrir e receba feedback que seu agente de programação consegue aplicar.",
  "landing.skipLink": "Pular para o conteúdo",
  "landing.header.homeLabel": "Início do Portifact",
  "landing.header.navLabel": "Principal",
  "landing.nav.product": "Produto",
  "landing.nav.review": "Revisão",
  "landing.nav.access": "Acesso",
  "landing.nav.security": "Segurança",
  "landing.nav.faq": "Dúvidas",
  "landing.header.star": "Estrela no GitHub",
  "landing.header.signIn": "Entrar",
  "landing.header.install": "Instalar",
  "landing.hero.badge": "Versão inicial",
  "landing.hero.statusShort": "Veja o que já funciona",
  "landing.hero.statusLong": "Publicar, compartilhar e revisar já estão disponíveis",
  "landing.hero.spoken":
    "Compartilhe o que seu agente criou. Receba feedback que ele consegue aplicar",
  "landing.hero.titleLead": "Compartilhe o que seu agente criou",
  "landing.hero.phrase1":
    'Receba feedback que ele consegue aplicar<span class="typing-caret"></span>',
  "landing.hero.phrase2": 'Privado por padrão<span class="typing-caret"></span>',
  "landing.hero.phrase3": 'Revise linha por linha<span class="typing-caret"></span>',
  "landing.hero.phrase4": 'Restaure quando quiser<span class="typing-caret"></span>',
  "landing.hero.typed": "Receba feedback que ele consegue aplicar",
  "landing.hero.lead":
    "Publique os planos, relatórios e protótipos que seu agente de programação produz com um link privado, escolha exatamente quem pode abri-los e receba comentários fixados na frase ou no elemento exato. Seu agente lê as conversas e faz as revisões.",
  "landing.hero.signIn": "Entrar",
  "landing.hero.readCode": "Leia o código no GitHub",
  "landing.hero.terminalLabel":
    "Um terminal executa portifact publish em report.html com o nome Billing migration. A CLI lista o arquivo, envia, torna a nova versão a atual e imprime a URL privada em portifact.dev e a data em que ela expira.",
  "landing.hero.screenshotAlt":
    "O visualizador do Portifact mostrando o relatório Billing migration. A barra do Portifact, no topo, tem o nome do artifact, a versão 1 e um botão Comments com uma conversa. No relatório, a frase Writes switch over only after seven days without errors está destacada, e a barra lateral de comentários mostra a pergunta de Ana Lopez sobre ela com a resposta do proprietário.",
  "landing.hero.caption":
    "Publique pelo terminal, revise no navegador. Código aberto sob a AGPL-3.0.",
  "landing.agents.title": "Funciona com os agentes que você já usa",
  "landing.agents.note":
    'A CLI e a skill para agentes funcionam em todos eles. O servidor MCP remoto funciona em clientes com suporte a login por OAuth e foi testado com Claude.ai, Claude Code e Codex CLI. <a href="/mcp-compatibility" class="text-text hover:no-underline">Ver a compatibilidade com MCP</a>',
  "landing.interfaces.eyebrow": "Três formas de usar",
  "landing.interfaces.title": "As mesmas regras, onde quer que você trabalhe",
  "landing.interfaces.lead":
    "A CLI, o servidor MCP remoto e o painel web ficam sobre a mesma camada de domínio. Uma operação passa pelas mesmas verificações de permissão, cotas, estados e erros, não importa onde você a inicie, então seu agente e sua equipe sempre veem a mesma coisa.",
  "landing.interfaces.tabsLabel": "Formas de usar o Portifact",
  "landing.interfaces.tabMcp": 'MCP<span class="hidden sm:inline"> para agentes</span>',
  "landing.interfaces.tabDashboard": "Painel",
  "landing.common.available": "Disponível",
  "landing.interfaces.cli.title": "Para você e seus scripts",
  "landing.interfaces.cli.body":
    'Um único binário autônomo para macOS, Linux e Windows. Publique um arquivo, uma pasta ou um ZIP, compartilhe e traga o feedback de volta, pelo seu shell ou por qualquer agente com terminal. Execute <code class="font-mono text-text">portifact login</code> para entrar.',
  "landing.interfaces.cli.json":
    'Saída <code class="font-mono">--json</code> estável e flags não interativas',
  "landing.interfaces.cli.preview":
    'Mostra a lista de arquivos antes de enviar e ignora segredos, <code class="font-mono">.git</code> e <code class="font-mono">node_modules</code>',
  "landing.interfaces.cli.signIn":
    "Entra com um código de dispositivo e guarda as credenciais no chaveiro do sistema",
  "landing.interfaces.cli.versions":
    "Versões, reversão e fontes privadas que só você pode baixar de volta",
  "landing.interfaces.cli.terminalLabel":
    "Uma sessão de terminal com a saída da CLI: portifact publish lista os três arquivos da pasta prototype, envia e imprime a URL privada e a expiração, portifact access add compartilha com dois endereços de e-mail, e portifact annotations export salva todas as conversas de revisão como Markdown em feedback.md.",
  "landing.interfaces.mcp.title": "Para o seu agente, diretamente",
  "landing.interfaces.mcp.body":
    'Um servidor MCP remoto em <code class="font-mono text-text">https://app.portifact.com/mcp</code>. Adicione-o ao seu cliente e entre com sua conta do Portifact no navegador. Seu agente publica documentos, gerencia versões e lê feedback como ferramentas, sem instalar nada a mais na sua máquina.',
  "landing.interfaces.mcp.tested":
    'Testado com Claude.ai, Claude Code e Codex CLI. <a href="/mcp-compatibility" class="text-text hover:no-underline">Ver a compatibilidade com MCP</a>',
  "landing.interfaces.mcp.inline":
    "Documentos pequenos vão direto; pastas, sites e mudanças de acesso passam pela CLI ou pelo painel",
  "landing.interfaces.mcp.noPrivilegedPath":
    "Sem caminho privilegiado: as mesmas verificações de permissão e cotas que a CLI",
  "landing.interfaces.mcp.untrusted":
    "Os comentários dos revisores chegam ao agente como dados, nunca como instruções",
  "landing.interfaces.mcp.sessionTitle": "sessão do agente",
  "landing.interfaces.mcp.sessionLabel":
    "Uma sessão de agente. Quando pedem para publicar o plano de design da API, o agente chama a ferramenta publish_document do Portifact, que retorna o ID do artifact, a versão 1, a URL privada e a data de expiração, e responde com o link. Quando pedem para ler o feedback, ele chama list_annotations, que retorna as conversas abertas, e resume os dois comentários dos revisores.",
  "landing.interfaces.dashboard.title": "Para toda a equipe",
  "landing.interfaces.dashboard.body":
    'Um painel web em <code class="font-mono text-text">app.portifact.com</code> para publicar, compartilhar, revisar e restaurar sem terminal. <a href="https://app.portifact.com/" class="text-text hover:no-underline">Entrar no painel</a>',
  "landing.interfaces.dashboard.publish":
    "Publique arquivos, uma pasta ou um ZIP pelo navegador, ou edite Markdown e texto ali mesmo",
  "landing.interfaces.dashboard.manage":
    "Altere o acesso, comente no visualizador de revisão, reverta versões e restaure artifacts arquivados",
  "landing.interfaces.dashboard.sessions":
    "Veja suas sessões do navegador e desconecte apps, incluindo a CLI e os clientes MCP",
  "landing.interfaces.dashboard.screenshotAlt":
    "A lista de artifacts do painel do Portifact, com uma caixa de busca e filtros de estado, tipo, acesso e comentários. Quatro artifacts aparecem: API design plan, em Markdown, aberto a usuários com login; Checkout prototype e Billing migration, sites restritos às pessoas com quem foram compartilhados; e Release notes, um texto público. Cada linha mostra o estado, a data de expiração, o tamanho e a atividade recente, como conversas de comentários abertas.",
  "landing.how.eyebrow": "Como funciona",
  "landing.how.title": "Do resultado do agente ao feedback, em um só ciclo",
  "landing.how.lead":
    "Sem arquivos zip, capturas de tela ou paredes de texto coladas. O trabalho fica onde foi feito, e os comentários voltam para o agente que o fez.",
  "landing.how.write.title": "Seu agente escreve",
  "landing.how.write.body":
    "Um plano, um relatório de progresso ou um protótipo chega ao disco como HTML, Markdown ou texto.",
  "landing.how.publish.title": "Publique",
  "landing.how.publish.body":
    "Um comando ou uma chamada de ferramenta retorna uma URL privada na própria origem.",
  "landing.how.share.title": "Compartilhe",
  "landing.how.share.body": "Abra para as pessoas que devem ver, e para mais ninguém.",
  "landing.how.collect.title": "Receba comentários",
  "landing.how.collect.body":
    "Os revisores selecionam uma frase ou um elemento e iniciam uma conversa sobre ele.",
  "landing.how.collect.label": "modo de revisão",
  "landing.how.revise.title": "Seu agente revisa",
  "landing.how.revise.body":
    "Ele exporta as conversas, aplica as mudanças e publica de novo na mesma URL.",
  "landing.how.note":
    "As etapas mostram comandos da CLI, e o painel também faz cada uma delas. Pelo MCP, seu agente publica documentos e lê as conversas; alterar o acesso fica com a CLI e o painel.",
  "landing.access.eyebrow": "Controle de acesso",
  "landing.access.title": "Privado até você decidir o contrário",
  "landing.access.lead":
    "Todo artifact novo começa visível só para você. Amplie o círculo um passo de cada vez e reduza de novo quando quiser.",
  "landing.access.private.name": "Privado",
  "landing.access.private.description": "Só você. O padrão de todo artifact novo.",
  "landing.access.emailList.name": "Lista de e-mails",
  "landing.access.emailList.description":
    "As pessoas que você indicar, depois de confirmarem o endereço.",
  "landing.access.signedIn.name": "Com login",
  "landing.access.signedIn.description": "Qualquer pessoa com uma conta do Portifact.",
  "landing.access.public.name": "Público",
  "landing.access.public.description":
    "Qualquer pessoa com o link. Ainda assim, não é indexado a menos que você permita. Contas novas podem escolher esta opção 15 minutos depois do cadastro.",
  "landing.access.note":
    "Publicar uma nova versão mantém o acesso atual. Uma atualização nunca amplia o público.",
  "landing.access.diagramLabel":
    "Quatro círculos de acesso, um dentro do outro. O mais interno é Privado, só você. Em volta dele, a lista de e-mails, depois todos com login e, por fora, o público.",
  "landing.access.public.hint": "qualquer pessoa com o link",
  "landing.access.signedIn.hint": "qualquer conta",
  "landing.access.emailList.hint": "pessoas que você indicar",
  "landing.access.emailList.add": "+ adicionar",
  "landing.access.private.hint": "Padrão · só você",
  "landing.review.eyebrow": "Revisão e anotações",
  "landing.review.title": "Feedback fixado exatamente no que ele comenta",
  "landing.review.lead":
    "Ative o modo de revisão e os revisores comentam direto no artifact. Seu agente recebe cada conversa com sua âncora, pronta para ser aplicada.",
  "landing.review.screenshotAlt":
    "O visualizador do Portifact no Checkout prototype. Dois destaques de comentários se sobrepõem na frase sobre devoluções grátis e prazos de entrega. O revisor clicou na sobreposição, então a barra lateral de comentários mostra as duas conversas juntas: Marco Rossi pede para mostrar a data de chegada em vez de 3 a 5 dias úteis, com a resposta do proprietário, e Ana Lopez pede para mover a frase para cima do botão.",
  "landing.review.caption": "Comentários sobrepostos em um site de protótipo.",
  "landing.review.terminalLabel":
    "O início da saída de portifact annotations export para as conversas abertas, em Markdown: um aviso de que o texto dos revisores são dados não confiáveis, o artifact, o número de conversas e a primeira conversa com a frase que ela cita e o comentário de Ana Lopez.",
  "landing.review.sentence.title": "Qualquer frase",
  "landing.review.sentence.body":
    "Selecione texto em HTML, Markdown ou texto simples, com o mouse ou o teclado.",
  "landing.review.element.title": "Qualquer elemento",
  "landing.review.element.body":
    "Aponte para um botão, um gráfico ou uma seção de um site e comente.",
  "landing.review.threads.title": "Conversas completas",
  "landing.review.threads.body":
    "Respostas, abertas e resolvidas, ligadas à versão em que foram escritas.",
  "landing.review.export.title": "Exportação para agentes",
  "landing.review.export.body":
    "JSON ou Markdown, lidos como dados, nunca como instruções a seguir.",
  "landing.lifecycle.eyebrow": "Ciclo de vida",
  "landing.lifecycle.title": "No ar enquanto importa, recuperável depois",
  "landing.lifecycle.lead":
    "Os agentes produzem muito. O Portifact mantém o trabalho ativo no ar e tira o resto do caminho sem perdê-lo.",
  "landing.lifecycle.timelineLabel":
    "Linha do tempo. Um artifact fica no ar por 30 dias, e cada atualização reinicia os 30 dias. Depois ele é arquivado por seis meses, durante os quais você pode restaurá-lo. Depois disso, ele é excluído.",
  "landing.lifecycle.timeline.lastUpdate": "Última atualização",
  "landing.lifecycle.timeline.restore": "Restaure quando quiser enquanto estiver arquivado",
  "landing.lifecycle.timeline.end": "7 meses depois",
  "landing.lifecycle.timeline.online": "No ar",
  "landing.lifecycle.timeline.onlineDuration": "30 dias",
  "landing.lifecycle.timeline.archived": "Arquivado",
  "landing.lifecycle.timeline.archivedDuration": "· 6 meses",
  "landing.lifecycle.timeline.deleted": "Excluído",
  "landing.lifecycle.online.title": "30 dias no ar, renovados a cada atualização",
  "landing.lifecycle.online.body":
    "Cada nova versão reinicia o relógio, então o trabalho em andamento nunca some no meio de uma revisão.",
  "landing.lifecycle.archived.title": "Arquivado por seis meses",
  "landing.lifecycle.archived.body":
    "Artifacts expirados saem do ar e deixam de contar como ativos, com as conversas preservadas.",
  "landing.lifecycle.restore.title": "Restaure em um passo",
  "landing.lifecycle.restore.body":
    "Traga de volta pela CLI, pelo seu agente ou pelo painel, na mesma URL.",
  "landing.security.eyebrow": "Segurança",
  "landing.security.title": "Cada artifact na própria sandbox",
  "landing.security.lead":
    "Agentes escrevem JavaScript. O Portifact parte do princípio de que qualquer página publicada pode ser hostil e a mantém longe da sua conta.",
  "landing.security.origin.title": "Uma origem separada por artifact",
  "landing.security.origin.body":
    'O conteúdo dos usuários fica no próprio subdomínio de <code class="font-mono">portifact.dev</code>. Sua sessão, seus tokens e a API ficam em <code class="font-mono">portifact.com</code>.',
  "landing.security.quiet.title": "Discreto por padrão",
  "landing.security.quiet.body":
    "Não é indexado por buscadores nem pode ser incorporado em outros sites, a menos que você permita.",
  "landing.security.installs.title": "Instalações verificadas, disponíveis hoje",
  "landing.security.installs.body":
    'O instalador confere cada download com checksums SHA-256, e as versões trazem uma procedência de build assinada que você pode verificar com <code class="font-mono whitespace-nowrap">gh attestation verify</code>.',
  "landing.security.diagramLabel":
    "Diagrama. De um lado, portifact.com reúne o painel, a API, o servidor MCP, as sessões e os tokens. Do outro, cada artifact roda no próprio subdomínio de portifact.dev. Uma parede entre os dois bloqueia cookies, credenciais e acesso à API.",
  "landing.security.diagram.trusted": "confiável",
  "landing.security.diagram.dashboard": "Painel",
  "landing.security.diagram.api": "API e MCP",
  "landing.security.diagram.sessions": "Sessões e tokens",
  "landing.security.diagram.viewer": "Visualizador de revisão",
  "landing.security.diagram.userContent": "só conteúdo de usuários",
  "landing.security.diagram.noCredentials": "nenhuma credencial aqui",
  "landing.useCases.eyebrow": "Casos de uso",
  "landing.useCases.title": "Feito para o que os agentes criam",
  "landing.useCases.plans.title": "Planos de implementação",
  "landing.useCases.plans.body":
    "Revise o plano e aponte a etapa arriscada antes que o agente escreva qualquer código.",
  "landing.useCases.reports.title": "Relatórios de progresso",
  "landing.useCases.reports.body":
    "Envie um link às partes interessadas em vez de uma captura de tela, e mantenha-o atualizado a cada execução.",
  "landing.useCases.prototypes.title": "Protótipos",
  "landing.useCases.prototypes.body":
    "Publique um protótipo HTML funcional com o CSS e o JavaScript dele e deixe as pessoas navegarem por ele.",
  "landing.useCases.designs.title": "Alternativas de design",
  "landing.useCases.designs.body":
    "Coloque três opções lado a lado, colete opiniões sobre cada uma e deixe o agente construir a vencedora.",
  "landing.install.eyebrow": "Instalação",
  "landing.install.title": "Configure em um minuto",
  "landing.install.lead":
    'Instale a CLI e a skill para agentes e depois entre com <code class="font-mono text-text">portifact login</code>. Você também pode conectar o servidor MCP ao seu agente ou usar o painel no navegador.',
  "landing.install.agent.title": "Deixe seu agente configurar",
  "landing.install.agent.recommended": "Recomendado",
  "landing.install.agent.body":
    "Cole isto no Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot ou qualquer agente de programação com terminal. Ele instala a CLI para o seu sistema operacional e ensina o agente a usar o Portifact.",
  "landing.install.agent.promptTitle": "Prompt para o seu agente",
  "landing.install.agent.copyPrompt": "Copiar prompt",
  "landing.install.agent.showPrompt": "Leia o prompt antes de colar",
  "landing.install.agent.hidePrompt": "Ocultar o prompt",
  "landing.install.agent.step1": "Detecta seu sistema e sua arquitetura",
  "landing.install.agent.step2": "Instala a CLI e verifica o checksum",
  "landing.install.agent.step3": 'Confere com <code class="font-mono">portifact --version</code>',
  "landing.install.agent.step4": "Adiciona a skill do Portifact ao seu agente",
  "landing.install.agent.note":
    "O prompt diz ao seu agente para parar se a verificação do checksum falhar e para perguntar a você antes de qualquer coisa que exija permissões de administrador.",
  "landing.install.manual.title": "Ou instale você mesmo",
  "landing.install.manual.unix": "macOS e Linux",
  "landing.install.copy": "Copiar",
  "landing.install.manual.skill": "Ensine seu agente",
  "landing.install.manual.note":
    "Um executável para Linux (glibc e Alpine), macOS e Windows em x64 e arm64. Sem Node, sem Bun, sem runtime para gerenciar.",
  "landing.install.mcp.title": "Conecte o servidor MCP",
  "landing.install.mcp.body":
    "Adicione este endereço de servidor a qualquer cliente MCP com suporte a servidores remotos com OAuth. Seu cliente abre o navegador para você entrar com sua conta do Portifact e escolher o que ele pode fazer.",
  "landing.install.mcp.address": "Endereço do servidor",
  "landing.install.mcp.note":
    'O primeiro login só deixa seu agente ver seus artifacts; o cliente pede de novo quando uma ferramenta precisa de mais, como publicar. As etapas de configuração para Claude.ai, Claude Code e Codex CLI estão na <a href="/mcp-compatibility" class="text-text hover:no-underline">página de compatibilidade com MCP</a>.',
  "landing.install.dashboard.title": "Ou use o painel",
  "landing.install.dashboard.body":
    'Entre em <code class="font-mono text-text">app.portifact.com</code> com Google, GitHub ou um código enviado para o seu e-mail. Publique, altere o acesso, revise conversas, reverta versões e restaure artifacts arquivados sem terminal.',
  "landing.common.signInToDashboard": "Entrar no painel",
  "landing.status.title": "O que funciona hoje",
  "landing.status.installer": "Instalador para macOS, Linux e Windows",
  "landing.status.signedReleases": "Versões assinadas com checksums",
  "landing.status.skill": "Skill para agentes",
  "landing.status.publish": "Publicação de sites HTML, Markdown e texto",
  "landing.status.versions": "Versões, reversão e fontes privadas",
  "landing.status.access": "Controle de acesso",
  "landing.status.archive": "Arquivamento e restauração",
  "landing.status.annotations": "Anotações e revisão",
  "landing.status.mcp":
    '<a href="/mcp-compatibility" class="text-text hover:no-underline">Servidor MCP</a>',
  "landing.status.dashboard": "Painel web",
  "landing.status.accessLogs": "Registros de acesso dos seus artifacts",
  "landing.free.eyebrow": "Plano gratuito",
  "landing.free.title": "Espaço para trabalho de verdade",
  "landing.free.lead":
    "Os limites que toda conta tem hoje. Eles podem ser ajustados conforme o Portifact cresce.",
  "landing.free.activeArtifacts": "artifacts ativos",
  "landing.free.perArtifact": "por artifact",
  "landing.free.perAccount": "por conta",
  "landing.free.publishesPerDay": "publicações por dia",
  "landing.openSource.eyebrow": "Código aberto",
  "landing.openSource.title": "Construído de forma aberta",
  "landing.openSource.lead":
    "O Portifact é licenciado sob a GNU AGPL v3.0. Leia o código, acompanhe o progresso e relate problemas no GitHub.",
  "landing.openSource.provenance": "Versões assinadas com procedência de build e checksums SHA-256",
  "landing.openSource.tests": "Testes com limites mínimos de cobertura em cada mudança",
  "landing.openSource.platform": "Roda no Cloudflare Workers, D1 e R2",
  "landing.openSource.viewOnGitHub": "Ver no GitHub",
  "landing.openSource.releases": "Versões",
  "landing.openSource.securityPolicy": "Política de segurança",
  "landing.faq.eyebrow": "Perguntas frequentes",
  "landing.faq.title": "Perguntas respondidas",
  "landing.faq.missing":
    'Faltou algo? <a href="https://github.com/leynier/portifact/issues" class="text-text">Abra uma issue no GitHub</a>.',
  "landing.faq.today.question": "Posso usar o Portifact hoje?",
  "landing.faq.today.answer":
    'Sim. Publicação, controle de acesso, versões, arquivamento e restauração, anotações com o visualizador de revisão, o servidor MCP e o painel já funcionam hoje. Entre com <code class="font-mono">portifact login</code>, conecte o servidor MCP ou entre em <a href="https://app.portifact.com/" class="text-text">app.portifact.com</a>. O Portifact está no começo, então espere algumas arestas e limites que podem mudar.',
  "landing.faq.agents.question": "Com quais agentes ele funciona?",
  "landing.faq.agents.answer":
    'Qualquer agente de programação com terminal pode executar a CLI. A skill pode ser instalada no Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot, OpenCode e outros agentes. O servidor MCP remoto funciona em clientes com suporte a login por OAuth e foi testado com Claude.ai, Claude Code e Codex CLI; veja a <a href="/mcp-compatibility" class="text-text">compatibilidade com MCP</a>.',
  "landing.faq.publish.question": "O que posso publicar?",
  "landing.faq.publish.answer":
    "Conteúdo estático: sites HTML com o CSS e o JavaScript deles, Markdown renderizado de forma limpa e texto simples exibido exatamente como foi escrito. Um único arquivo, uma pasta ou um ZIP, com fontes privadas que só você pode baixar, se quiser guardá-las junto. O Portifact não executa builds nem servidores.",
  "landing.faq.audience.question": "Quem pode ver o que eu publico?",
  "landing.faq.audience.answer":
    "Só você, até você mudar isso. Você pode abrir um artifact para uma lista de endereços de e-mail, para qualquer pessoa com login ou para o público, e restringir de novo a qualquer momento. Publicar uma nova versão nunca amplia o público.",
  "landing.faq.expiry.question": "O que acontece depois de 30 dias?",
  "landing.faq.expiry.answer":
    "Se você não o atualizou, o artifact é arquivado: ele sai do ar, mas é mantido por seis meses, e você pode restaurá-lo quando precisar. Depois de seis meses no arquivo, ele é excluído. Cada atualização renova os 30 dias.",
  "landing.faq.comments.question":
    "Meu agente pode agir com segurança sobre os comentários dos revisores?",
  "landing.faq.comments.answer":
    "Seu agente pode ler e exportar cada conversa como JSON ou Markdown. A skill do Portifact o ensina a tratar os comentários como dados não confiáveis: ele os resume para você e nunca segue instruções escritas dentro de um comentário.",
  "landing.faq.sharedWithMe.question": "É seguro abrir um artifact que alguém compartilhou comigo?",
  "landing.faq.sharedWithMe.answer":
    "Cada artifact roda no próprio subdomínio de portifact.dev, que não guarda nenhuma credencial de conta. Sua sessão e a API ficam em portifact.com, então uma página publicada não pode agir na sua conta.",
  "landing.cta.title": "Dê um lar ao trabalho do seu agente",
  "landing.cta.lead": "Instale a CLI e a skill, conecte o servidor MCP ou entre no painel.",
  "landing.cta.install": "Instalar o Portifact",
  "landing.footer.tagline":
    "Compartilhe o que seu agente criou. Código aberto sob a GNU AGPL v3.0.",
  "landing.footer.theme": "Tema",
  "landing.footer.theme.system": "Sistema",
  "landing.footer.theme.light": "Claro",
  "landing.footer.theme.dark": "Escuro",
  "landing.footer.product": "Produto",
  "landing.footer.interfaces": "Três formas de usar",
  "landing.footer.install": "Instalação",
  "landing.footer.faq": "Perguntas frequentes",
  "landing.footer.project": "Projeto",
  "landing.footer.releases": "Versões",
  "landing.footer.security": "Segurança",
  "landing.footer.license": "Licença",
  "landing.footer.notices": "Avisos de terceiros",
  "landing.footer.legal": "Jurídico",
  "landing.footer.terms": "Termos de Serviço",
  "landing.footer.privacy": "Política de Privacidade",
  "landing.footer.acceptableUse": "Política de Uso Aceitável",
  "landing.footer.report": "Denunciar um artifact",
  "landing.nav.plans": "Planos",
  "landing.plans.eyebrow": "Planos",
  "landing.plans.title": "Comece de graça e cresça quando precisar",
  "landing.plans.lead":
    "Todos os planos publicam, compartilham e revisam do mesmo jeito. Os planos pagos aumentam os limites e somam os recursos marcados como incluídos; os marcados como em breve ainda não estão disponíveis.",
  "landing.plans.compare": "Compare os limites",
};
