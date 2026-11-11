// Russian catalog of the auth and report pages: the scripts' messages and the pages' markers.
// Standard Russian with "вы" in lowercase. The sign-in notices keep every condition of the
// English (docs/legal.md, "Acceptance at sign-in") and the same three links.
import type { AuthMessages } from "./en.ts";
import type { AuthCatalog } from "./types.ts";

const messages = {
  network: "Не удалось связаться с Portifact. Проверьте подключение и попробуйте ещё раз.",
  unexpected: "Что-то пошло не так. Попробуйте ещё раз.",
  rateLimited: "Слишком много попыток. Подождите минуту и попробуйте ещё раз.",
  emailRequired: "Введите адрес электронной почты.",
  emailInvalid: "Введите корректный адрес электронной почты, например name@example.com.",
  codeRequired: "Введите 6-значный код из письма.",
  codeInvalid: "Код неверный или его срок истёк. Проверьте его или запросите новый.",
  codeSent: (email: string) => `Мы отправили 6-значный код на ${email}.`,
  codeSentStatus: "Код отправлен. Введите 6-значный код из письма.",
  codeResent: "Новый код уже в пути.",
  resendCode: "Отправить новый код",
  resendIn: (seconds: number) => `Новый код через ${seconds} с`,
  humanCheckNeeded:
    "Ещё один шаг: Cloudflare нужна короткая проверка, что вы человек. Пройдите её под вариантами входа, чтобы продолжить.",
  emailSuppressed:
    "Мы не можем отправлять письма на этот адрес, потому что прежние письма на него не доставлялись или были отмечены как спам. Войдите через Google или GitHub либо напишите на privacy@portifact.com, чтобы мы проверили адрес.",
  emailCapacity:
    "Коды по почте пока приостановлены, потому что Portifact исчерпал месячный лимит писем. Войдите через Google или GitHub либо попробуйте позже.",
  signedInAs: (email: string) => `Вы вошли как ${email}`,
  signedOut: "Вы вышли.",
  methodConnected: "Подключено",
  methodNotUsed: "Ещё не использовался",
  redirecting: "Выполняется вход.",
  ssoFor: (email: string) => `${email} входит через поставщика удостоверений вашей организации.`,
  ssoShown: "Ваша организация использует единый вход. Продолжите с ним или получите код по почте.",
  termsUpdateFor: (email: string) => `Вы вошли как ${email}`,
  providerErrors: {
    human_verification_required:
      "Новым аккаунтам нужна короткая проверка, что вы человек, и она не завершилась. Попробуйте ещё раз; если под вариантами входа появится проверка, пройдите её. Если ничего не появляется, перезагрузите страницу или разрешите challenges.cloudflare.com.",
    terms_not_accepted:
      "Ваше согласие с условиями не дошло до Portifact или истекло через 30 минут. Выберите способ входа ещё раз, чтобы продолжить.",
    account_not_linked:
      "Ваш провайдер не подтвердил этот адрес электронной почты, поэтому он не может открыть аккаунт Portifact с этим адресом. Подтвердите адрес у провайдера или войдите с кодом по почте.",
    email_not_verified:
      "Ваш провайдер не подтвердил этот адрес электронной почты. Подтвердите его у провайдера или войдите с кодом по почте.",
    email_not_found: "Ваш провайдер не передал адрес электронной почты. Войдите с кодом по почте.",
    state_mismatch:
      "Вход занял слишком много времени или был начат в другой вкладке. Попробуйте ещё раз.",
    artifact_unavailable:
      "Этот artifact не существует, больше недоступен или не может быть открыт с этим аккаунтом. Чтобы использовать другой аккаунт, выйдите и снова откройте ссылку.",
    network_refused:
      "Это рабочее пространство разрешает доступ только из одобренных сетей, а вы сейчас не в одной из них. Подключитесь к одобренной сети и снова откройте ссылку или обратитесь к администратору рабочего пространства.",
    read_rate_limited:
      "С этого аккаунта открыто слишком много artifacts за короткое время. Подождите несколько минут и снова откройте ссылку.",
    sso_unavailable:
      "Единый вход сейчас недоступен для этого адреса. Войдите другим способом или обратитесь к администратору вашего workspace.",
    sso_email_outside_domain:
      "Поставщик удостоверений вашей организации передал адрес вне её подтверждённых доменов, поэтому Portifact не может его использовать. Обратитесь к администратору вашего workspace.",
    sso_failed:
      "Единый вход не завершился. Попробуйте ещё раз; если ошибка повторяется, войдите с кодом по почте и сообщите администратору вашего workspace.",
    sso_workspace_full:
      "В workspace вашей организации нет свободного места, поэтому вы не смогли присоединиться. Попросите место у администратора и войдите снова.",
    sso_email_unverified:
      "Поставщик удостоверений вашей организации не подтвердил этот адрес, поэтому Portifact не может его использовать. Обратитесь к администратору вашего workspace.",
    sso_link_required:
      "У этого адреса уже есть аккаунт Portifact. Войдите один раз с кодом по почте или как обычно, затем выберите на этой странице «Связать единый вход».",
    sso_removed:
      "Администратор workspace удалил вас, поэтому вы не можете снова присоединиться через единый вход. Попросите администратора пригласить вас снова.",
  },
  providerErrorFallback: "Вход не завершился. Попробуйте ещё раз.",
  /** The read entry's confirmation before a code goes to an artifact's custom host. */
  readConfirm: {
    heading: "Открыть по собственному адресу",
    body: (host: string) =>
      `Этот artifact находится на ${host}, адресом управляет его владелец. Продолжайте, только если хотели открыть его там.`,
    continue: "Продолжить",
    missing: "Ссылка была неполной. Откройте её снова там, где вы её нашли.",
  },
  deviceCodeRequired: "Введите код, показанный в терминале.",
  deviceCodeInvalid: "Код неверный или его срок истёк. Снова выполните команду login.",
  deviceCodeTaken: "Этот код уже рассматривает другой аккаунт.",
  deviceProcessed: "Этот код уже использован. Снова выполните команду login.",
  deviceApproved: "Устройство подключено. Можно вернуться в терминал.",
  deviceDenied: "Запрос отклонён. Устройство не получило доступ.",
  consentMissing:
    "Для этой страницы нужен запрос на авторизацию. Начните заново из приложения, которое направило вас сюда.",
  consentClientUnknown:
    "Приложение, которое направило вас сюда, не зарегистрировано или отключено.",
  redirectHost: (host: string) => `После решения вы вернётесь на ${host}.`,
  scopes: {
    "artifacts:read": "Видеть ваши artifacts, их настройки и версии",
    "artifacts:write": "Публиковать и обновлять artifacts",
    "artifacts:share": "Менять, кто может открывать ваши artifacts",
    "artifacts:delete": "Архивировать и удалять ваши artifacts",
    "annotations:read": "Читать комментарии к вашим artifacts",
    "annotations:write": "Писать комментарии и отвечать на них от вашего имени",
    "annotations:moderate": "Закрывать, скрывать и удалять комментарии к вашим artifacts",
    "credentials:manage": "Видеть приложения, подключённые к аккаунту, и отключать их",
    offline_access: "Оставаться подключённым, пока вы не отзовёте доступ",
  },
  unknownScope: (name: string) => `Использовать разрешение «${name}»`,
  languageLabel: "Язык",
  report: {
    artifactRequired: "Введите адрес или ID artifact.",
    artifactInvalid: "Введите адрес вида https://abcdefghij.portifact.dev/ или ID из 10 символов.",
    reasonRequired: "Выберите, что не так с artifact.",
    detailsInvalid: "Удалите управляющие символы или сократите описание.",
    emailInvalid: "Введите корректный адрес электронной почты или оставьте поле пустым.",
    rateLimited:
      "Отсюда отправлено слишком много жалоб. Попробуйте позже или напишите на abuse@portifact.com.",
    network: "Не удалось связаться с Portifact. Проверьте подключение и попробуйте ещё раз.",
    failed: "Не удалось отправить жалобу. Попробуйте ещё раз или напишите на abuse@portifact.com.",
    sent: "Жалоба отправлена.",
  },
  /** The share link entry page (src/share/share.ts). */
  share: {
    checking: "Проверяем ссылку.",
    opening: "Открываем artifact.",
    passwordRequired: "Введите пароль.",
    refused: "Пароль неверный, или срок действия ссылки истёк, или она отозвана.",
    humanCheckShown: "Подтвердите ниже, что вы человек. После этого пароль будет проверен снова.",
    humanCheckUnavailable:
      "Не удалось загрузить проверку на человека. Разрешите challenges.cloudflare.com или попробуйте позже.",
    rateLimited: "Слишком много попыток. Подождите несколько минут и попробуйте снова.",
    network: "Не удалось подключиться к Portifact. Проверьте соединение и попробуйте снова.",
    failed: "Не удалось открыть ссылку. Попробуйте снова.",
  },
  /** The comment notice unsubscribe page (src/unsubscribe/unsubscribe.ts). */
  unsubscribe: {
    missing:
      "Ссылка неполная. Откройте ссылку из письма ещё раз или отключите уведомления о комментариях в настройках.",
    invalid: "Эта ссылка больше не работает. Отключите уведомления о комментариях в настройках.",
    rateLimited: "Слишком много попыток отсюда. Повторите через несколько минут.",
    network: "Не удалось связаться с Portifact. Проверьте подключение и повторите попытку.",
    failed:
      "Не удалось отключить уведомления о комментариях. Повторите попытку или отключите их в настройках.",
    done: "Уведомления о комментариях и ревью отключены.",
  },
} satisfies AuthMessages;

