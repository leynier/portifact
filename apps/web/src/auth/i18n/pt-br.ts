// Brazilian Portuguese catalog of the auth and report pages: the scripts' messages and the pages'
// markers. Brazilian Portuguese with "você". The sign-in notices keep every condition of the
// English (docs/legal.md, "Acceptance at sign-in") and the same three links.
import type { AuthMessages } from "./en.ts";
import type { AuthCatalog } from "./types.ts";

const messages = {
  network: "Não foi possível acessar o Portifact. Verifique sua conexão e tente de novo.",
  unexpected: "Algo deu errado. Tente de novo.",
  rateLimited: "Tentativas demais. Aguarde um minuto e tente de novo.",
  emailRequired: "Digite seu endereço de e-mail.",
  emailInvalid: "Digite um endereço de e-mail válido, como nome@example.com.",
  codeRequired: "Digite o código de 6 dígitos do e-mail.",
  codeInvalid: "Esse código não é válido ou expirou. Confira o código ou envie um novo.",
  codeSent: (email: string) => `Enviamos um código de 6 dígitos para ${email}.`,
  codeSentStatus: "Código enviado. Digite o código de 6 dígitos do e-mail.",
  codeResent: "Um novo código está a caminho.",
  resendCode: "Enviar um novo código",
  resendIn: (seconds: number) => `Enviar um novo código em ${seconds} s`,
  humanCheckNeeded:
    "Só mais um passo: a Cloudflare precisa de uma verificação rápida de que você é humano. Conclua-a abaixo das opções de login para continuar.",
  emailSuppressed:
    "Não podemos enviar e-mails para este endereço porque mensagens anteriores foram devolvidas ou marcadas como spam. Entre com Google ou GitHub, ou escreva para privacy@portifact.com para que ele seja analisado.",
  emailCapacity:
    "Os códigos por e-mail estão pausados por enquanto porque o Portifact atingiu o limite mensal de e-mails. Entre com Google ou GitHub, ou tente de novo mais tarde.",
  signedInAs: (email: string) => `Conectado como ${email}`,
  signedOut: "Você saiu da sua conta.",
  methodConnected: "Conectado",
  methodNotUsed: "Ainda não usado",
  redirecting: "Entrando na sua conta.",
  termsUpdateFor: (email: string) => `Conectado como ${email}`,
  providerErrors: {
    human_verification_required:
      "Contas novas precisam de uma verificação rápida de que você é humano, e ela não foi concluída. Tente de novo; se uma verificação aparecer abaixo das opções de login, conclua-a. Se nada aparecer, recarregue a página ou permita challenges.cloudflare.com.",
    terms_not_accepted:
      "Sua aceitação dos termos não chegou ao Portifact, ou expirou depois de 30 minutos. Escolha uma opção de login de novo para continuar.",
    account_not_linked:
      "Seu provedor não verificou este endereço de e-mail, então ele não pode abrir a conta do Portifact que o usa. Verifique-o lá, ou entre com um código por e-mail.",
    email_not_verified:
      "Seu provedor não verificou este endereço de e-mail. Verifique-o lá, ou entre com um código por e-mail.",
    email_not_found:
      "Seu provedor não compartilhou um endereço de e-mail. Entre com um código por e-mail.",
    state_mismatch: "O login demorou demais ou foi iniciado em outra aba. Tente de novo.",
    artifact_unavailable:
      "Este artifact não existe, não está mais disponível ou não pode ser aberto com esta conta. Para usar outra conta, saia e abra o link de novo.",
    read_rate_limited:
      "Esta conta abriu artifacts demais em pouco tempo. Aguarde alguns minutos e abra o link de novo.",
  },
  providerErrorFallback: "O login não foi concluído. Tente de novo.",
  deviceCodeRequired: "Digite o código exibido no seu terminal.",
  deviceCodeInvalid: "Esse código não é válido ou expirou. Execute o comando de login de novo.",
  deviceCodeTaken: "Outra conta já está analisando este código.",
  deviceProcessed: "Este código já foi usado. Execute o comando de login de novo.",
  deviceApproved: "Dispositivo conectado. Você pode voltar ao seu terminal.",
  deviceDenied: "Solicitação negada. O dispositivo não recebeu acesso.",
  consentMissing:
    "Esta página precisa de uma solicitação de autorização. Comece de novo pelo app que trouxe você até aqui.",
  consentClientUnknown: "O app que trouxe você até aqui não está registrado ou está desativado.",
  redirectHost: (host: string) => `Depois de decidir, você volta para ${host}.`,
  scopes: {
    "artifacts:read": "Ver seus artifacts, as configurações e as versões deles",
    "artifacts:write": "Publicar e atualizar artifacts",
    "artifacts:share": "Alterar quem pode abrir seus artifacts",
    "artifacts:delete": "Arquivar e excluir seus artifacts",
    "annotations:read": "Ler comentários nos seus artifacts",
    "annotations:write": "Escrever e responder comentários em seu nome",
    "annotations:moderate": "Resolver, ocultar e excluir comentários nos seus artifacts",
    "credentials:manage": "Ver os apps conectados à sua conta e desconectá-los",
    offline_access: "Continuar conectado até você revogar o acesso",
  },
  unknownScope: (name: string) => `Usar a permissão "${name}"`,
  languageLabel: "Idioma",
  report: {
    artifactRequired: "Digite o endereço ou o ID do artifact.",
    artifactInvalid:
      "Digite um endereço como https://abcdefghij.portifact.dev/ ou um ID de 10 caracteres.",
    reasonRequired: "Escolha o que há de errado com o artifact.",
    detailsInvalid: "Remova os caracteres de controle ou encurte os detalhes.",
    emailInvalid: "Digite um endereço de e-mail válido, ou deixe em branco.",
    rateLimited:
      "Denúncias demais a partir daqui. Tente de novo mais tarde ou escreva para abuse@portifact.com.",
    network: "Não foi possível acessar o Portifact. Verifique sua conexão e tente de novo.",
    failed:
      "Não foi possível enviar a denúncia. Tente de novo ou escreva para abuse@portifact.com.",
    sent: "Denúncia enviada.",
  },
  /** The comment notice unsubscribe page (src/unsubscribe/unsubscribe.ts). */
  unsubscribe: {
    missing:
      "Este link está incompleto. Abra de novo o link do e-mail ou desative os avisos de comentários nas suas configurações.",
    invalid:
      "Este link não funciona mais. Desative os avisos de comentários nas suas configurações.",
    rateLimited: "Muitas tentativas daqui. Tente de novo em alguns minutos.",
    network: "Não foi possível conectar ao Portifact. Verifique sua conexão e tente de novo.",
    failed:
      "Não foi possível desativar os avisos de comentários. Tente de novo ou desative-os nas suas configurações.",
    done: "Avisos de comentários desativados.",
  },
} satisfies AuthMessages;

