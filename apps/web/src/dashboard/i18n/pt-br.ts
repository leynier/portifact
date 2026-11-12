// Brazilian Portuguese messages of the dashboard, with "você", with the same keys as en.ts.
// Titles and buttons have no trailing period; no em dashes.
import { planTextPtBR } from "../../plans/i18n/pt-br.ts";
import type { Catalog } from "./en.ts";

export const ptBR = {
  ...planTextPtBR,
  "app.title": "Portifact",
  "app.pageTitle": "{page} · Portifact",
  "shell.skipLink": "Pular para o conteúdo",
  "shell.navigation": "Principal",
  "shell.home": "Painel do Portifact",
  "shell.artifacts": "Artifacts",
  "shell.usageLink": "Uso",
  "shell.appsLink": "Apps",
  "shell.webhooksLink": "Webhooks",
  "shell.settingsLink": "Configurações",
  "shell.profileLink": "Perfil",
  "shell.openNavigation": "Abrir navegação",
  "shell.closeNavigation": "Fechar navegação",
  "shell.collapseSidebar": "Recolher barra lateral",
  "shell.expandSidebar": "Expandir barra lateral",
  "shell.resizeSidebar": "Redimensionar barra lateral",
  "shell.signOut": "Sair",
  "shell.signingOut": "Saindo da sua conta.",
  "shell.signOutFailed": "Não foi possível sair. Tente de novo.",
  "shell.publishLink": "Publicar",
  "shell.dismiss": "Dispensar mensagem",
  "theme.legend": "Tema",
  "theme.system": "Sistema",
  "theme.light": "Claro",
  "theme.dark": "Escuro",
  "copy.done": "Copiado para a área de transferência",
  "copy.failed":
    "O navegador bloqueou a área de transferência. Selecione o texto e copie manualmente.",
  "copy.copied": "Copiado",
  "shell.loadingAccount": "Carregando sua conta",
  "shell.capacity.title": "O Portifact está protegendo sua capacidade",
  "shell.capacity.new_artifacts":
    "A criação de novos artifacts está pausada por enquanto. As atualizações dos seus artifacts continuam funcionando, e seus artifacts continuam no ar.",
  "shell.capacity.publishing":
    "Novos envios estão pausados por enquanto, e novos comentários também podem estar. Seus artifacts continuam no ar, e você ainda pode ler, exportar, excluir, renovar e reduzir o acesso.",

  "language.title": "Idioma",
  "language.hint":
    "O idioma do painel, das páginas de login e dos e-mails que o Portifact envia para você.",
  "language.label": "Idioma",
  "language.description": "Salvo na sua conta, para que seus outros dispositivos também o usem.",
  "language.changed": "O painel agora está em português.",
  "language.loadFailed":
    "Não foi possível carregar o idioma. Verifique sua conexão e tente de novo.",
  "language.saveFailed":
    "O idioma mudou neste navegador, mas sua conta não conseguiu salvá-lo. Tente de novo mais tarde.",

  "list.title": "Artifacts",
  "list.description":
    "Tudo o que você publicou. A lista é atualizada enquanto esta aba estiver aberta.",
  "list.loading": "Carregando seus artifacts",
  "list.caption": "Seus artifacts",
  "list.column.name": "Nome",
  "list.column.state": "Estado",
  "list.column.expires": "Expira",
  "list.column.usage": "Tamanho",
  "list.column.activity": "Atividade",
  "list.column.actions": "Ações rápidas",
  "list.noVersion": "Sem versão",
  "list.versions": "{count, plural, one {# versão mantida} other {# versões mantidas}}",
  "list.updated": "Atualizado {date}",
  "list.openThreads":
    "{count, plural, =0 {Nenhuma conversa aberta} one {# conversa aberta} other {# conversas abertas}}",
  "list.lastComment": "Comentários alterados {date}",
  "list.trafficNote": "O tráfego é contado para a sua conta inteira, não por artifact.",
  "list.trafficLink": "Ver uso",
  "list.loadMore": "Carregar mais",
  "list.loadingMore": "Carregando mais artifacts",
  "list.count": "{count, plural, one {Mostrando # artifact} other {Mostrando # artifacts}}",
  "list.empty.title": "Nenhum artifact ainda",
  "list.empty.body":
    "Publique um arquivo HTML, uma pasta, um ZIP ou um documento com o botão Publicar ou pelo terminal, e ele aparece aqui.",
  "list.error.title": "Não foi possível carregar seus artifacts",
  "list.refreshFailed.title": "Não foi possível atualizar a lista",
  "list.refreshFailed.body":
    "Ela mostra o que foi carregado por último. O Portifact tenta de novo em instantes.",
  "list.never": "Nunca",
  "list.pinned": "Fixado",
  "list.column.access": "Acesso",
  "list.captionFiltered": "Seus artifacts que correspondem à busca e aos filtros",
  "list.countFiltered":
    "{count, plural, one {Mostrando # artifact correspondente} other {Mostrando # artifacts correspondentes}}",
  "list.searching": "Buscando nos seus artifacts",
  "list.noMatch.title": "Nenhum artifact corresponde",
  "list.noMatch.body": "Tente outra busca ou limpe os filtros para ver todos os artifacts.",
  "list.access.public": "Público",
  "list.access.authenticated": "Usuários com login",
  "list.access.restricted": "Restrito",
  "list.annotations.off": "Comentários desativados",
  "list.annotations.open": "Comentários abertos",
  "list.annotations.locked": "Comentários bloqueados",
  "list.filter.label": "Buscar e filtrar artifacts",
  "list.filter.search": "Buscar",
  "list.filter.searchPlaceholder": "Nome ou ID",
  "list.filter.clearSearch": "Limpar a busca",
  "list.filter.searchTooLong": "Busque no máximo {max} caracteres",
  "list.filter.state": "Estado",
  "list.filter.type": "Tipo",
  "list.filter.access": "Acesso",
  "list.filter.annotations": "Comentários",
  "list.filter.expiring": "Expiração",
  "list.expiring.soon": "Expira em até 3 dias",
  "list.filter.any": "Qualquer",
  "list.filter.open": "Filtros",
  "list.filter.activeCount": "ativos",
  "list.filter.sheetTitle": "Filtrar artifacts",
  "list.filter.close": "Fechar os filtros",
  "list.filter.done": "Concluir",
  "list.filter.clear": "Limpar filtros",
  "list.content.toggle": "Pesquisar no conteúdo",
  "list.content.toggleHint": "Encontre palavras no texto dos artifacts ativos, não só nos nomes.",
  "list.content.search": "Pesquisar no conteúdo",
  "list.content.placeholder": "Palavras do texto",
  "list.content.caption": "Artifacts cujo texto corresponde à pesquisa",
  "list.content.column.match": "Correspondência",
  "list.content.file": "Em {path}",
  "list.content.partial": "Indexado em parte: parte do texto era grande demais para pesquisar.",
  "list.content.count":
    "{count, plural, one {Mostrando # artifact cujo texto corresponde} other {Mostrando # artifacts cujo texto corresponde}}",
  "list.content.searching": "Pesquisando dentro dos seus artifacts",
  "list.content.noMatch.title": "Nenhum texto corresponde",
  "list.content.noMatch.body":
    "Todas as palavras precisam aparecer no texto. Artifacts arquivados não são pesquisados.",
  "list.content.error": "A pesquisa falhou",
  "list.open": "Abrir",
  "list.openLabel": "Abrir o {name} publicado",
  "list.review": "Revisar",
  "list.reviewLabel": "Revisar e comentar {name}",
  "list.onboarding.lead":
    "Cada artifact tem seu próprio link, privado para você até você escolher quem mais pode abri-lo. Escolha a forma que combina com o seu jeito de trabalhar.",
  "list.onboarding.browser.title": "Envie pelo navegador",
  "list.onboarding.browser.body":
    "Solte um arquivo HTML, uma pasta, um ZIP ou um documento Markdown.",
  "list.onboarding.browser.action": "Publicar pelo navegador",
  "list.onboarding.cli.title": "Publique pelo terminal",
  "list.onboarding.cli.body":
    "Instale a CLI, entre uma vez e depois publique um arquivo ou uma pasta.",
  "list.onboarding.cli.install": "Instalar a CLI",
  "list.onboarding.cli.publish": "Publicar um arquivo",
  "list.onboarding.cli.copy": "Copiar comando",
  "list.onboarding.mcp.title": "Deixe seu agente publicar",
  "list.onboarding.mcp.body":
    "Adicione o Portifact como servidor MCP remoto no Claude, Codex, Cursor ou qualquer cliente MCP, e depois peça ao seu agente para publicar o que ele criou.",
  "list.onboarding.mcp.url": "URL do servidor MCP",
  "list.onboarding.mcp.copy": "Copiar URL",

  "detail.loading": "Carregando o artifact",
  "detail.back": "Todos os artifacts",
  "detail.notFound.title": "Artifact não encontrado",
  "detail.notFound.body": "Ele não existe, foi excluído ou pertence a outra conta.",
  "detail.error.title": "Não foi possível carregar o artifact",
  "detail.facts": "Detalhes",
  "detail.url": "URL",
  "detail.type": "Tipo",
  "detail.state": "Estado",
  "detail.access": "Acesso",
  "detail.created": "Criado",
  "detail.updated": "Atualizado",
  "detail.expires": "Expira",
  "detail.archived": "Arquivado",
  "detail.purge": "Excluído definitivamente em",
  "detail.notSet": "Não definido",
  "detail.link": "Link",
  "detail.copyLink": "Copiar link",
  "detail.linkCopied": "Link copiado",
  "detail.open": "Abrir",
  "detail.lifecycleHint":
    "Renovar o mantém no ar por mais 30 dias. Artifacts arquivados saem do ar e são excluídos definitivamente depois; restaure-os antes disso.",
  "detail.comments.title": "Comentários",
  "detail.comments.body":
    "Os revisores comentam frases e elementos exatos. Leia, responda e resolva os comentários no visualizador de revisão, onde seu agente também pode lê-los.",
  "detail.comments.unavailable":
    "Os comentários podem ser lidos e adicionados enquanto o artifact estiver ativo.",
  "detail.versions.title": "Versões",
  "detail.versions.body":
    "Cada publicação é uma nova versão. Baixe, compare e reverta versões mantidas no histórico.",
  "detail.actions": "Ações",
  "detail.sectionsNav": "Seções do artifact",
  "sections.title": "Nesta página",
  "detail.section.overview": "Visão geral",
  "detail.section.sharing": "Compartilhamento",
  "detail.section.comments": "Comentários",
  "detail.section.activity": "Atividade",
  "detail.section.danger": "Zona de perigo",
  "detail.danger.body":
    "Arquivar tira o artifact do ar; ele é excluído definitivamente depois, a menos que você o restaure antes disso. Excluir remove o artifact e todas as versões agora, definitivamente.",
  "detail.keepOnline.body": "Renovar o mantém no ar por mais 30 dias.",
  "detail.restore.body":
    "Restaure-o antes que seja excluído definitivamente para colocá-lo de volta no ar.",
  "detail.noActions": "Nenhuma ação está disponível neste estado.",
  "detail.renew": "Renovar por 30 dias",
  "detail.pin": "Fixar",
  "detail.unpin": "Desafixar",
  "detail.pinned.body": "Fixado: fica no ar sem expiração até você desafixar.",
  "detail.pin.paid": "Fixar mantém um artifact no ar sem expiração. Faz parte do plano {plan}.",
  "detail.expiresNever": "Nunca, está fixado",
  "detail.pinnedDone": "Artifact fixado. Fica no ar sem expiração.",
  "detail.unpinnedDone": "Artifact desafixado. Agora expira em {date}.",
  "detail.archive": "Arquivar",
  "detail.restore": "Restaurar",
  "detail.delete": "Excluir",
  "detail.renewed": "Artifact renovado. Agora ele expira em {date}.",
  "detail.archivedDone":
    "Artifact arquivado. Ele será excluído definitivamente em {date}, a menos que você o restaure.",
  "detail.restored": "Artifact restaurado. Ele expira em {date}.",
  "detail.deleted": "Artifact {name} excluído.",
  "detail.working": "Processando.",
  "detail.actionFailed.title": "A ação não foi concluída",
  "detail.confirmDelete.title": "Excluir {name}?",
  "detail.confirmDelete.body":
    "O artifact deixa de ser servido imediatamente e seus arquivos são removidos. Isso não pode ser desfeito.",
  "detail.confirmDelete.confirm": "Excluir artifact",
  "detail.confirmDelete.cancel": "Manter",

  "accessSettings.title": "Acesso",
  "accessSettings.loading": "Carregando quem pode abrir este artifact",
  "accessSettings.loadFailed.title": "Não foi possível carregar as configurações de acesso",
  "accessSettings.republish":
    "Publicar uma nova versão nunca muda estas configurações, então republicar nunca abre um artifact para mais pessoas. Só você pode ampliar o acesso, aqui, pela CLI ou por um agente que você autorizou a compartilhar.",
  "accessSettings.suspended": "Este artifact está suspenso, então seu acesso não pode mudar.",
  "detail.suspended.title": "Suspenso por uma possível violação da Política de Uso Aceitável",
  "detail.suspended.body":
    "O Portifact suspendeu este artifact após uma análise. Ele não é servido para ninguém e não pode ser alterado nem receber publicações. Motivo: {reason}. Se você acha que é um engano, escreva para abuse@portifact.com com o endereço do artifact.",
  "reason.phishing": "phishing ou uma página de login falsa",
  "reason.malware": "malware, exploits ou mineração de criptomoedas",
  "reason.sexual_content": "conteúdo sexualmente explícito",
  "reason.child_safety": "conteúdo que sexualiza menores",
  "reason.copyright": "violação de direitos autorais ou de marca",
  "reason.impersonation": "falsificação de identidade",
  "reason.harassment": "ameaças, assédio ou extremismo violento",
  "reason.private_information": "informações privadas de alguém",
  "reason.spam": "spam",
  "reason.other": "outra violação das regras",
  "accessSettings.mode.legend": "Quem pode abrir este artifact",
  "accessSettings.mode.restricted":
    "Você e os endereços de e-mail listados abaixo. Cada pessoa entra com esse endereço antes de abrir.",
  "accessSettings.mode.authenticated":
    "Qualquer pessoa com o link que entre no Portifact, com qualquer conta.",
  "accessSettings.mode.public": "Qualquer pessoa com o link, sem precisar entrar.",
  "accessSettings.mode.publicSlack":
    "Se este espaço tiver o Slack conectado, um link para ele postado lá mostra seu nome e tipo, e o Slack mantém essa prévia mesmo depois que ele deixar de ser público.",
  "accessSettings.mode.publicFrom":
    "Disponível a partir de {date}. Contas novas esperam {minutes} minutos antes de tornar um artifact público.",
  "accessSettings.indexable.label": "Permitir que buscadores o listem",
  "accessSettings.indexable.hint": "Só vale enquanto o artifact for público.",
  "accessSettings.embeddable.label": "Permitir que outros sites o incorporem",
  "accessSettings.embeddable.hint":
    "Outros sites podem exibi-lo dentro de um frame. Só vale enquanto o artifact for público.",
  "accessSettings.bar.label": "Mostrar a barra do Portifact",
  "accessSettings.bar.hint":
    "Os links abrem no visualizador do Portifact, com a barra no topo e os comentários ao lado do artifact. Desative para apps e páginas que precisam da janela inteira; o link passa a abrir só o artifact.",
  "accessSettings.comments.legend": "Quem vê os comentários",
  "accessSettings.comments.owner": "Só você, e cada pessoa os seus",
  "accessSettings.comments.owner.hint":
    "Cada pessoa vê as conversas que iniciou e as conversas que você iniciou, com todas as respostas. Você vê todas as conversas.",
  "accessSettings.comments.everyone": "Todos que podem abrir o artifact",
  "accessSettings.comments.everyone.hint":
    "Todos que podem abrir o artifact veem todas as conversas e podem responder a elas.",
  "accessSettings.comments.exceptions":
    "Você pode abrir uma exceção para uma pessoa que adicionou, ao lado do endereço dela em Compartilhamento.",
  "accessSettings.comments.confirm.title": "Mostrar todos os comentários para todos?",
  "accessSettings.comments.confirm.body":
    "Os comentários já escritos ficam visíveis para todos que podem abrir o artifact, não só os novos.",
  "accessSettings.comments.confirm.action": "Mostrar todos os comentários",
  "accessSettings.cancel": "Cancelar",
  "accessSettings.save": "Salvar acesso",
  "accessSettings.saved":
    "Acesso salvo. Quem não puder mais abrir o artifact perde o acesso em até um minuto.",
  "accessSettings.unchanged": "Nada para salvar: o acesso já está assim.",
  "accessSettings.saveFailed.title": "O acesso não foi salvo",
  "accessSettings.conflict":
    "O acesso foi alterado em outro lugar enquanto isso. As configurações mais recentes estão sendo exibidas; confira e tente de novo.",
  "accessSettings.tooNew":
    "Contas novas podem tornar um artifact público {minutes} minutos depois de criadas, a partir de {date}.",
  "accessSettings.tooNewNoDate":
    "Contas novas podem tornar um artifact público {minutes} minutos depois de criadas.",
  "accessSettings.readersFull":
    "Um artifact pode listar no máximo {max} pessoas. Remova alguém para adicionar outra.",

  "settings.unsaved": "Alterações não salvas",
  "linkSettings.title": "Configurações do link",
  "linkSettings.description": "Como o link abre, e se buscadores e outros sites podem usá-lo.",
  "linkSettings.save": "Salvar configurações do link",
  "linkSettings.saved": "Configurações do link salvas.",
  "linkSettings.unchanged": "Nada para salvar: o link já está assim.",
  "linkSettings.saveFailed.title": "As configurações do link não foram salvas",
  "commentSettings.title": "Configurações de comentários",
  "commentSettings.mode.legend": "Comentários neste artifact",
  "commentSettings.mode.open": "Abertos",
  "commentSettings.mode.open.hint": "Quem pode abrir o artifact pode comentar e responder.",
  "commentSettings.mode.locked": "Bloqueados",
  "commentSettings.mode.locked.hint":
    "Os comentários continuam legíveis; ninguém pode adicionar novos.",
  "commentSettings.mode.off": "Desativados",
  "commentSettings.mode.off.hint": "Os comentários ficam ocultos e ninguém pode comentar.",
  "commentSettings.save": "Salvar configurações de comentários",
  "commentSettings.saved": "Configurações de comentários salvas.",
  "commentSettings.unchanged": "Nada para salvar: os comentários já estão assim.",
  "commentSettings.saveFailed.title": "As configurações de comentários não foram salvas",

  "readers.title": "Pessoas que você adicionou",
  "readers.hint":
    "Elas podem abrir o artifact enquanto o acesso estiver definido como só você e as pessoas que você adicionar.",
  "readers.count": "{count} de {max} pessoas",
  "readers.empty": "Ninguém ainda. Adicione um endereço de e-mail abaixo.",
  "readers.list": "Pessoas que podem abrir este artifact",
  "readers.email.label": "Endereço de e-mail",
  "readers.email.hint": "A pessoa entra com exatamente este endereço para abrir o artifact.",
  "readers.add": "Adicionar pessoa",
  "readers.added": "{email} adicionado.",
  "readers.remove": "Remover",
  "readers.removeLabel": "Remover {email}",
  "readers.removed": "{email} removido. A pessoa perde o acesso em até um minuto.",
  "readers.invalid": "Digite um endereço de e-mail, como ana@example.com.",
  "readers.duplicate": "{email} já está na lista.",
  "readers.full": "A lista está cheia: um artifact pode ter no máximo {max} pessoas.",
  "readers.failed.title": "A lista não foi alterada",
  "readers.comments.label": "Comentários que {email} vê",
  "readers.comments.inherit.owner": "Padrão: os dela e os seus",
  "readers.comments.inherit.everyone": "Padrão: todos os comentários",
  "readers.comments.all": "Todos os comentários",
  "readers.comments.own": "Só os dela e os seus",
  "readers.comments.hint":
    "O menu ao lado de cada pessoa escolhe quais comentários ela vê. Vale sempre que ela entrar com esse endereço, em qualquer modo de acesso.",
  "readers.comments.changed": "{email} agora vê: {choice}.",
  "readers.comments.confirm.title": "Mostrar todos os comentários para {email}?",
  "readers.comments.confirm.body":
    "{email} verá todas as conversas deste artifact, incluindo comentários já escritos por outras pessoas.",

  "profile.title": "Perfil",
  "profile.description": "Quem você é no Portifact, como você entra e onde sua sessão está aberta.",
  "profile.details": "Sua conta",
  "profile.sectionsNav": "Seções do perfil",
  "account.name": "Nome",
  "account.email": "E-mail",
  "account.memberSince": "Membro desde",
  "account.methods.title": "Formas de login",
  "account.methods.hint":
    "Um login com Google ou GitHub se junta a esta conta automaticamente quando confirma o mesmo endereço de e-mail.",
  "account.methods.loading": "Carregando suas formas de login",
  "account.methods.error": "Não foi possível carregar as formas de login",
  "account.methods.email": "Código por e-mail",
  "account.methods.emailDetail": "Os códigos são enviados para {email}",
  "account.methods.connected": "Conectado em {date}",
  "provider.google": "Google",
  "provider.github": "GitHub",
  "account.sessions.title": "Sessões do navegador",
  "account.sessions.hint":
    "Navegadores com login na sua conta. Artifacts protegidos abertos em um navegador são fechados em até um minuto depois que ele sai da conta.",
  "account.sessions.loading": "Carregando suas sessões do navegador",
  "account.sessions.error": "Não foi possível carregar as sessões do navegador",
  "account.sessions.caption": "Navegadores com login na sua conta",
  "account.sessions.column.browser": "Navegador",
  "account.sessions.column.lastActive": "Última atividade",
  "account.sessions.column.expires": "Encerra em",
  "account.sessions.this": "Este navegador",
  "account.sessions.device": "{browser} no {system}",
  "account.sessions.unknown": "Navegador desconhecido",
  "account.sessions.signOutOthers": "Sair das outras sessões",
  "account.sessions.onlyThis": "Este é o único navegador com login.",
  "account.sessions.confirm.title": "Sair das outras sessões?",
  "account.sessions.confirm.body":
    "Todos os outros navegadores saem da conta imediatamente. Os apps que você conectou, como a CLI e seus agentes, continuam funcionando até você desconectá-los abaixo.",
  "account.sessions.confirm.confirm": "Sair das outras",
  "account.sessions.signedOut":
    "{count, plural, =0 {Nenhum outro navegador estava com login.} one {# outra sessão foi encerrada.} other {# outras sessões foram encerradas.}}",
  "apps.title": "Apps",
  "apps.description":
    "A CLI e os agentes que podem agir por você. Desconecte qualquer um deles quando quiser.",
  "apps.connect.title": "Conectar um app",
  "apps.connect.hint":
    "Cada app pede sua aprovação no navegador na primeira vez e depois aparece aqui.",
  "apps.connect.cli": "Entrar pela CLI",
  "apps.connect.mcp": "URL do servidor MCP para o seu agente",
  "apps.connect.copyCommand": "Copiar comando",
  "apps.connect.copyUrl": "Copiar URL",
  "account.apps.title": "Apps conectados",
  "account.apps.hint":
    "A CLI e os agentes que você conectou por MCP. Cada um pode fazer o que os detalhes listam até você desconectá-lo.",
  "account.apps.loading": "Carregando seus apps conectados",
  "account.apps.error": "Não foi possível carregar os apps conectados",
  "account.apps.empty.title": "Nenhum app conectado",
  "account.apps.empty.body":
    "Execute portifact login em um terminal ou adicione o servidor MCP do Portifact ao seu agente. Cada um pede sua aprovação aqui e aparece nesta lista até você desconectá-lo.",
  "account.apps.unnamed": "App sem nome",
  "account.apps.firstParty": "Feito pelo Portifact",
  "account.apps.thirdParty": "App de terceiros",
  "account.apps.resources": "Conecta-se a",
  "account.apps.connectsTo": "Conecta-se a {resources}",
  "account.apps.access.full": "Acesso total",
  "account.apps.access.readOnly": "Só leitura",
  "account.apps.access.partial":
    "{count, plural, one {# de {total} permissões} other {# de {total} permissões}}",
  "account.apps.lastUsed": "Último uso {when}",
  "account.apps.expiresOn": "O acesso expira {date}",
  "account.apps.details": "Detalhes",
  "account.apps.detailsOf": "Detalhes de {name}",
  "account.apps.resource.api": "API do Portifact",
  "account.apps.resource.mcp": "MCP do Portifact",
  "account.apps.scopes": "Pode",
  "account.apps.approved": "Aprovado em",
  "account.apps.lastIssued": "Último token emitido",
  "account.apps.expires": "O acesso expira",
  "account.apps.noExpiry": "Não expira",
  "account.apps.disconnect": "Desconectar",
  "account.apps.disconnectLabel": "Desconectar {name}",
  "account.apps.confirm.title": "Desconectar {name}?",
  "account.apps.confirm.body":
    "Ele perde o acesso imediatamente e precisa pedir sua aprovação de novo para se reconectar.",
  "account.apps.disconnected": "{name} desconectado.",
  "settings.title": "Configurações",
  "settings.sectionsNav": "Seções das configurações",
  "settings.description":
    "Seu idioma, a aparência do Portifact, como novos artifacts começam, os e-mails que você recebe, seus dados e a exclusão da sua conta.",
  "settings.appearance.title": "Aparência",
  "settings.appearance.hint":
    "A aparência do Portifact neste navegador. Sistema segue a configuração do seu dispositivo. Os artifacts mantêm a aparência que seus criadores deram a eles.",
  "settings.defaults.title": "Padrões para novos artifacts",
  "settings.defaults.hint":
    "Todo artifact que você criar a partir de agora começa assim, seja publicado pelo painel, pela CLI ou por um agente. Os artifacts que você já tem mantêm as próprias configurações; altere-as na página de cada artifact.",
  "settings.defaults.loading": "Carregando suas configurações",
  "settings.defaults.error": "Não foi possível carregar suas configurações",
  "settings.defaults.access": "Quem pode abrir um novo artifact",
  "settings.defaults.access.restricted":
    "Só você, até você adicionar pessoas. Esta é a opção mais segura.",
  "settings.defaults.comments": "Comentários em um novo artifact",
  "settings.defaults.comments.off": "Desativados",
  "settings.defaults.comments.off.hint": "Ninguém pode comentar até você ativar os comentários.",
  "settings.defaults.comments.open": "Abertos",
  "settings.defaults.comments.open.hint": "Todos que podem abrir o artifact podem comentar.",
  "settings.defaults.bar.label": "Mostrar a barra do Portifact em novos artifacts",
  "settings.defaults.save": "Salvar padrões",
  "settings.defaults.saved": "Padrões salvos. Novos artifacts começam assim.",
  "settings.defaults.unchanged": "Nada para salvar: seus padrões já estão assim.",
  "settings.defaults.failed": "Seus padrões não foram salvos",
  "settings.notices.title": "Avisos por e-mail",
  "settings.notices.hint":
    "Os artifacts deixam de ser servidos 30 dias depois da última vez que você os publica ou renova. O Portifact pode lembrar você alguns dias antes.",
  "settings.notices.expiry.label": "Enviar um e-mail antes que meus artifacts expirem",
  "settings.notices.expiry.hint":
    "No máximo um e-mail por dia, listando todos os artifacts que expiram em até 3 dias, com um link para renovar cada um.",
  "settings.notices.save": "Salvar avisos por e-mail",
  "settings.notices.saved": "Avisos por e-mail salvos.",
  "settings.notices.unchanged": "Nada para salvar: seus avisos por e-mail já estão assim.",
  "settings.notices.failed": "Seus avisos por e-mail não foram salvos",
  "settings.notices.comments.label": "Enviar um e-mail quando houver novos comentários ou revisões",
  "settings.notices.comments.hint":
    "No máximo um e-mail a cada 10 minutos, com quantas conversas, respostas e resoluções são novas em cada artifact, nunca o que foi escrito. Só em artifacts cujo proprietário tem um plano com avisos de comentários. A mesma opção cobre os e-mails de revisão: quando alguém pede sua revisão e quando uma versão que você gerencia é aprovada ou recebe pedidos de mudança.",
  "commentNotices.label": "Enviar um e-mail quando houver novos comentários neste artifact",
  "commentNotices.hint":
    "No máximo um e-mail a cada 10 minutos, só com contagens. Desative todos os e-mails de comentários nas suas configurações.",
  "commentNotices.muted": "E-mails de comentários desativados para este artifact.",
  "commentNotices.unmuted": "E-mails de comentários ativados para este artifact.",
  "commentNotices.failed": "Sua escolha não foi salva",
  "commentNotices.planRequired":
    "Avisos por e-mail de novos comentários fazem parte do plano {plan}.",
  "settings.danger.title": "Zona de perigo",
  "settings.danger.hint": "Estas ações não podem ser desfeitas.",
  "account.data.title": "Seus dados",
  "account.data.hint":
    "Baixe tudo o que sua conta guarda em JSON: seu perfil, os artifacts com o acesso, as versões e as listas de arquivos, e os comentários. Cada versão lista um link que baixa os arquivos dela.",
  "account.data.download": "Baixar os dados da sua conta (JSON)",
  "account.data.spacePersonal":
    "Para levar o que seu espaço pessoal guarda (as versões mantidas e as fontes de cada artefato, os registros de acesso, os dados de cada artefato e do espaço e o registro de auditoria), use a página de download do espaço.",
  "account.data.spaceWorkspace":
    "Para levar o que o espaço de trabalho {workspace} guarda (as versões mantidas e as fontes de cada artefato, os registros de acesso, os dados de cada artefato e do espaço e o registro de auditoria), use a página de download do espaço.",
  "account.data.spaceLink": "Baixar os dados deste espaço",
  "account.delete.title": "Excluir conta",
  "account.delete.hint":
    'Excluir sua conta remove seus artifacts, sessões, apps e formas de login, e seus comentários em artifacts de outras pessoas. Um comentário que alguém respondeu vira uma marca de "Mensagem excluída". Os endereços dos artifacts nunca são dados a outra pessoa. Isso não pode ser desfeito, então baixe seus dados primeiro.',
  "account.delete.confirmLabel": "Digite seu e-mail para confirmar",
  "account.delete.confirmHint": "Digite {email}",
  "account.delete.mismatch": "Digite exatamente o e-mail da sua conta para confirmar.",
  "account.delete.button": "Excluir conta",
  "account.delete.dialog.title": "Excluir sua conta definitivamente?",
  "account.delete.dialog.body":
    "Seus artifacts param de funcionar na hora e tudo o que está listado acima é excluído. Você vai sair da conta.",
  "account.delete.dialog.confirm": "Excluir minha conta",
  "account.delete.reauth.title": "Entre de novo para excluir sua conta",
  "account.delete.reauth.body":
    "Para sua segurança, a exclusão exige um login feito nos últimos 10 minutos. Entre de novo e depois volte aqui.",
  "account.delete.reauth.action": "Entrar de novo",
  "account.delete.done": "Sua conta foi excluída.",
  "account.actionFailed.title": "A ação não foi concluída",
  "accessLog.title": "Quem abriu",
  "accessLog.hint":
    "Visitantes com login que abriram este artifact nos últimos {days, plural, one {# dia} other {# dias}}, do mais recente ao mais antigo, uma entrada por visitante a cada 30 minutos. Só você vê esta lista. Só os artifacts restritos às pessoas que você lista registram aberturas, suas próprias visitas não são registradas, e algumas aberturas podem faltar.",
  "accessLog.loading": "Carregando quem abriu o artifact",
  "accessLog.error.title": "Não foi possível carregar o registro de acesso",
  "accessLog.empty.title": "Nenhum visitante ainda",
  "accessLog.empty.body":
    "Ninguém com login abriu este artifact nos últimos {days, plural, one {# dia} other {# dias}}.",
  "accessLog.caption": "Aberturas deste artifact por visitantes com login",
  "accessLog.column.opened": "Aberto",
  "accessLog.column.visitor": "Visitante",
  "accessLog.loadMore": "Mostrar mais",
  "accessLog.export.hint":
    "As exportações incluem todas as entradas dos últimos {days, plural, one {# dia} other {# dias}}, não só as exibidas.",
  "accessLog.export.csv": "Exportar como CSV",
  "accessLog.export.json": "Exportar como JSON",
  "accessLog.export.doneCsv": "O registro de acesso foi exportado como CSV.",
  "accessLog.export.doneJson": "O registro de acesso foi exportado como JSON.",
  "accessLog.export.failed": "Não foi possível exportar o registro de acesso",

  "analytics.title": "Estatísticas",
  "analytics.hint":
    "Visualizações de página por dia (UTC) e, nos artifacts restritos às pessoas que você lista, quantas delas o abriram. Apenas contagens: ninguém é identificado aqui.",
  "analytics.loading": "Carregando as estatísticas do artifact",
  "analytics.error.title": "Não foi possível carregar as estatísticas",
  "analytics.planRequired":
    "Estatísticas por artifact e um registro de acessos de um ano fazem parte do plano {plan}.",
  "analytics.range.label": "Período",
  "analytics.range.days": "Últimos {count, plural, one {# dia} other {# dias}}",
  "analytics.total.views": "Visualizações",
  "analytics.total.signedIn": "Visualizações de visitantes com login",
  "analytics.total.visitors": "Visitantes distintos com login",
  "analytics.visitors.notKept": "Contados só em artifacts restritos às pessoas que você lista",
  "analytics.chart.label": "Visualizações por dia",
  "analytics.chart.summary":
    "Visualizações: {views} em {days, plural, one {# dia} other {# dias}}. Dia com mais visualizações: {busiest}, com {most}.",
  "analytics.chart.summaryEmpty":
    "Nenhuma visualização nos últimos {days, plural, one {# dia} other {# dias}}.",
  "analytics.chart.day": "{day}. Visualizações: {views}. Com login: {signedIn}.",
  "analytics.chart.dayWithVisitors":
    "{day}. Visualizações: {views}. Com login: {signedIn}. Visitantes distintos: {visitors}.",
  "analytics.chart.keyboard": "Coloque o foco no gráfico e use as setas para ler cada dia.",
  "analytics.table.show": "Mostrar os números em uma tabela",
  "analytics.table.caption": "Visualizações por dia deste artifact",
  "analytics.column.day": "Dia",
  "analytics.column.views": "Visualizações",
  "analytics.column.signedIn": "Com login",
  "analytics.column.visitors": "Visitantes distintos",
  "analytics.note":
    "Guardadas por {days, plural, one {# dia} other {# dias}}. Suas próprias visitas e as prévias de links não são contadas, mas navegadores automatizados podem ser, então estes números são um indicador, não uma auditoria.",

  "usage.title": "Uso",
  "usage.description":
    "Suas cotas e o que seus artifacts serviram neste mês. O tráfego é contado a cada poucos segundos, então pode ficar um pouco atrasado.",
  "usage.meterPercent": "{used} de {limit} ({percent})",
  "usage.plan.section": "Plano",
  "usage.plan.hint": "Seu plano define os limites desta página.",
  "usage.plan.name": "Plano atual",
  "usage.plan.free": "Free",
  "usage.plan.pro": "Pro",
  "usage.plan.team": "Team",
  "usage.plan.enterprise": "Enterprise",
  "usage.plan.seats": "Assentos",
  "usage.plan.until": "Válido até",
  "usage.traffic.section": "Tráfego deste mês",
  "usage.traffic.hint":
    "Contado para a sua conta inteira, somando todos os seus artifacts. Atingir qualquer um dos limites pausa todos os artifacts até a renovação.",
  "usage.trafficRequests.hint": "Cada página, arquivo e download que seus artifacts responderam.",
  "usage.trafficBytes.hint": "O tamanho de tudo o que seus artifacts enviaram aos visitantes.",
  "usage.storage.section": "Artifacts e armazenamento",
  "usage.activeArtifacts.hint":
    "Artifacts que estão no ar agora. Artifacts arquivados e excluídos não contam.",
  "usage.storage.hint":
    "Arquivos únicos que você mantém em todas as versões, contados uma vez. Envios em andamento contam enquanto acontecem.",
  "usage.publishing.section": "Publicação",
  "usage.publishing.hint":
    "Limites de quão rápido você pode publicar. As janelas de 24 horas são móveis, então liberam aos poucos.",
  "usage.publishes.hint": "Versões que você publicou ou para as quais reverteu.",
  "usage.newFiles": "Arquivos novos, últimas 24 horas",
  "usage.newFiles.hint":
    "Arquivos que você ainda não tinha enviado; arquivos que você já mantém não contam.",
  "usage.newBytes": "Dados novos, últimas 24 horas",
  "usage.newBytes.hint": "O tamanho desses arquivos novos.",
  "usage.newObjects": "Arquivos novos neste mês",
  "usage.newObjects.hint": "Renova em {date}.",
  "usage.openUploads": "Envios em andamento",
  "usage.openUploads.hint": "Publicações iniciadas, mas ainda não concluídas.",
  "usage.versions.section": "Limites de cada versão",
  "usage.versions.hint": "Os mesmos para todos os artifacts.",
  "usage.versions.publishedBytes": "Tamanho publicado",
  "usage.versions.files": "Arquivos",
  "usage.versions.documentBytes": "Documento Markdown ou de texto",
  "usage.public.title": "Artifacts públicos em breve",
  "usage.public.body":
    "Contas novas podem tornar um artifact público {minutes} minutos depois de criadas. Você pode a partir de {date}.",
  "usage.loading": "Carregando seu uso",
  "usage.error": "Não foi possível carregar o uso",
  "usage.meter": "{used} de {limit}",
  "usage.activeArtifacts": "Artifacts ativos",
  "usage.storage": "Armazenamento",
  "usage.publishes": "Publicações, últimas 24 horas",
  "usage.trafficRequests": "Requisições servidas neste mês",
  "usage.trafficBytes": "Dados servidos neste mês",
  "usage.trafficResets": "O tráfego renova em",
  "usage.blocks": "Bloqueado agora",
  "usage.lifts": "{message} Liberado em {date}.",
  "usage.traffic.title": "Seus artifacts usaram o tráfego deste mês",
  "usage.traffic.body":
    "Seus artifacts serviram 1 milhão de requisições ou 25 GB neste mês, então os visitantes recebem um erro (HTTP 429) em todos eles até {date}. Suas outras cotas não são afetadas: você ainda pode publicar, alterar o acesso e gerenciar seus artifacts. Os artifacts de outras pessoas continuam funcionando.",
  "usage.traffic.link": "Ver seu uso",
  "usage.nearLimit": "Perto do limite",
  "usage.atLimit": "Limite atingido",
  "account.cancel": "Cancelar",

  "scope.artifacts:read": "Ver seus artifacts, as configurações e as versões deles",
  "scope.artifacts:write": "Publicar e atualizar artifacts",
  "scope.artifacts:share": "Alterar quem pode abrir seus artifacts",
  "scope.artifacts:delete": "Arquivar e excluir seus artifacts",
  "scope.annotations:read": "Ler comentários nos seus artifacts",
  "scope.annotations:write": "Escrever e responder comentários em seu nome",
  "scope.annotations:moderate": "Resolver, ocultar e excluir comentários nos seus artifacts",
  "scope.credentials:manage": "Ver os apps conectados à sua conta e desconectá-los",
  "scope.offline_access": "Continuar conectado até você desconectá-lo",
  "scope.unknown": "Usar a permissão {name}",

  "list.publish": "Publicar",

  "content.title": "Conteúdo",
  "content.publishVersion": "Publicar uma nova versão",
  "content.edit": "Editar documento",
  "content.history": "Histórico de versões",

  "publish.title": "Publicar",
  "publish.description":
    "Envie um arquivo HTML, uma pasta, um ZIP ou um documento. Nada é enviado até você revisar.",
  "publish.versionTitle": "Nova versão de {name}",
  "publish.versionDescription":
    "Os arquivos que você escolher substituem a versão atual. Os visitantes continuam vendo a atual até a nova ser publicada.",
  "publish.loading": "Carregando o artifact",
  "publish.unavailable":
    "Este artifact não pode receber uma nova versão no estado atual. Restaure-o primeiro se ele estiver arquivado.",
  "publish.step.choose": "Escolha o que publicar",
  "publish.steps.label": "Etapas da publicação",
  "publish.steps.choose": "Escolher",
  "publish.steps.review": "Revisar",
  "publish.steps.publish": "Publicar",
  "steps.done": "concluída",
  "steps.upcoming": "não iniciada",
  "publish.drop.site": "Arraste arquivos, uma pasta ou um ZIP para cá, ou escolha-os",
  "publish.drop.document": "Arraste um documento para cá, ou escolha-o",
  "publish.drop.active": "Solte para escolher estes arquivos",
  "publish.done.review": "Revisar e comentar",
  "publish.type.legend": "Tipo",
  "publish.type.site": "Um arquivo HTML, uma pasta de arquivos estáticos ou um ZIP de uma.",
  "publish.type.markdown": "Um documento Markdown, renderizado pelo Portifact.",
  "publish.type.text": "Um documento de texto simples, exibido exatamente como foi escrito.",
  "publish.name.label": "Nome",
  "publish.name.hint":
    "Exibido na sua lista e como título da página. Por padrão, o nome do arquivo ou da pasta.",
  "publish.entry.label": "Página de entrada",
  "publish.entry.hint":
    "A página que os visitantes abrem primeiro. Um único arquivo HTML sempre se torna esta página.",
  "publish.pick.files": "Escolher arquivos",
  "publish.pick.filesHint": "Uma página HTML, ou vários arquivos publicados lado a lado.",
  "publish.pick.folder": "Escolher uma pasta",
  "publish.pick.folderHint": "Todos os arquivos dela, mantendo a estrutura.",
  "publish.pick.zip": "Escolher um arquivo ZIP",
  "publish.pick.zipHint":
    "Um ZIP do seu site. Use quando seu navegador não conseguir escolher pastas.",
  "publish.pick.zipOnly":
    "Este navegador não consegue escolher pastas. Coloque a pasta em um arquivo ZIP e escolha-o.",
  "publish.pick.document": "Escolher um arquivo",
  "publish.pick.documentHint": "Um arquivo de texto UTF-8 de até 5 MB.",
  "publish.text.label": "Ou escreva aqui",
  "publish.text.hint": "Cole ou digite o documento. Ele é publicado como {file}.",
  "publish.text.use": "Revisar este texto",
  "publish.text.required": "Escreva ou cole o documento primeiro.",
  "publish.untitled": "Sem título",
  "publish.building": "Lendo e verificando os arquivos",
  "publish.buildingProgress": "{done} de {total}",
  "publish.cancel": "Cancelar",
  "publish.buildCancelled": "A leitura dos arquivos foi interrompida. Nada foi enviado.",
  "publish.buildFailed.title": "Estes arquivos não podem ser publicados",
  "publish.step.review": "Revise antes de publicar",
  "publish.review.summary": "Resumo",
  "publish.review.files": "Arquivos",
  "publish.review.filesValue": "{count, plural, one {# arquivo} other {# arquivos}}, {size}",
  "publish.review.entry": "Página de entrada",
  "publish.review.access": "Quem pode abrir",
  "publish.review.accessNew":
    "Só você. Depois de publicar, você pode compartilhá-lo na página do artifact.",
  "publish.review.accessVersion": "{mode}. Publicar uma nova versão nunca muda quem pode abri-lo.",
  "publish.review.caption": "Arquivos a publicar",
  "publish.review.column.path": "Caminho",
  "publish.review.column.size": "Tamanho",
  "publish.review.column.type": "Tipo de conteúdo",
  "publish.review.excluded":
    "{count, plural, one {# item deixado de fora} other {# itens deixados de fora}}",
  "publish.review.excludedHint":
    "Estes nunca são publicados, assim como na CLI. Remova-os da origem se achar que algum deveria ser.",
  "publish.reason.default": "controle de versão, dependências ou caches",
  "publish.reason.secret": "pode conter segredos",
  "publish.review.publish": "Publicar",
  "publish.review.back": "Escolher outros arquivos",
  "publish.phase.preparing": "Preparando o envio",
  "publish.phase.uploading": "Enviando",
  "publish.phase.committing": "Verificando os arquivos e publicando",
  "publish.uploadProgress": "{sent} de {total}, {done} de {count} arquivos",
  "publish.uploadStarted":
    "{count, plural, =0 {Todos os arquivos já estão armazenados. Publicando.} one {Enviando # arquivo novo.} other {Enviando # arquivos novos.}}",
  "publish.uploadCancelled": "Envio cancelado. Nada foi publicado.",
  "publish.failed.title": "A publicação não foi concluída",
  "publish.resume": "Retomar envio",
  "publish.startOver": "Recomeçar",
  "publish.done.title": "Versão {number} publicada",
  "publish.done.body": "Está no ar em {url} e expira em {date}.",
  "publish.done.pinned": "Está no ar em {url}. Está fixado, então não expira.",
  "publish.done.open": "Abrir a página do artifact",
  "publish.done.another": "Publicar outra coisa",
  "publish.announce.done": "Versão {number} de {name} publicada.",

  "manifest.empty":
    "Não há nada para publicar: todos os arquivos foram deixados de fora ou a origem está vazia.",
  "manifest.too_many_files": "Uma versão pode ter no máximo {detail} arquivos.",
  "manifest.too_large": "Uma versão pode ter no máximo {detail}.",
  "manifest.invalid_path": "Um caminho de arquivo não é permitido: {detail}",
  "manifest.missing_entry":
    "A página de entrada {detail} não está entre os arquivos. Altere a página de entrada ou adicione-a.",
  "manifest.document_files": "Um documento é um único arquivo. Escolha um arquivo.",
  "manifest.document_too_large": "Os documentos são limitados a 5 MB.",
  "manifest.not_text":
    "Este não é um arquivo de texto UTF-8, então não pode ser publicado como documento.",
  "manifest.not_zip": "Este não é um arquivo ZIP, ou ele está danificado.",
  "manifest.unsupported":
    "Este ZIP usa um formato que o Portifact não lê (ZIP64, arquivos divididos ou compressão incomum). Crie-o de novo com as configurações padrão.",
  "manifest.encrypted": "{detail} está criptografado. Use um ZIP sem senha.",
  "manifest.symlink":
    "{detail} é um link simbólico. Links simbólicos não são publicados; substitua-o pelo próprio arquivo.",
  "manifest.special_file": "{detail} não é um arquivo comum.",
  "manifest.corrupt":
    "O ZIP está danificado: {detail} não se expande para o que o arquivo declara.",
  "manifest.unexpected": "Não foi possível ler os arquivos. Tente de novo.",

  "upload.integrity":
    "{path} não chegou intacto: o armazenamento o recusou pelo tamanho ou pelo checksum. Recomece para ler os arquivos de novo.",
  "upload.storage": "O armazenamento recusou {path}. Retome o envio para tentar de novo.",
  "upload.network":
    "Não foi possível acessar o armazenamento. Verifique sua conexão e depois retome o envio.",
  "upload.missing": "O envio pede um arquivo que esta página não tem. Recomece.",
  "publish.error.quota_exceeded":
    "Isto não cabe nos limites da sua conta: artifacts ativos, armazenamento, arquivos ou publicações por dia. Arquive ou exclua algo, ou tente de novo mais tarde.",
  "publish.error.version_conflict":
    "Uma versão mais recente foi publicada enquanto isso. Recomece para que suas alterações partam dela.",
  "publish.error.upload_incomplete":
    "Nem todos os arquivos chegaram intactos ao armazenamento. Retome o envio para mandar o que falta.",
  "publish.error.invalid_input":
    "O Portifact recusou estes arquivos. Verifique os caminhos, os tamanhos e o tipo, e depois recomece.",

  "editor.title": "Editar {name}",
  "editor.description":
    "Salvar publica uma nova versão. Os visitantes continuam vendo a atual até lá.",
  "editor.loading": "Carregando o documento",
  "editor.loadFailed.title": "Não foi possível carregar o documento",
  "editor.notDocument":
    "Só artifacts Markdown e de texto podem ser editados aqui. Publique uma nova versão em vez disso.",
  "editor.unavailable":
    "Este artifact não pode receber uma nova versão no estado atual. Restaure-o primeiro se ele estiver arquivado.",
  "editor.source.markdown": "Markdown",
  "editor.source.text": "Texto",
  "editor.source.hint": "{path}, até 5 MB.",
  "editor.preview": "Pré-visualizar",
  "editor.previewTitle": "Pré-visualização de {name}",
  "editor.previewHeading": "Pré-visualização",
  "editor.previewHint":
    "Renderizado pelo Portifact exatamente como será publicado. Links e imagens dentro dele não abrem aqui.",
  "editor.previewEmpty": "Escolha Pré-visualizar para ver o documento renderizado.",
  "editor.previewStale": "O texto mudou desde esta pré-visualização.",
  "editor.previewFailed.title": "Não foi possível renderizar a pré-visualização",
  "editor.save": "Salvar e publicar",
  "editor.unchanged": "Nada para salvar: o documento não mudou.",
  "editor.saving": "Publicando uma nova versão.",
  "editor.saved": "Salvo como versão {number}.",
  "editor.saveFailed.title": "O documento não foi salvo",
  "editor.reload": "Carregar a versão mais recente",
  "editor.tooLarge": "Os documentos são limitados a 5 MB.",

  "history.title": "Histórico de {name}",
  "history.versionsTitle": "Versões mantidas",
  "history.description": "As versões que você ainda pode baixar ou restaurar.",
  "history.retention":
    "O plano do proprietário mantém {count, plural, one {# versão anterior} other {# versões anteriores}} por {days, plural, one {# dia} other {# dias}} depois que cada uma é substituída.",
  "compare.title": "Comparar versões",
  "compare.description": "Escolha duas versões para ver quais arquivos mudaram e como.",
  "compare.paid":
    "Comparar versões e manter mais versões por mais tempo fazem parte do plano {plan}.",
  "compare.needTwo": "Publique outra versão para compará-la com esta.",
  "compare.from": "Versão anterior",
  "compare.to": "Versão posterior",
  "compare.currentOption": "Versão {number} (atual)",
  "compare.submit": "Comparar",
  "compare.loading": "Comparando versões",
  "compare.error.title": "Não foi possível comparar as versões",
  "compare.summary":
    "Versão {from} comparada com a versão {to}. Adicionados: {added}. Removidos: {removed}. Alterados: {changed}. Sem alterações: {unchanged}.",
  "compare.none": "As duas versões têm os mesmos arquivos.",
  "compare.caption": "Arquivos que diferem entre a versão {from} e a versão {to}",
  "compare.column.file": "Arquivo",
  "compare.column.change": "Alteração",
  "compare.column.size": "Tamanho",
  "compare.change.added": "Adicionado",
  "compare.change.removed": "Removido",
  "compare.change.changed": "Alterado",
  "compare.source": "Fonte",
  "compare.sizes": "{before} antes, {after} depois",
  "compare.noFile": "nenhum",
  "compare.show": "Ver alterações",
  "compare.showLabel": "Ver as alterações de {path}",
  "compare.loadMore": "Ver mais arquivos",
  "diff.title": "Alterações em {path}",
  "diff.close": "Ocultar alterações",
  "diff.loading": "Carregando as alterações",
  "diff.counts": "Linhas adicionadas: {added}. Linhas removidas: {removed}.",
  "diff.layout": "Layout",
  "diff.unified": "Unificado",
  "diff.split": "Lado a lado",
  "diff.caption": "Alterações em {path} da versão {from} para a versão {to}",
  "diff.column.before": "Antes",
  "diff.column.after": "Depois",
  "diff.column.change": "Alteração",
  "diff.column.text": "Texto",
  "diff.added": "Adicionada",
  "diff.removed": "Removida",
  "diff.unchanged": "Sem alterações",
  "diff.noNewline": "sem quebra de linha no final",
  "diff.hunk": "A partir da linha {before} antes e da linha {after} depois",
  "diff.more": "Ver mais alterações",
  "diff.status.identical": "Este arquivo é igual nas duas versões.",
  "diff.status.binary": "Este arquivo não é texto, então só o tamanho é comparado.",
  "diff.status.too_large": "Este arquivo é grande demais para comparar linha por linha.",
  "diff.status.too_many_lines": "Este arquivo tem linhas demais para comparar linha por linha.",
  "diff.status.too_many_changes": "Este arquivo mudou demais para mostrar linha por linha.",
  "history.loading": "Carregando versões",
  "history.error.title": "Não foi possível carregar as versões",
  "history.caption": "Versões, da mais recente à mais antiga",
  "history.column.version": "Versão",
  "history.column.published": "Publicada",
  "history.column.files": "Arquivos",
  "history.column.kept": "Mantida até",
  "history.column.actions": "Ações",
  "history.version": "Versão {number}",
  "history.current": "Atual",
  "history.whileCurrent": "Enquanto for a atual",
  "history.files": "{count, plural, one {# arquivo} other {# arquivos}}, {size}",
  "history.sources": "{count, plural, one {# fonte} other {# fontes}}, {size}",
  "history.empty.title": "Nenhuma versão ainda",
  "history.empty.body": "Publique a primeira versão e ela aparece aqui.",
  "history.loadMore": "Carregar versões mais antigas",
  "history.download": "Baixar arquivos",
  "history.downloadLabel": "Baixar os arquivos da versão {number}",
  "history.downloadSources": "Baixar fontes",
  "history.downloadSourcesLabel": "Baixar as fontes da versão {number}",
  "history.downloading": "Baixando e verificando os arquivos.",
  "history.downloaded": "{file} está pronto.",
  "history.downloadFailed.title": "O download não foi concluído",
  "download.integrity": "{path} não corresponde ao checksum, então não foi salvo. Tente de novo.",
  "download.network": "Não foi possível baixar {path}. Tente de novo.",
  "history.rollback": "Reverter",
  "history.rollbackLabel": "Reverter para a versão {number}",
  "history.rollbackUnavailable": "A reversão está disponível enquanto o artifact estiver ativo.",
  "history.confirmRollback.title": "Reverter para a versão {number}?",
  "history.confirmRollback.body":
    "Os arquivos dela são publicados de novo como uma nova versão, e o prazo de 30 dias recomeça. Quem pode abrir o artifact não muda.",
  "history.confirmRollback.confirm": "Reverter",
  "history.rolledBack": "A versão {from} foi publicada de novo como versão {number}.",
  "history.actionFailed.title": "A ação não foi concluída",
  "history.archive.title": "Arquivado",
  "history.archive.body":
    "Este artifact está arquivado e ninguém pode abri-lo. Ele será excluído definitivamente em {date}, a menos que você o restaure. Você ainda pode baixar as versões dele.",
  "history.archive.noDate":
    "Ele é excluído definitivamente depois de seis meses, a menos que você o restaure.",
  "history.conversations.title": "Conversas em versões anteriores",
  "history.conversations.description":
    "As conversas de comentários ficam com a versão em que foram escritas. Só você vê as anteriores, aqui e em modo só leitura; os visitantes veem as conversas da versão atual.",
  "history.conversations.loading": "Carregando conversas",
  "history.conversations.error": "Não foi possível carregar as conversas",
  "history.conversations.refreshFailed": "Não foi possível atualizar as conversas",
  "history.conversations.empty": "Nenhuma versão anterior tem conversas de comentários.",
  "history.conversations.counts":
    "{count, plural, one {# conversa} other {# conversas}}, {open, plural, =0 {nenhuma aberta} one {# aberta} other {# abertas}}",
  "history.conversations.version": "Versão {number}: {counts}",
  "history.conversations.unlisted": "Versões que não estão mais listadas: {counts}",
  "review.open": "Revisar e comentar",
  "viewer.loading": "Abrindo o artifact",
  "viewer.unavailable.title": "Este artifact não pode ser aberto",
  "viewer.unavailable.body":
    "Ele não existe, não está disponível agora ou sua conta não pode abri-lo.",
  "viewer.failed.title": "Não foi possível abrir o artifact",
  "viewer.dashboard": "Seus artifacts",
  "viewer.skipLink": "Pular para o artifact",
  "viewer.brand": "Portifact",
  "viewer.version": "Versão {number}",
  "viewer.withoutBar": "Abrir sem a barra do Portifact",
  "viewer.copyLink": "Copiar link",
  "viewer.copied": "Link copiado.",
  "viewer.copyFailed": "Não foi possível copiar o link: {url}",
  "viewer.manage": "Gerenciar",
  "viewer.comments": "Comentários",
  "viewer.comments.open":
    "{count, plural, one {(# conversa aberta)} other {(# conversas abertas)}}",
  "viewer.closeComments": "Fechar comentários",
  "viewer.more": "Mais",
  "viewer.account": "Sua conta",
  "viewer.signIn": "Entrar",
  "viewer.frame.label": "Artifact",
  "viewer.frame.title": "{name}, publicado com o Portifact",
  "viewer.anonymous.body":
    "Entre para ler os comentários deste artifact e adicionar os seus. Você volta para esta página depois de entrar.",
  "viewer.anonymous.signIn": "Entrar para comentar",
  "review.startFailed.title": "Não foi possível conectar os comentários ao artifact",
  "review.frame.connecting": "Conectando à página",
  "review.frame.isolated":
    "O artifact roda no próprio site e não pode ver sua conta, seu e-mail nem os comentários de outras pessoas. Selecionar algo nele nunca publica um comentário: você escreve e confirma cada um aqui.",
  "review.status.unavailable.title":
    "As ferramentas de revisão não estão disponíveis neste navegador",
  "review.status.unavailable.body":
    "Este navegador bloqueia o cookie de que a revisão precisa dentro do frame. Você ainda pode deixar comentários gerais sobre a página.",
  "review.status.silent.title": "A página não responde às ferramentas de revisão",
  "review.status.silent.body":
    "A própria política de segurança dela pode bloqueá-las. Você ainda pode deixar comentários gerais sobre a página.",
  "review.tab.title": "Revisar em uma aba separada",
  "review.tab.body":
    "Abra o artifact na própria aba para vê-lo no modo de revisão. A aba mostra o próprio artifact, escrito pelo autor dele, não pelo Portifact: não entre nem digite nada lá, mesmo que pareça o Portifact. Ela não tem ferramentas de revisão, então escreva seus comentários aqui. A sessão de revisão dela termina depois de {minutes} minutos, ou quando você escolher Encerrar revisão na aba.",
  "review.tab.prepare": "Preparar uma aba de revisão",
  "review.tab.open": "Abrir a aba de revisão",
  "review.tab.ready": "O link da aba de revisão está pronto.",
  "review.tab.opened":
    "A aba de revisão foi aberta. Escolha Encerrar revisão na aba quando terminar; os comentários ficam aqui.",
  "review.tab.expired": "O link expirou antes de ser aberto. Prepare um novo.",
  "review.status.ended.title": "Esta sessão de revisão terminou",
  "review.status.ended.body":
    "É o que diz a página no frame. Os comentários aqui continuam funcionando; recarregue a revisão para usar de novo as ferramentas de revisão na página.",
  "review.status.failed.title": "O link de revisão expirou",
  "review.status.failed.body":
    "É o que diz a página no frame. Os comentários aqui continuam funcionando; recarregue a revisão para abrir a página de novo.",
  "review.status.foreign.title": "O frame não está rodando a sua sessão de revisão",
  "review.status.foreign.body":
    "Algo, talvez outro artifact, abriu uma sessão de revisão diferente no frame, então as ferramentas de revisão estão desativadas para ela. Recarregue a revisão para iniciar a sua de novo. Os comentários aqui não são afetados.",
  "review.status.lost.title": "O frame parou de responder a partir do artifact",
  "review.status.lost.body":
    "Ele pode estar mostrando outro site, outro artifact ou um arquivo sem as ferramentas de revisão, então não confie que o que ele mostra é este artifact. Recarregue a revisão para mostrar o artifact de novo. Os comentários aqui não são afetados.",
  "review.reload": "Recarregar a revisão",
  "review.newVersion.title": "Uma versão mais recente foi publicada",
  "review.newVersion.body":
    "Você está vendo uma versão mais antiga. Novos comentários vão para a versão mais recente.",
  "review.newVersion.action": "Revisar a nova versão",
  "review.mode.off.owner.title": "Os comentários estão desativados",
  "review.mode.off.owner.body":
    "Ative-os para deixar as pessoas que podem abrir este artifact comentarem.",
  "review.mode.off.turnOn": "Ativar comentários",
  "review.mode.off.turnedOn": "Os comentários estão ativados.",
  "review.mode.off.visitor.title": "Os comentários estão desativados neste artifact",
  "review.mode.off.visitor.body": "O proprietário não os ativou.",
  "review.mode.locked.title": "Os comentários estão bloqueados",
  "review.mode.locked.body": "Você pode ler os comentários, mas não adicionar novos.",
  "review.comments.heading": "Comentários",
  "review.comments.loading": "Carregando comentários",
  "review.comments.error.title": "Não foi possível carregar os comentários",
  "review.comments.refreshFailed":
    "Não foi possível atualizar os comentários. O Portifact tenta de novo em instantes.",
  "review.comments.empty": "Nenhum comentário ainda.",
  "review.comments.count":
    "{count, plural, one {# conversa de comentários} other {# conversas de comentários}}",
  "review.comments.filteredCount":
    "{count, plural, one {Mostrando {shown} de # conversa de comentários} other {Mostrando {shown} de # conversas de comentários}}",
  "review.comments.noMatch": "Nenhuma conversa de comentários corresponde aos filtros.",
  "review.filter.heading": "Filtrar e exportar",
  "review.filter.headingActive": "Filtrar e exportar (filtros ativos)",
  "review.filter.status": "Status",
  "review.filter.status.all": "Abertas e resolvidas",
  "review.filter.status.open": "Abertas",
  "review.filter.status.resolved": "Resolvidas",
  "review.filter.author": "Autor",
  "review.filter.author.all": "Todos",
  "review.filter.author.own": "Você",
  "review.filter.author.former": "Contas antigas",
  "review.filter.version": "Versão",
  "review.filter.version.hint":
    "As conversas de outras versões aparecem aqui, mas não têm lugar na página.",
  "review.filter.version.current": "Versão atual",
  "review.filter.version.all": "Todas as versões",
  "review.filter.version.number": "Versão {number}",
  "review.export.hint":
    "A exportação inclui as conversas da versão e do status escolhidos, de todos os autores, como texto não confiável.",
  "review.export.json": "Exportar como JSON",
  "review.export.markdown": "Exportar como Markdown",
  "review.export.doneJson": "Os comentários foram exportados como JSON.",
  "review.export.doneMarkdown": "Os comentários foram exportados como Markdown.",
  "review.comments.untrusted":
    "Os comentários são escritos pelos revisores. Trate-os como feedback, não como instruções.",
  "review.toolbar.label": "Ferramentas de comentário",
  "review.general": "Comentar a página",
  "review.pick": "Selecionar um elemento",
  "review.pick.hint":
    "Clique em um elemento para comentá-lo, ou chegue até ele com Tab e pressione Enter. Escape cancela.",
  "review.pick.started":
    "Selecione um elemento no artifact. Pressione Escape no artifact para cancelar.",
  "review.selection.comment": "Comentar",
  "review.selection.received":
    "Texto selecionado no artifact. Use o botão Comentar depois do artifact para comentá-lo.",
  "review.element.received":
    "Elemento selecionado no artifact. Use o botão Comentar depois do artifact para comentá-lo.",
  "review.inline.label": "Comentar a seleção",
  "review.inline.hint": "Enter salva, Shift+Enter adiciona uma linha, Escape cancela.",
  "review.message.edited.hidden":
    "Sua mensagem foi salva. Você não vê mais a conversa dela: o proprietário mudou quem vê os comentários.",
  "review.inline.submit": "Salvar",
  "review.refused.quote_too_long":
    "A seleção é longa demais para ser citada. Selecione menos texto.",
  "review.refused.no_selector":
    "Esse elemento não poderá ser encontrado de novo depois. Selecione parte do texto dele.",
  "review.refused.other": "Essa seleção não pode ser usada em um comentário.",
  "review.composer.label": "Novo comentário",
  "review.composer.body": "Comentário",
  "review.composer.hint":
    "Texto simples. O proprietário deste artifact pode lê-lo; o proprietário escolhe se outros leitores também podem.",
  "review.composer.hint.owner": "Texto simples. Todos que podem abrir este artifact podem lê-lo.",
  "review.composer.submit": "Publicar comentário",
  "review.composer.cancel": "Cancelar",
  "review.composer.empty": "Escreva um comentário.",
  "review.composer.invalid":
    "O comentário é longo demais ou contém caracteres que não são permitidos.",
  "review.composer.posted": "Comentário publicado.",
  "review.humanCheck.body":
    "Uma verificação rápida de que você é humano antes de publicar seu comentário. Ele é publicado assim que a verificação terminar.",
  "review.humanCheck.needed":
    "Uma verificação rápida de que você é humano antes de publicar seu comentário.",
  "review.humanCheck.retry":
    "A verificação de que você é humano não foi concluída. Conclua-a e depois salve de novo.",
  "review.humanCheck.unavailable":
    "A verificação de que você é humano não carregou nesta página. Recarregue a página e tente de novo.",
  "review.report": "Denunciar este artifact",
  "review.target.general": "Comentário geral em {path}",
  "review.target.element": "Elemento {tag}",
  "review.target.quote": "Texto citado",
  "review.thread.title": "Conversa {number}",
  "review.thread.titlePrefix": "Conversa ",
  "review.thread.more": "Mais ações da conversa {number}",
  "review.thread.showMessages":
    "{count, plural, one {Mostrar o comentário} other {Mostrar os # comentários}}",
  "review.thread.hideMessages": "Recolher os comentários",
  "review.thread.open": "Aberta",
  "review.thread.resolved": "Resolvida",
  "review.thread.replies": "{count, plural, one {# resposta} other {# respostas}}",
  "review.thread.hideReplies": "Ocultar respostas",
  "review.thread.otherVersion": "Versão anterior",
  "review.thread.orphaned": "Sem localização",
  "review.thread.otherPage": "Em {path}",
  "review.thread.show": "Mostrar no artifact",
  "review.thread.resolve": "Resolver",
  "review.thread.reopen": "Reabrir",
  "review.thread.reply": "Responder",
  "review.thread.delete": "Excluir conversa",
  "review.thread.resolvedDone": "Conversa {number} resolvida.",
  "review.thread.reopenedDone": "Conversa {number} reaberta.",
  "review.thread.deletedDone": "Conversa {number} excluída.",
  "review.thread.activated": "Conversa {number} selecionada.",
  "review.thread.activatedMany": "Conversas {numbers} selecionadas.",
  "review.group.heading":
    "{count, plural, one {# conversa no texto em que você clicou} other {# conversas no texto em que você clicou}}",
  "review.group.clear": "Mostrar todas as conversas",
  "review.thread.confirmDelete.title": "Excluir a conversa {number}?",
  "review.thread.confirmDelete.body":
    "Todas as mensagens dela são removidas para todos. Isso não pode ser desfeito.",
  "review.thread.confirmDelete.confirm": "Excluir conversa",
  "review.thread.confirmDelete.cancel": "Manter",
  "review.message.formerAccount": "Conta antiga",
  "review.message.you": "Você",
  "review.message.hidden": "Ocultada pelo proprietário",
  "review.message.deleted": "Mensagem excluída",
  "review.message.edited": "Editada",
  "review.message.hide": "Ocultar",
  "review.message.unhide": "Mostrar de novo",
  "review.message.delete": "Excluir",
  "review.message.more": "Mais ações da mensagem de {author}",
  "review.message.moderated": "Mensagem atualizada.",
  "review.message.edit": "Editar",
  "review.message.editLabel": "Editar sua mensagem",
  "review.message.editBody": "Mensagem",
  "review.message.editSave": "Salvar",
  "review.message.edited.done": "Mensagem editada.",
  "review.message.editConflict":
    "Esta mensagem foi alterada em outro lugar enquanto isso. A versão mais recente está sendo exibida; edite-a de novo.",
  "review.reply.label": "Responder à conversa {number}",
  "review.reply.body": "Resposta",
  "review.reply.hint.owner":
    "O proprietário iniciou esta conversa, então todos que podem ver os comentários veem sua resposta.",
  "review.reply.submit": "Publicar resposta",
  "review.reply.posted": "Resposta publicada.",
  "review.actionFailed.title": "A ação não foi concluída",

  "notFound.title": "Página não encontrada",
  "notFound.body": "Este endereço não corresponde a nenhuma página do painel.",

  "action.retry": "Tentar de novo",

  "type.site": "Site",
  "type.markdown": "Markdown",
  "type.text": "Texto",

  "state.draft": "Rascunho",
  "state.active": "Ativo",
  "state.archived": "Arquivado",
  "state.suspended": "Suspenso",
  "state.purging": "Sendo excluído",
  "state.deleted": "Excluído",

  "access.public": "Público: qualquer pessoa com o link",
  "access.authenticated": "Qualquer pessoa com login no Portifact",
  "access.restricted": "Só você e as pessoas que você adicionar",

  "error.network": "Não foi possível acessar o Portifact. Verifique sua conexão e tente de novo.",
  "error.unexpected": "Algo deu errado. Tente de novo.",
  "error.invalid_input": "A solicitação não era válida.",
  "error.unauthenticated": "Sua sessão terminou. Entre de novo.",
  "error.forbidden": "Você não tem permissão para fazer isso.",
  "error.not_found": "O artifact não existe mais.",
  "error.version_conflict": "O artifact mudou enquanto isso. Recarregue e tente de novo.",
  "error.quota_exceeded":
    "Você atingiu o limite de artifacts ativos. Arquive ou exclua um e tente de novo.",
  "error.traffic_exceeded":
    "Seus artifacts usaram o tráfego deste mês. Eles voltam a funcionar no próximo mês.",
  "error.upload_incomplete": "O envio ainda não foi concluído.",
  "error.artifact_archived": "O artifact está arquivado. Restaure-o primeiro.",
  "error.account_too_new_for_public": "Contas novas ainda não podem tornar artifacts públicos.",
  "error.capacity_unavailable":
    "O Portifact está no limite da capacidade agora. Tente de novo mais tarde.",
  "error.sole_workspace_admin":
    "Um workspace precisa ter uma pessoa administradora e você é a única. Torne antes outro membro administrador ou peça ao Portifact em hello@portifact.com para excluir o workspace.",
  "error.seats_exhausted":
    "O workspace usa todas as suas vagas. Remova um membro ou revogue um convite, ou peça mais vagas.",
  "error.rate_limited": "Solicitações demais. Aguarde um momento e tente de novo.",
  "error.reauthentication_required": "Entre de novo para fazer isso.",
  "error.human_verification_required":
    "Seus primeiros comentários em artifacts de outras pessoas precisam de uma verificação rápida de que você é humano. Conclua-a e depois publique de novo.",
  "error.plan_required": "Este recurso não faz parte do plano do dono do artifact.",
  "shareLinks.title": "Links de compartilhamento",
  "shareLinks.description":
    "Links que permitem que qualquer pessoa que os tenha leia este artifact sem uma conta. Os visitantes só leem a versão atual: não podem comentar e nunca são identificados.",
  "shareLinks.loading": "Carregando os links de compartilhamento",
  "shareLinks.loadFailed": "Os links de compartilhamento não carregaram",
  "shareLinks.paidTitle": "Links de compartilhamento fazem parte de um plano pago",
  "shareLinks.paid":
    "Seu plano não inclui links de compartilhamento. Adicionar pessoas e o acesso público funcionam como antes.",
  "shareLinks.paused":
    "Seu plano não inclui mais links de compartilhamento, então estes links não abrem. Eles são mantidos e voltam a funcionar se o plano incluir links de compartilhamento. Você ainda pode revogá-los.",
  "shareLinks.publicNote":
    "Este artifact é público, então qualquer pessoa já pode abri-lo. Links de compartilhamento fazem diferença se você restringir o acesso depois.",
  "shareLinks.created.title": 'Link "{label}" criado',
  "shareLinks.created.once":
    "Copie agora: por segurança ele é mostrado só desta vez. Qualquer pessoa com este link pode ler o artifact.",
  "shareLinks.created.label": "Link de compartilhamento",
  "shareLinks.created.copy": "Copiar link",
  "shareLinks.created.done": "Concluído",
  "shareLinks.created.announce":
    "Link de compartilhamento criado. Copie agora; ele é mostrado só uma vez.",
  "shareLinks.empty": "Ainda não há links de compartilhamento.",
  "shareLinks.list": "Links de compartilhamento deste artifact",
  "shareLinks.expired": "Expirado",
  "shareLinks.noExpiry": "Sem expiração",
  "shareLinks.expires": "Expira em {date}",
  "shareLinks.withPassword": "Senha",
  "shareLinks.noPassword": "Sem senha",
  "shareLinks.neverUsed": "Ainda não usado",
  "shareLinks.lastUsed": "Usado pela última vez em {date}",
  "shareLinks.revoke": "Revogar",
  "shareLinks.revokeLabel": "Revogar o link {label}",
  "shareLinks.revoked": "O link {label} foi revogado.",
  "shareLinks.revokeFailed": "O link não foi revogado",
  "shareLinks.confirm.title": 'Revogar "{label}"?',
  "shareLinks.confirm.body":
    "Quem tiver este link perde o acesso em até um minuto. Não dá para desfazer; um link novo tem outro endereço.",
  "shareLinks.cancel": "Cancelar",
  "shareLinks.create": "Criar link",
  "shareLinks.createFailed": "O link não foi criado",
  "shareLinks.full":
    "Este artifact tem {max} links ativos, o máximo possível. Revogue um para criar outro.",
  "shareLinks.label.label": "Rótulo",
  "shareLinks.label.hint": "Só você vê, por exemplo para quem é o link.",
  "shareLinks.label.invalid": "Dê ao link um rótulo de 1 a {max} caracteres.",
  "shareLinks.expiry.label": "Expira depois de",
  "shareLinks.expiry.never": "Nunca",
  "shareLinks.expiry.days": "{count, plural, one {# dia} other {# dias}}",
  "shareLinks.password.label": "Senha (opcional)",
  "shareLinks.password.hint":
    "Pelo menos {min} caracteres. Os visitantes a digitam antes de o artifact abrir. Envie-a separada do link.",
  "shareLinks.password.short": "Use pelo menos {min} caracteres ou deixe vazio.",
  "domains.title": "Domínio próprio",
  "domains.description":
    "Sirva este artifact a partir de um domínio seu, como docs.example.com. O endereço do Portifact continua funcionando.",
  "domains.loading": "Carregando o domínio próprio",
  "domains.loadFailed": "Não foi possível carregar o domínio próprio",
  "domains.paidTitle": "Domínios próprios fazem parte de um plano pago",
  "domains.paid":
    "Com um plano pago você pode servir este artifact a partir do seu próprio domínio.",
  "domains.unavailableTitle": "Domínios próprios ainda não estão disponíveis",
  "domains.unavailable":
    "O Portifact ainda não serve domínios próprios. Esta seção será aberta quando servir.",
  "domains.removingNote": "{hostname} está sendo removido.",
  "domains.cardLabel": "Domínio próprio {hostname}",
  "domains.state.pending": "Aguardando o DNS",
  "domains.state.provisioning": "Configurando",
  "domains.state.active": "Ativo",
  "domains.state.removing": "Removendo",
  "domains.next.pending":
    "Crie os dois registros abaixo no seu provedor de DNS e verifique de novo.",
  "domains.next.provisioning":
    "Seu domínio foi verificado. O certificado costuma levar alguns minutos; verifique de novo em breve.",
  "domains.next.active":
    "Seu artifact é servido neste domínio. Mantenha o registro TXT: ele é verificado todos os dias.",
  "domains.next.removing": "O domínio está sendo removido.",
  "domains.problem.txt_missing": "O registro TXT não foi encontrado",
  "domains.problem.txt_missing.hint":
    "Confira se o nome e o valor do registro são exatamente iguais. Mudanças de DNS podem levar alguns minutos para aparecer.",
  "domains.problem.certificate_pending": "O certificado ainda não está pronto",
  "domains.problem.certificate_pending.hint":
    "Confira se o registro CNAME aponta para o valor abaixo e verifique de novo em alguns minutos.",
  "domains.problem.cloudflare_unavailable": "O serviço de certificados não respondeu",
  "domains.problem.cloudflare_unavailable.hint":
    "Não há nada errado do seu lado. Uma nova tentativa é feita em breve.",
  "domains.problem.cname_elsewhere": "O domínio não aponta para o Portifact",
  "domains.problem.cname_elsewhere.hint":
    "O DNS dele não leva mais ao destino CNAME abaixo. Aponte de novo; um domínio ativo é removido após 3 verificações diárias seguidas assim.",
  "domains.missedChecks":
    "{count, plural, one {O registro TXT faltou na última verificação diária. Depois de 3 falhas seguidas o domínio é removido.} other {O registro TXT faltou nas últimas # verificações diárias. Depois de 3 falhas seguidas o domínio é removido.}}",
  "domains.records": "Registros a criar",
  "domains.records.type": "Registro {type}",
  "domains.records.txtHint":
    "Prova que você controla o domínio. Mantenha-o depois que o domínio estiver ativo.",
  "domains.records.cnameHint": "Aponta seu domínio para o Portifact.",
  "domains.records.name": "Nome",
  "domains.records.value": "Valor",
  "domains.records.copy": "Copiar",
  "domains.claimExpires": "Adicione os registros antes de {date}, ou adicione o domínio de novo.",
  "domains.check": "Verificar de novo",
  "domains.checkFailed": "Não foi possível verificar o domínio",
  "domains.remove": "Remover domínio",
  "domains.removed": "{hostname} foi removido.",
  "domains.removeFailed": "Não foi possível remover o domínio",
  "domains.confirm.title": "Remover {hostname}?",
  "domains.confirm.body":
    "O artifact deixa de ser servido neste domínio na hora e mantém seu endereço do Portifact. Adicionar o domínio de novo exige uma nova verificação de DNS.",
  "domains.cancel": "Cancelar",
  "domains.bar.title":
    "As visitas abrem no visualizador enquanto a barra do Portifact estiver ligada",
  "domains.bar.body":
    "Enquanto a barra estiver ligada, quem abrir seu domínio vai parar no visualizador em app.portifact.com. Desligue a barra para manter seu domínio na barra de endereços.",
  "domains.bar.turnOff": "Desligar a barra",
  "domains.bar.done": "A barra do Portifact está desligada.",
  "domains.add": "Adicionar domínio",
  "domains.added": "{hostname} foi adicionado. Agora crie os registros DNS.",
  "domains.addFailed": "Não foi possível adicionar o domínio",
  "domains.full":
    "{count, plural, one {Seu plano inclui # domínio próprio, e ele já está em uso.} other {Seu plano inclui # domínios próprios, e todos estão em uso.}}",
  "domains.hostname.label": "Nome do host",
  "domains.hostname.hint":
    "Um subdomínio que você controla, como docs.example.com. Domínios raiz e curingas não são aceitos.",
  "domains.hostname.invalid": "Digite um nome de host como docs.example.com.",
  "accessLog.shareLink": "Link de compartilhamento: {label}",
  "webhooks.title": "Webhooks",
  "webhooks.description":
    "Envie eventos dos seus artifacts para os seus próprios sistemas, Slack ou Discord.",
  "webhooks.planTitle": "Webhooks fazem parte de um plano pago",
  "webhooks.planRequired":
    "Webhooks fazem parte do plano {plan}. Os webhooks que você adicionou ficam aqui, pausados, e voltam a funcionar quando o seu plano os incluir.",
  "webhooks.add.title": "Adicionar um webhook",
  "webhooks.add.hint":
    "Os eventos de cada artifact seu vão para este endereço. O texto dos comentários e os e-mails dos leitores nunca são enviados.",
  "webhooks.add.url": "URL",
  "webhooks.add.urlHint": "Um endereço HTTPS público na porta padrão.",
  "webhooks.add.format": "Formato",
  "webhooks.format.generic": "JSON genérico, assinado",
  "webhooks.format.genericHint":
    "Confira o cabeçalho webhook-signature de cada entrega com o segredo de assinatura.",
  "webhooks.format.slack": "Slack",
  "webhooks.format.slackHint": "Uma URL de webhook de entrada do Slack (hooks.slack.com).",
  "webhooks.format.discord": "Discord",
  "webhooks.format.discordHint":
    "Uma URL de webhook de um canal do Discord (discord.com/api/webhooks).",
  "webhooks.add.events": "Eventos",
  "webhooks.event.comment.created": "Novos comentários e respostas",
  "webhooks.event.thread.resolved": "Conversas resolvidas",
  "webhooks.event.artifact.published": "Novas versões",
  "webhooks.event.artifact.expiring": "Artifacts prestes a expirar",
  "webhooks.event.artifact.access_changed": "Mudanças de acesso",
  "webhooks.event.review.requested": "Pedidos de revisão",
  "webhooks.event.review.completed": "Revisões aprovadas ou com mudanças pedidas",
  "webhooks.add.submit": "Adicionar webhook",
  "webhooks.add.noEvents": "Escolha pelo menos um evento.",
  "webhooks.add.limit": "Você pode ter no máximo {limit} webhooks. Remova um para adicionar outro.",
  "webhooks.added": "Webhook adicionado para {host}.",
  "webhooks.secret.title": "Copie o segredo de assinatura agora",
  "webhooks.secret.body":
    "Ele só aparece uma vez. Guarde-o na configuração do seu receptor para verificar cada entrega.",
  "webhooks.secret.label": "Segredo de assinatura para {host}",
  "webhooks.secret.copy": "Copiar segredo",
  "webhooks.secret.done": "Já guardei",
  "webhooks.list.title": "Seus webhooks",
  "webhooks.list.loading": "Carregando seus webhooks",
  "webhooks.list.error": "Não foi possível carregar os webhooks",
  "webhooks.empty.title": "Ainda não há webhooks",
  "webhooks.empty.body":
    "Adicione um para receber os eventos dos seus artifacts onde a sua equipe trabalha.",
  "webhooks.state.active": "Ativo",
  "webhooks.state.paused": "Pausado pelo plano",
  "webhooks.state.disabled": "Desativado",
  "webhooks.reason.manual": "Desativado por um administrador",
  "webhooks.reason.failures": "Desativado após falhas repetidas",
  "webhooks.reason.gone": "Desativado: o receptor disse que não existe mais",
  "webhooks.reason.invalid_url": "Desativado: a URL não é mais permitida",
  "webhooks.failures": "{count} tentativas com falha seguidas",
  "webhooks.lastAttempt": "Última tentativa {when}: {outcome}",
  "webhooks.outcome.delivered": "entregue",
  "webhooks.outcome.failed": "falhou",
  "webhooks.outcome.skipped": "ignorada",
  "webhooks.noAttempts": "Ainda não há tentativas",
  "webhooks.test": "Enviar teste",
  "webhooks.testLabel": "Enviar teste para {host}",
  "webhooks.testQueued": "Evento de teste na fila para {host}. Sai em cerca de dois minutos.",
  "webhooks.enable": "Ativar",
  "webhooks.enableLabel": "Ativar o webhook de {host}",
  "webhooks.disable": "Desativar",
  "webhooks.disableLabel": "Desativar o webhook de {host}",
  "webhooks.enabled": "Webhook de {host} ativado.",
  "webhooks.disabled": "Webhook de {host} desativado.",
  "webhooks.remove": "Remover",
  "webhooks.removeLabel": "Remover o webhook de {host}",
  "webhooks.removed": "Webhook de {host} removido.",
  "webhooks.confirm.title": "Remover o webhook de {host}?",
  "webhooks.confirm.body":
    "Ele para de receber eventos e o registro de entregas é apagado. Não dá para desfazer.",
  "webhooks.deliveries": "Entregas",
  "webhooks.deliveriesOf": "Entregas do webhook de {host}",
  "webhooks.deliveries.loading": "Carregando entregas",
  "webhooks.deliveries.error": "Não foi possível carregar as entregas",
  "webhooks.deliveries.empty": "Nenhuma tentativa nos últimos {days} dias.",
  "webhooks.deliveries.time": "Hora",
  "webhooks.deliveries.attempt": "Tentativa",
  "webhooks.deliveries.outcome": "Resultado",
  "webhooks.error.timeout": "tempo esgotado",
  "webhooks.error.network": "sem conexão",
  "webhooks.error.redirect": "redirecionado, não seguido",
  "webhooks.error.invalid_url": "URL não permitida",
  "webhooks.error.daily_cap": "limite diário atingido",
  "webhooks.actionFailed": "Não deu certo",
  "webhooks.notOfferedTitle": "Webhooks ainda não estão disponíveis",
  "webhooks.notOffered":
    "O Portifact ainda não envia webhooks. Eles aparecerão aqui quando forem oferecidos.",
  "webhooks.reason.key_unavailable":
    "Desativado: a chave que o protege não está mais disponível. Remova e adicione de novo.",
  "webhooks.reason.unavailable": "Desativado: o Portifact desligou os webhooks por enquanto",
  "webhooks.error.key_unavailable": "chave indisponível",
  "webhooks.via.dashboard": "Adicionado no painel",
  "webhooks.via.cli": "Adicionado com a CLI do Portifact",
  "webhooks.via.other": "Adicionado por meio de outro app",
  "webhooks.via.by": "por {name}",
  "webhooks.probation":
    "Ativado de novo após falhas: mais algumas falhas o desativam até uma entrega dar certo.",
  "shell.brandingLink": "Marca",
  "branding.title": "Marca",
  "branding.description":
    "Mostre seu nome, logo, cor e link na barra acima dos seus artifacts no visualizador. O aviso do Portifact, o endereço do artifact e o link de denúncia sempre ficam na barra.",
  "branding.loading": "Carregando sua marca",
  "branding.error": "Não foi possível carregar sua marca",
  "branding.paidTitle": "A marca faz parte de um plano pago",
  "branding.paid":
    "Colocar sua marca na barra do visualizador faz parte do plano {plan}. Seus artifacts mostram a barra padrão, e a marca que você salvou fica aqui para quando seu plano voltar a incluí-la.",
  "branding.suspendedTitle": "Sua marca está suspensa",
  "branding.suspended":
    "Seus artifacts mostram a barra padrão enquanto a suspensão durar. Escreva para abuse@portifact.com sobre isso.",
  "branding.form.title": "Marca",
  "branding.form.hint":
    "Aparece como texto e um link. Nada aqui muda a aparência dos próprios artifacts.",
  "branding.form.name": "Nome",
  "branding.form.nameHint": "Até {max} caracteres. Não pode ser lido como Portifact.",
  "branding.form.nameRequired": "Digite o nome a mostrar.",
  "branding.form.nameTooLong": "Use no máximo {max} caracteres.",
  "branding.form.link": "Link (opcional)",
  "branding.form.linkHint": "Seu próprio site, aberto em uma nova aba. Começa com https://.",
  "branding.form.linkInvalid": "Digite um endereço que comece com https://.",
  "branding.form.color": "Cor de destaque (opcional)",
  "branding.form.colorHint":
    "Uma cor como #1a2b3c. Ela preenche a etiqueta da marca, e o texto fica preto ou branco para continuar legível.",
  "branding.form.colorPicker": "Escolher a cor de destaque",
  "branding.form.colorInvalid": "Use uma cor como #1a2b3c.",
  "branding.form.save": "Salvar marca",
  "branding.form.saved": "Marca salva.",
  "branding.form.failed": "Não foi possível salvar a marca",
  "branding.form.invalid":
    "Confira o nome e o link: o nome não pode ser lido como Portifact, e o link precisa ser o endereço https do seu próprio site.",
  "branding.logo.title": "Logo",
  "branding.logo.hint":
    "Uma imagem PNG, JPEG ou WebP de até {kb} KB e {px} por {px} pixels, sem animação. Ela conta no seu armazenamento.",
  "branding.logo.needsName": "Salve primeiro o nome da marca e depois adicione um logo.",
  "branding.logo.none": "Ainda não há logo.",
  "branding.logo.current": "{type}, {width} por {height} pixels, {size}.",
  "branding.logo.choose": "Escolher um logo",
  "branding.logo.replace": "Substituir o logo",
  "branding.logo.remove": "Remover logo",
  "branding.logo.uploaded": "Logo salvo.",
  "branding.logo.removed": "Logo removido.",
  "branding.logo.failed": "Não foi possível salvar o logo",
  "branding.logo.invalid":
    "Use uma imagem PNG, JPEG ou WebP de até {kb} KB e {px} por {px} pixels, sem animação nem texto guardado nela.",
  "branding.logo.full": "Seu armazenamento está cheio. Exclua algo primeiro.",
  "branding.preview.title": "Prévia",
  "branding.preview.hint": "A barra em cada tema com o que está no formulário, salvo ou não.",
  "branding.preview.light": "Tema claro",
  "branding.preview.dark": "Tema escuro",
  "branding.preview.sample": "Relatório trimestral",
  "branding.preview.noName": "Seu nome",
  "branding.preview.origin": "a1b2c3d4e5.portifact.dev",
  "branding.delete.title": "Excluir marca",
  "branding.delete.hint": "Seus artifacts voltam a mostrar a barra padrão, e o logo é excluído.",
  "branding.delete.action": "Excluir marca",
  "branding.delete.confirm": "Excluir a marca?",
  "branding.delete.body":
    "O nome, a cor, o link e o logo são removidos, e o visualizador mostra a barra padrão em todos os seus artifacts.",
  "branding.delete.done": "Marca excluída.",
  "branding.delete.failed": "Não foi possível excluir a marca",
  "branding.delete.cancel": "Cancelar",
  "viewer.brandNewTab": "(abre em uma nova aba)",
  "viewer.hosting.poweredBy": "Com tecnologia Portifact",
  "viewer.hosting.origin": "Publicado em",
  // Workspaces (premium plan T1): the space menu, members, invitations and transfers.
  "space.label": "Espaço",
  "space.personal": "Pessoal",
  "space.personalDetail": "Seu próprio espaço",
  "space.invitations": "{count, plural, one {# convite pendente} other {# convites pendentes}}",
  "space.missing.title": "Workspace não encontrado",
  "space.missing.body":
    "Este workspace não existe ou você não é membro dele. Peça a um dos admins para convidar você.",
  "space.missing.personal": "Ir para o seu espaço pessoal",
  "space.notAllowed.title": "Indisponível para o seu papel",
  "space.notAllowed.back": "Voltar aos artifacts",
  "space.notAllowed.list":
    "Como membro de {workspace}, você lê e comenta os artifacts compartilhados com você, pelos links deles. Ver e gerenciar todos os artifacts do workspace exige o papel de editor ou admin: peça a um dos admins.",
  "space.notAllowed.publish":
    "Publicar em {workspace} exige o papel de editor ou admin. Peça a um dos admins.",
  "space.notAllowed.usage": "O uso de {workspace} é mostrado aos editores e admins dele.",
  "space.notAllowed.branding": "Só os admins de {workspace} definem a marca dele.",
  "role.admin": "Admin",
  "role.editor": "Editor",
  "role.member": "Membro",
  "role.admin.hint":
    "gerencia membros, a marca e todos os artifacts, e pode tirar artifacts do workspace",
  "role.editor.hint": "publica e gerencia os artifacts do workspace",
  "role.member.hint": "lê e comenta o que é compartilhado com ele",
  "shell.membersLink": "Membros",
  "list.descriptionWorkspace":
    "Tudo o que foi publicado em {workspace}, com estado, acesso e atividade.",
  "publish.descriptionWorkspace":
    "Publique em {workspace}: um arquivo HTML, uma pasta, um ZIP ou um documento. Nada é enviado antes da sua revisão.",
  "publish.review.accessNewWorkspace":
    "Os admins e editores de {workspace}. Depois de publicar, você pode compartilhar pela página do artifact.",
  "usage.descriptionWorkspace":
    "As cotas de {workspace}, compartilhadas por todos que publicam nele, e o tráfego deste mês.",
  "branding.descriptionWorkspace":
    "A marca que a barra do visualizador mostra nos artifacts de {workspace}.",
  "detail.section.space": "Espaço",
  "transfer.title": "Mover para outro espaço",
  "transfer.description":
    "Este artifact está em {space}. Mova para o seu espaço pessoal ou para um workspace em que você seja editor ou admin.",
  "transfer.destination": "Destino",
  "transfer.move": "Mover artifact",
  "transfer.blocked": "Este artifact não pode ser movido agora",
  "transfer.notAdmin": "Só um admin de {workspace} pode tirar artifacts dele.",
  "transfer.domain":
    "Este artifact tem um domínio próprio, ativo ou pendente. Remova em Compartilhamento e depois mova o artifact.",
  "transfer.none":
    "Não há outro espaço para onde você possa movê-lo. Você pode mover artifacts para o seu espaço pessoal e para workspaces em que seja editor ou admin.",
  "transfer.noneInRegion":
    "Este espaço mantém os dados na UE, então o artifact só pode ir para outro espaço da UE, e você não tem nenhum.",
  "transfer.confirm.title": "Mover {name} para {space}?",
  "transfer.confirm.stays":
    "Não muda: o ID, o link, as versões, as pessoas que você adicionou e os comentários.",
  "transfer.confirm.changes":
    "Muda: os admins e editores de {space} passam a gerenciá-lo e a ver quem o abriu, inclusive antes da mudança, e ele conta no uso de {space}.",
  "transfer.confirm.plan":
    "Fixações e links de compartilhamento seguem o plano de {space}: se ele não os incluir, eles param de funcionar.",
  "transfer.confirm.blocks":
    "Ele não é movido se {space} não tiver espaço para ele ou se ainda houver um envio aberto.",
  "transfer.confirm.action": "Mover",
  "transfer.done": "{name} foi movido para {space}.",
  "transfer.failed": "O artifact não foi movido",
  "transfer.error.quota_exceeded":
    "{space} não tem espaço para este artifact. Libere antes uma vaga ativa ou armazenamento lá.",
  "transfer.error.version_conflict":
    "Ainda há um envio aberto para este artifact, ou ele mudou nesse meio-tempo. Conclua ou cancele o envio, recarregue e tente de novo.",
  "transfer.error.invalid_input":
    "Este artifact tem um domínio próprio ou já está nesse espaço. Remova o domínio antes.",
  "transfer.error.forbidden":
    "O seu papel não permite tirar este artifact do espaço dele nem movê-lo para esse.",
  "transfer.error.artifact_archived": "Só um artifact ativo ou arquivado pode ser movido.",
  "transfer.error.not_found": "Esse espaço ou este artifact não está mais disponível para você.",
  "members.title": "Membros",
  "members.description":
    "As pessoas de {workspace} e o que cada uma pode fazer. Os admins gerenciam membros e convites.",
  "members.personal.title": "O seu espaço pessoal não tem membros",
  "members.personal.body":
    "Membros pertencem a workspaces. Escolha um workspace no menu de espaços para ver os membros dele.",
  "members.loading": "Carregando membros",
  "members.loadFailed": "Os membros não carregaram",
  "members.seats": "Vagas",
  "members.seatsUsed": "Vagas em uso",
  "members.seatsValue": "{used} de {limit} ({percent})",
  "members.seatsHint":
    "Cada membro e cada convite pendente ocupa uma vaga. O plano do workspace define quantas existem.",
  "members.listTitle": "Pessoas",
  "members.count": "{count, plural, one {# membro} other {# membros}}",
  "members.caption": "Membros de {workspace}",
  "members.you": "Você",
  "members.joined": "Entrou em {date}",
  "members.roleLabel": "Papel de {name}",
  "members.remove": "Remover",
  "members.removeNamed": "Remover {name}",
  "members.leave": "Sair do workspace",
  "members.lastAdmin":
    "Único admin: torne outro membro admin antes de mudar este papel, remover essa pessoa ou sair.",
  "members.confirmRemove.title": "Remover {name} de {workspace}?",
  "members.confirmRemove.body":
    "A pessoa perde o acesso aos artifacts do workspace na hora. O que ela publicou continua no workspace.",
  "members.confirmRemove.action": "Remover membro",
  "members.confirmLeave.title": "Sair de {workspace}?",
  "members.confirmLeave.body":
    "Você perde o acesso aos artifacts dele na hora. Para voltar, um admin precisa convidar você de novo.",
  "members.roleChanged": "{name} agora é {role}.",
  "members.removed": "{name} foi removido.",
  "members.left": "Você saiu de {workspace}.",
  "members.actionFailed": "A alteração não foi salva",
  "members.error.forbidden":
    "O seu papel mudou nesse meio-tempo: só admins gerenciam membros e convites. Recarregue a página.",
  "members.error.version_conflict": "O membro mudou nesse meio-tempo. Recarregue e tente de novo.",
  "members.error.not_found": "Essa pessoa não está mais no workspace.",
  "invite.title": "Convidar alguém",
  "invite.description":
    "Enviamos por e-mail um link válido por 7 dias. A pessoa entra fazendo login com esse endereço.",
  "invite.email": "E-mail",
  "invite.role": "Papel",
  "invite.send": "Enviar convite",
  "invite.sent": "Convite enviado para {email}.",
  "invite.emailInvalid": "Digite um endereço de e-mail, como nome@exemplo.com.",
  "invite.alreadyMember": "{email} já é membro.",
  "invite.full.title": "Nenhuma vaga livre",
  "invite.failed": "O convite não foi enviado",
  "invite.error.invalid_input": "Esse endereço já pertence a um membro ou não é um e-mail válido.",
  "invite.error.rate_limited": "Convites demais por enquanto. Aguarde um pouco e tente de novo.",
  "invite.error.capacity_unavailable":
    "O Portifact já enviou todos os e-mails de convite que pode neste mês. Tente de novo no mês que vem.",
  "invite.error.not_found": "Esse convite não existe mais. Recarregue a página.",
  "pending.title": "Convites pendentes",
  "pending.description": "Cada um ocupa uma vaga até ser aceito, recusado, revogado ou expirar.",
  "pending.loading": "Carregando convites",
  "pending.loadFailed": "Os convites não carregaram",
  "pending.empty": "Nenhum convite pendente.",
  "pending.detail": "{role}, convidado por {inviter}, expira em {date}",
  "pending.unknownInviter": "um ex-membro",
  "pending.resend": "Convidar de novo",
  "pending.resendNamed": "Convidar de novo: {email}",
  "pending.revoke": "Revogar",
  "pending.revokeNamed": "Revogar: {email}",
  "pending.confirmRevoke.title": "Revogar o convite de {email}?",
  "pending.confirmRevoke.body": "O link para de funcionar e a vaga fica livre de novo.",
  "pending.confirmRevoke.action": "Revogar convite",
  "pending.revoked": "O convite de {email} foi revogado.",
  "pending.resent": "Um novo convite foi enviado para {email}. O link anterior não funciona mais.",
  "invitation.title": "Convite para um workspace",
  "invitation.signedOut.body":
    "Alguém convidou você para um workspace no Portifact. Entre com o endereço de e-mail para o qual o convite foi enviado e depois aceite ou recuse aqui.",
  "invitations.signedOut.body":
    "Entre para ver os convites para workspaces enviados ao seu e-mail.",
  "invitation.signIn": "Entrar para responder",
  "invitation.loading": "Carregando o convite",
  "invitation.loadFailed": "O convite não carregou",
  "invitation.invited.body": "{inviter} convidou você para {workspace} como {role}.",
  "invitation.invited.bodyNoInviter": "Você foi convidado para {workspace} como {role}.",
  "invitation.expiresTerm": "Expira",
  "invitation.accept": "Aceitar",
  "invitation.acceptNamed": "Aceitar o convite para {workspace}",
  "invitation.decline": "Recusar",
  "invitation.declineNamed": "Recusar o convite para {workspace}",
  "invitation.confirmDecline.title": "Recusar o convite para {workspace}?",
  "invitation.confirmDecline.body":
    "O link para de funcionar. Um admin pode convidar você de novo mais tarde.",
  "invitation.confirmDecline.action": "Recusar convite",
  "invitation.accepted": "Você entrou em {workspace}.",
  "invitation.declined": "Você recusou o convite para {workspace}.",
  "invitation.failed": "A sua resposta não foi salva",
  "invitation.other.title": "Este convite é para outro endereço",
  "invitation.other.body":
    "Ele foi enviado para {email}, e você entrou como {current}. Entre com {email} para responder.",
  "invitation.other.unverified":
    "Ele foi enviado para {email}, o endereço desta conta, que ainda não foi verificado. Saia e entre de novo com um código enviado para {email}.",
  "invitation.switch": "Entrar com outra conta",
  "invitation.missing.title": "Este convite não funciona mais",
  "invitation.missing.body":
    "Ele expirou, foi revogado ou já foi usado. Peça a um admin do workspace para convidar você de novo.",
  "invitations.title": "Convites",
  "invitations.description":
    "Convites para workspaces enviados ao seu endereço de e-mail verificado.",
  "invitations.loading": "Carregando convites",
  "invitations.loadFailed": "Os convites não carregaram",
  "invitations.empty.title": "Nenhum convite pendente",
  "invitations.empty.body":
    "Quando um admin convidar o seu endereço para um workspace, o convite aparece aqui e no seu e-mail.",
  "invitations.others": "Outros convites",
  "invitations.notice.title": "Você foi convidado para um workspace",
  "invitations.notice.body":
    "{count, plural, one {Você tem # convite pendente.} other {Você tem # convites pendentes.}}",
  "invitations.notice.link": "Ver convites",
  "workspaces.title": "Workspaces",
  "workspaces.description":
    "Os workspaces de que você faz parte e o seu papel em cada um. Os admins convidam pessoas e mudam papéis na página Membros de cada workspace.",
  "workspaces.loading": "Carregando workspaces",
  "workspaces.loadFailed": "Os workspaces não carregaram",
  "workspaces.none":
    "Você não faz parte de nenhum workspace. O Portifact cria workspaces para equipes, e um admin convida você por e-mail.",
  "workspaces.leave": "Sair",
  "workspaces.leaveNamed": "Sair de {workspace}",
  "account.delete.soleAdmin.title": "Você é o único admin de um workspace",
  "account.delete.soleAdmin.body":
    "Um workspace precisa manter um admin. Torne outro membro admin em cada um destes workspaces, ou peça ao Portifact em hello@portifact.com para excluí-los, e depois exclua a sua conta.",
  "account.delete.soleAdmin.members": "Membros de {workspace}",
  "webhooks.adminOnly.title": "Só administradores gerenciam webhooks",
  "webhooks.adminOnly.body":
    "Os webhooks enviam os eventos dos artifacts deste workspace para outros sistemas, por isso só os administradores de {workspace} podem vê-los e gerenciá-los. Peça a um deles se precisar de um webhook.",
  "shell.planLink": "Plano",
  "plan.title": "Plano",
  "plan.description": "O plano do seu espaço pessoal, seus limites e recursos, e os outros planos.",
  "plan.descriptionWorkspace":
    "O plano de {workspace}, seus limites e recursos, e os outros planos.",
  "plan.current.hint": "O que este espaço tem agora. A página Uso mostra quanto disso está em uso.",
  "plan.current.limits": "Limites do plano atual",
  "plan.current.usageLink": "Ver o uso",
  "plan.grace.title": "O que o plano {plan} guardava fica até {date}",
  "plan.grace.body":
    "Até lá nada é apagado: até {versions} versões anteriores de cada artefato por {days} dias, e o registro de acessos e a análise por {log} dias. Depois dessa data, o que o plano deste espaço não guarda é apagado.",
  "plan.grace.reads": "Ainda pode ser lido até lá: {features}.",
  "plan.grace.download":
    "Baixe o que precisar antes disso: o histórico de cada artefato tem as versões, e o registro de acessos e o registro de auditoria têm suas exportações. Ou peça o plano de novo para manter tudo.",
  "data.title": "Baixe seus dados",
  "data.description":
    "Tudo o que este espaço guarda e você pode levar: as versões mantidas de cada artefato e suas fontes, os registros de acesso e os dados de cada um (configurações, regras de acesso, links de compartilhamento, revisões, análises e comentários), os dados do espaço, o registro de auditoria e, para o seu espaço pessoal, os dados da sua conta. Os arquivos vêm direto do armazenamento; nada é empacotado no servidor.",
  "data.adminsOnly": "Baixar todos os dados de {workspace} cabe aos administradores.",
  "data.grace.title": "O que é apagado e quando",
  "data.grace.hint":
    "Um plano que venceu, foi removido ou reduzido mantém o que guardava por 60 dias. Depois, o que o plano deste espaço não guarda é apagado.",
  "data.grace.body":
    "Baixe o que precisar antes dessas datas ou peça o plano de novo para manter tudo.",
  "data.grace.loading": "Carregando o que é apagado e quando",
  "data.grace.error": "Não foi possível carregar o que é apagado e quando.",
  "data.grace.nothing": "Nada do que está mantido é apagado quando a carência terminar.",
  "data.grace.caption": "O que é apagado quando a carência termina, e a partir de quando",
  "data.grace.column.kind": "O quê",
  "data.grace.column.count": "Quantos",
  "data.grace.column.from": "A partir de",
  "data.kind.versions": "Versões anteriores",
  "data.kind.accessLog": "Entradas do registro de acesso",
  "data.kind.analytics": "Contadores diários de análise",
  "data.kind.auditEvents": "Eventos de auditoria",
  "data.kind.pins": "Artefatos fixados (desafixados e depois arquivados como sempre)",
  "data.artifacts.title": "Artefatos",
  "data.artifacts.hint":
    "Abra um artefato para baixar qualquer versão que ele mantém, arquivos publicados ou fontes.",
  "data.artifacts.loading": "Carregando artefatos",
  "data.artifacts.error": "Não foi possível carregar os artefatos.",
  "data.artifacts.none": "Este espaço não tem artefatos.",
  "data.artifacts.more": "Mostrar mais artefatos",
  "data.artifact.summary":
    "{name}: {count, plural, one {# versão mantida} other {# versões mantidas}}",
  "data.versions.title": "Versões de {name}",
  "data.versions.caption": "Versões mantidas de {name}, da mais nova para a mais antiga",
  "data.versions.size": "Tamanho",
  "data.accessLog.csv": "Registro de acesso em CSV",
  "data.accessLog.json": "Registro de acesso em JSON",
  "data.accessLog.csvLabel": "Registro de acesso em CSV de {name}",
  "data.accessLog.jsonLabel": "Registro de acesso em JSON de {name}",
  "data.accessLog.saved": "O registro de acesso está pronto.",
  "data.records.button": "Dados (JSON)",
  "data.records.label": "Dados (JSON) de {name}",
  "data.records.saved": "Os dados estão prontos.",
  "data.records.later":
    "Faltam algumas partes porque o servidor pediu para esperar. Baixe de novo em alguns minutos.",
  "data.records.failed": "Não foi possível baixar os dados.",
  "data.space.title": "Dados do espaço",
  "data.space.hint":
    "As configurações do espaço, sem segredos: para um workspace, seus membros e papéis, grupos e seus membros, convites, domínios de e-mail, políticas, login único e tokens de serviço; para qualquer espaço, a marca, os webhooks, as integrações e os fluxos de auditoria.",
  "data.space.download": "Baixar os dados do espaço (JSON)",
  "data.space.logo": "Baixar o logotipo da marca",
  "data.logs.title": "Registros e conta",
  "data.logs.hint":
    "O registro de auditoria do espaço tem sua própria exportação, e seu espaço pessoal inclui os dados da sua conta.",
  "data.logs.audit": "Exporte o registro de auditoria na página Registro de auditoria",
  "data.logs.account": "Baixe os dados da sua conta (JSON)",
  "data.logs.cli":
    "Para levar tudo de uma vez, rode portifact export <pasta> em um terminal: ele baixa cada versão mantida e os dados de cada artefato, retoma se for interrompido e grava um manifesto. Membros, convites e outras configurações que só o painel lê estão nos dados do espaço acima.",
  "shell.grace.title": "O que o plano {plan} guardava fica até {date}",
  "shell.grace.download": "Baixe seus dados",
  "shell.grace.request": "Peça o {plan} de novo",
  "shell.grace.hide": "Ocultar por hoje",
  "shell.grace.body":
    "Depois dessa data, o que o plano deste espaço não guarda é apagado. Baixe o que precisar ou peça o plano de novo para manter tudo.",
  "shell.grace.bodyAskAdmin":
    "Depois dessa data, o que o plano deste espaço não guarda é apagado. Peça a um administrador do espaço que baixe o que você precisa ou peça o plano de novo.",
  "plan.loading": "Carregando o plano",
  "plan.error": "Não foi possível carregar o plano.",
  "plan.compare.section": "Todos os planos",
  "plan.requestNote": "Só os administradores de {workspace} podem solicitar outro plano.",
  "plan.hidden": "O plano de {workspace} é mostrado aos editores e administradores.",
  "usage.plan.compare": "Comparar planos",
  "shell.auditLink": "Auditoria",
  "audit.title": "Auditoria",
  "audit.description":
    "Quem mudou o quê neste espaço. As mudanças ficam guardadas por {days} dias.",
  "audit.planTitle": "A auditoria faz parte de um plano pago",
  "audit.planRequired":
    "A auditoria faz parte do plano {plan}. As mudanças já são registradas, então os últimos 90 dias aparecem aqui quando o plano a incluir.",
  "audit.forbidden.title": "Só administradores podem ver a auditoria",
  "audit.forbidden.body":
    "Peça a um administrador deste espaço de trabalho se precisar saber quem mudou algo.",
  "audit.loading": "Carregando a auditoria",
  "audit.error.title": "Não foi possível carregar a auditoria",
  "audit.empty.title": "Nenhuma mudança registrada",
  "audit.empty.body": "Nada corresponde a estes filtros nos últimos {days} dias.",
  "audit.caption": "Mudanças neste espaço, da mais recente para a mais antiga",
  "audit.column.when": "Quando",
  "audit.column.who": "Quem",
  "audit.column.what": "O quê",
  "audit.column.on": "Em",
  "audit.loadMore": "Mostrar mudanças anteriores",
  "audit.filters": "Filtrar a auditoria",
  "audit.filter.kind": "Tipo de mudança",
  "audit.filter.actor": "Quem",
  "audit.filter.period": "Período",
  "audit.group.all": "Todas as mudanças",
  "audit.group.access": "Acesso e compartilhamento",
  "audit.group.lifecycle": "Publicação e ciclo de vida",
  "audit.group.integrations": "Domínios, webhooks e marca",
  "audit.group.members": "Membros, tokens e plano",
  "audit.actor.all": "Qualquer pessoa",
  "audit.period.day": "Últimas 24 horas",
  "audit.period.week": "Últimos 7 dias",
  "audit.period.month": "Últimos 30 dias",
  "audit.period.all": "Tudo o que está guardado",
  "audit.actor.removed": "Membro removido",
  "audit.actor.token": "{label} (token de serviço)",
  "audit.actor.tokenGone": "Token de serviço revogado",
  "audit.actor.operator": "Operador do Portifact",
  "audit.actor.system": "Portifact",
  "audit.artifact.gone": "Artifact excluído",
  "audit.target.space": "Este espaço",
  "audit.target.invitation": "Um convite",
  "audit.kind.published": "Publicou a versão {version}",
  "audit.kind.publishedFirst": "Criou com a versão {version}",
  "audit.kind.rolledBack": "Voltou aos arquivos da versão {from}, agora versão {version}",
  "audit.kind.renewed": "Renovou",
  "audit.kind.archived": "Arquivou",
  "audit.kind.restored": "Restaurou",
  "audit.kind.deleted": "Excluiu",
  "audit.kind.pinned": "Fixou",
  "audit.kind.unpinned": "Desafixou",
  "audit.kind.transferredIn":
    "Trouxe para cá de {from, select, workspace {um espaço de trabalho} other {um espaço pessoal}}",
  "audit.kind.transferredOut":
    "Moveu para {to, select, workspace {um espaço de trabalho} other {um espaço pessoal}}",
  "audit.kind.accessChanged": "Mudou o acesso: {changes}",
  "audit.access.mode":
    "{mode, select, public {tornou público} authenticated {abriu para qualquer pessoa conectada} other {restringiu aos leitores da lista}}",
  "audit.access.readersAdded":
    "{count, plural, one {adicionou # leitor} other {adicionou # leitores}}",
  "audit.access.readersRemoved":
    "{count, plural, one {removeu # leitor} other {removeu # leitores}}",
  "audit.access.domains": "em {domains}",
  "audit.access.exceptions":
    "{count, plural, one {mudou quais comentários # leitor vê} other {mudou quais comentários # leitores veem}}",
  "audit.access.bar":
    "{on, select, true {ativou a barra do Portifact} other {desativou a barra do Portifact}}",
  "audit.access.comments":
    "{visibility, select, everyone {mostrou os comentários a todos} other {mostrou os comentários só ao dono}}",
  "audit.access.indexable":
    "{on, select, true {permitiu a indexação em buscadores} other {parou a indexação em buscadores}}",
  "audit.access.embeddable":
    "{on, select, true {permitiu incorporar} other {parou de permitir incorporar}}",
  "audit.kind.shareLinkCreated":
    "Criou um link de compartilhamento{password, select, true { com senha} other {}}{expires, select, true {, que expira} other {}}",
  "audit.kind.shareLinkRevoked": "Revogou um link de compartilhamento",
  "detail.section.reviews": "Revisões",
  "approval.title": "Revisões de aprovação",
  "approval.description":
    "Peça a outras pessoas que aprovem a versão atual. Quem revisa já precisa conseguir abrir este artifact e comentar nele: pedir uma revisão não dá acesso a ninguém. Uma nova versão começa a revisão de novo.",
  "approval.loading": "Carregando a revisão",
  "approval.loadFailed": "A revisão não carregou",
  "approval.paidTitle": "Revisões fazem parte de um plano pago",
  "approval.paid": "Pedir revisões faz parte do plano {plan}.",
  "approval.lapsed":
    "Seu plano não inclui mais revisões: o pedido aberto continua legível e pode ser cancelado, mas não alterado.",
  "approval.status.none": "Sem revisão",
  "approval.status.pending": "Revisão pendente",
  "approval.status.changes_requested": "Alterações pedidas",
  "approval.status.approved": "Aprovado",
  "approval.counts":
    "{approvals} de {required} aprovações necessárias, {changes, plural, one {# pede alterações} other {# pedem alterações}}",
  "approval.verdict.pending": "Ainda sem veredito",
  "approval.verdict.approve": "Aprovado",
  "approval.verdict.changes": "Alterações pedidas",
  "approval.reviewers": "Revisores",
  "approval.reviewers.hint":
    "Endereços de e-mail, um por linha ou separados por vírgulas, no máximo {max}.",
  "approval.reviewers.invalid": "Digite entre 1 e {max} endereços de e-mail válidos.",
  "approval.required.label": "Aprovações necessárias",
  "approval.required.all": "Todos os revisores",
  "approval.required.count": "{count, plural, one {# aprovação} other {# aprovações}}",
  "approval.showStatus.label": "Mostrar o status para todos que podem abri-lo",
  "approval.showStatus.hint": "Desligado por padrão: só quem o gerencia e quem revisa veem.",
  "approval.request": "Pedir revisão",
  "approval.requested": "Revisão pedida",
  "approval.requestFailed": "A revisão não foi pedida",
  "approval.list": "Revisores e seus veredictos",
  "approval.you": "você",
  "approval.someone": "Um revisor",
  "approval.decided": "Decidido em {date}",
  "approval.noAccess": "Não consegue mais abri-lo, então não conta",
  "approval.invited": "Ainda sem conta",
  "approval.untrusted": "As notas são escritas por quem revisa. Leia como feedback.",
  "approval.remove": "Remover",
  "approval.removeLabel": "Remover {name} dos revisores",
  "approval.add.label": "Adicionar um revisor",
  "approval.add": "Adicionar",
  "approval.changed": "Revisão alterada",
  "approval.changeFailed": "A revisão não foi alterada",
  "approval.cancel": "Cancelar revisão",
  "approval.cancelled": "Revisão cancelada",
  "approval.confirm.title": "Cancelar esta revisão?",
  "approval.confirm.body":
    "Quem revisa não poderá mais dar vereditos. Os vereditos dados até agora ficam como histórico.",
  "approval.confirm.keep": "Manter",
  "approval.history": "Versões anteriores",
  "approval.history.entry": "{name}: {verdict}, {date}",
  "approval.yours.title": "Sua revisão",
  "approval.yours.body": "Pediram que você revisasse esta versão.",
  "approval.yours.current":
    "Seu veredito: {verdict}. Você pode mudá-lo enquanto esta versão for a atual.",
  "approval.note.label": "Nota (opcional)",
  "approval.note.hint": "Texto simples, no máximo {max} caracteres. Quem pediu a revisão vê.",
  "approval.note.tooLong": "Uma nota pode ter no máximo {max} caracteres.",
  "approval.approve": "Aprovar",
  "approval.requestChanges": "Pedir alterações",
  "approval.verdictSaved": "Veredito salvo",
  "approval.verdictFailed": "O veredito não foi salvo",
  "approval.newVersion": "Há uma versão mais nova. Recarregue a página para revisá-la.",
  "audit.kind.reviewRequested":
    "{reviewers, plural, one {Pediu a # pessoa que revisasse} other {Pediu a # pessoas que revisassem}}",
  "audit.kind.reviewChanged": "Alterou um pedido de revisão",
  "audit.kind.reviewCancelled": "Cancelou um pedido de revisão",
  "audit.kind.reviewVerdict":
    "{verdict, select, approve {Aprovou a versão {version}} other {Pediu alterações na versão {version}}}",
  "audit.kind.domainAttached": "Conectou o domínio {hostname}",
  "audit.kind.domainRemoved":
    "{reason, select, removed {Removeu o domínio {hostname}} operator {O Portifact removeu o domínio {hostname}} other {O domínio {hostname} foi desconectado automaticamente}}",
  "audit.kind.webhookCreated":
    "Adicionou um webhook {format, select, slack {do Slack} discord {do Discord} other {assinado}} para {host}",
  "audit.kind.webhookChanged":
    "{enabled, select, true {Ativou um webhook} false {Desativou um webhook} other {Mudou os eventos de um webhook}}",
  "audit.kind.webhookRemoved": "Removeu um webhook",
  "audit.kind.brandChanged":
    "{logo, select, true {Mudou o logo da marca} other {Mudou o nome, a cor ou o link da marca}}",
  "audit.kind.brandRemoved":
    "{logo, select, true {Removeu o logo da marca} other {Removeu a marca}}",
  "audit.kind.memberInvited": "Convidou alguém de {domain} como {role}",
  "audit.kind.invitationRevoked": "Revogou um convite",
  "audit.kind.memberJoined": "{member} entrou como {role}",
  "audit.kind.roleChanged": "Mudou {member} de {from} para {to}",
  "audit.kind.memberRemoved": "Removeu {member}",
  "audit.kind.memberLeft": "{member} saiu",
  "audit.kind.planGranted":
    "Definiu o plano {plan} com {seats, plural, one {# vaga} other {# vagas}}",
  "audit.kind.planGrantedUntil":
    "Definiu o plano {plan} com {seats, plural, one {# vaga} other {# vagas}} até {until}",
  "audit.kind.graceStarted":
    "Começou um período de carência ({reason}): o que o plano {plan} guardava fica até {until}",
  "audit.kind.graceEnded":
    "Terminou o período de carência do que o plano {plan} guardava ({reason})",
  "audit.graceStart.lowered": "plano reduzido",
  "audit.graceStart.removed": "plano removido",
  "audit.graceStart.expired": "plano vencido",
  "audit.graceStart.unreadable": "carência ilegível",
  "audit.graceEnd.renewed": "plano renovado",
  "audit.graceEnd.operator": "encerrado pela Portifact",
  "audit.graceEnd.expired": "os dias passaram",
  "audit.graceEnd.folded": "unida a uma posterior",
  "audit.kind.planRemoved": "Removeu o plano, e o espaço voltou ao Free",
  "audit.kind.tokenCreated":
    "Criou um token de serviço que expira em {days, plural, one {# dia} other {# dias}}",
  "audit.kind.tokenRevoked": "Revogou um token de serviço",
  "audit.export.label": "Exportar o log de auditoria",
  "audit.export.csv": "Exportar como CSV",
  "audit.export.jsonl": "Exportar como JSON Lines",
  "audit.export.hint":
    "Baixa todas as mudanças guardadas que correspondem aos filtros, das mais recentes para as mais antigas. Os membros aparecem pelo nome, nunca pelo endereço.",
  "audit.export.doneCsv": "O log de auditoria foi exportado como CSV.",
  "audit.export.doneJsonl": "O log de auditoria foi exportado como JSON Lines.",
  "audit.export.failed": "Não foi possível exportar o log de auditoria",
  "audit.export.planRequired": "Exportar o log de auditoria faz parte do plano {plan}.",
  "audit.kind.exported":
    "{format, select, csv {Exportou o log de auditoria como CSV} other {Exportou o log de auditoria como JSON Lines}}",
  "audit.kind.emailDomainVerified": "Verificou o domínio de email {domain}",
  "audit.kind.emailDomainRemoved":
    "{reason, select, removed {Removeu o domínio de email {domain}} claimed {O domínio de email {domain} foi removido porque outro workspace o comprovou} other {O domínio de email {domain} foi removido porque o registro DNS está ausente}}",
  "shell.serviceTokensLink": "Tokens de serviço",
  "tokens.title": "Tokens de serviço",
  "tokens.description":
    "Credenciais para que automações, como CI, publiquem em {workspace} sem o login de uma pessoa. Cada token tem uma função, permissões e uma validade, e para de funcionar quando você o revoga.",
  "tokens.personal.title": "Tokens de serviço pertencem a um workspace",
  "tokens.personal.body": "Mude para um workspace que você administra para criar tokens para ele.",
  "tokens.adminOnly.title": "Só admins gerenciam tokens de serviço",
  "tokens.adminOnly.body": "Peça um token a um admin deste workspace.",
  "tokens.planTitle": "Tokens de serviço não estão no plano deste workspace",
  "tokens.planRequired":
    "Criar tokens de serviço faz parte do plano {plan}. Os tokens existentes são listados e podem ser revogados, mas não funcionam até o plano incluí-los de novo.",
  "tokens.list.title": "Tokens",
  "tokens.loading": "Carregando tokens de serviço",
  "tokens.loadFailed": "Os tokens de serviço não carregaram",
  "tokens.empty.title": "Nenhum token de serviço ainda",
  "tokens.empty.body":
    "Crie um para um job de CI, salve como o segredo PORTIFACT_TOKEN e rode a CLI portifact.",
  "tokens.secret.title": "Copie o token agora",
  "tokens.secret.body":
    "Esta é a única vez que ele aparece. Guarde-o como segredo do seu CI, por exemplo PORTIFACT_TOKEN. Quem o tiver pode fazer o que as permissões dele permitem até ele expirar ou você revogá-lo.",
  "tokens.secret.label": "Token de serviço {label}",
  "tokens.secret.copy": "Copiar token",
  "tokens.secret.done": "Já guardei",
  "tokens.create.title": "Criar um token",
  "tokens.create.hint": "Ele age pelo workspace, nunca por você, e nunca é membro.",
  "tokens.create.limit":
    "Este workspace já tem o máximo de tokens ({limit}). Revogue um para criar outro.",
  "tokens.create.label": "Rótulo",
  "tokens.create.labelHint": "Onde é usado, como prévias do GitHub",
  "tokens.create.labelError": "Digite um rótulo de 1 a 80 caracteres.",
  "tokens.create.scopes": "O que ele pode fazer",
  "tokens.create.scopesError": "Escolha pelo menos uma.",
  "tokens.create.expiry": "Expira após",
  "tokens.create.expiryHint": "Quando expirar, um token novo o substitui.",
  "tokens.create.days": "{days, plural, one {# dia} other {# dias}}",
  "tokens.create.restriction": "Limitar a",
  "tokens.create.prefix": "Prefixo de chave",
  "tokens.create.prefixHint":
    "Cada artifact que ele publicar precisa de uma chave começando assim, como pr-.",
  "tokens.create.prefixError":
    "Use letras, dígitos, pontos, sublinhados, barras ou hifens, começando com uma letra ou um dígito.",
  "tokens.create.submit": "Criar token",
  "tokens.scope.read": "Ler",
  "tokens.scope.readHint": "Listar artifacts e suas versões",
  "tokens.scope.write": "Publicar",
  "tokens.scope.writeHint": "Publicar artifacts e versões novas, renovar e arquivar",
  "tokens.scope.share": "Compartilhar",
  "tokens.scope.shareHint":
    "Mudar quem pode abrir um artifact, inclusive torná-lo público. Um token vazado poderia expor artifacts.",
  "tokens.scope.delete": "Excluir",
  "tokens.scope.deleteHint":
    "Excluir artifacts para sempre. Um token vazado poderia destruí-los; limite-o a um prefixo de chave.",
  "tokens.restriction.none": "Todos os artifacts do workspace",
  "tokens.restriction.noneHint": "O token alcança todos os artifacts do workspace.",
  "tokens.restriction.own": "Artifacts que ele criou",
  "tokens.restriction.ownHint":
    "O que pessoas ou outros tokens publicarem parece inexistente para ele.",
  "tokens.restriction.key": "Artifacts com um prefixo de chave",
  "tokens.restriction.keyHint":
    "Só artifacts publicados com uma chave sob o prefixo que você escolher.",
  "tokens.created": "Token {label} criado",
  "tokens.actionFailed": "Não deu certo",
  "tokens.reach.none": "Alcança todos os artifacts do workspace",
  "tokens.reach.own": "Alcança só os artifacts que criou",
  "tokens.reach.key": "Alcança só chaves que começam com {prefix}",
  "tokens.expired": "Expirado",
  "tokens.revoke": "Revogar",
  "tokens.revokeLabel": "Revogar {label}",
  "tokens.scopes": "Permissões: {scopes}",
  "tokens.expiresOn": "Expira em {date}",
  "tokens.expiredOn": "Expirou em {date}",
  "tokens.lastUsed": "Último uso {when}",
  "tokens.neverUsed": "Nunca usado",
  "tokens.createdBy": "Criado por {name} em {date}",
  "tokens.createdOn": "Criado em {date}",
  "tokens.revoked": "Token {label} revogado",
  "tokens.confirm.title": "Revogar {label}?",
  "github.title": "GitHub Actions",
  "github.hint":
    "Permite que os workflows de um repositório confiável publiquem previews sem um token guardado.",
  "github.off":
    "O acesso com GitHub Actions ainda não está disponível no Portifact. Mesmo assim, você pode remover os repositórios desta lista.",
  "github.audience": "Audiência",
  "github.audienceCopy": "Copiar audiência",
  "github.audienceHint":
    "O workflow pede ao GitHub um ID token com esta audiência. A ação de previews e a CLI fazem isso por você.",
  "github.loading": "Carregando repositórios confiáveis",
  "github.loadFailed": "Não foi possível carregar os repositórios confiáveis.",
  "github.empty.title": "Nenhum repositório confiável",
  "github.empty.body":
    "Confie em um repositório para que os workflows dele publiquem previews neste workspace sem um token.",
  "github.create.title": "Confiar em um repositório",
  "github.create.hint":
    "A confiança fica ligada aos IDs numéricos do GitHub: um repositório renomeado continua confiável, um apagado e criado de novo não.",
  "github.create.repository": "Repositório",
  "github.create.repositoryHint": "Como dono/nome. Só é mostrado às pessoas; nunca é verificado.",
  "github.create.repositoryError": "Use dono/nome, como acme/site.",
  "github.create.repositoryId": "ID do repositório",
  "github.create.ownerId": "ID do dono",
  "github.create.idsHint":
    "Encontre os dois com gh api repos/OWNER/REPO --jq .id,.owner.id, ou em GITHUB_REPOSITORY_ID e GITHUB_REPOSITORY_OWNER_ID de uma execução.",
  "github.create.idError": "Use o número que o GitHub mostra.",
  "github.create.events": "Eventos que podem publicar",
  "github.create.eventsError": "Escolha pelo menos um evento.",
  "github.event.push": "push",
  "github.event.pushHint":
    "Pushes para o repositório. Só pessoas com permissão de escrita podem fazê-los.",
  "github.event.pull_request": "pull_request",
  "github.event.pull_requestHint":
    "Pull requests. Em um repositório público a execução de um fork não recebe ID token, então só os branches do próprio repositório publicam. Em um privado com tokens de escrita para forks, a execução de um fork também pode publicar.",
  "github.event.workflow_dispatch": "workflow_dispatch",
  "github.event.workflow_dispatchHint":
    "Execuções iniciadas manualmente por pessoas com permissão de escrita.",
  "github.event.merge_group": "merge_group",
  "github.event.merge_groupHint":
    "Execuções da fila de merge, iniciadas pelo GitHub para o repositório.",
  "github.event.release": "release",
  "github.event.releaseHint": "Releases publicadas no repositório.",
  "github.event.schedule": "schedule",
  "github.event.scheduleHint": "Execuções agendadas do branch principal.",
  "github.event.pull_request_target": "pull_request_target",
  "github.event.pull_request_targetHint":
    "Execuções privilegiadas que o pull request de um fork pode iniciar. Seguras só se o workflow nunca compilar o código do fork.",
  "github.event.workflow_run": "workflow_run",
  "github.event.workflow_runHint":
    "Execuções privilegiadas iniciadas por outro workflow, que o pull request de um fork pode disparar. Seguras só se o workflow nunca compilar o código do fork.",
  "github.create.privileged":
    "Entendo que o pull request de um fork pode iniciar essas execuções e que o workflow nunca compila o código dele",
  "github.create.privilegedError": "Confirme para confiar em pull_request_target ou workflow_run.",
  "github.create.ref": "Ref (opcional)",
  "github.create.refHint":
    "Exata, como refs/heads/main. A ref de uma execução de pull request é refs/pull/NÚMERO/merge, então com uma ref de branch nenhum pull request publica.",
  "github.create.refError": "Use uma ref completa que comece com refs/.",
  "github.create.environment": "Ambiente (opcional)",
  "github.create.environmentHint":
    "Nome exato. O GitHub aplica as regras de proteção do ambiente, como revisores obrigatórios, antes de o job receber o token.",
  "github.create.scopes": "O que as execuções podem fazer",
  "github.create.scopesError": "Escolha pelo menos um.",
  "github.create.submit": "Confiar no repositório",
  "github.create.limit": "Um workspace pode confiar em no máximo {limit} repositórios.",
  "github.created": "Agora {repository} é confiável.",
  "github.rule.ids": "ID do repositório {repositoryId}, ID do dono {ownerId}",
  "github.rule.events": "Eventos: {events}",
  "github.rule.prefix": "Publica só chaves que começam com {prefix}",
  "github.rule.ref": "Ref: {ref}",
  "github.rule.environment": "Ambiente: {environment}",
  "github.rule.live":
    "{count, plural, =0 {Nenhuma credencial ativa} one {# credencial ativa} other {# credenciais ativas}}",
  "github.remove": "Remover",
  "github.removeLabel": "Remover {repository}",
  "github.confirm.title": "Deixar de confiar em {repository}?",
  "github.confirm.body":
    "Os workflows dele não poderão mais publicar, e as credenciais já emitidas para as execuções param de funcionar na hora.",
  "github.removed": "{repository} não é mais confiável.",
  "audit.kind.githubTrusted": "Confiou no repositório do GitHub {repository}",
  "audit.kind.githubTrustChanged": "Mudou a confiança no repositório do GitHub {repository}",
  "audit.kind.githubTrustRemoved": "Deixou de confiar no repositório do GitHub {repository}",
  "audit.kind.githubExchanged": "A execução do GitHub {run} de {repository} recebeu uma credencial",
  "tokens.confirm.body":
    "Tudo que o usa para de funcionar na próxima requisição. Não dá para desfazer.",
  "access.workspace": "Todo o workspace",
  "access.domain": "O workspace e seus domínios de e-mail",
  "list.access.workspace": "Workspace",
  "list.access.domain": "Domínio de e-mail",
  "accessSettings.mode.workspace":
    "{count, plural, one {O # membro deste workspace} other {Os # membros deste workspace}}, depois de entrar, com qualquer função.",
  "accessSettings.mode.domain":
    "{count, plural, one {O # membro deste workspace} other {Os # membros deste workspace}} e qualquer pessoa conectada com um endereço verificado em {domains}.",
  "accessSettings.mode.domainNone":
    "{count, plural, one {O # membro deste workspace} other {Os # membros deste workspace}} e qualquer pessoa conectada com um endereço verificado nos domínios de e-mail do workspace. Ainda não há domínio verificado: um admin adiciona um na página Membros.",
  "accessSettings.mode.listOnlyRestricted":
    "As pessoas listadas abaixo só podem abri-lo enquanto ele estiver restrito.",
  "accessSettings.mode.workspacePlan": "Faz parte do plano {plan}.",
  "accessSettings.lapsed.title": "Por enquanto só os membros podem abrir este artifact",
  "accessSettings.lapsed.body":
    "O plano do workspace não inclui agora o compartilhamento com domínios de e-mail, então só os membros podem abrir este artifact até que o plano volte a incluí-lo. Nada foi alterado.",
  "emailDomains.title": "Domínios de e-mail",
  "emailDomains.description":
    "Qualquer pessoa conectada ao Portifact com um endereço verificado em um destes domínios pode abrir os artifacts do workspace compartilhados com seus domínios de e-mail. Só conta o domínio exato, não os subdomínios.",
  "emailDomains.loading": "Carregando domínios de e-mail",
  "emailDomains.loadFailed": "Os domínios de e-mail não carregaram",
  "emailDomains.rules":
    "Comprove cada domínio com um registro DNS. Provedores de e-mail públicos (como gmail.com), sufixos compartilhados e os domínios do Portifact são recusados. O Portifact verifica o registro todo dia e remove um domínio depois de 3 verificações falhas seguidas.",
  "emailDomains.addFailed": "O domínio não foi adicionado",
  "emailDomains.add": "Adicionar domínio",
  "emailDomains.domain": "Domínio",
  "emailDomains.domainHint":
    "O domínio próprio da sua organização, como example.com. Até {limit} domínios.",
  "emailDomains.domainRequired": "Digite um domínio.",
  "emailDomains.empty": "Ainda não há domínios de e-mail.",
  "emailDomains.added": "{domain} foi adicionado. Crie o registro TXT e depois verifique.",
  "emailDomains.planTitle": "Domínios de e-mail fazem parte de um plano pago",
  "emailDomains.plan":
    "Verificar domínios de e-mail faz parte do plano {plan}. Os domínios já listados ficam, e você ainda pode removê-los.",
  "emailDomains.state.verified": "Verificado",
  "emailDomains.state.pending": "Aguardando o registro DNS",
  "emailDomains.verifiedOn": "Verificado em {date}.",
  "emailDomains.pendingUntil": "Crie o registro antes de {date}, ou a solicitação é descartada.",
  "emailDomains.failing.title": "O registro DNS está faltando",
  "emailDomains.failing.body":
    "{count, plural, one {O registro estava faltando na última verificação diária.} other {O registro estava faltando nas últimas # verificações diárias seguidas.}} {left, plural, one {Depois de mais # verificação falha o domínio é removido.} other {Depois de mais # verificações falhas o domínio é removido.}}",
  "emailDomains.actionFailed": "A alteração não foi salva",
  "emailDomains.recordHint":
    "Crie este registro no seu provedor de DNS. Pode demorar um pouco para aparecer.",
  "emailDomains.verify": "Verificar",
  "emailDomains.verifyNamed": "Verificar {domain}",
  "emailDomains.remove": "Remover",
  "emailDomains.removeNamed": "Remover {domain}",
  "emailDomains.verified": "{domain} está verificado.",
  "emailDomains.removed": "{domain} foi removido.",
  "emailDomains.confirmRemove.title": "Remover {domain}?",
  "emailDomains.confirmRemove.body":
    "Quem abre artifacts só por causa deste domínio perde o acesso em um minuto. Você pode adicioná-lo de novo depois com um registro novo.",
  "emailDomains.confirmRemove.action": "Remover domínio",
  "emailDomains.error.quota_exceeded": "O workspace já tem o máximo de domínios de e-mail.",
  "emailDomains.error.version_conflict":
    "O domínio mudou nesse meio-tempo, ou outro workspace ainda o comprova no DNS. Recarregue e tente de novo.",
  "emailDomains.error.capacity_unavailable":
    "Não foi possível verificar o DNS agora. Tente de novo em instantes.",
  "emailDomains.error.not_found": "Esse domínio não está mais na lista.",
  "emailDomains.error.refused":
    "Este domínio não pode ser adicionado. Use o domínio próprio da sua organização: provedores de e-mail públicos, sufixos compartilhados, nomes reservados e os domínios do Portifact são recusados.",
  "emailDomains.error.recordMissing":
    "O registro TXT ainda não foi encontrado com o valor deste domínio. Mudanças de DNS podem demorar a aparecer; tente de novo mais tarde. Uma solicitação com mais de 7 dias precisa ser adicionada de novo.",
  "transfer.confirm.accessReset":
    "Agora ele é compartilhado com o workspace ou um domínio de e-mail, então passa a ser restrito: só as pessoas da lista de leitores continuam lendo.",
  "shell.groupsLink": "Grupos",
  "groups.title": "Grupos",
  "groups.description":
    "Conjuntos nomeados de membros de {workspace}. Adicione um grupo a um artifact restrito e os membros dele poderão abri-lo, como os leitores da lista.",
  "groups.personal.title": "Grupos pertencem a um workspace",
  "groups.personal.body":
    "Mude para um workspace que você administra para gerenciar os grupos dele.",
  "groups.adminOnly.title": "Só administradores gerenciam grupos",
  "groups.adminOnly.body":
    "Editores escolhem grupos nas configurações de compartilhamento de um artifact. Peça a um administrador deste workspace para criar ou mudar um.",
  "groups.planTitle": "Grupos não estão no plano deste workspace",
  "groups.planRequired":
    "Grupos fazem parte do plano {plan}. Os grupos existentes podem ser renomeados, esvaziados e excluídos, mas não dão acesso a ninguém até o plano incluí-los de novo.",
  "groups.list.title": "Grupos",
  "groups.loading": "Carregando grupos",
  "groups.loadFailed": "Os grupos não carregaram",
  "groups.empty.title": "Nenhum grupo ainda",
  "groups.empty.body":
    "Crie um grupo, adicione membros e depois adicione-o nas configurações de compartilhamento de um artifact restrito.",
  "groups.create.title": "Criar um grupo",
  "groups.create.hint":
    "Administradores e editores veem o nome dele quando escolhem quem pode abrir um artifact.",
  "groups.create.limit": "Um workspace pode ter no máximo {limit} grupos. Exclua um primeiro.",
  "groups.create.name": "Nome",
  "groups.create.submit": "Criar grupo",
  "groups.nameError": "Use uma linha de 1 a {max} caracteres.",
  "groups.actionFailed": "O grupo não mudou",
  "groups.created": "O grupo {name} foi criado.",
  "groups.memberCount": "{count, plural, one {# membro} other {# membros}}",
  "groups.showMembers": "Membros",
  "groups.hideMembers": "Ocultar membros",
  "groups.rename": "Renomear",
  "groups.renameLabel": "Renomear {name}",
  "groups.renameField": "Novo nome para {name}",
  "groups.save": "Salvar nome",
  "groups.renamed": "O grupo agora se chama {name}.",
  "groups.delete": "Excluir",
  "groups.deleteLabel": "Excluir {name}",
  "groups.deleted": "O grupo {name} foi excluído.",
  "groups.confirm.title": "Excluir {name}?",
  "groups.confirm.body":
    "Os membros dele deixam de ler os artifacts que o incluem em até um minuto, a menos que outra coisa lhes dê acesso. Isso não pode ser desfeito.",
  "groups.membersLoading": "Carregando os membros do grupo",
  "groups.noMembers": "Ninguém está neste grupo ainda.",
  "groups.membersOf": "Membros de {name}",
  "groups.removeMember": "Remover",
  "groups.removeMemberLabel": "Remover {name} de {group}",
  "groups.memberRemoved": "{name} foi removido de {group}.",
  "groups.addMember": "Adicionar um membro a {name}",
  "groups.chooseMember": "Escolha um membro",
  "groups.add": "Adicionar",
  "groups.memberAdded": "{name} foi adicionado a {group}.",
  "groupAccess.title": "Grupos",
  "groupAccess.hint":
    "Membros destes grupos do workspace podem abri-lo depois de entrar, como os leitores da lista.",
  "groupAccess.onlyRestricted":
    "Os grupos só dão acesso aos membros enquanto o acesso é restrito; em outros modos mantêm apenas as exceções de comentários.",
  "groupAccess.count": "{count} de {max} grupos",
  "groupAccess.planTitle": "Grupos não estão no plano deste workspace",
  "groupAccess.planRequired":
    "Adicionar grupos faz parte do plano {plan}. Os grupos já adicionados não dão acesso a ninguém até o plano incluí-los de novo, e você ainda pode removê-los.",
  "groupAccess.failed.title": "Os grupos não mudaram",
  "groupAccess.empty": "Nenhum grupo adicionado.",
  "groupAccess.list": "Grupos que podem abrir este artifact",
  "groupAccess.removeLabel": "Remover o grupo {name}",
  "groupAccess.removed": "O grupo {name} foi removido.",
  "groupAccess.full": "Um artifact pode incluir no máximo {max} grupos.",
  "groupAccess.none":
    "Este workspace ainda não tem grupos. Os administradores os criam na página Grupos.",
  "groupAccess.added": "O grupo {name} foi adicionado.",
  "groupAccess.pick": "Adicionar um grupo",
  "groupAccess.choose": "Escolha um grupo",
  "groupAccess.option": "{name} ({count, plural, one {# membro} other {# membros}})",
  "groupAccess.add": "Adicionar grupo",
  "groupAccess.comments.label": "Comentários que o grupo {name} vê",
  "groupAccess.comments.changed": "O grupo {name} agora vê: {choice}.",
  "groupAccess.comments.confirm.title": "Mostrar todos os comentários a {name}?",
  "groupAccess.comments.confirm.body":
    "Cada membro de {name} verá todas as conversas de comentários deste artifact, incluindo as que outros leitores começaram antes.",
  "audit.group.groups": "Grupos",
  "audit.kind.groupCreated": "Criou o grupo {group}",
  "audit.kind.groupRenamed": "Renomeou um grupo, agora {group}",
  "audit.kind.groupDeleted": "Excluiu o grupo {group}",
  "audit.kind.groupMemberAdded": "Adicionou {member} ao grupo {group}",
  "audit.kind.groupMemberRemoved": "Removeu {member} do grupo {group}",
  "audit.target.groupGone": "um grupo excluído",
  "audit.access.groupsAdded": "{count, plural, one {adicionou # grupo} other {adicionou # grupos}}",
  "audit.access.groupsRemoved": "{count, plural, one {removeu # grupo} other {removeu # grupos}}",
  "audit.access.groupExceptions":
    "{count, plural, one {mudou a visibilidade de comentários de # grupo} other {mudou a visibilidade de comentários de # grupos}}",
  // Single sign-on (premium plan E1, decision 0016).
  "sso.title": "Login único",
  "sso.description":
    "Pessoas com um endereço nos domínios de e-mail verificados do workspace podem entrar pelo provedor de identidade da sua organização com OpenID Connect.",
  "sso.loadFailed": "Não foi possível carregar o login único",
  "sso.stateLabel": "Estado",
  "sso.state.off": "Não configurado",
  "sso.state.on": "Ativo",
  "sso.state.plan": "Pausado: fora deste plano",
  "sso.state.domains": "Pausado: nenhum domínio verificado",
  "sso.planTitle": "Fora deste plano",
  "sso.plan":
    "O login único faz parte do plano {plan}. Um provedor já configurado continua, e você ainda pode removê-lo.",
  "sso.lapsedTitle": "Um domínio não está mais verificado",
  "sso.lapsed":
    "{domains} não está mais verificado, então seus endereços não podem entrar assim até o domínio ser verificado de novo.",
  "sso.membership":
    "Quem entra assim passa a fazer parte do workspace como membro, ou com o papel de um convite pendente, enquanto houver vaga. Membros atuais mantêm o papel.",
  "sso.removalNote":
    "Quem um admin remove não pode voltar pelo login único até um admin convidar de novo. Quem sai por conta própria pode.",
  "sso.redirectUri": "URI de redirecionamento",
  "sso.redirectPending":
    "Salve o provedor para obter a URI de redirecionamento a registrar no seu provedor de identidade. Ela tem este formato: {pattern}.",
  "sso.saveFailed": "A alteração não foi salva",
  "sso.testOkTitle": "A descoberta funciona",
  "sso.testOk": "O login vai para {authorization}, os tokens vêm de {token} e as chaves de {keys}.",
  "sso.testOkShort": "A descoberta funciona.",
  "sso.testFailed": "A descoberta falhou",
  "sso.formLabel": "Provedor de login único",
  "sso.issuer": "URL do emissor",
  "sso.issuerHint":
    "O emissor do seu provedor de identidade, por exemplo https://login.example.com. O Portifact lê o documento de descoberta dele. Não pode mudar depois de salvo.",
  "sso.clientId": "ID do cliente",
  "sso.clientSecret": "Segredo do cliente",
  "sso.secretHint": "Guardado criptografado e nunca mostrado de novo.",
  "sso.secretKeep": "Deixe em branco para manter o segredo guardado.",
  "sso.domains": "Domínios atendidos",
  "sso.domainsHint":
    "Somente os domínios de e-mail verificados do workspace. Um endereço de outro domínio não pode entrar assim.",
  "sso.noDomains": "Verifique um domínio de e-mail acima primeiro.",
  "sso.issuerRequired": "Informe a URL do emissor.",
  "sso.clientIdRequired": "Informe o ID do cliente.",
  "sso.secretRequired": "Informe o segredo do cliente.",
  "sso.domainsRequired": "Escolha pelo menos um domínio.",
  "sso.save": "Salvar",
  "sso.saveChanges": "Salvar alterações",
  "sso.test": "Verificar o emissor",
  "sso.remove": "Remover o login único",
  "sso.saved": "Login único salvo.",
  "sso.removed": "Login único removido.",
  "sso.scim":
    "Remover alguém no seu provedor de identidade não remove a pessoa aqui: remova-a da lista de membros.",
  "sso.confirmRemove.title": "Remover o login único?",
  "sso.confirmRemove.body":
    "Ninguém mais poderá entrar por este provedor. Os membros continuam membros e mantêm as contas; entram com um código por e-mail, Google ou GitHub. Um novo provedor recebe uma nova URI de redirecionamento.",
  "sso.confirmRemove.action": "Remover",
  "sso.problem.invalid_issuer":
    "O emissor precisa ser uma URL https pública sem consulta nem fragmento.",
  "sso.problem.unreachable": "Não foi possível acessar o provedor de identidade.",
  "sso.problem.timeout": "O provedor de identidade demorou demais para responder.",
  "sso.problem.redirect":
    "O provedor de identidade respondeu com um redirecionamento, que o Portifact não segue. Use o emissor para o qual ele redireciona.",
  "sso.problem.http_error": "O provedor de identidade respondeu com um erro.",
  "sso.problem.too_large": "A resposta do provedor de identidade é grande demais.",
  "sso.problem.not_json": "O documento de descoberta não é um JSON válido.",
  "sso.problem.issuer_mismatch":
    "O documento de descoberta indica outro emissor. Use o emissor exatamente como o documento diz.",
  "sso.problem.missing_endpoint":
    "Falta no documento de descoberta o endpoint de autorização, de tokens ou de chaves.",
  "sso.problem.invalid_endpoint":
    "Um endpoint do documento de descoberta não é uma URL https pública.",
  "sso.problem.no_code_flow":
    "O provedor de identidade não oferece o fluxo de código de autorização.",
  "sso.problem.no_pkce": "O provedor de identidade não aceita PKCE com S256.",
  "sso.problem.no_signing_algorithm":
    "O provedor de identidade assina os ID tokens com um algoritmo que o Portifact não aceita (famílias RS256, PS256, ES256 ou EdDSA).",
  "sso.error.invalid_input":
    "Confira o emissor, o cliente e os domínios. Verificar o emissor mostra o que falhou na descoberta.",
  "sso.error.capacity_unavailable": "O login único não está disponível agora.",
  "sso.error.version_conflict": "O login único mudou nesse meio-tempo. Recarregue e tente de novo.",
  "sso.error.not_found": "O login único não está configurado.",
  "audit.kind.memberJoinedSso": "{member} entrou como {role} pelo login único",
  "audit.kind.ssoCreated":
    "Configurou o login único com {host} para {count, plural, one {# domínio} other {# domínios}}",
  "audit.kind.ssoChanged": "Alterou o login único",
  "audit.kind.ssoRemoved": "Removeu o login único",
  "shell.policiesLink": "Políticas",
  "policies.title": "Políticas",
  "policies.description":
    "Regras para todos os artefatos de {workspace}. Valem para todos que atuam sobre os artefatos, incluindo administradores e tokens de serviço.",
  "policies.personal.title": "Políticas são dos espaços de trabalho",
  "policies.personal.body":
    "Um espaço pessoal não tem políticas. Troque para um espaço de trabalho para ver as dele.",
  "policies.loading": "Carregando as políticas",
  "policies.loadFailed": "Não foi possível carregar as políticas",
  "policies.planTitle": "Definir políticas faz parte do plano {plan}",
  "policies.planRequired":
    "O plano do espaço de trabalho não inclui políticas. As já definidas continuam valendo, e os administradores ainda podem afrouxá-las ou removê-las.",
  "policies.readOnly.title": "Definidas pelos administradores",
  "policies.readOnly.body": "Só administradores mudam as políticas. Elas também valem para você.",
  "policies.adminsToo": "Estas políticas também valem para administradores.",
  "policies.public.legend": "Acesso público",
  "policies.public.allowed": "Permitido",
  "policies.public.allowedHint":
    "Administradores e editores podem tornar um artefato público, então qualquer pessoa com o link pode abri-lo.",
  "policies.public.forbidden": "Proibido",
  "policies.public.forbiddenHint":
    "Nenhum artefato do espaço de trabalho pode ser público. Artefatos públicos passam a ser compartilhados com o espaço de trabalho.",
  "policies.default.legend": "Acesso de artefatos novos",
  "policies.default.hint":
    "Com o que um artefato novo do espaço de trabalho começa. Os existentes mantêm o seu.",
  "policies.default.restricted": "Só o lado dono e os leitores adicionados podem abri-lo.",
  "policies.default.workspace": "Qualquer membro do espaço de trabalho pode abri-lo.",
  "policies.default.domain":
    "Membros e qualquer pessoa conectada com um endereço verificado dos domínios de e-mail do espaço de trabalho podem abri-lo.",
  "policies.default.domainNone": "Verifique primeiro um domínio de e-mail na página Membros.",
  "policies.readers.legend": "Domínios de leitores",
  "policies.readers.any": "Qualquer endereço",
  "policies.readers.anyHint": "Leitores podem ser adicionados com qualquer endereço de e-mail.",
  "policies.readers.only": "Só estes domínios",
  "policies.readers.onlyHint":
    "Leitores só podem ser adicionados destes domínios de e-mail. Membros e grupos não são afetados.",
  "policies.readers.domains": "Domínios permitidos",
  "policies.readers.domainsHint": "Um por linha, como example.com, no máximo {max}.",
  "policies.readers.domainsError": "Escreva entre 1 e {max} domínios simples, como example.com.",
  "policies.links.legend": "Links de compartilhamento",
  "policies.links.allowed": "Permitidos",
  "policies.links.allowedHint":
    "Administradores e editores podem criar links de compartilhamento, com ou sem senha.",
  "policies.links.password_required": "Senha obrigatória",
  "policies.links.password_requiredHint":
    "Todo link precisa de senha. Os que não têm deixam de abrir.",
  "policies.links.disabled": "Desativados",
  "policies.links.disabledHint": "Sem links de compartilhamento. Os existentes são revogados.",
  "policies.lifetime.label": "Vida máxima de um link, em dias",
  "policies.lifetime.hint": "Deixe vazio para não limitar. Links mais antigos deixam de abrir.",
  "policies.lifetime.error": "Escreva um número inteiro de dias de 1 a {max}, ou deixe vazio.",
  "policies.save": "Salvar políticas",
  "policies.saved": "As políticas foram salvas.",
  "policies.saveFailed": "As políticas não foram salvas",
  "policies.conflict":
    "Alguém mudou as políticas nesse meio-tempo. Elas foram carregadas de novo: revise e salve.",
  "policies.impact.title": "Aplicar estas políticas aos artefatos existentes?",
  "policies.impact.body": "Salvar muda o que já existe em {workspace}:",
  "policies.impact.public":
    "{count, plural, one {# artefato público passa a ser compartilhado com o espaço de trabalho} other {# artefatos públicos passam a ser compartilhados com o espaço de trabalho}}",
  "policies.impact.readers":
    "{count, plural, one {# leitor fora dos domínios permitidos é removido} other {# leitores fora dos domínios permitidos são removidos}}",
  "policies.impact.revoked":
    "{count, plural, one {# link é revogado} other {# links são revogados}}",
  "policies.impact.password":
    "{count, plural, one {# link sem senha deixa de abrir} other {# links sem senha deixam de abrir}}",
  "policies.impact.lifetime":
    "{count, plural, one {# link além da vida máxima deixa de abrir} other {# links além da vida máxima deixam de abrir}}",
  "policies.impact.note":
    "Isso acontece em segundo plano, em lotes pequenos, e fica registrado no log de auditoria.",
  "policies.impact.confirm": "Aplicar e salvar",
  "policies.impact.cancel": "Continuar editando",
  "policies.note.publicForbidden": "A política do espaço de trabalho proíbe acesso público.",
  "policies.note.readerDomains":
    "A política do espaço de trabalho só permite leitores de {domains}.",
  "policies.note.linksDisabled":
    "A política do espaço de trabalho não permite links de compartilhamento.",
  "policies.note.linksPassword":
    "A política do espaço de trabalho exige senha em todo link de compartilhamento.",
  "policies.note.linksLifetime":
    "A política do espaço de trabalho limita os links a {days, plural, one {# dia} other {# dias}}.",
  "error.policy_refused": "Uma política do espaço de trabalho não permite isso.",
  "error.terms_not_accepted":
    "Aceite os termos atuais para continuar. Recarregue a página para revisá-los.",
  "audit.group.policies": "Políticas",
  "audit.kind.policyChanged": "Mudou as políticas do espaço de trabalho: {changes}",
  "audit.kind.policyEnforced": "Aplicou as políticas do espaço de trabalho: {changes}",
  "audit.policy.public":
    "{value, select, forbidden {acesso público proibido} other {acesso público permitido}}",
  "audit.policy.default":
    "{mode, select, workspace {artefatos novos compartilhados com o espaço de trabalho} domain {artefatos novos compartilhados com os domínios de e-mail} other {artefatos novos restritos}}",
  "audit.policy.readers": "leitores só de {domains}",
  "audit.policy.readersAny": "leitores de qualquer domínio",
  "audit.policy.links":
    "{value, select, disabled {links desativados} password_required {links com senha obrigatória} other {links permitidos}}",
  "audit.policy.lifetime": "links de no máximo {days, plural, one {# dia} other {# dias}}",
  "audit.policy.lifetimeNone": "sem limite de vida para os links",
  "audit.policy.narrowed":
    "{count, plural, one {restringiu # artefato ao espaço de trabalho} other {restringiu # artefatos ao espaço de trabalho}}",
  "audit.policy.readersRemoved":
    "{count, plural, one {removeu # leitor} other {removeu # leitores}}",
  "audit.policy.linksRevoked": "{count, plural, one {revogou # link} other {revogou # links}}",
  "audit.policy.sessionsEnded":
    "{count, plural, one {encerrou # sessão de link} other {encerrou # sessões de link}}",
  "policies.impact.stale":
    "O que esta política muda nos artefatos existentes aumentou desde a sua revisão. Salve de novo para revisar os números novos.",
  "policies.savedWithChanges":
    "Os artefatos existentes estão sendo ajustados às políticas. As páginas deles e o log de auditoria mostram o que mudou.",
  "policies.default.domainLapsed":
    "Nenhum domínio de e-mail está verificado, então artefatos novos começam compartilhados com o espaço de trabalho até que um seja verificado.",
  "audit.access.byPolicy": "pela política do espaço de trabalho",
  "audit.actor.directory": "{label} (diretório)",
  "audit.actor.directoryGone": "Diretório (token SCIM revogado)",
  "audit.kind.memberJoinedDirectory": "{member} entrou como {role} pelo diretório",
  "audit.kind.memberProvisioned":
    "Provisionou alguém de {domain} como {role}; entra ao fazer login",
  "audit.kind.scimTokenCreated": "Criou um token SCIM ({days, plural, one {# dia} other {# dias}})",
  "audit.kind.scimTokenRevoked": "Revogou um token SCIM",
  "audit.kind.scimEmailsOn": "Ativou os e-mails de convite para pessoas provisionadas",
  "audit.kind.scimEmailsOff": "Desativou os e-mails de convite para pessoas provisionadas",
  "pending.directory": "Do diretório",
  "pending.directoryDetail":
    "{role}, provisionado pelo diretório: entra no primeiro login, ocupa uma vaga até {date}",
  "scim.title": "Sincronização de diretório (SCIM)",
  "scim.description":
    "Deixe seu provedor de identidade adicionar e remover as pessoas do espaço de trabalho. Ele provisiona endereços dos seus domínios de e-mail verificados; quem não tem conta no Portifact entra no primeiro login com esse endereço.",
  "scim.loadFailed": "Não foi possível carregar a sincronização de diretório",
  "scim.baseUrl": "URL base do SCIM",
  "scim.baseUrlCopy": "Copiar URL",
  "scim.baseUrlHint":
    "Cole no seu provedor de identidade como URL base do SCIM ou URL do locatário, e um token abaixo como token de portador.",
  "scim.planTitle": "Fora deste plano",
  "scim.plan":
    "A sincronização de diretório precisa do plano {plan}. Até lá as solicitações do diretório são recusadas; você ainda pode revogar os tokens.",
  "scim.rules":
    "Pessoas novas entram como membros. Desativar alguém no diretório remove a pessoa do espaço de trabalho e encerra todas as sessões dela; a conta e o espaço pessoal continuam dela. Quem for removido aqui manualmente não volta na próxima sincronização.",
  "scim.lastSync": "Última sincronização",
  "scim.lastSyncNever": "O diretório ainda não se conectou.",
  "scim.pendingLabel": "Aguardando login",
  "scim.pending":
    "{count, plural, =0 {Ninguém} one {# pessoa, nos convites pendentes} other {# pessoas, nos convites pendentes}}",
  "scim.tokens": "Tokens",
  "scim.tokensEmpty": "Nenhum token ainda.",
  "scim.tokenExpires": "Expira em {date}",
  "scim.tokenExpired": "Expirou em {date}",
  "scim.tokenUsed": "último uso em {date}",
  "scim.tokenUnused": "nunca usado",
  "scim.create": "Criar um token SCIM",
  "scim.label": "Rótulo",
  "scim.labelHint": "Por exemplo, o nome do provedor de identidade.",
  "scim.labelRequired": "Digite um rótulo de até 80 caracteres.",
  "scim.expiry": "Expira após",
  "scim.days": "{count, plural, one {# dia} other {# dias}}",
  "scim.limit":
    "Um espaço de trabalho tem no máximo {count} tokens SCIM, para que um substitua outro sem interrupção. Revogue um para criar outro.",
  "scim.secret.title": "Copie o token agora",
  "scim.secret.body":
    "Ele aparece só uma vez. Cole no seu provedor de identidade como token de portador.",
  "scim.secret.label": "Token SCIM {label}",
  "scim.secret.copy": "Copiar token",
  "scim.secret.done": "Já salvei",
  "scim.revoke": "Revogar",
  "scim.revokeNamed": "Revogar: {label}",
  "scim.confirmRevoke.title": "Revogar {label}?",
  "scim.confirmRevoke.body":
    "A próxima solicitação do diretório com ele é recusada. As pessoas que ele provisionou continuam como estão.",
  "scim.confirmRevoke.action": "Revogar token",
  "scim.revoked": "O token {label} foi revogado.",
  "scim.created": "O token {label} foi criado. Copie agora.",
  "scim.emails":
    "Enviar o e-mail de convite para pessoas que o diretório provisiona sem conta no Portifact",
  "scim.emailsHint":
    "Desativado por padrão: os provedores de identidade costumam avisar sobre apps novos. De qualquer forma, a pessoa entra no primeiro login com esse endereço.",
  "scim.emailsSaved": "Salvo.",
  "scim.actionFailed": "A alteração não foi salva",
  "audit.kind.scimRoleOn": "Deu o papel {role} aos membros de um grupo do diretório",
  "audit.kind.scimRoleOff": "Deixou de dar o papel {role} por um grupo do diretório",
  "groups.directory": "Gerenciado pelo seu diretório",
  "groups.directoryNote":
    "O diretório da sua organização gerencia este grupo por SCIM: mude o nome e os membros lá.",
  "members.directoryRole": "Em um grupo do diretório com papel",
  "scim.roles.title": "Papéis a partir de grupos do diretório",
  "scim.roles.description":
    "Os membros do grupo que você escolher recebem esse papel quando ele é maior que o atual. O diretório só retira um papel que deu: nunca rebaixa um papel definido à mão por um administrador, e um papel que você muda à mão passa a ser seu.",
  "scim.roles.access":
    "Um grupo listado em um artifact permite que seus membros o leiam, então agora seu diretório decide quem lê esses artifacts.",
  "scim.roles.editor": "Grupo cujos membros são editores",
  "scim.roles.admin": "Grupo cujos membros são administradores",
  "scim.roles.none": "Nenhum grupo",
  "scim.roles.option": "{name} ({count, plural, one {# membro} other {# membros}})",
  "scim.roles.noGroups": "Seu diretório ainda não enviou nenhum grupo.",
  "scim.roles.save": "Salvar papéis",
  "scim.roles.saved": "Papéis salvos.",
  "scim.roles.confirm.title": "Tornar administradores os membros de {name}?",
  "scim.roles.confirm.body":
    "{count, plural, one {Há # pessoa} other {Há # pessoas}} em {name} agora, e {pending, plural, =0 {mais ninguém estará} one {mais # estará} other {mais # estarão}} quando fizerem login. Quem controla seu diretório vai decidir quem administra este espaço de trabalho: seus membros, políticas, tokens e configurações.",
  "scim.roles.confirm.action": "Torná-los administradores",
  "groups.stopSync": "Parar de sincronizar",
  "groups.stopSyncLabel": "Parar de sincronizar {name}",
  "groups.stopSync.title": "Parar de sincronizar {name} do seu diretório?",
  "groups.stopSync.body":
    "Seu diretório não vai mais gerenciar este grupo: a partir de agora os administradores o editam aqui. O mapeamento de papel é removido, e as pessoas que ele tornou editores ou administradores mantêm seus papéis. Se o diretório enviar depois um grupo com o mesmo nome, ele é recusado.",
  "groups.stopSync.done": "{name} não é mais sincronizado do seu diretório.",
  "audit.kind.groupSyncStopped": "Parou de sincronizar o grupo {group} do diretório",
  "shell.integrationsLink": "Integrações",
  "integrations.title": "Integrações",
  "integrations.description":
    "Transforme uma conversa de comentários em uma issue no GitHub, no Linear ou no Jira. Uma conexão age com uma credencial que um administrador cola, então as issues aparecem como criadas por essa conta.",
  "integrations.adminOnly.title": "Só administradores gerenciam integrações",
  "integrations.adminOnly.body":
    "Peça a um administrador de {workspace} para conectar o GitHub, o Linear ou o Jira.",
  "integrations.planTitle": "Fora deste plano",
  "integrations.planRequired":
    "As integrações fazem parte do plano {plan}. As conexões já feitas são mantidas, mas nenhuma issue pode ser criada por elas.",
  "integrations.list.title": "Conexões",
  "integrations.list.loading": "Carregando conexões",
  "integrations.list.error": "Não foi possível carregar as conexões.",
  "integrations.empty.title": "Nenhuma conexão ainda",
  "integrations.empty.body":
    "Conecte o GitHub, o Linear ou o Jira para que administradores e editores criem issues a partir de conversas de comentários.",
  "integrations.service.github": "GitHub",
  "integrations.service.linear": "Linear",
  "integrations.service.jira": "Jira",
  "integrations.service.other": "Outro serviço",
  "integrations.add.title": "Conectar um serviço",
  "integrations.add.hint":
    "A credencial é verificada com o serviço, guardada criptografada e nunca mais mostrada: o Portifact mostra só os quatro últimos caracteres.",
  "integrations.add.service": "Serviço",
  "integrations.add.label": "Rótulo",
  "integrations.add.labelHint": "Um nome que sua equipe reconheça, como Repositório do produto.",
  "integrations.add.credential.github": "Token de acesso pessoal refinado (fine-grained)",
  "integrations.add.credential.linear": "Chave de API do Linear",
  "integrations.add.credential.jira": "Token de API da Atlassian com escopos",
  "integrations.add.targets.github": "Repositórios",
  "integrations.add.targets.linear": "IDs de equipes",
  "integrations.add.targets.jira": "Chaves de projeto",
  "integrations.add.targetsHint.github": "Um dono/repositório por linha, no máximo {limit}.",
  "integrations.add.targetsHint.linear":
    "Um ID de equipe por linha, no máximo {limit}. O Linear o mostra nas configurações da equipe.",
  "integrations.add.targetsHint.jira":
    "Uma chave de projeto por linha, como ENG, no máximo {limit}.",
  "integrations.add.account": "E-mail da conta Atlassian",
  "integrations.add.accountHint":
    "O e-mail da conta que criou o token. Ele é guardado criptografado junto com o token e nunca mais é mostrado.",
  "integrations.add.site": "Site do Jira",
  "integrations.add.siteHint": "Por exemplo, acme.atlassian.net.",
  "integrations.add.cloudId": "ID de nuvem (cloud ID)",
  "integrations.add.cloudIdHint":
    "Abra seu-site.atlassian.net/_edge/tenant_info no navegador e copie o valor de cloudId.",
  "integrations.add.failed":
    "O serviço não aceitou a credencial ou um dos repositórios, equipes ou projetos. Confira-os com os passos acima e tente de novo.",
  "integrations.add.submit": "Conectar",
  "integrations.add.limit":
    "Um espaço pode ter no máximo {limit} conexões. Remova uma para adicionar outra.",
  "integrations.howto.github.title": "Crie um token do GitHub com o mínimo de permissões",
  "integrations.howto.github.1":
    "No GitHub, abra Settings, Developer settings, Personal access tokens, Fine-grained tokens e escolha Generate new token.",
  "integrations.howto.github.2":
    "Defina como dono do recurso a conta ou organização dona dos repositórios e dê uma data de expiração.",
  "integrations.howto.github.3":
    "Em Repository access, escolha Only select repositories e marque os repositórios que você lista aqui.",
  "integrations.howto.github.4":
    "Em Repository permissions, defina Issues como Read and write. Deixe todas as outras permissões em No access; Metadata fica somente leitura.",
  "integrations.howto.github.5":
    "Gere o token e cole aqui. As issues aparecem como criadas pela conta do token.",
  "integrations.howto.linear.title": "Crie uma chave de API do Linear",
  "integrations.howto.linear.1":
    "No Linear, abra Settings, depois Security and access, e crie uma chave de API pessoal.",
  "integrations.howto.linear.2":
    "Se o Linear permitir limitar a chave, permita apenas criar issues e só nas equipes que você lista aqui.",
  "integrations.howto.linear.3":
    "Cole a chave aqui. As issues aparecem como criadas pela sua conta do Linear.",
  "integrations.howto.jira.title": "Crie um token do Jira com o mínimo de permissões",
  "integrations.howto.jira.1":
    "Entre na Atlassian com a conta de onde as issues devem vir (de preferência uma conta dedicada), abra as configurações da conta, depois Segurança, e escolha Criar token de API com escopos.",
  "integrations.howto.jira.2": "Dê um nome e uma validade e escolha o Jira como aplicativo.",
  "integrations.howto.jira.3":
    "Selecione somente os escopos read:jira-user, read:jira-work e write:jira-work.",
  "integrations.howto.jira.4":
    "Crie o token e cole aqui com o e-mail da conta, o site e o ID de nuvem dele. Um token sem escopos não funciona.",
  "integrations.howto.jira.5":
    "As issues aparecem como criadas por essa conta, nos projetos que você listar aqui.",
  "integrations.connected": "{label} conectado.",
  "integrations.identity": "Age como {identity}",
  "integrations.credential": "Credencial terminada em {hint}",
  "integrations.site": "Site {site}",
  "integrations.attention.credential_rejected":
    "O serviço recusou esta credencial. Cole uma nova e teste.",
  "integrations.attention.key_unavailable":
    "A credencial guardada não pode mais ser aberta. Cole de novo.",
  "integrations.attention.site_mismatch":
    "O ID de nuvem não corresponde mais a este site do Jira: o site mudou de endereço. Remova esta conexão e conecte o site de novo com o nome atual.",
  "integrations.state.ready": "Pronta",
  "integrations.state.attention": "Precisa de atenção",
  "integrations.test": "Testar",
  "integrations.testLabel": "Testar {label}",
  "integrations.testPassed":
    "{label} funciona. Age como {identity}, e todos os repositórios, equipes ou projetos estão acessíveis.",
  "integrations.testRefreshed":
    "O Portifact agora cria issues em {targets} com o tipo de issue atual do projeto.",
  "integrations.problem.credential_rejected":
    "O serviço recusou a credencial: ela está errada, expirou ou foi revogada.",
  "integrations.problem.missing_permission":
    "O serviço aceitou a credencial, mas ela não consegue ler a própria conta.",
  "integrations.problem.target_unreachable":
    "A credencial não alcança {target}. Verifique o acesso dela lá.",
  "integrations.problem.issues_disabled": "As issues estão desativadas em {target}.",
  "integrations.problem.service_unavailable": "O serviço não respondeu. Tente de novo mais tarde.",
  "integrations.problem.rate_limited":
    "O serviço está limitando as solicitações desta credencial. Tente de novo mais tarde.",
  "integrations.problem.site_mismatch":
    "O ID de nuvem não pertence a esse site do Jira. Copie os dois de novo a partir do site.",
  "integrations.edit": "Alterar",
  "integrations.editLabel": "Alterar {label}",
  "integrations.edit.title": "Alterar {label}",
  "integrations.edit.credentialHint": "Deixe vazio para manter a credencial atual.",
  "integrations.edit.accountHint":
    "Necessário com um token novo: o e-mail da conta Atlassian dele.",
  "integrations.edit.save": "Salvar",
  "integrations.saved": "{label} salvo.",
  "integrations.remove": "Remover",
  "integrations.removeLabel": "Remover {label}",
  "integrations.confirm.title": "Remover {label}?",
  "integrations.confirm.body":
    "A credencial é apagada do Portifact. As issues já criadas mantêm seus links; as que ainda estão sendo criadas falham. Revogue também o token ou a chave no serviço.",
  "integrations.removed": "{label} removido.",
  "integrations.actionFailed": "Não funcionou",
  "integrations.service.slack": "Slack",
  "integrations.state.pending": "Não concluída",
  "integrations.attention.pending":
    "Conclua a conexão: cole o bot token e o signing secret do app do Slack.",
  "integrations.attention.app_uninstalled":
    "O Slack informa que o app foi desinstalado ou que seus tokens foram revogados. Instale-o de novo no Slack e cole o novo bot token e o signing secret.",
  "integrations.howto.slack.title": "Como conectar o Slack",
  "integrations.howto.slack.1":
    "Comece aqui com um rótulo. O Portifact mostra então um manifesto para um app do Slack seu; nada é enviado ao Slack ainda.",
  "integrations.howto.slack.2":
    "Abra o link para criar o app no Slack a partir desse manifesto e depois instale-o no seu espaço do Slack. Você precisa de permissão para criar e instalar apps lá.",
  "integrations.howto.slack.3":
    "Copie o Bot User OAuth Token (começa com xoxb-) em OAuth & Permissions e o Signing Secret em Basic Information, e cole-os aqui.",
  "integrations.howto.slack.4":
    "Nas configurações do app no Slack, abra Event Subscriptions e clique em Verify ao lado da Request URL.",
  "integrations.slack.start": "Começar",
  "integrations.slack.started":
    "{label} iniciada. Crie o app do Slack a partir do manifesto para concluir.",
  "integrations.slack.previews":
    "Quando alguém posta um link para um dos artifacts públicos deste espaço no seu workspace do Slack, o app mostra abaixo o nome e o tipo do artifact. Nada mais é enviado: nenhum conteúdo e nada sobre artifacts que não são públicos.",
  "integrations.slack.previewsStay":
    "O Slack mantém a prévia na mensagem: se um artifact deixar de ser público, as prévias anteriores continuam mostrando seu nome e tipo, e novas postagens do link não recebem nenhuma.",
  "integrations.slack.notices":
    "Avisos em um canal vêm dos webhooks: adicione um incoming webhook ao mesmo app do Slack e cole a URL dele na página Webhooks.",
  "integrations.slack.noticesLink": "Abrir Webhooks",
  "integrations.slack.pending.title": "Conclua a conexão com o Slack",
  "integrations.slack.pending.body":
    "Crie o app a partir deste manifesto e instale-o no seu espaço do Slack; depois cole abaixo o bot token e o signing secret. Uma conexão não concluída em 24 horas é excluída.",
  "integrations.slack.create": "Criar o app no Slack",
  "integrations.slack.manifest": "Manifesto do app",
  "integrations.slack.requestUrl": "Request URL",
  "integrations.slack.copyRequestUrl": "Copiar a Request URL",
  "integrations.slack.copyManifest": "Copiar o manifesto",
  "integrations.slack.copied": "Copiado",
  "integrations.slack.botToken": "Bot User OAuth Token",
  "integrations.slack.botTokenHint":
    "Em OAuth & Permissions, nas configurações do app no Slack. Começa com xoxb-.",
  "integrations.slack.signingSecret": "Signing Secret",
  "integrations.slack.signingSecretHint":
    "Em Basic Information, nas configurações do app no Slack, em App Credentials.",
  "integrations.slack.finish": "Concluir a conexão",
  "integrations.slack.verify":
    "Agora abra Event Subscriptions nas configurações do app no Slack e clique em Verify ao lado da Request URL. Se o Slack não conseguir verificar, o signing secret está errado: cole-o de novo aqui.",
  "integrations.slack.rename":
    "O app se chama Portifact. Para diferenciar dois espaços conectados ao mesmo espaço do Slack, renomeie o app nas configurações dele no Slack (Basic Information, Display Information).",
  "integrations.slack.team": "Espaço do Slack {team}",
  "integrations.slack.outdatedTitle": "Manifesto antigo",
  "integrations.slack.outdated":
    "Este app foi criado com um manifesto mais antigo. Atualize o manifesto do app no Slack com o que está abaixo.",
  "integrations.slack.setup": "Manifesto e Request URL",
  "integrations.slack.eu":
    "Os dados deste espaço ficam na UE. Um app do Slack conectado recebe o que o Portifact envia a ele, como os nomes de artifacts públicos cujos links são publicados, e o Slack pode guardar isso fora da UE.",
  "integrations.edit.slackHint":
    "Deixe os dois vazios para manter o token e o segredo atuais. Um novo bot token vai com o signing secret.",
  "integrations.confirm.slackBody":
    "O bot token e o signing secret são excluídos do Portifact, e o Portifact revoga o bot token no Slack. Exclua também o app no Slack.",
  "issues.create": "Criar issue",
  "issues.dialog.title": "Criar uma issue a partir da conversa {number}",
  "issues.dialog.close": "Fechar",
  "issues.dialog.connection": "Conexão",
  "issues.dialog.target": "Repositório, equipe ou projeto",
  "issues.dialog.issueTitle": "Título da issue",
  "issues.dialog.parts": "O que enviar",
  "issues.dialog.part.link": "Um link para esta conversa",
  "issues.dialog.part.artifactName": "O nome do artifact",
  "issues.dialog.part.quote": "O texto citado",
  "issues.dialog.part.quoteHint": "Uma seleção do artifact. Sai do Portifact.",
  "issues.dialog.part.message": "A primeira mensagem da conversa",
  "issues.dialog.part.messageHint":
    "Palavras de alguém. Saem do Portifact e ficam na issue mesmo que o comentário seja apagado depois.",
  "issues.dialog.preview": "Exatamente o que é enviado",
  "issues.dialog.previewHint":
    "O texto dos comentários vai como texto simples: menções, links e imagens nele não fazem nada. Ele é lido de novo quando a issue é criada, então uma edição posterior é o que vai.",
  "issues.dialog.never":
    "Nunca enviados: e-mails dos leitores, o conteúdo do artifact, outras mensagens da conversa ou notas de revisão.",
  "issues.dialog.visible":
    "Todos que veem esta conversa, incluindo leitores de fora da sua equipe, veem o link da issue criada e o nome do repositório, equipe ou projeto, mesmo que seja privado.",
  "issues.failure.target_removed":
    "um administrador removeu esse repositório, equipe ou projeto da conexão.",
  "issues.failure.artifact_moved": "o artifact foi movido para outro espaço.",
  "issues.failure.requester_left": "você não pode mais criar issues para este espaço.",
  "issues.failure.thread_gone": "a conversa foi excluída.",
  "issues.failure.site_changed": "o endereço do site do Jira mudou.",
  "issues.failure.other": "não foi possível criá-la.",
  "issues.dialog.eu":
    "Este espaço guarda seus dados na UE. O que você enviar vai para o {service}, fora da UE.",
  "issues.dialog.submit": "Criar issue",
  "issues.dialog.noConnections":
    "Nenhuma conexão pode ser usada. Peça a um administrador para conectar o GitHub, o Linear ou o Jira, ou para corrigir uma conexão que precisa de atenção.",
  "issues.requested": "Issue solicitada. O link aparece na conversa em poucos minutos.",
  "issues.list": "Issues",
  "issues.link": "Issue {key} em {target}",
  "issues.pending": "A issue em {target} está sendo criada",
  "issues.failed": "A issue em {target} não foi criada: {reason}",
  "issues.failure.credential_rejected": "a credencial da conexão não funciona mais.",
  "issues.failure.target_unreachable": "a credencial não pode criar issues ali.",
  "issues.failure.rejected": "o serviço a recusou.",
  "issues.failure.connection_removed": "a conexão foi removida.",
  "issues.failure.unavailable": "as integrações não estão disponíveis.",
  "issues.failure.plan_lapsed": "o plano não inclui mais integrações.",
  "issues.failure.service_unavailable": "o serviço não respondeu.",
  "issues.failure.invalid_response":
    "o serviço respondeu de um jeito que o Portifact não pôde usar.",
  "audit.kind.integrationConnected":
    "Conectou o {service, select, github {GitHub} linear {Linear} jira {Jira} slack {Slack} other {{service}}} com {targets, plural, one {# repositório ou equipe} other {# repositórios ou equipes}}",
  "audit.kind.integrationConnectedOnly":
    "Conectou o {service, select, github {GitHub} linear {Linear} jira {Jira} slack {Slack} other {{service}}}",
  "audit.kind.integrationChanged":
    "{credential, select, true {Substituiu a credencial de uma conexão} other {Alterou o rótulo ou os destinos de uma conexão}}",
  "audit.kind.integrationRemoved":
    "Removeu uma conexão do {service, select, github {GitHub} linear {Linear} jira {Jira} slack {Slack} other {{service}}}",
  "audit.kind.integrationFailing":
    "{reason, select, app_uninstalled {O app do Slack de uma conexão foi desinstalado} site_mismatch {O site do Jira de uma conexão mudou de endereço} key_unavailable {A credencial de uma conexão não pode mais ser aberta} other {O {service, select, github {GitHub} linear {Linear} jira {Jira} slack {Slack} other {{service}}} recusou a credencial de uma conexão}}",
  "audit.kind.issueCreated":
    "Criou uma issue no {service, select, github {GitHub} linear {Linear} jira {Jira} slack {Slack} other {{service}}} em {target} a partir de uma conversa {message, select, true {com a primeira mensagem} other {sem texto de comentários}}",
  "policies.networks.legend": "Redes para pessoas",
  "policies.networks.hint":
    "Os membros, incluindo os administradores, agem no workspace e leem os artifacts só do workspace apenas a partir destas redes. Artifacts públicos, links de compartilhamento e pessoas de fora com quem você compartilhou não são afetados.",
  "policies.networks.any": "Qualquer rede",
  "policies.networks.anyHint": "As pessoas acessam o workspace de qualquer lugar.",
  "policies.networks.only": "Somente estas redes",
  "policies.networks.onlyHint":
    "Solicitações de outros endereços são recusadas com uma mensagem que explica o motivo.",
  "policies.networks.ranges": "Endereços e intervalos IP permitidos",
  "policies.networks.rangesHint":
    "Um por linha, como 192.0.2.0/24 ou 2001:db8::/32, no máximo {max}. Um único endereço corresponde a um dispositivo.",
  "policies.networks.rangesError":
    "Escreva de 1 a {max} endereços ou intervalos IP, como 192.0.2.0/24. Um intervalo de todos os endereços (/0) não é permitido.",
  "policies.networks.yourIp":
    "Seu endereço atual é {ip}. A lista precisa incluí-lo, ou ao salvá-la você perderia o acesso.",
  "policies.networks.notStored":
    "O Portifact verifica o endereço que a Cloudflare informa em cada solicitação e nunca o armazena.",
  "policies.networks.hidden":
    "As pessoas só acessam este workspace a partir de redes aprovadas. Os administradores veem a lista.",
  "policies.networks.limits":
    "Isso não impede quem chega a uma rede aprovada, por exemplo por uma VPN compartilhada, e limita as contas das pessoas, não os artifacts já compartilhados fora do workspace.",
  "policies.tokenNetworks.legend": "Redes para tokens de serviço",
  "policies.tokenNetworks.hint":
    "Os tokens de serviço não são limitados pela lista para pessoas. Dê a eles uma lista própria, como os endereços dos seus runners de CI.",
  "policies.tokenNetworks.anyHint": "Os tokens de serviço funcionam de qualquer lugar.",
  "policies.tokenNetworks.onlyHint":
    "Tokens de serviço usados a partir de outros endereços são recusados.",
  "policies.tokenNetworks.hidden":
    "Os tokens de serviço só funcionam a partir de redes aprovadas. Os administradores do workspace veem a lista.",
  "policies.impact.networksTitle": "Limitar as redes que acessam este workspace?",
  "policies.impact.members":
    "{count, plural, one {# membro acessará} other {# membros acessarão}} o workspace apenas a partir das redes permitidas",
  "policies.impact.tokens":
    "{count, plural, one {# token de serviço funcionará} other {# tokens de serviço funcionarão}} apenas a partir das redes permitidas",
  "policies.impact.networksNote":
    "O Portifact não guarda o endereço de ninguém, então não consegue saber quem está fora destas redes agora. Seu próprio endereço está incluído.",
  "policies.impact.networksConfirm": "Limitar redes",
  "space.blocked.title": "Indisponível nesta rede",
  "space.blocked.body":
    "{workspace} só permite acesso a partir das redes aprovadas, e esta rede não é uma delas. Conecte-se a uma rede aprovada ou fale com um administrador do workspace. Seus outros espaços continuam funcionando.",
  "audit.policy.networks": "pessoas só a partir de {count, plural, one {# rede} other {# redes}}",
  "audit.policy.networksAny": "pessoas de qualquer rede",
  "audit.policy.tokenNetworks":
    "tokens de serviço só a partir de {count, plural, one {# rede} other {# redes}}",
  "audit.policy.tokenNetworksAny": "tokens de serviço de qualquer rede",
  "policies.networks.bothFamilies":
    "Redes que usam IPv4 e IPv6 precisam dos dois intervalos: um navegador pode chegar ao Portifact por qualquer um deles, e as solicitações por uma família que a lista não inclui são recusadas.",
  "policies.impact.singleFamily":
    "{list, select, people {A lista para pessoas} other {A lista para tokens de serviço}} só inclui intervalos {family, select, ipv4 {IPv4} other {IPv6}}: solicitações que chegarem por {family, select, ipv4 {IPv6} other {IPv4}} serão recusadas, também a partir destas redes",
  "policies.impact.unboundTokens":
    "{count, plural, one {# token de serviço continua} other {# tokens de serviço continuam}} funcionando de qualquer rede. Defina uma lista para tokens de serviço para limitá-los também",
  "policies.impact.familiesConfirm": "Entendi, salvar",
  "audit.group.exports": "Exportações e streams",
  "audit.kind.streamCreated":
    "Começou a enviar o registro para {host}{start, select, oldest { a partir do evento mais antigo mantido} other {}}",
  "audit.kind.streamChanged":
    "{state, select, active {Retomou o stream para {host}} paused {Pausou o stream para {host}} other {{secret, select, true {Deu um novo segredo de assinatura ao stream para {host}} other {Alterou o stream para {host}}}}}",
  "audit.kind.streamRemoved": "Removeu o stream para {host}",
  "audit.kind.streamPaused":
    "{reason, select, failures {O stream para {host} foi pausado: o endpoint continuou falhando} plan {O stream para {host} foi pausado: o plano não o inclui mais} invalid_url {O stream para {host} foi pausado: a URL não passa mais nas verificações} other {O stream para {host} foi pausado: a URL e o segredo não podem mais ser abertos}}",
  "audit.stream.title": "Envio para o seu SIEM",
  "audit.stream.description":
    "O Portifact envia cada evento deste registro para um endpoint HTTPS que você mantém, como JSON Lines assinado, em ordem e pelo menos uma vez: guarde cada ID de evento uma só vez. Um evento é enviado quando tem {minutes} minutos.",
  "region.leaves.title": "O destino pode estar fora da UE",
  "region.leaves.webhooks":
    "Os dados deste espaço são mantidos na UE. As entregas de webhooks vão para os endereços que você informa, que podem estar em qualquer lugar: o que elas levam sai da UE.",
  "region.leaves.integrations":
    "Os dados deste espaço ficam na UE. As issues que você cria vão para o GitHub, o Linear ou o Jira, que podem guardá-las em qualquer lugar: o que você envia sai da UE.",
  "audit.stream.euTitle": "Seu endpoint pode estar fora da UE",
  "audit.stream.eu":
    "Os dados deste espaço ficam na UE. O endpoint que você escolher pode estar em qualquer lugar: os eventos que ele recebe saem da UE.",
  "audit.stream.planTitle": "Não está no seu plano",
  "audit.stream.planRequired":
    "Enviar o registro de auditoria faz parte do plano {plan}. Os streams existentes ficam pausados e mantêm a posição.",
  "audit.stream.list": "Seus streams de auditoria",
  "audit.stream.empty": "Nenhum stream ainda",
  "audit.stream.emptyBody": "Adicione um endpoint para receber cada novo evento deste registro.",
  "audit.stream.add.title": "Adicionar um stream",
  "audit.stream.add.label": "Nome",
  "audit.stream.add.url": "URL do endpoint",
  "audit.stream.add.urlHint": "Somente HTTPS. Depois de salva, só o host é exibido.",
  "audit.stream.add.start": "Começar a partir de",
  "audit.stream.add.submit": "Adicionar stream",
  "audit.stream.add.limit":
    "Um espaço pode ter no máximo {limit} streams. Remova um para adicionar outro.",
  "audit.stream.start.now": "Agora",
  "audit.stream.start.nowHint": "Somente os eventos de agora em diante.",
  "audit.stream.start.oldest": "O evento mais antigo mantido",
  "audit.stream.start.oldestHint":
    "Tudo o que o registro ainda mantém (até {days} dias) e depois os novos eventos.",
  "audit.stream.added": "Stream para {host} adicionado",
  "audit.stream.secret.title": "Copie o segredo de assinatura agora",
  "audit.stream.secret.body":
    "Ele só é exibido desta vez. Seu endpoint o usa para verificar que cada requisição vem do Portifact.",
  "audit.stream.secret.label": "Segredo de assinatura de {label} ({host})",
  "audit.stream.secret.copy": "Copiar segredo",
  "audit.stream.secret.done": "Já salvei",
  "audit.stream.rotate.body":
    "O segredo antigo continua assinando junto com o novo por 24 horas, para que seu endpoint troque sem perder nenhuma requisição.",
  "audit.stream.verify.title": "Verifique cada requisição",
  "audit.stream.verify.body":
    "Cada requisição traz webhook-id, webhook-timestamp e webhook-signature, o mesmo esquema dos webhooks do Portifact. Recalcule a assinatura sobre o corpo original, recuse carimbos de tempo com mais de 5 minutos de diferença e ignore eventos cujo ID você já guardou. Linhas com um campo record não são eventos: uma lacuna ou um teste.",
  "audit.stream.verify.sample": "Verificação da assinatura em Node.js",
  "audit.stream.state.active": "Ativo",
  "audit.stream.state.paused": "Pausado",
  "audit.stream.state.attention": "Precisa de atenção",
  "audit.stream.reason.manual": "Pausado por um administrador.",
  "audit.stream.reason.plan":
    "Pausado: o plano não inclui mais o envio do registro. Retome quando incluir; ele continua de onde parou.",
  "audit.stream.reason.failures":
    "Pausado depois que o endpoint falhou por 3 dias. Corrija-o, envie um teste e retome.",
  "audit.stream.reason.invalid_url":
    "Pausado: a URL não passa mais nas verificações do Portifact. Altere a URL.",
  "audit.stream.reason.key_unavailable":
    "Pausado: a URL e o segredo não podem mais ser abertos. Remova-o e adicione de novo.",
  "audit.stream.through": "Entregue até {when}",
  "audit.stream.notYet": "Nada entregue ainda",
  "audit.stream.failures":
    "{count, plural, one {# requisição falhou} other {# requisições falharam seguidas}}",
  "audit.stream.lastAttempt": "Última requisição {when}: {outcome}",
  "audit.stream.noAttempts": "Nenhuma requisição ainda",
  "audit.stream.testPending": "Há um teste esperando para ser enviado.",
  "audit.stream.gapTitle": "Alguns eventos podem nunca chegar a este endpoint",
  "audit.stream.gap":
    "Os eventos registrados entre {from} e {to} foram ou serão excluídos pela retenção do registro antes de este endpoint recebê-los; o que ainda estava guardado foi enviado. O endpoint recebeu um registro de lacuna informando isso.",
  "audit.stream.test": "Enviar teste",
  "audit.stream.testLabel": "Enviar teste para {label}",
  "audit.stream.testQueued": "Teste na fila para {label}",
  "audit.stream.pause": "Pausar",
  "audit.stream.pauseLabel": "Pausar o stream {label}",
  "audit.stream.paused": "Stream {label} pausado",
  "audit.stream.resume": "Retomar",
  "audit.stream.resumeLabel": "Retomar o stream {label}",
  "audit.stream.resumed": "Stream {label} retomado",
  "audit.stream.rotate": "Novo segredo",
  "audit.stream.rotateLabel": "Novo segredo para {label}",
  "audit.stream.rotated": "Novo segredo criado para {label}",
  "audit.stream.remove": "Remover",
  "audit.stream.removeLabel": "Remover o stream {label}",
  "audit.stream.removed": "Stream {label} removido",
  "audit.stream.confirm.title": "Remover o stream {label}?",
  "audit.stream.confirm.body":
    "O Portifact para de enviar na hora. Seu endpoint mantém o que recebeu; um novo stream começaria de novo a partir de agora.",
  "audit.stream.failed": "Não funcionou",
  "audit.stream.deliveries": "Requisições",
  "audit.stream.deliveriesOf": "Requisições do stream {label}",
  "audit.stream.deliveries.loading": "Carregando requisições",
  "audit.stream.deliveries.error": "Não foi possível carregar as requisições.",
  "audit.stream.deliveries.empty": "Nenhuma requisição nos últimos {days} dias.",
  "audit.stream.deliveries.time": "Hora",
  "audit.stream.deliveries.events": "Eventos",
  "audit.stream.deliveries.outcome": "Resultado",
  "audit.stream.outcome.delivered": "entregue",
  "audit.stream.outcome.failed": "falhou",
  "audit.stream.outcome.skipped": "ignorada",
  "audit.stream.outcome.test": "teste",
  "audit.stream.error.unreachable": "não foi possível conectar",
  "audit.stream.error.certificate": "certificado não aceito",
  "audit.stream.error.timeout": "tempo esgotado",
  "audit.stream.error.redirect": "redirecionada, não seguida",
  "audit.stream.error.refused": "recusada",
  "audit.stream.error.invalid_url": "URL não aceita mais",
  "audit.stream.error.key_unavailable": "não pode ser aberto",
  "audit.stream.error.daily_cap": "limite diário atingido",
  "audit.stream.revokeNow": "Substituir já",
  "audit.stream.revokeNowLabel": "Substituir já o segredo de {label}",
  "audit.stream.revokeConfirm.title": "Substituir já o segredo de {label}?",
  "audit.stream.revokeConfirm.body":
    "O segredo antigo para de assinar na hora. Até seu endpoint ter o novo, ele recusa as requisições do Portifact; nada se perde, elas são enviadas de novo quando ele as aceitar. Use isto se o segredo antigo vazou.",
  "audit.stream.revokedNow": "Novo segredo para {label}; o antigo não assina mais",
  "audit.stream.revokeNow.body":
    "O segredo antigo não assina mais. Passe este ao seu endpoint agora.",
  "policies.session.legend": "Duração da sessão",
  "policies.session.hint":
    "Por quanto tempo depois de entrar uma pessoa pode agir no workspace. Passado esse tempo, o painel, a CLI e os apps conectados pedem que ela entre de novo; ninguém é desconectado e nada é apagado.",
  "policies.session.any": "Sem limite",
  "policies.session.anyHint": "Um login age no workspace enquanto durar.",
  "policies.session.only": "Pedir um novo login",
  "policies.session.onlyHint": "As pessoas entram de novo quando o login passa do limite.",
  "policies.session.hours": "Horas depois do login",
  "policies.session.hoursHint": "Um número inteiro entre {min} e {max}.",
  "policies.session.hoursError": "Escreva um número inteiro de horas entre {min} e {max}.",
  "policies.session.yours":
    "Você entrou há {count, plural, one {# hora} other {# horas}}. Um limite menor deixaria você de fora, então entre de novo antes se precisar de um.",
  "policies.session.tokens": "Tokens de serviço não fazem login e não são limitados.",
  "policies.session.limits":
    "A CLI conta a partir do `portifact login` e um app a partir de quando foi conectado, por mais que renovem seus tokens.",
  "policies.clients.legend": "Apps que podem agir",
  "policies.clients.hint":
    "Quais tipos de app podem agir no workspace com o login de uma pessoa. O painel é sempre permitido.",
  "policies.clients.any": "Qualquer app",
  "policies.clients.anyHint":
    "O painel, a CLI do Portifact e os apps que as pessoas conectam, como clientes MCP.",
  "policies.clients.only": "Só os apps escolhidos aqui",
  "policies.clients.onlyHint": "Os outros apps são recusados com uma mensagem que diz por quê.",
  "policies.clients.which": "Apps permitidos",
  "policies.clients.dashboard": "O painel (sempre permitido)",
  "policies.clients.cli": "A CLI do Portifact",
  "policies.clients.cliHint":
    "A linha de comando do Portifact, reconhecida pelo seu registro de cliente fixo.",
  "policies.clients.apps": "Outros apps conectados",
  "policies.clients.appsHint":
    "Clientes MCP e qualquer outro app que uma pessoa conecte por OAuth.",
  "policies.clients.tokens": "Tokens de serviço não são limitados.",
  "policies.clients.limits":
    "Apps que se registram sozinhos escolhem o próprio nome, então o Portifact os permite ou recusa como um grupo só, nunca pelo nome. Isso não impede que alguém copie o que pode ler para outro app.",
  "policies.impact.signInsTitle": "Mudar como as pessoas entram neste workspace?",
  "policies.impact.signInMembers":
    "{count, plural, one {# membro será limitado} other {# membros serão limitados}}",
  "policies.impact.staleMembers":
    "{count, plural, one {# membro teria} other {# membros teriam}} que entrar de novo, no painel, na CLI ou em um app conectado, na próxima ação",
  "policies.impact.clientMembers":
    "{count, plural, one {# membro usa} other {# membros usam}} um app que isso recusaria",
  "policies.impact.signInsNote":
    "Ninguém é desconectado: as pessoas precisam entrar de novo, ou usar outro app, quando voltarem a agir no workspace.",
  "policies.impact.signInsConfirm": "Salvar",
  "space.blockedSession.title": "Entre de novo para continuar",
  "space.blockedSession.body":
    "{workspace} pede um novo login depois de um tempo, e o seu é mais antigo do que ele permite. Entre de novo para voltar aqui. Seus outros espaços continuam funcionando.",
  "space.blockedSession.action": "Entrar de novo",
  "audit.policy.session": "entrar de novo a cada {count, plural, one {# hora} other {# horas}}",
  "audit.policy.sessionAny": "sem limite de duração da sessão",
  "audit.policy.clients":
    "{kinds, select, none {só o painel pode agir} cli {só o painel e a CLI podem agir} oauth_apps {só o painel e os apps conectados podem agir} both {o painel, a CLI e os apps conectados podem agir} other {qualquer app pode agir}}",
  "space.blockedSso.title": "Entre com login único para continuar",
  "space.blockedSso.body":
    "{workspace} exige entrar pelo login único dele, e este navegador entrou de outra forma. Entre com login único para voltar aqui: sua conta continua a mesma e seus outros espaços continuam funcionando. Se o seu endereço não é atendido pelo provedor de identidade do espaço, fale com um administrador. Você ainda pode sair do espaço pela página dos seus espaços de trabalho.",
  "space.blockedSso.action": "Entrar com login único",
  "policies.sso.legend": "Login único",
  "policies.sso.hint":
    "Se as pessoas precisam entrar pelo provedor de identidade deste espaço para agir nele, pelo painel, pela CLI e por apps conectados.",
  "policies.sso.any": "Qualquer login",
  "policies.sso.anyHint": "Códigos por e-mail, Google, GitHub e login único funcionam.",
  "policies.sso.only": "Somente com login único",
  "policies.sso.onlyHint":
    "Administradores incluídos. A CLI e os apps funcionam quando a pessoa os aprovou de uma sessão de login único. Tokens de serviço não são afetados.",
  "policies.sso.notUsable":
    "Configure primeiro o login único com um domínio de e-mail verificado, em um plano que o inclua. Até lá, ele não pode ser exigido.",
  "policies.sso.signInFirst":
    "Entre primeiro com login único neste navegador, para saber que funciona antes de exigi-lo. Você voltará aqui.",
  "policies.sso.tradeoff":
    "Administradores também ficam sujeitos, para que nenhuma conta possa contornar o provedor de identidade. Se o provedor cair ou estiver mal configurado, ninguém pode agir no espaço até ele voltar a funcionar ou o suporte da Portifact retirar a exigência a pedido de um administrador; os outros espaços de todos continuam funcionando.",
  "policies.sso.required": "As pessoas entram pelo login único deste espaço para agir nele.",
  "policies.sso.suspended":
    "O login único é exigido, mas o provedor não consegue conectar ninguém agora (não atende nenhum domínio verificado ou o plano não o inclui mais), então a exigência não é aplicada até que consiga.",
  "policies.impact.ssoTitle": "Exigir login único?",
  "policies.impact.ssoConfirm": "Exigir login único",
  "policies.impact.ssoMembers":
    "{count, plural, one {# membro vai agir} other {# membros vão agir}} no espaço só com login único.",
  "policies.impact.ssoOutside":
    "{count, plural, one {O endereço de # membro não está} other {Os endereços de # membros não estão}} em um domínio atendido pelo provedor: essas pessoas não conseguem entrar por ele e serão recusadas até um administrador retirar a exigência ou o endereço mudar.",
  "policies.impact.ssoWithout":
    "{count, plural, one {# membro ainda não tem} other {# membros ainda não têm}} sessão com login único e vão precisar entrar por ele na próxima ação.",
  "policies.impact.ssoNote":
    "Ninguém é desconectado. Logins da CLI e apps conectados aprovados por outro tipo de login são recusados neste espaço até a pessoa aprová-los de novo de uma sessão de login único.",
  "account.sessions.column.method": "Entrou com",
  "account.apps.method": "Aprovado a partir de um login com",
  "account.method.code": "Código por e-mail",
  "account.method.google": "Google",
  "account.method.github": "GitHub",
  "account.method.sso": "Login único",
  "account.method.unknown": "Não registrado",
  "audit.policy.sso": "{value, select, true {login único exigido} other {login único não exigido}}",
  "audit.policy.ssoRemoved": "(o provedor de login único foi removido)",
  "audit.kind.policySsoSuspended":
    "O login único exigido não se aplica mais: o provedor não consegue conectar ninguém ({cause, select, domain {um domínio verificado mudou} plan {o plano mudou} provider {o provedor mudou} other {detectado na verificação diária}})",
  "audit.kind.policySsoResumed":
    "O login único exigido volta a valer: o provedor consegue conectar as pessoas ({cause, select, domain {um domínio verificado mudou} plan {o plano mudou} provider {o provedor mudou} other {detectado na verificação diária}})",
  "policies.sso.switchedOff":
    "O login único é exigido, mas está desligado neste Portifact: ninguém consegue entrar pelo provedor nem agir neste espaço até o suporte da Portifact retirar a exigência ou religar o login único. Fale com o suporte da Portifact.",
  "policies.maxLife.legend": "Vida máxima dos artifacts",
  "policies.maxLife.hint":
    "Arquiva cada artifact do workspace um número de dias após a última publicação (uma reversão conta) ou restauração. Só antecipa o vencimento: renovar não leva um artifact além dele, e um artifact arquivado pode ser restaurado até o fim do arquivo. Nada é excluído. Mover um artifact para o workspace começa uma vida nova, como uma publicação.",
  "policies.maxLife.any": "Sem máximo",
  "policies.maxLife.anyHint": "Os artifacts continuam no ar enquanto alguém os renova ou publica.",
  "policies.maxLife.only": "Arquivar após uma vida máxima",
  "policies.maxLife.onlyHint":
    "Enquanto estiver definida não é possível fixar, e os artifacts fixados deixam de estar com seu prazo.",
  "policies.maxLife.days": "Dias após a última publicação ou restauração",
  "policies.maxLife.daysHint": "De {min} a {max} dias.",
  "policies.maxLife.daysError": "Escreva um número inteiro de dias entre {min} e {max}.",
  "policies.maxLife.notice":
    "Um máximo novo ou menor entra em vigor {days} dias depois de salvo, e cada administrador recebe um e-mail. Até lá nada é arquivado por ele, mas cada artifact já mostra o novo vencimento e os donos recebem o aviso de vencimento habitual. Um máximo maior, ou nenhum, vale na hora.",
  "policies.maxLife.pending": "Uma vida máxima entra em vigor em {date}",
  "policies.maxLife.pendingBody":
    "A partir daí, os artifacts são arquivados {days} dias após a última publicação ou restauração. Nada é arquivado por ela antes dessa data.",
  "policies.maxLife.active":
    "Os artifacts são arquivados {days} dias após a última publicação ou restauração e não podem ser fixados.",
  "policies.impact.atStart":
    "{count, plural, one {# artifact ativo é arquivado no dia em que a vida máxima entra em vigor, a menos que alguém o publique de novo} other {# artifacts ativos são arquivados no dia em que a vida máxima entra em vigor, a menos que alguém os publique de novo}}",
  "policies.impact.soon":
    "{count, plural, one {mais # é arquivado nos 30 dias seguintes} other {mais # são arquivados nos 30 dias seguintes}}",
  "policies.impact.pins":
    "{count, plural, one {# artifact fixado deixa de estar} other {# artifacts fixados deixam de estar}}",
  "detail.maxLife":
    "Este workspace arquiva artifacts {days} dias após a última publicação ou restauração: o vencimento já inclui isso, e fixar não está disponível.",
  "audit.policy.maxLife": "artifacts arquivados {days} dias após a última publicação",
  "audit.policy.maxLifeNone": "sem vida máxima dos artifacts",
  "audit.policy.deadlinesSet":
    "{count, plural, one {antecipou o vencimento de # artifact} other {antecipou o vencimento de # artifacts}}",
  "audit.policy.deadlinesExtended":
    "{count, plural, one {devolveu o tempo de # artifact} other {devolveu o tempo de # artifacts}}",
  "transfer.confirm.maxLife":
    "{space} arquiva artifacts {days} dias após a última publicação, restauração ou transferência: movido agora, este é arquivado no máximo em {date}, a menos que alguém o publique de novo, e lá não pode ser fixado.",
  "policies.comments.unavailable":
    "A regra de retenção de comentários não pôde ser alterada agora, então nada foi salvo. Tente de novo em alguns minutos.",
  "policies.comments.legend": "Retenção de comentários",
  "policies.comments.hint":
    "Exclui cada conversa de comentários do espaço de trabalho, com todas as mensagens, quando ela fica um número de dias sem atividade. Uma conversa aberta na versão atual de um artefato é mantida, para que o que os revisores aguardam nunca se perca; quando uma nova versão substitui essa versão, a conversa recebe o período inteiro de novo a partir desse momento. Ninguém pode recuperar conversas excluídas, nem a Portifact.",
  "policies.comments.any": "Manter os comentários",
  "policies.comments.anyHint": "As threads ficam até alguém excluí-las ou o artifact ser excluído.",
  "policies.comments.only": "Excluir threads antigas",
  "policies.comments.onlyHint":
    "Uma conversa resolvida é excluída quando sua última atividade é mais antiga que o período. Uma conversa aberta em uma versão anterior é excluída quando o período passou tanto desde sua última atividade quanto desde que sua versão foi substituída. Uma resposta reinicia o período.",
  "policies.comments.days": "Dias após a última atividade de uma thread",
  "policies.comments.daysHint": "De {min} a {max} dias.",
  "policies.comments.daysError": "Escreva um número inteiro de dias entre {min} e {max}.",
  "policies.comments.notice":
    "Uma retenção nova ou menor entra em vigor {days} dias depois de salva, e cada administrador recebe um e-mail, e outro pouco antes da primeira exclusão se ela vier muito depois. Uma retenção maior, ou nenhuma, vale na hora. Se o plano do workspace vencer, nada é excluído e a retenção é removida até um administrador defini-la de novo.",
  "policies.comments.pending": "A retenção de comentários entra em vigor em {date}",
  "policies.comments.active":
    "As conversas de comentários são excluídas definitivamente {days} dias após a última atividade ou, para uma conversa aberta, {days} dias após a substituição da sua versão, se isso for depois. Conversas abertas na versão atual de um artefato são mantidas.",
  "policies.comments.notInForce": "A retenção de comentários está definida, mas não está em vigor",
  "policies.comments.notInForceHint":
    "Nada é excluído por ela: isso acontece após a restauração de um backup ou quando um salvamento não conseguiu registrar a regra. Salve a regra de novo para colocá-la em vigor; como qualquer regra nova, ela passa a valer após o período de aviso.",
  "policies.impact.threads":
    "{count, plural, one {# thread de comentários é excluída para sempre no dia em que a retenção entra em vigor} other {# threads de comentários são excluídas para sempre no dia em que a retenção entra em vigor}}",
  "policies.impact.messages":
    "{count, plural, one {# mensagem nelas é excluída junto} other {# mensagens nelas são excluídas junto}}",
  "policies.impact.threadsSoon":
    "{count, plural, one {mais # thread é excluída nos 30 dias seguintes} other {mais # threads são excluídas nos 30 dias seguintes}}",
  "policies.impact.openThreads":
    "Conversas abertas na versão atual de um artefato não são contadas: elas são mantidas e, quando uma nova versão a substitui, cada uma recebe o período inteiro a partir desse momento.",
  "audit.policy.comments": "threads de comentários excluídas {days} dias após a última atividade",
  "audit.policy.commentsNone": "sem retenção de comentários",
  "audit.policy.planLapsed": "(o plano não inclui mais políticas)",
  "audit.policy.threadsDeleted":
    "{count, plural, one {excluiu # thread de comentários} other {excluiu # threads de comentários}}",
  "audit.policy.messagesDeleted": "{count, plural, one {com # mensagem} other {com # mensagens}}",
} satisfies Catalog;