const TERMS_LINKS = {
  terms:
    '<a href="https://portifact.com/terms" target="_blank" rel="noopener">Условия обслуживания</a>',
  acceptableUse:
    '<a href="https://portifact.com/acceptable-use" target="_blank" rel="noopener">Правила допустимого использования</a>',
  privacy:
    '<a href="https://portifact.com/privacy" target="_blank" rel="noopener">Политику конфиденциальности</a>',
};

/** The conditions of the sign-in notices after the action that accepts them. */
const termsConditions = `вы подтверждаете, что вам 18 лет или больше, принимаете ${TERMS_LINKS.terms} и ${TERMS_LINKS.acceptableUse}, а также что вы прочитали ${TERMS_LINKS.privacy}. Ссылки открываются в новой вкладке.`;

export const ru: AuthCatalog = {
  messages,
  page: {
    // Shared by the four pages.
    "auth.skip": "Перейти к содержимому",
    "auth.home": "Главная Portifact",
    "auth.legal": "Правовая информация",
    "auth.terms": "Условия",
    "auth.privacy": "Конфиденциальность",
    "auth.acceptableUse": "Допустимое использование",
    "auth.accessTo": "Доступ к",
    "auth.ableTo": "Сможет",
    "auth.deny": "Отклонить",

    // login.html
    "login.title": "Вход в Portifact",
    "login.intro": "Впервые здесь? Первый вход создаст ваш аккаунт.",
    "login.signedInHint": "Можно открыть кабинет, закрыть эту страницу или выйти в этом браузере.",
    "login.openDashboard": "Открыть кабинет",
    "login.methodsHeading": "Способы входа",
    "login.methodsHint":
      "Аккаунт Google или GitHub с этим подтверждённым адресом привязывается к этому аккаунту при первом использовании.",
    "login.methodNotUsed": "Ещё не использовался",
    "login.signOut": "Выйти",
    "login.termsUpdateHeading": "Ознакомьтесь с условиями, чтобы продолжить",
    "login.termsUpdateBody": "Ваш аккаунт ещё не принял текущую версию условий.",
    "login.termsUpdateNotice": `Выбирая «Принять и продолжить», ${termsConditions}`,
    "login.agreeAndContinue": "Принять и продолжить",
    "login.termsNotice": `Продолжая с Google, GitHub или кодом по почте, ${termsConditions}`,
    "login.termsNoticeSso": `Продолжая с Google, GitHub, кодом по почте или единым входом, ${termsConditions}`,
    "login.ssoHeading": "Ваша организация использует единый вход",
    "login.ssoContinue": "Продолжить с единым входом",
    "login.ssoUseCode": "Лучше код по почте",
    "login.ssoLinkHint":
      "Ваша организация использует единый вход. Свяжите его с этим аккаунтом один раз и используйте в следующий раз.",
    "login.ssoLink": "Связать единый вход",
    "login.google": "Продолжить с Google",
    "login.github": "Продолжить с GitHub",
    "login.orEmail": "или по электронной почте",
    "login.emailLabel": "Адрес электронной почты",
    "login.sendCode": "Отправить код",
    "login.codeHeading": "Проверьте почту",
    "login.codeLabel": "6-значный код",
    "login.codeHint":
      "Код действует 5 минут и только один раз. Если письмо не пришло, проверьте папку «Спам».",
    "login.verify": "Войти",
    "login.resend": "Отправить новый код",
    "login.changeEmail": "Другой адрес",
    "login.humanHeading": "Ещё один шаг: подтвердите, что вы человек",
    "login.humanBody":
      "Cloudflare нужна короткая проверка, прежде чем Portifact сможет продолжить. Пройдите её ниже, и вход продолжится сам.",

    // device.html
    "device.title": "Подключение устройства к Portifact",
    "device.eyebrow": "CLI и приложения Portifact",
    "device.heading": "Подключение устройства",
    "device.intro": "Подтвердите CLI Portifact или другое приложение, которое показало вам код.",
    "device.codeLabel": "Код, показанный в терминале",
    "device.continue": "Продолжить",
    "device.reviewHeading": "Подтвердить этот вход?",
    "device.app": "Приложение",
    "device.code": "Код",
    "device.warning":
      "Подтверждайте, только если вы сами начали это в своём терминале и код совпадает.",
    "device.approve": "Подтвердить",

    // consent.html
    "consent.title": "Доступ к Portifact",
    "consent.eyebrow": "Подключённые приложения",
    "consent.heading": "Разрешить доступ",
    "consent.requestHeading":
      '<span id="client-name" class="font-semibold break-words"></span> хочет использовать ваш аккаунт Portifact',
    "consent.publishedBy": "Сведения о приложении опубликовал",
    "consent.loopback":
      "Возврат в приложение на этом устройстве. Разрешайте, только если вы начали это из приложения, которому доверяете.",
    "consent.allow": "Разрешить",
    "consent.disconnect":
      "Отключить приложения можно в любой момент на странице аккаунта в кабинете.",

    // report.html
    "report.title": "Жалоба на artifact в Portifact",
    "report.heading": "Пожаловаться на artifact",
    "report.intro":
      'Сообщите нам о контенте, который нарушает <a href="https://portifact.com/acceptable-use">Правила допустимого использования</a>. Аккаунт не нужен. Мы стараемся ответить в течение 48 часов.',
    "report.artifactLabel": "Адрес или ID artifact",
    "report.reasonLabel": "Что не так",
    "report.reason.none": "Выберите причину",
    "report.reason.phishing": "Фишинг или поддельная страница входа",
    "report.reason.malware": "Вредоносное ПО, эксплойты или майнинг криптовалют",
    "report.reason.child_safety": "Сексуализация несовершеннолетних",
    "report.reason.sexual_content": "Откровенно сексуальный контент",
    "report.reason.copyright":
      "Нарушение авторских прав или прав на товарный знак, пиратские файлы",
    "report.reason.impersonation": "Выдача себя за другое лицо",
    "report.reason.harassment": "Угрозы, травля или насильственный экстремизм",
    "report.reason.private_information": "Чужая личная информация",
    "report.reason.spam": "Спам",
    "report.reason.other": "Другое нарушение правил",
    "report.detailsLabel":
      'Подробности <span class="font-normal text-text-muted">(необязательно)</span>',
    "report.detailsHint":
      "Что вы увидели и где. Не вставляйте незаконные материалы; адреса достаточно. До 2000 символов.",
    "report.emailLabel":
      'Ваша электронная почта <span class="font-normal text-text-muted">(необязательно)</span>',
    "report.emailHint":
      'Только если хотите, чтобы мы могли ответить. См. <a href="https://portifact.com/privacy">Политику конфиденциальности</a>.',
    "report.send": "Отправить жалобу",
    "report.doneHeading": "Спасибо, мы получили вашу жалобу",
    "report.doneBody":
      'Мы рассматриваем каждую жалобу. Также можно написать на <a href="mailto:abuse@portifact.com">abuse@portifact.com</a>.',
    // share.html
    "share.title": "Открыть общий artifact",
    "share.heading": "Открыть общий artifact",
    "share.passwordIntro": "Человек, поделившийся этим artifact, защитил его паролем.",
    "share.passwordLabel": "Пароль",
    "share.humanCheckHint":
      "После нескольких неверных паролей подтвердите, что вы человек, чтобы попробовать снова.",
    "share.open": "Открыть",
    "share.unavailableHeading": "Эта ссылка не работает",
    "share.unavailableBody":
      "Возможно, срок её действия истёк или её отозвали, или это не ссылка для доступа. Попросите новую ссылку у того, кто ею поделился.",
    "share.incompleteHeading": "Откройте ссылку снова",
    "share.incompleteBody":
      "Этой странице нужна полная ссылка, включая часть после #. Для вашей безопасности страница убирает эту часть из адресной строки, поэтому после перезагрузки откройте ссылку снова оттуда, где вы её получили.",
    "share.privacy":
      "Вы читаете artifact без учётной записи. Portifact не записывает, кто вы; владелец видит только, что ссылкой воспользовались. Artifact написан его автором, а не Portifact: не вводите в нём пароли и личные данные.",
    "share.report": "Сообщить о нарушении",

    // unsubscribe.html
    "unsubscribe.title": "Отключить уведомления о комментариях Portifact",
    "unsubscribe.heading": "Отключить уведомления о комментариях",
    "unsubscribe.intro":
      "Вы больше не будете получать письма о новых комментариях и ревью artifacts в Portifact. Напоминания об истечении срока и письма для входа не изменятся.",
    "unsubscribe.confirm": "Отключить уведомления о комментариях",
    "unsubscribe.doneHeading": "Уведомления о комментариях отключены",
    "unsubscribe.doneBody": 'Их можно снова включить в <a href="/settings">настройках</a>.',
  },
};
