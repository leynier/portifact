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
    read_rate_limited:
      "С этого аккаунта открыто слишком много artifacts за короткое время. Подождите несколько минут и снова откройте ссылку.",
  },
  providerErrorFallback: "Вход не завершился. Попробуйте ещё раз.",
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
  /** The comment notice unsubscribe page (src/unsubscribe/unsubscribe.ts). */
  unsubscribe: {
    missing:
      "Ссылка неполная. Откройте ссылку из письма ещё раз или отключите уведомления о комментариях в настройках.",
    invalid: "Эта ссылка больше не работает. Отключите уведомления о комментариях в настройках.",
    rateLimited: "Слишком много попыток отсюда. Повторите через несколько минут.",
    network: "Не удалось связаться с Portifact. Проверьте подключение и повторите попытку.",
    failed:
      "Не удалось отключить уведомления о комментариях. Повторите попытку или отключите их в настройках.",
    done: "Уведомления о комментариях отключены.",
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

    // unsubscribe.html
    "unsubscribe.title": "Отключить уведомления о комментариях Portifact",
    "unsubscribe.heading": "Отключить уведомления о комментариях",
    "unsubscribe.intro":
      "Вы больше не будете получать письма о новых комментариях к artifacts в Portifact. Напоминания об истечении срока и письма для входа не изменятся.",
    "unsubscribe.confirm": "Отключить уведомления о комментариях",
    "unsubscribe.doneHeading": "Уведомления о комментариях отключены",
    "unsubscribe.doneBody": 'Их можно снова включить в <a href="/settings">настройках</a>.',
  },
};
