// Brazilian Portuguese messages of the MCP compatibility page and the chrome of the legal pages,
// keyed by their markers. The legal texts themselves stay in English.
import type { PageMessages } from "../../markers.ts";

export const documents: PageMessages = {
  // Chrome of the legal pages (terms, privacy, acceptable-use), shared across the three.
  "legal.skip": "Pular para o conteúdo",
  "legal.home": "Início do Portifact",
  "legal.footer.license": "O Portifact é de código aberto sob a GNU AGPL v3.0.",
  "legal.footer.nav": "Jurídico",
  "legal.footer.terms": "Termos",
  "legal.footer.privacy": "Privacidade",
  "legal.footer.acceptableUse": "Uso aceitável",
  "legal.footer.dpa": "Tratamento de dados",
  "legal.terms.title": "Termos de Serviço: Portifact",
  "legal.terms.description":
    "Os termos para usar o Portifact, o serviço que publica artifacts estáticos com controle de acesso e revisão.",
  "legal.privacy.title": "Política de Privacidade: Portifact",
  "legal.privacy.description":
    "Quais dados o Portifact guarda, por quê, por quanto tempo, quem os processa e como exercer seus direitos.",
  "legal.acceptableUse.title": "Política de Uso Aceitável: Portifact",
  "legal.acceptableUse.description":
    "O que você não pode publicar nem fazer no Portifact, como denunciar abusos e o que acontece quando as regras são violadas.",
  "legal.dpa.title": "Adendo de Tratamento de Dados: Portifact",
  "legal.dpa.description":
    "As condições em que o Portifact trata dados pessoais em nome de seus clientes, com as cláusulas contratuais padrão e a lista de suboperadores.",

  // MCP compatibility page.
  "mcp.meta.title": "Compatibilidade com MCP: Portifact",
  "mcp.meta.description":
    "Quais clientes MCP funcionam com o servidor MCP remoto do Portifact, como eles entram e o que esperar de cada um.",
  "mcp.chrome.skip": "Pular para o conteúdo",
  "mcp.chrome.home": "Início do Portifact",
  "mcp.intro.title": "Compatibilidade com MCP",
  "mcp.intro.tested":
    'Último teste em <time datetime="2026-11-08">8 de novembro de 2026</time>, com o Portifact 0.11.0. A renovação de token do Codex CLI e as ferramentas de comentários foram verificadas de novo no mesmo dia com o Portifact 0.13.0.',
  "mcp.intro.server":
    "O Portifact oferece um servidor MCP remoto em <code>https://app.portifact.com/mcp</code> (Streamable HTTP). Adicione-o ao seu cliente e entre com sua conta do Portifact no navegador. O primeiro login pede apenas para ver seus artifacts; seu cliente pede de novo quando uma ferramenta precisa de mais, como publicar ou excluir.",
  "mcp.toc.title": "Nesta página",
  "mcp.matrix.title": "Clientes testados",
  "mcp.matrix.intro":
    "Cada cliente listou, publicou, leu de volta e excluiu um documento. Os três entram com OAuth e PKCE e se identificam com um documento de metadados de cliente publicado.",
  "mcp.matrix.caption": "Clientes MCP testados com o Portifact",
  "mcp.matrix.client": "Cliente",
  "mcp.matrix.version": "Versão",
  "mcp.matrix.protocol": "Protocolo",
  "mcp.matrix.moreAccess": "Quando uma ferramenta precisa de mais acesso",
  "mcp.matrix.status": "Status",
  "mcp.matrix.claudeAiVersion": "Web, novembro de 2026",
  "mcp.matrix.notRecorded": "Não registrado",
  "mcp.matrix.claudeAiMoreAccess": "Pede que você permita no navegador",
  "mcp.matrix.claudeCodeMoreAccess": "Pede que você execute <code>/mcp</code> e entre de novo",
  "mcp.matrix.codexMoreAccess":
    "A chamada falha; entre de novo com as permissões de que você precisa",
  "mcp.matrix.works": "Funciona",
  "mcp.claudeAi.body":
    "Adicione um conector personalizado com o endereço do servidor e entre. Na primeira vez que o Claude publica, ele pede que você também permita publicar. O conector mostra 24 ferramentas: 9 que só leem e 15 que escrevem ou excluem.",
  "mcp.claudeCode.body":
    "Adicione o servidor com <code>claude mcp add --transport http portifact https://app.portifact.com/mcp</code>, depois escolha-o em <code>/mcp</code> e entre. Quando uma ferramenta precisa de um acesso que você ainda não deu, a chamada falha com uma mensagem que nomeia a permissão que falta. Execute <code>/mcp</code>, escolha Re-authenticate e permita; o Claude Code mantém o que você permitiu antes. Execuções não interativas (<code>claude -p</code>) não conseguem entrar, então faça isso primeiro em uma sessão interativa.",
  "mcp.codex.body":
    "Adicione o servidor com <code>codex mcp add portifact --url https://app.portifact.com/mcp</code>; o Codex inicia o login na hora. O Codex não pede mais acesso por conta própria, então entre com tudo de que seu agente vai precisar, por exemplo:",
  "mcp.codex.comments":
    "Adicione <code>annotations:read</code>, <code>annotations:write</code> ou <code>annotations:moderate</code> para as ferramentas de comentários; com os três, o Codex ativou os comentários, comentou, respondeu, resolveu e exportou os comentários de um documento. O Codex pede que você aprove as ferramentas que excluem antes de executá-las. Ele renova o próprio acesso sozinho quando o token, que dura uma hora, expira.",
  "mcp.other.title": "Outros clientes",
  "mcp.other.body":
    'Qualquer cliente compatível com servidores MCP remotos com OAuth deve funcionar: o Portifact segue a especificação de autorização do MCP de 2026-07-28 e também aceita o registro dinâmico de clientes e as revisões do protocolo de 2025. Se o seu não funcionar, a CLI <code>portifact</code> e a skill para agentes funcionam em qualquer agente com um shell. Conte para nós no <a href="https://github.com/leynier/portifact/issues">GitHub</a>.',
  "mcp.footer.license": "O Portifact é de código aberto sob a GNU AGPL v3.0.",
  "mcp.footer.nav": "Jurídico",
  "mcp.footer.terms": "Termos",
  "mcp.footer.privacy": "Privacidade",
  "mcp.footer.acceptableUse": "Uso aceitável",
  "mcp.footer.dpa": "Tratamento de dados",
};