const TERMS_LINKS = {
  terms:
    '<a href="https://portifact.com/terms" target="_blank" rel="noopener">Termos de Serviço</a>',
  acceptableUse:
    '<a href="https://portifact.com/acceptable-use" target="_blank" rel="noopener">Política de Uso Aceitável</a>',
  privacy:
    '<a href="https://portifact.com/privacy" target="_blank" rel="noopener">Política de Privacidade</a>',
};

/** The conditions of the sign-in notices after the action that accepts them. */
const termsConditions = `você confirma que tem 18 anos ou mais, concorda com os ${TERMS_LINKS.terms} e a ${TERMS_LINKS.acceptableUse}, e leu a ${TERMS_LINKS.privacy}. Os links abrem em uma nova aba.`;

export const ptBR: AuthCatalog = {
  messages,
  page: {
    // Shared by the four pages.
    "auth.skip": "Pular para o conteúdo",
    "auth.home": "Início do Portifact",
    "auth.legal": "Jurídico",
    "auth.terms": "Termos",
    "auth.privacy": "Privacidade",
    "auth.acceptableUse": "Uso aceitável",
    "auth.accessTo": "Acesso a",
    "auth.ableTo": "Poderá",
    "auth.deny": "Negar",

    // login.html
    "login.title": "Entrar no Portifact",
    "login.intro": "É novo por aqui? Seu primeiro login cria sua conta.",
    "login.signedInHint":
      "Você pode abrir seu painel, fechar esta página ou sair da conta neste navegador.",
    "login.openDashboard": "Abrir seu painel",
    "login.methodsHeading": "Formas de login",
    "login.methodsHint":
      "Uma conta Google ou GitHub com este e-mail verificado se junta a esta conta na primeira vez que você a usa.",
    "login.methodNotUsed": "Ainda não usado",
    "login.signOut": "Sair",
    "login.termsUpdateHeading": "Revise os termos para continuar",
    "login.termsUpdateBody": "Sua conta ainda não aceitou a versão atual dos termos.",
    "login.termsUpdateNotice": `Ao selecionar Concordar e continuar, ${termsConditions}`,
    "login.agreeAndContinue": "Concordar e continuar",
    "login.termsNotice": `Ao continuar com Google, GitHub ou um código por e-mail, ${termsConditions}`,
    "login.google": "Continuar com Google",
    "login.github": "Continuar com GitHub",
    "login.orEmail": "ou use seu e-mail",
    "login.emailLabel": "Endereço de e-mail",
    "login.sendCode": "Enviar um código por e-mail",
    "login.codeHeading": "Confira seu e-mail",
    "login.codeLabel": "Código de 6 dígitos",
    "login.codeHint":
      "O código expira em 5 minutos e funciona uma vez. Se ele não chegou, confira sua pasta de spam.",
    "login.verify": "Entrar",
    "login.resend": "Enviar um novo código",
    "login.changeEmail": "Usar outro e-mail",
    "login.humanHeading": "Só mais um passo: confirme que você é humano",
    "login.humanBody":
      "A Cloudflare precisa de uma verificação rápida antes que o Portifact possa continuar. Conclua-a abaixo e seu login continua sozinho.",

    // device.html
    "device.title": "Conectar um dispositivo ao Portifact",
    "device.eyebrow": "CLI e apps do Portifact",
    "device.heading": "Conectar um dispositivo",
    "device.intro": "Aprove a CLI do Portifact ou outro app que mostrou um código para você.",
    "device.codeLabel": "Código exibido no seu terminal",
    "device.continue": "Continuar",
    "device.reviewHeading": "Aprovar este login?",
    "device.app": "App",
    "device.code": "Código",
    "device.warning":
      "Aprove só se você iniciou isto no seu próprio terminal e o código corresponde.",
    "device.approve": "Aprovar",

    // consent.html
    "consent.title": "Permitir acesso ao Portifact",
    "consent.eyebrow": "Apps conectados",
    "consent.heading": "Permitir acesso",
    "consent.requestHeading":
      '<span id="client-name" class="font-semibold break-words"></span> quer usar sua conta do Portifact',
    "consent.publishedBy": "Detalhes do app publicados por",
    "consent.loopback":
      "Ele volta para um app neste dispositivo. Permita só se você iniciou isto em um app de confiança.",
    "consent.allow": "Permitir",
    "consent.disconnect":
      "Você pode desconectar apps quando quiser na página da sua conta no painel.",

    // report.html
    "report.title": "Denunciar um artifact ao Portifact",
    "report.heading": "Denunciar um artifact",
    "report.intro":
      'Conte para nós sobre conteúdo que viola a <a href="https://portifact.com/acceptable-use">Política de Uso Aceitável</a>. Você não precisa de uma conta. Procuramos responder em até 48 horas.',
    "report.artifactLabel": "Endereço ou ID do artifact",
    "report.reasonLabel": "O que há de errado",
    "report.reason.none": "Escolha um motivo",
    "report.reason.phishing": "Phishing ou uma página de login falsa",
    "report.reason.malware": "Malware, exploits ou mineração de criptomoedas",
    "report.reason.child_safety": "Sexualiza menores",
    "report.reason.sexual_content": "Conteúdo sexualmente explícito",
    "report.reason.copyright": "Violação de direitos autorais ou de marca, arquivos piratas",
    "report.reason.impersonation": "Falsificação de identidade",
    "report.reason.harassment": "Ameaças, assédio ou extremismo violento",
    "report.reason.private_information": "Informações privadas de alguém",
    "report.reason.spam": "Spam",
    "report.reason.other": "Outra coisa que viola as regras",
    "report.detailsLabel": 'Detalhes <span class="font-normal text-text-muted">(opcional)</span>',
    "report.detailsHint":
      "O que você viu e onde. Não cole material ilegal; o endereço é suficiente. Até 2.000 caracteres.",
    "report.emailLabel": 'Seu e-mail <span class="font-normal text-text-muted">(opcional)</span>',
    "report.emailHint":
      'Só se você quiser que possamos responder. Veja a <a href="https://portifact.com/privacy">Política de Privacidade</a>.',
    "report.send": "Enviar denúncia",
    "report.doneHeading": "Obrigado, recebemos sua denúncia",
    "report.doneBody":
      'Analisamos cada denúncia. Você também pode escrever para <a href="mailto:abuse@portifact.com">abuse@portifact.com</a>.',

    // unsubscribe.html
    "unsubscribe.title": "Desativar os avisos de comentários do Portifact",
    "unsubscribe.heading": "Desativar os avisos de comentários",
    "unsubscribe.intro":
      "Você deixará de receber e-mails sobre novos comentários em artifacts do Portifact. Os avisos de expiração e os e-mails de login não mudam.",
    "unsubscribe.confirm": "Desativar os avisos de comentários",
    "unsubscribe.doneHeading": "Os avisos de comentários estão desativados",
    "unsubscribe.doneBody":
      'Você pode ativá-los de novo nas suas <a href="/settings">configurações</a>.',
  },
};
