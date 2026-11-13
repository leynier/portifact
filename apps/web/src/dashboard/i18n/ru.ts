// Russian messages of the dashboard (standard Russian, "вы" in lowercase), with the same keys as
// en.ts. "artifact" stays in Latin script, masculine and undeclined. Titles and buttons have no
// trailing period; no em dashes.
import { planTextRu } from "../../plans/i18n/ru.ts";
import type { Catalog } from "./en.ts";

export const ru = {
  ...planTextRu,
  "app.title": "Portifact",
  "dataGrant.pageTitle": "Сохранение введённого",
  "dataGrant.title": "Разрешить {host} сохранять то, что вы вводите?",
  "dataGrant.ownerPerson": "Опубликовал(а) {name}",
  "dataGrant.ownerWorkspace": "Опубликовано рабочим пространством {name}",
  "dataGrant.learns":
    "Страница будет знать вас как {name}, с идентификатором только для этого artifact. Ваш адрес почты она не узнает.",
  "dataGrant.managers":
    "Люди, которые управляют этим artifact, могут читать всё, что там сохранено.",
  "dataGrant.moves":
    "Если artifact перейдёт к другому владельцу, сохранённое перейдёт вместе с ним.",
  "dataGrant.deletion":
    "Если вы удалите аккаунт, созданное вами там будет удалено вместе с последующими правками других. Ваши правки в записях других людей останутся, без вашего имени.",
  "dataGrant.lasts":
    "Действует {days} дней в этом браузере, пока вы не выйдете или не отзовёте разрешение.",
  "dataGrant.rights": "Посмотреть, чем вы поделились, и отозвать",
  "dataGrant.allow": "Разрешить",
  "dataGrant.notNow": "Не сейчас",
  "dataGrant.loading": "Загрузка",
  "dataGrant.unavailable": "Этот запрос нельзя использовать",
  "dataGrant.unavailableHint": "Откройте artifact снова и выберите сохранение оттуда.",
  "dataGrant.failed": "Разрешение не завершено",
  "sharedData.title": "Ваши общие данные",
  "sharedData.description":
    "Страницы artifact, которые могут знать вас и сохранять то, что вы вводите. Отзыв действует в течение минуты; сохранённое остаётся в artifact.",
  "sharedData.listTitle": "Разрешённые страницы",
  "sharedData.loading": "Загрузка общих данных",
  "sharedData.failed": "Не удалось загрузить общие данные",
  "sharedData.empty": "Вы пока ничем не поделились",
  "sharedData.emptyHint":
    "Когда страница artifact попросит сохранять то, что вы вводите, и вы разрешите, она появится здесь.",
  "sharedData.artifact": "Artifact",
  "sharedData.since": "Разрешено с",
  "sharedData.status": "Статус",
  "sharedData.actions": "Действия",
  "sharedData.gone": "Artifact больше недоступен",
  "sharedData.open": "Разрешено до {date}",
  "sharedData.ended": "Завершено",
  "sharedData.revoke": "Отозвать",
  "sharedData.revokeNamed": "Отозвать {name}",
  "sharedData.revoked": "{name} больше не может сохранять от вашего имени",
  "sharedData.confirmTitle": "Отозвать {name}?",
  "sharedData.confirmBody":
    "В течение минуты, во всех браузерах, страница перестанет знать вас и сохранять от вашего имени. Сохранённое остаётся в artifact.",
  "sharedData.cancel": "Отмена",
  "sharedData.revokeFailed": "Отзыв не завершён",
  "sharedData.more": "Показать ещё",
  "app.pageTitle": "{page} · Portifact",
  "shell.skipLink": "Перейти к содержимому",
  "shell.navigation": "Основное",
  "shell.home": "Кабинет Portifact",
  "shell.artifacts": "Artifacts",
  "shell.usageLink": "Использование",
  "shell.appsLink": "Приложения",
  "shell.webhooksLink": "Вебхуки",
  "shell.settingsLink": "Настройки",
  "shell.profileLink": "Профиль",
  "shell.openNavigation": "Открыть навигацию",
  "shell.closeNavigation": "Закрыть навигацию",
  "shell.collapseSidebar": "Свернуть боковую панель",
  "shell.expandSidebar": "Развернуть боковую панель",
  "shell.resizeSidebar": "Изменить ширину боковой панели",
  "shell.signOut": "Выйти",
  "shell.signingOut": "Выполняется выход.",
  "shell.signOutFailed": "Выйти не удалось. Попробуйте ещё раз.",
  "shell.publishLink": "Опубликовать",
  "shell.dismiss": "Закрыть сообщение",
  "theme.legend": "Тема",
  "theme.system": "Системная",
  "theme.light": "Светлая",
  "theme.dark": "Тёмная",
  "copy.done": "Скопировано в буфер обмена",
  "copy.failed": "Браузер заблокировал буфер обмена. Выделите текст и скопируйте его вручную.",
  "copy.copied": "Скопировано",
  "shell.loadingAccount": "Загрузка аккаунта",
  "shell.capacity.title": "Portifact бережёт свои ресурсы",
  "shell.capacity.new_artifacts":
    "Создание новых artifacts пока приостановлено. Обновления ваших artifacts по-прежнему работают, и ваши artifacts остаются в сети.",
  "shell.capacity.publishing":
    "Новые загрузки пока приостановлены, и новые комментарии, возможно, тоже. Ваши artifacts остаются в сети, и вы по-прежнему можете читать, экспортировать, удалять, продлевать и сокращать доступ.",

  "language.title": "Язык",
  "language.hint": "Язык кабинета, страниц входа и писем, которые Portifact вам отправляет.",
  "language.label": "Язык",
  "language.description":
    "Сохраняется в вашем аккаунте, поэтому на других ваших устройствах он тоже будет использоваться.",
  "language.changed": "Кабинет теперь на русском языке.",
  "language.loadFailed": "Не удалось загрузить язык. Проверьте подключение и попробуйте ещё раз.",
  "language.saveFailed":
    "Язык изменился в этом браузере, но сохранить его в аккаунте не удалось. Попробуйте позже.",

  "list.title": "Artifacts",
  "list.description": "Всё, что вы опубликовали. Список обновляется, пока эта вкладка открыта.",
  "list.loading": "Загрузка ваших artifacts",
  "list.caption": "Ваши artifacts",
  "list.column.name": "Название",
  "list.column.state": "Состояние",
  "list.column.expires": "Истекает",
  "list.column.usage": "Размер",
  "list.column.activity": "Активность",
  "list.column.actions": "Быстрые действия",
  "list.noVersion": "Нет версии",
  "list.versions":
    "{count, plural, one {# версия сохранена} few {# версии сохранены} many {# версий сохранено} other {# версии сохранено}}",
  "list.updated": "Обновлён {date}",
  "list.openThreads":
    "{count, plural, =0 {Нет открытых веток} one {# открытая ветка} few {# открытые ветки} many {# открытых веток} other {# открытой ветки}}",
  "list.lastComment": "Комментарии изменены {date}",
  "list.trafficNote": "Трафик считается для всего аккаунта, а не для каждого artifact.",
  "list.trafficLink": "Использование",
  "list.loadMore": "Загрузить ещё",
  "list.loadingMore": "Загрузка других artifacts",
  "list.count":
    "{count, plural, one {Показан # artifact} few {Показано # artifacts} many {Показано # artifacts} other {Показано # artifacts}}",
  "list.empty.title": "Пока нет artifacts",
  "list.empty.body":
    "Опубликуйте HTML-файл, папку, ZIP или документ кнопкой «Опубликовать» или из терминала, и он появится здесь.",
  "list.error.title": "Не удалось загрузить ваши artifacts",
  "list.refreshFailed.title": "Не удалось обновить список",
  "list.refreshFailed.body":
    "Показано то, что загрузилось в последний раз. Portifact скоро попробует снова.",
  "list.never": "Никогда",
  "list.pinned": "Закреплён",
  "list.column.access": "Доступ",
  "list.captionFiltered": "Ваши artifacts, подходящие под поиск и фильтры",
  "list.countFiltered":
    "{count, plural, one {Показан # подходящий artifact} few {Показано # подходящих artifacts} many {Показано # подходящих artifacts} other {Показано # подходящих artifacts}}",
  "list.searching": "Поиск по вашим artifacts",
  "list.noMatch.title": "Ничего не найдено",
  "list.noMatch.body":
    "Попробуйте другой запрос или сбросьте фильтры, чтобы увидеть все artifacts.",
  "list.access.public": "Публичный",
  "list.access.authenticated": "Вошедшие пользователи",
  "list.access.restricted": "Ограниченный",
  "list.annotations.off": "Комментарии выключены",
  "list.annotations.open": "Комментарии открыты",
  "list.annotations.locked": "Комментарии закрыты",
  "list.filter.label": "Поиск и фильтры artifacts",
  "list.filter.search": "Поиск",
  "list.filter.searchPlaceholder": "Название или ID",
  "list.filter.clearSearch": "Очистить поиск",
  "list.filter.searchTooLong": "Не более {max} символов в запросе",
  "list.filter.state": "Состояние",
  "list.filter.type": "Тип",
  "list.filter.access": "Доступ",
  "list.filter.annotations": "Комментарии",
  "list.filter.expiring": "Срок действия",
  "list.expiring.soon": "Истекает в течение 3 дней",
  "list.filter.any": "Любой",
  "list.filter.open": "Фильтры",
  "list.filter.activeCount": "включено",
  "list.filter.sheetTitle": "Фильтры artifacts",
  "list.filter.close": "Закрыть фильтры",
  "list.filter.done": "Готово",
  "list.filter.clear": "Сбросить фильтры",
  "list.content.toggle": "Искать в содержимом",
  "list.content.toggleHint":
    "Находит слова в тексте активных artifact, а не только в их названиях.",
  "list.content.search": "Искать в содержимом",
  "list.content.placeholder": "Слова из текста",
  "list.content.caption": "Artifact, текст которых соответствует поиску",
  "list.content.column.match": "Совпадение",
  "list.content.file": "В {path}",
  "list.content.partial": "Проиндексирован частично: часть текста слишком велика для поиска.",
  "list.content.count":
    "{count, plural, one {Найден # artifact с подходящим текстом} few {Найдено # artifact с подходящим текстом} many {Найдено # artifact с подходящим текстом} other {Найдено # artifact с подходящим текстом}}",
  "list.content.searching": "Поиск в ваших artifact",
  "list.content.noMatch.title": "Совпадений в тексте нет",
  "list.content.noMatch.body":
    "В тексте должно встречаться каждое слово. Архивные artifact не ищутся.",
  "list.content.error": "Поиск не удался",
  "list.open": "Открыть",
  "list.openLabel": "Открыть опубликованную версию «{name}»",
  "list.review": "Проверить",
  "list.reviewLabel": "Проверить и прокомментировать «{name}»",
  "list.onboarding.lead":
    "Каждый artifact получает свою ссылку, доступную только вам, пока вы не решите, кто ещё может его открыть. Выберите способ, который подходит вам.",
  "list.onboarding.browser.title": "Загрузить в браузере",
  "list.onboarding.browser.body": "Перетащите HTML-файл, папку, ZIP или документ Markdown.",
  "list.onboarding.browser.action": "Опубликовать из браузера",
  "list.onboarding.cli.title": "Публикация из терминала",
  "list.onboarding.cli.body":
    "Установите CLI, войдите один раз, а затем публикуйте файл или папку.",
  "list.onboarding.cli.install": "Установить CLI",
  "list.onboarding.cli.publish": "Опубликовать файл",
  "list.onboarding.cli.copy": "Копировать команду",
  "list.onboarding.mcp.title": "Пусть публикует агент",
  "list.onboarding.mcp.body":
    "Добавьте Portifact как удалённый MCP-сервер в Claude, Codex, Cursor или любом MCP-клиенте, а затем попросите агента опубликовать то, что он создал.",
  "list.onboarding.mcp.url": "URL MCP-сервера",
  "list.onboarding.mcp.copy": "Копировать URL",

  "detail.loading": "Загрузка artifact",
  "detail.back": "Все artifacts",
  "detail.notFound.title": "Artifact не найден",
  "detail.notFound.body": "Он не существует, был удалён или принадлежит другому аккаунту.",
  "detail.error.title": "Не удалось загрузить artifact",
  "detail.facts": "Сведения",
  "detail.url": "URL",
  "detail.type": "Тип",
  "detail.state": "Состояние",
  "detail.access": "Доступ",
  "detail.created": "Создан",
  "detail.updated": "Обновлён",
  "detail.expires": "Истекает",
  "detail.archived": "В архиве с",
  "detail.purge": "Окончательное удаление",
  "detail.notSet": "Не задано",
  "detail.link": "Ссылка",
  "detail.copyLink": "Копировать ссылку",
  "detail.linkCopied": "Ссылка скопирована",
  "detail.open": "Открыть",
  "detail.lifecycleHint":
    "Продление оставляет его в сети ещё на 30 дней. Artifacts в архиве недоступны и позже удаляются навсегда; восстановите их до этого.",
  "detail.comments.title": "Комментарии",
  "detail.comments.body":
    "Рецензенты комментируют конкретные фразы и элементы. Читайте, отвечайте и закрывайте комментарии в просмотрщике, где их может прочитать и ваш агент.",
  "detail.comments.unavailable": "Читать и добавлять комментарии можно, пока artifact активен.",
  "detail.versions.title": "Версии",
  "detail.versions.body":
    "Каждая публикация создаёт новую версию. Скачивайте, сравнивайте и откатывайте сохранённые версии в истории.",
  "detail.actions": "Действия",
  "detail.sectionsNav": "Разделы artifact",
  "sections.title": "На этой странице",
  "detail.section.overview": "Обзор",
  "detail.section.sharing": "Доступ",
  "detail.section.comments": "Комментарии",
  "detail.section.activity": "Активность",
  "detail.section.danger": "Опасная зона",
  "detail.danger.body":
    "Архивирование убирает artifact из сети; позже он удаляется навсегда, если вы не восстановите его раньше. Удаление сразу и навсегда стирает его и все версии.",
  "detail.keepOnline.body": "Продление оставляет его в сети ещё на 30 дней.",
  "detail.restore.body":
    "Восстановите его до окончательного удаления, чтобы снова сделать доступным.",
  "detail.noActions": "В этом состоянии действия недоступны.",
  "detail.renew": "Продлить на 30 дней",
  "detail.pin": "Закрепить",
  "detail.unpin": "Открепить",
  "detail.pinned.body": "Закреплён: остаётся онлайн без срока, пока вы его не открепите.",
  "detail.pin.paid": "Закрепление оставляет artifact онлайн без срока. Это часть тарифа {plan}.",
  "detail.expiresNever": "Никогда, он закреплён",
  "detail.pinnedDone": "Artifact закреплён. Он остаётся онлайн без срока.",
  "detail.unpinnedDone": "Artifact откреплён. Теперь он истекает {date}.",
  "detail.archive": "В архив",
  "detail.restore": "Восстановить",
  "detail.delete": "Удалить",
  "detail.renewed": "Artifact продлён. Теперь он истекает {date}.",
  "detail.archivedDone":
    "Artifact перемещён в архив. Он будет удалён навсегда {date}, если вы его не восстановите.",
  "detail.restored": "Artifact восстановлен. Он истекает {date}.",
  "detail.deleted": "Artifact «{name}» удалён.",
  "detail.working": "Выполняется.",
  "detail.actionFailed.title": "Действие не завершилось",
  "detail.confirmDelete.title": "Удалить «{name}»?",
  "detail.confirmDelete.body":
    "Artifact сразу перестанет открываться, а его файлы будут удалены. Это действие нельзя отменить.",
  "detail.confirmDelete.confirm": "Удалить artifact",
  "detail.confirmDelete.cancel": "Оставить",

  "accessSettings.title": "Доступ",
  "accessSettings.loading": "Загрузка списка тех, кто может открыть этот artifact",
  "accessSettings.loadFailed.title": "Не удалось загрузить настройки доступа",
  "accessSettings.republish":
    "Публикация новой версии никогда не меняет эти настройки, поэтому повторная публикация не открывает artifact большему кругу людей. Расширить доступ можете только вы: здесь, из CLI или через агента, которому вы разрешили делиться.",
  "accessSettings.suspended": "Этот artifact заблокирован, поэтому доступ к нему изменить нельзя.",
  "detail.suspended.title":
    "Заблокирован из-за возможного нарушения Правил допустимого использования",
  "detail.suspended.body":
    "Portifact заблокировал этот artifact после проверки. Он никому не показывается, его нельзя изменить или опубликовать в нём новую версию. Причина: {reason}. Если вы считаете, что это ошибка, напишите на abuse@portifact.com и укажите адрес artifact.",
  "detail.suspended.facts": "Факты, на которые мы опирались",
  "detail.suspended.ground": "Основание (закон или правило наших условий) и почему оно применяется",
  "detail.suspended.notice":
    "Решение принято {date} по полученному уведомлению. Это решение принял человек.",
  "detail.suspended.review":
    "Решение принято {date} по итогам нашей собственной проверки. Это решение принял человек.",
  "settings.suspended.title": "Ваш аккаунт приостановлен",
  "settings.suspended.body":
    "Portifact приостановил ваш аккаунт. Он не может публиковать, а его артефакты приостановлены вместе с ним. Вы по-прежнему можете входить, экспортировать данные и удалить аккаунт. Причина: {reason}. Чтобы попросить о пересмотре, напишите на abuse@portifact.com.",
  "branding.suspendedReason": "Причина: {reason}.",
  "reason.phishing": "фишинг или поддельная страница входа",
  "reason.malware": "вредоносное ПО, эксплойты или майнинг криптовалют",
  "reason.sexual_content": "откровенно сексуальный контент",
  "reason.child_safety": "контент, сексуализирующий несовершеннолетних",
  "reason.copyright": "нарушение авторских прав или прав на товарный знак",
  "reason.impersonation": "выдача себя за другое лицо",
  "reason.harassment": "угрозы, травля или насильственный экстремизм",
  "reason.private_information": "чужая личная информация",
  "reason.spam": "спам",
  "reason.other": "другое нарушение правил",
  "accessSettings.mode.legend": "Кто может открыть этот artifact",
  "accessSettings.mode.restricted":
    "Вы и адреса электронной почты из списка ниже. Каждый человек сначала входит с этим адресом.",
  "accessSettings.mode.authenticated":
    "Любой, у кого есть ссылка и кто вошёл в Portifact с любым аккаунтом.",
  "accessSettings.mode.public": "Любой, у кого есть ссылка, без входа.",
  "accessSettings.mode.publicSlack":
    "Если к этому пространству подключён Slack, опубликованная там ссылка на него показывает его название и тип, и Slack сохраняет это превью, даже когда он перестаёт быть публичным.",
  "accessSettings.mode.publicFrom":
    "Доступно с {date}. Новые аккаунты ждут {minutes} мин., прежде чем сделать artifact публичным.",
  "accessSettings.indexable.label": "Разрешить поисковым системам показывать его",
  "accessSettings.indexable.hint": "Действует, только пока artifact публичный.",
  "accessSettings.embeddable.label": "Разрешить другим сайтам встраивать его",
  "accessSettings.embeddable.hint":
    "Другие сайты смогут показывать его во фрейме. Действует, только пока artifact публичный.",
  "accessSettings.bar.label": "Показывать панель Portifact",
  "accessSettings.bar.hint":
    "Ссылки открываются в просмотрщике Portifact: панель сверху, комментарии рядом с artifact. Выключите её для приложений и страниц, которым нужно всё окно; тогда ссылка откроет только сам artifact.",
  "accessSettings.comments.legend": "Кто видит комментарии",
  "accessSettings.comments.owner": "Только вы, а каждый человек свои",
  "accessSettings.comments.owner.hint":
    "Каждый видит ветки, которые начал сам, и ветки, начатые вами, со всеми ответами в них. Вы видите все ветки.",
  "accessSettings.comments.everyone": "Все, кто может открыть artifact",
  "accessSettings.comments.everyone.hint":
    "Все, кто может открыть artifact, видят все ветки и могут в них отвечать.",
  "accessSettings.comments.exceptions":
    "Для добавленного вами человека можно сделать исключение рядом с его адресом в разделе «Доступ».",
  "accessSettings.comments.confirm.title": "Показать все комментарии всем?",
  "accessSettings.comments.confirm.body":
    "Уже написанные комментарии, а не только новые, станут видны всем, кто может открыть artifact.",
  "accessSettings.comments.confirm.action": "Показать все комментарии",
  "accessSettings.cancel": "Отмена",
  "accessSettings.save": "Сохранить доступ",
  "accessSettings.saved":
    "Доступ сохранён. Те, кто больше не может открыть artifact, потеряют доступ в течение минуты.",
  "accessSettings.unchanged": "Нечего сохранять: доступ уже настроен так.",
  "accessSettings.saveFailed.title": "Доступ не сохранён",
  "accessSettings.conflict":
    "Тем временем доступ изменили в другом месте. Сейчас показаны последние настройки; проверьте их и попробуйте ещё раз.",
  "accessSettings.tooNew":
    "Новые аккаунты могут сделать artifact публичным через {minutes} мин. после создания, с {date}.",
  "accessSettings.tooNewNoDate":
    "Новые аккаунты могут сделать artifact публичным через {minutes} мин. после создания.",
  "accessSettings.readersFull":
    "В списке artifact может быть не больше {max} человек. Удалите кого-нибудь, чтобы добавить другого.",

  "settings.unsaved": "Несохранённые изменения",
  "linkSettings.title": "Настройки ссылки",
  "linkSettings.description":
    "Как открывается ссылка и могут ли её использовать поисковые системы и другие сайты.",
  "linkSettings.save": "Сохранить настройки ссылки",
  "linkSettings.saved": "Настройки ссылки сохранены.",
  "linkSettings.unchanged": "Нечего сохранять: ссылка уже настроена так.",
  "linkSettings.saveFailed.title": "Настройки ссылки не сохранены",
  "commentSettings.title": "Настройки комментариев",
  "commentSettings.mode.legend": "Комментарии к этому artifact",
  "commentSettings.mode.open": "Открыты",
  "commentSettings.mode.open.hint":
    "Те, кто может открыть artifact, могут комментировать и отвечать.",
  "commentSettings.mode.locked": "Закрыты",
  "commentSettings.mode.locked.hint": "Комментарии можно читать, но добавлять новые нельзя.",
  "commentSettings.mode.off": "Выключены",
  "commentSettings.mode.off.hint": "Комментарии скрыты, и комментировать нельзя.",
  "commentSettings.save": "Сохранить настройки комментариев",
  "commentSettings.saved": "Настройки комментариев сохранены.",
  "commentSettings.unchanged": "Нечего сохранять: комментарии уже настроены так.",
  "commentSettings.saveFailed.title": "Настройки комментариев не сохранены",

  "readers.title": "Добавленные люди",
  "readers.hint":
    "Они могут открыть artifact, пока доступ открыт только вам и добавленным вами людям.",
  "readers.count": "{count} из {max} человек",
  "readers.empty": "Пока никого. Добавьте адрес электронной почты ниже.",
  "readers.list": "Люди, которые могут открыть этот artifact",
  "readers.email.label": "Адрес электронной почты",
  "readers.email.hint": "Чтобы открыть artifact, человек входит именно с этим адресом.",
  "readers.add": "Добавить",
  "readers.added": "Адрес {email} добавлен.",
  "readers.remove": "Удалить",
  "readers.removeLabel": "Удалить {email}",
  "readers.removed": "Адрес {email} удалён. Доступ пропадёт в течение минуты.",
  "readers.invalid": "Введите адрес электронной почты, например ana@example.com.",
  "readers.duplicate": "{email} уже есть в списке.",
  "readers.full": "Список заполнен: у artifact может быть не больше {max} человек.",
  "readers.failed.title": "Список не изменён",
  "readers.comments.label": "Комментарии, которые видит {email}",
  "readers.comments.inherit.owner": "По умолчанию: свои и ваши",
  "readers.comments.inherit.everyone": "По умолчанию: все комментарии",
  "readers.comments.all": "Все комментарии",
  "readers.comments.own": "Только свои и ваши",
  "readers.comments.hint":
    "Меню рядом с каждым человеком определяет, какие комментарии он видит. Это действует всегда, когда он входит с этим адресом, при любом режиме доступа.",
  "readers.comments.changed": "{email} теперь видит: {choice}.",
  "readers.comments.confirm.title": "Показать {email} все комментарии?",
  "readers.comments.confirm.body":
    "{email} увидит все ветки этого artifact, включая комментарии, уже написанные другими людьми.",

  "profile.title": "Профиль",
  "profile.description": "Кто вы в Portifact, как вы входите и где выполнен вход.",
  "profile.details": "Ваш аккаунт",
  "profile.sectionsNav": "Разделы профиля",
  "account.name": "Имя",
  "account.email": "Электронная почта",
  "account.memberSince": "С нами с",
  "account.methods.title": "Способы входа",
  "account.methods.hint":
    "Вход через Google или GitHub автоматически привязывается к этому аккаунту, если подтверждает тот же адрес электронной почты.",
  "account.methods.loading": "Загрузка способов входа",
  "account.methods.error": "Не удалось загрузить способы входа",
  "account.methods.email": "Код по почте",
  "account.methods.emailDetail": "Коды отправляются на {email}",
  "account.methods.connected": "Подключено {date}",
  "provider.google": "Google",
  "provider.github": "GitHub",
  "account.sessions.title": "Сеансы в браузерах",
  "account.sessions.hint":
    "Браузеры, в которых выполнен вход в ваш аккаунт. Защищённые artifacts, открытые в браузере, закрываются в течение минуты после выхода из него.",
  "account.sessions.loading": "Загрузка сеансов в браузерах",
  "account.sessions.error": "Не удалось загрузить сеансы в браузерах",
  "account.sessions.caption": "Браузеры, в которых выполнен вход в ваш аккаунт",
  "account.sessions.column.browser": "Браузер",
  "account.sessions.column.lastActive": "Активность",
  "account.sessions.column.expires": "Выход",
  "account.sessions.this": "Этот браузер",
  "account.sessions.device": "{browser} на {system}",
  "account.sessions.unknown": "Неизвестный браузер",
  "account.sessions.signOutOthers": "Завершить другие сеансы",
  "account.sessions.onlyThis": "Вход выполнен только в этом браузере.",
  "account.sessions.confirm.title": "Завершить другие сеансы?",
  "account.sessions.confirm.body":
    "Во всех остальных браузерах сразу будет выполнен выход. Подключённые приложения, например CLI и ваши агенты, продолжат работать, пока вы не отключите их ниже.",
  "account.sessions.confirm.confirm": "Завершить другие",
  "account.sessions.signedOut":
    "{count, plural, =0 {В других браузерах вход не был выполнен.} one {Завершён # другой сеанс.} few {Завершено # других сеанса.} many {Завершено # других сеансов.} other {Завершено # другого сеанса.}}",
  "apps.title": "Приложения",
  "apps.description":
    "CLI и агенты, которые могут действовать от вашего имени. Любое из них можно отключить в любой момент.",
  "apps.connect.title": "Подключить приложение",
  "apps.connect.hint":
    "Каждое приложение в первый раз запрашивает ваше разрешение в браузере, а затем появляется здесь.",
  "apps.connect.cli": "Вход из CLI",
  "apps.connect.mcp": "URL MCP-сервера для агента",
  "apps.connect.copyCommand": "Копировать команду",
  "apps.connect.copyUrl": "Копировать URL",
  "account.apps.title": "Подключённые приложения",
  "account.apps.hint":
    "CLI и агенты, подключённые через MCP. Каждое может делать то, что указано в его сведениях, пока вы его не отключите.",
  "account.apps.loading": "Загрузка подключённых приложений",
  "account.apps.error": "Не удалось загрузить подключённые приложения",
  "account.apps.empty.title": "Нет подключённых приложений",
  "account.apps.empty.body":
    "Выполните portifact login в терминале или добавьте MCP-сервер Portifact в своего агента. Каждое приложение запросит здесь ваше разрешение и будет в этом списке, пока вы его не отключите.",
  "account.apps.unnamed": "Приложение без названия",
  "account.apps.firstParty": "От Portifact",
  "account.apps.thirdParty": "Стороннее приложение",
  "account.apps.resources": "Подключается к",
  "account.apps.connectsTo": "Подключается к {resources}",
  "account.apps.access.full": "Полный доступ",
  "account.apps.access.readOnly": "Только чтение",
  "account.apps.access.partial":
    "{count, plural, one {# из {total} разрешений} few {# из {total} разрешений} many {# из {total} разрешений} other {# из {total} разрешений}}",
  "account.apps.lastUsed": "Использовалось {when}",
  "account.apps.expiresOn": "Доступ истекает {date}",
  "account.apps.details": "Сведения",
  "account.apps.detailsOf": "Сведения: {name}",
  "account.apps.resource.api": "Portifact API",
  "account.apps.resource.mcp": "Portifact MCP",
  "account.apps.scopes": "Разрешено",
  "account.apps.approved": "Одобрено",
  "account.apps.lastIssued": "Последний токен выдан",
  "account.apps.expires": "Доступ истекает",
  "account.apps.noExpiry": "Бессрочно",
  "account.apps.disconnect": "Отключить",
  "account.apps.disconnectLabel": "Отключить {name}",
  "account.apps.confirm.title": "Отключить {name}?",
  "account.apps.confirm.body":
    "Приложение сразу потеряет доступ, и для повторного подключения ему снова понадобится ваше разрешение.",
  "account.apps.disconnected": "Приложение {name} отключено.",
  "settings.title": "Настройки",
  "settings.sectionsNav": "Разделы настроек",
  "settings.description":
    "Язык, внешний вид Portifact, начальные настройки новых artifacts, письма, ваши данные и удаление аккаунта.",
  "settings.appearance.title": "Внешний вид",
  "settings.appearance.hint":
    "Как Portifact выглядит в этом браузере. «Системная» следует настройке устройства. Artifacts сохраняют оформление, которое им дали авторы.",
  "settings.defaults.title": "Настройки новых artifacts",
  "settings.defaults.hint":
    "Каждый artifact, который вы создадите с этого момента, начнёт с этих настроек, где бы вы его ни опубликовали: в кабинете, из CLI или через агента. Существующие artifacts сохраняют свои настройки; меняйте их на странице каждого artifact.",
  "settings.defaults.loading": "Загрузка настроек",
  "settings.defaults.error": "Не удалось загрузить настройки",
  "settings.defaults.access": "Кто может открыть новый artifact",
  "settings.defaults.access.restricted":
    "Только вы, пока не добавите людей. Это самый безопасный вариант.",
  "settings.defaults.comments": "Комментарии к новому artifact",
  "settings.defaults.comments.off": "Выключены",
  "settings.defaults.comments.off.hint":
    "Никто не может комментировать, пока вы не включите комментарии.",
  "settings.defaults.comments.open": "Открыты",
  "settings.defaults.comments.open.hint": "Все, кто может открыть artifact, могут комментировать.",
  "settings.defaults.bar.label": "Показывать панель Portifact на новых artifacts",
  "settings.defaults.save": "Сохранить",
  "settings.defaults.saved": "Настройки сохранены. Новые artifacts начнут с них.",
  "settings.defaults.unchanged": "Нечего сохранять: настройки по умолчанию уже такие.",
  "settings.defaults.failed": "Настройки по умолчанию не сохранены",
  "settings.notices.title": "Уведомления по почте",
  "settings.notices.hint":
    "Artifacts перестают открываться через 30 дней после последней публикации или продления. Portifact может напомнить вам об этом за несколько дней.",
  "settings.notices.expiry.label": "Напоминать по почте перед истечением срока artifacts",
  "settings.notices.expiry.hint":
    "Не больше одного письма в день со списком всех artifacts, срок которых истекает в ближайшие 3 дня, и ссылкой для продления каждого.",
  "settings.notices.save": "Сохранить уведомления",
  "settings.notices.saved": "Уведомления по почте сохранены.",
  "settings.notices.unchanged": "Нечего сохранять: уведомления уже настроены так.",
  "settings.notices.failed": "Уведомления по почте не сохранены",
  "settings.notices.comments.label": "Сообщать по почте о новых комментариях и ревью",
  "settings.notices.comments.hint":
    "Не чаще одного письма в 10 минут: сколько новых веток, ответов и закрытых веток в каждом artifact, без текста комментариев. Только для artifacts, у владельца которых тариф с уведомлениями о комментариях. Та же настройка управляет письмами о ревью: когда вас просят провести ревью и когда версию, которой вы управляете, одобряют или запрашивают изменения.",
  "commentNotices.label": "Сообщать по почте о новых комментариях к этому artifact",
  "commentNotices.hint":
    "Не чаще одного письма в 10 минут, только числа. Все письма о комментариях отключаются в настройках.",
  "commentNotices.muted": "Письма о комментариях к этому artifact отключены.",
  "commentNotices.unmuted": "Письма о комментариях к этому artifact включены.",
  "commentNotices.failed": "Ваш выбор не сохранён",
  "commentNotices.planRequired": "Уведомления о новых комментариях по почте входят в тариф {plan}.",
  "settings.danger.title": "Опасная зона",
  "settings.danger.hint": "Эти действия нельзя отменить.",
  "account.data.title": "Ваши данные",
  "account.data.hint":
    "Скачайте всё, что хранится в вашем аккаунте, в формате JSON: профиль, artifacts с их доступом, версиями и списками файлов, а также комментарии. Для каждой версии указана ссылка на скачивание её файлов.",
  "account.data.download": "Скачать данные аккаунта (JSON)",
  "account.data.spacePersonal":
    "Чтобы забрать то, что хранит ваше личное пространство (сохранённые версии и исходники каждого артефакта, журналы доступа, записи каждого артефакта и пространства и журнал аудита), откройте страницу загрузки пространства.",
  "account.data.spaceWorkspace":
    "Чтобы забрать то, что хранит рабочее пространство {workspace} (сохранённые версии и исходники каждого артефакта, журналы доступа, записи каждого артефакта и пространства и журнал аудита), откройте страницу загрузки пространства.",
  "account.data.spaceLink": "Скачать данные этого пространства",
  "account.delete.title": "Удаление аккаунта",
  "account.delete.hint":
    "Удаление аккаунта стирает ваши artifacts, сеансы, приложения и способы входа, а также ваши комментарии к чужим artifacts. Комментарий, на который кто-то ответил, заменяется отметкой «сообщение удалено». Адреса artifacts никогда не передаются другим. Это действие нельзя отменить, поэтому сначала скачайте свои данные.",
  "account.delete.confirmLabel": "Введите свой адрес для подтверждения",
  "account.delete.confirmHint": "Введите {email}",
  "account.delete.mismatch": "Для подтверждения введите адрес аккаунта точно.",
  "account.delete.button": "Удалить аккаунт",
  "account.delete.dialog.title": "Удалить аккаунт навсегда?",
  "account.delete.dialog.body":
    "Ваши artifacts сразу перестанут работать, а всё перечисленное выше будет удалено. Будет выполнен выход.",
  "account.delete.dialog.confirm": "Удалить мой аккаунт",
  "account.delete.reauth.title": "Войдите снова, чтобы удалить аккаунт",
  "account.delete.reauth.body":
    "Для вашей безопасности удаление требует входа не ранее чем 10 минут назад. Войдите снова и вернитесь сюда.",
  "account.delete.reauth.action": "Войти снова",
  "account.delete.done": "Ваш аккаунт удалён.",
  "account.actionFailed.title": "Действие не завершилось",
  "accessLog.title": "Кто открывал",
  "accessLog.hint":
    "Вошедшие посетители, открывавшие этот artifact за последние {days, plural, one {# день} few {# дня} many {# дней} other {# дня}}, сначала новые, по одной записи на посетителя за каждые 30 минут. Этот список видите только вы. Открытия записываются только для artifacts, доступ к которым ограничен указанными вами людьми; ваши собственные посещения не записываются, и некоторые открытия могут отсутствовать.",
  "accessLog.loading": "Загрузка списка тех, кто открывал artifact",
  "accessLog.error.title": "Не удалось загрузить журнал доступа",
  "accessLog.empty.title": "Пока нет посетителей",
  "accessLog.empty.body":
    "Никто из вошедших не открывал этот artifact за последние {days, plural, one {# день} few {# дня} many {# дней} other {# дня}}.",
  "accessLog.caption": "Открытия этого artifact вошедшими посетителями",
  "accessLog.column.opened": "Открыт",
  "accessLog.column.visitor": "Посетитель",
  "accessLog.loadMore": "Показать ещё",
  "accessLog.export.hint":
    "Экспорт содержит все записи за последние {days, plural, one {# день} few {# дня} many {# дней} other {# дня}}, а не только показанные.",
  "accessLog.export.csv": "Экспорт в CSV",
  "accessLog.export.json": "Экспорт в JSON",
  "accessLog.export.doneCsv": "Журнал доступа экспортирован в CSV.",
  "accessLog.export.doneJson": "Журнал доступа экспортирован в JSON.",
  "accessLog.export.failed": "Не удалось экспортировать журнал доступа",

  "analytics.title": "Статистика",
  "analytics.hint":
    "Просмотры страниц по дням (UTC) и, для artifacts с доступом только для указанных вами людей, сколько из них его открыли. Только счётчики: здесь никто не идентифицируется.",
  "analytics.loading": "Загрузка статистики artifact",
  "analytics.error.title": "Не удалось загрузить статистику",
  "analytics.planRequired": "Статистика по artifact и журнал доступа за год входят в тариф {plan}.",
  "analytics.range.label": "Период",
  "analytics.range.days":
    "Последние {count, plural, one {# день} few {# дня} many {# дней} other {# дня}}",
  "analytics.total.views": "Просмотры",
  "analytics.total.signedIn": "Просмотры вошедших посетителей",
  "analytics.total.visitors": "Разные вошедшие посетители",
  "analytics.visitors.notKept":
    "Считаются только для artifacts с доступом для указанных вами людей",
  "analytics.chart.label": "Просмотры по дням",
  "analytics.chart.summary":
    "Просмотры: {views} за {days, plural, one {# день} few {# дня} many {# дней} other {# дня}}. Самый активный день: {busiest}, просмотров: {most}.",
  "analytics.chart.summaryEmpty":
    "Нет просмотров за последние {days, plural, one {# день} few {# дня} many {# дней} other {# дня}}.",
  "analytics.chart.day": "{day}. Просмотры: {views}. С входом: {signedIn}.",
  "analytics.chart.dayWithVisitors":
    "{day}. Просмотры: {views}. С входом: {signedIn}. Разные посетители: {visitors}.",
  "analytics.chart.keyboard": "Переведите фокус на график и читайте каждый день с помощью стрелок.",
  "analytics.table.show": "Показать числа в таблице",
  "analytics.table.caption": "Просмотры этого artifact по дням",
  "analytics.column.day": "День",
  "analytics.column.views": "Просмотры",
  "analytics.column.signedIn": "С входом",
  "analytics.column.visitors": "Разные посетители",
  "analytics.note":
    "Хранятся {days, plural, one {# день} few {# дня} many {# дней} other {# дня}}. Ваши собственные посещения и превью ссылок не считаются, а автоматизированные браузеры могут учитываться, поэтому эти числа ориентир, а не аудит.",

  "usage.title": "Использование",
  "usage.description":
    "Ваши квоты и то, что ваши artifacts отдали в этом месяце. Трафик считается раз в несколько секунд, поэтому может немного отставать.",
  "usage.meterPercent": "{used} из {limit} ({percent})",
  "usage.plan.section": "Тариф",
  "usage.plan.hint": "Ваш тариф задаёт лимиты на этой странице.",
  "usage.plan.name": "Текущий тариф",
  "usage.plan.free": "Free",
  "usage.plan.pro": "Pro",
  "usage.plan.team": "Team",
  "usage.plan.enterprise": "Enterprise",
  "usage.plan.seats": "Места",
  "usage.plan.until": "Действует до",
  "usage.traffic.section": "Трафик за месяц",
  "usage.traffic.hint":
    "Считается для всего аккаунта, по всем вашим artifacts. Достижение любого лимита приостанавливает все artifacts до сброса.",
  "usage.trafficRequests.hint":
    "Все страницы, файлы и загрузки, на которые ответили ваши artifacts.",
  "usage.trafficBytes.hint": "Объём всего, что ваши artifacts отправили посетителям.",
  "usage.storage.section": "Artifacts и хранилище",
  "usage.activeArtifacts.hint":
    "Artifacts, которые сейчас в сети. Artifacts в архиве и удалённые не учитываются.",
  "usage.storage.hint":
    "Уникальные файлы во всех версиях, каждый учитывается один раз. Незавершённые загрузки учитываются, пока идут.",
  "usage.publishing.section": "Публикация",
  "usage.publishing.hint":
    "Ограничения скорости публикации. Окна в 24 часа скользящие, поэтому освобождаются постепенно.",
  "usage.publishes.hint": "Версии, которые вы опубликовали или на которые откатились.",
  "usage.newFiles": "Новые файлы за 24 часа",
  "usage.newFiles.hint":
    "Файлы, которые вы раньше не загружали; уже хранящиеся файлы не учитываются.",
  "usage.newBytes": "Новые данные за 24 часа",
  "usage.newBytes.hint": "Объём этих новых файлов.",
  "usage.newObjects": "Новые файлы за месяц",
  "usage.newObjects.hint": "Сброс {date}.",
  "usage.openUploads": "Незавершённые загрузки",
  "usage.openUploads.hint": "Публикации, которые начаты, но ещё не завершены.",
  "usage.versions.section": "Лимиты одной версии",
  "usage.versions.hint": "Одинаковы для всех artifacts.",
  "usage.versions.publishedBytes": "Размер публикации",
  "usage.versions.files": "Файлы",
  "usage.versions.documentBytes": "Документ Markdown или текст",
  "usage.public.title": "Скоро можно будет публиковать artifacts открыто",
  "usage.public.body":
    "Новые аккаунты могут сделать artifact публичным через {minutes} мин. после создания. Вы сможете с {date}.",
  "usage.loading": "Загрузка данных об использовании",
  "usage.error": "Не удалось загрузить данные об использовании",
  "usage.meter": "{used} из {limit}",
  "usage.activeArtifacts": "Активные artifacts",
  "usage.storage": "Хранилище",
  "usage.publishes": "Публикации за 24 часа",
  "usage.trafficRequests": "Запросы за месяц",
  "usage.trafficBytes": "Данные за месяц",
  "usage.trafficResets": "Сброс трафика",
  "usage.blocks": "Сейчас заблокировано",
  "usage.lifts": "{message} Снимается {date}.",
  "usage.traffic.title": "Ваши artifacts израсходовали трафик этого месяца",
  "usage.traffic.body":
    "В этом месяце ваши artifacts обработали 1 миллион запросов или 25 ГБ, поэтому до {date} посетители получают ошибку (HTTP 429) на всех из них. Другие квоты не затронуты: вы по-прежнему можете публиковать, менять доступ и управлять своими artifacts. Artifacts других людей продолжают работать.",
  "usage.traffic.link": "Посмотреть использование",
  "usage.nearLimit": "Почти лимит",
  "usage.atLimit": "Лимит исчерпан",
  "account.cancel": "Отмена",

  "scope.artifacts:read": "Видеть ваши artifacts, их настройки и версии",
  "scope.artifacts:write": "Публиковать и обновлять artifacts",
  "scope.artifacts:share": "Менять, кто может открывать ваши artifacts",
  "scope.artifacts:delete": "Архивировать и удалять ваши artifacts",
  "scope.annotations:read": "Читать комментарии к вашим artifacts",
  "scope.annotations:write": "Писать комментарии и отвечать на них от вашего имени",
  "scope.annotations:moderate": "Закрывать, скрывать и удалять комментарии к вашим artifacts",
  "scope.data:read": "Читать и экспортировать данные, сохранённые в ваших artifacts",
  "scope.data:write": "Изменять данные, сохранённые в ваших artifacts",
  "scope.credentials:manage": "Видеть приложения, подключённые к аккаунту, и отключать их",
  "scope.offline_access": "Оставаться подключённым, пока вы его не отключите",
  "scope.unknown": "Использовать разрешение {name}",

  "list.publish": "Опубликовать",

  "content.title": "Содержимое",
  "content.publishVersion": "Опубликовать новую версию",
  "content.edit": "Редактировать документ",
  "content.history": "История версий",

  "publish.title": "Публикация",
  "publish.description":
    "Загрузите HTML-файл, папку, ZIP или документ. Ничего не загружается, пока вы не проверите выбор.",
  "publish.versionTitle": "Новая версия «{name}»",
  "publish.versionDescription":
    "Выбранные файлы заменят текущую версию. Посетители видят её, пока не будет опубликована новая.",
  "publish.loading": "Загрузка artifact",
  "publish.unavailable":
    "В текущем состоянии этот artifact не может получить новую версию. Если он в архиве, сначала восстановите его.",
  "publish.step.choose": "Выберите, что опубликовать",
  "publish.steps.label": "Шаги публикации",
  "publish.steps.choose": "Выбор",
  "publish.steps.review": "Проверка",
  "publish.steps.publish": "Публикация",
  "steps.done": "готово",
  "steps.upcoming": "не начато",
  "publish.drop.site": "Перетащите сюда файлы, папку или ZIP либо выберите их",
  "publish.drop.document": "Перетащите сюда документ или выберите его",
  "publish.drop.active": "Отпустите, чтобы выбрать эти файлы",
  "publish.done.review": "Проверить и прокомментировать",
  "publish.type.legend": "Тип",
  "publish.type.site": "HTML-файл, папка со статическими файлами или ZIP с ней.",
  "publish.type.markdown": "Документ Markdown, который отрисовывает Portifact.",
  "publish.type.text": "Простой текстовый документ, показанный точно как написан.",
  "publish.name.label": "Название",
  "publish.name.hint":
    "Показывается в списке и как заголовок страницы. По умолчанию имя файла или папки.",
  "publish.entry.label": "Начальная страница",
  "publish.entry.hint":
    "Страница, которую посетители открывают первой. Отдельный HTML-файл всегда становится ею.",
  "publish.pick.files": "Выбрать файлы",
  "publish.pick.filesHint": "Одна HTML-страница или несколько файлов рядом.",
  "publish.pick.folder": "Выбрать папку",
  "publish.pick.folderHint": "Все файлы в ней с сохранением структуры.",
  "publish.pick.zip": "Выбрать ZIP-файл",
  "publish.pick.zipHint":
    "ZIP с вашим сайтом. Используйте его, если браузер не умеет выбирать папки.",
  "publish.pick.zipOnly":
    "Этот браузер не умеет выбирать папки. Упакуйте папку в ZIP-файл и выберите его.",
  "publish.pick.document": "Выбрать файл",
  "publish.pick.documentHint": "Текстовый файл в UTF-8 размером до 5 МБ.",
  "publish.text.label": "Или напишите здесь",
  "publish.text.hint": "Вставьте или введите документ. Он будет опубликован как {file}.",
  "publish.text.use": "Проверить этот текст",
  "publish.text.required": "Сначала напишите или вставьте документ.",
  "publish.untitled": "Без названия",
  "publish.building": "Чтение и проверка файлов",
  "publish.buildingProgress": "{done} из {total}",
  "publish.cancel": "Отмена",
  "publish.buildCancelled": "Чтение файлов остановлено. Ничего не загружено.",
  "publish.buildFailed.title": "Эти файлы нельзя опубликовать",
  "publish.step.review": "Проверка перед публикацией",
  "publish.review.summary": "Сводка",
  "publish.review.files": "Файлы",
  "publish.review.filesValue":
    "{count, plural, one {# файл} few {# файла} many {# файлов} other {# файла}}, {size}",
  "publish.review.entry": "Начальная страница",
  "publish.review.access": "Кто может открыть",
  "publish.review.accessNew":
    "Только вы. После публикации можно поделиться им на странице artifact.",
  "publish.review.accessVersion":
    "{mode}. Публикация новой версии никогда не меняет круг тех, кто может открыть artifact.",
  "publish.review.caption": "Файлы для публикации",
  "publish.review.column.path": "Путь",
  "publish.review.column.size": "Размер",
  "publish.review.column.type": "Тип содержимого",
  "publish.review.excluded":
    "{count, plural, one {# элемент исключён} few {# элемента исключены} many {# элементов исключено} other {# элемента исключено}}",
  "publish.review.excludedHint":
    "Они никогда не публикуются, так же как в CLI. Если считаете, что какой-то должен публиковаться, уберите его из исходной папки.",
  "publish.reason.default": "контроль версий, зависимости или кеши",
  "publish.reason.secret": "может содержать секреты",
  "publish.review.publish": "Опубликовать",
  "publish.review.back": "Выбрать другие файлы",
  "publish.phase.preparing": "Подготовка загрузки",
  "publish.phase.uploading": "Загрузка",
  "publish.phase.committing": "Проверка файлов и публикация",
  "publish.uploadProgress": "{sent} из {total}, файлов: {done} из {count}",
  "publish.uploadStarted":
    "{count, plural, =0 {Все файлы уже сохранены. Публикуем.} one {Загружается # новый файл.} few {Загружаются # новых файла.} many {Загружается # новых файлов.} other {Загружается # нового файла.}}",
  "publish.uploadCancelled": "Загрузка отменена. Ничего не опубликовано.",
  "publish.failed.title": "Публикация не завершилась",
  "publish.resume": "Продолжить загрузку",
  "publish.startOver": "Начать заново",
  "publish.done.title": "Опубликована версия {number}",
  "publish.done.body": "Она доступна по адресу {url} и истекает {date}.",
  "publish.done.pinned": "Она доступна по адресу {url}. Она закреплена, поэтому не истекает.",
  "publish.done.open": "Открыть страницу artifact",
  "publish.done.another": "Опубликовать что-то ещё",
  "publish.announce.done": "Опубликована версия {number} artifact «{name}».",

  "manifest.empty": "Публиковать нечего: все файлы исключены или источник пуст.",
  "manifest.too_many_files": "В версии может быть не больше {detail} файлов.",
  "manifest.too_large": "Версия может занимать не больше {detail}.",
  "manifest.invalid_path": "Недопустимый путь к файлу: {detail}",
  "manifest.missing_entry":
    "Начальной страницы {detail} нет среди файлов. Измените начальную страницу или добавьте её.",
  "manifest.document_files": "Документ состоит из одного файла. Выберите один файл.",
  "manifest.document_too_large": "Размер документа ограничен 5 МБ.",
  "manifest.not_text":
    "Это не текстовый файл в UTF-8, поэтому его нельзя опубликовать как документ.",
  "manifest.not_zip": "Это не ZIP-файл, или он повреждён.",
  "manifest.unsupported":
    "В этом ZIP используется формат, который Portifact не читает (ZIP64, многотомные архивы или нестандартное сжатие). Создайте его заново со стандартными настройками.",
  "manifest.encrypted": "{detail} зашифрован. Используйте ZIP без пароля.",
  "manifest.symlink": "{detail} является ссылкой. Ссылки не публикуются; замените её самим файлом.",
  "manifest.special_file": "{detail} не является обычным файлом.",
  "manifest.corrupt": "ZIP повреждён: {detail} распаковывается не в то, что заявлено в архиве.",
  "manifest.unexpected": "Не удалось прочитать файлы. Попробуйте ещё раз.",

  "upload.integrity":
    "{path} пришёл повреждённым: хранилище отклонило его из-за размера или контрольной суммы. Начните заново, чтобы перечитать файлы.",
  "upload.storage": "Хранилище отклонило {path}. Продолжите загрузку, чтобы попробовать снова.",
  "upload.network":
    "Не удалось связаться с хранилищем. Проверьте подключение и продолжите загрузку.",
  "upload.missing": "Загрузка запрашивает файл, которого нет на этой странице. Начните заново.",
  "publish.error.quota_exceeded":
    "Это не укладывается в лимиты аккаунта: активные artifacts, хранилище, файлы или публикации в день. Перенесите что-нибудь в архив или удалите либо попробуйте позже.",
  "publish.error.version_conflict":
    "Тем временем была опубликована более новая версия. Начните заново, чтобы ваши изменения основывались на ней.",
  "publish.error.upload_incomplete":
    "Не все файлы дошли до хранилища целыми. Продолжите загрузку, чтобы отправить недостающие.",
  "publish.error.invalid_input":
    "Portifact отклонил эти файлы. Проверьте пути, размеры и тип и начните заново.",

  "editor.title": "Редактирование «{name}»",
  "editor.description": "Сохранение публикует новую версию. До этого посетители видят текущую.",
  "editor.loading": "Загрузка документа",
  "editor.loadFailed.title": "Не удалось загрузить документ",
  "editor.notDocument":
    "Здесь можно редактировать только artifacts в формате Markdown и текста. Опубликуйте новую версию.",
  "editor.unavailable":
    "В текущем состоянии этот artifact не может получить новую версию. Если он в архиве, сначала восстановите его.",
  "editor.source.markdown": "Markdown",
  "editor.source.text": "Текст",
  "editor.source.hint": "{path}, до 5 МБ.",
  "editor.preview": "Предпросмотр",
  "editor.previewTitle": "Предпросмотр «{name}»",
  "editor.previewHeading": "Предпросмотр",
  "editor.previewHint":
    "Отрисовано Portifact точно так, как будет опубликовано. Ссылки и изображения внутри здесь не открываются.",
  "editor.previewEmpty": "Нажмите «Предпросмотр», чтобы увидеть отрисованный документ.",
  "editor.previewStale": "Текст изменился после этого предпросмотра.",
  "editor.previewFailed.title": "Не удалось отрисовать предпросмотр",
  "editor.save": "Сохранить и опубликовать",
  "editor.unchanged": "Нечего сохранять: документ не изменился.",
  "editor.saving": "Публикация новой версии.",
  "editor.saved": "Сохранено как версия {number}.",
  "editor.saveFailed.title": "Документ не сохранён",
  "editor.reload": "Загрузить последнюю версию",
  "editor.tooLarge": "Размер документа ограничен 5 МБ.",

  "history.title": "История «{name}»",
  "history.versionsTitle": "Сохранённые версии",
  "history.description": "Версии, которые ещё можно скачать или вернуть.",
  "history.retention":
    "Тариф владельца хранит {count, plural, one {# предыдущую версию} few {# предыдущие версии} many {# предыдущих версий} other {# предыдущей версии}} {days, plural, one {# день} few {# дня} many {# дней} other {# дня}} после замены каждой.",
  "compare.title": "Сравнить версии",
  "compare.description": "Выберите две версии, чтобы увидеть, какие файлы изменились и как.",
  "compare.paid":
    "Сравнение версий и более долгое хранение большего числа версий входят в тариф {plan}.",
  "compare.needTwo": "Опубликуйте ещё одну версию, чтобы сравнить её с этой.",
  "compare.from": "Более ранняя версия",
  "compare.to": "Более поздняя версия",
  "compare.currentOption": "Версия {number} (текущая)",
  "compare.submit": "Сравнить",
  "compare.loading": "Сравнение версий",
  "compare.error.title": "Не удалось сравнить версии",
  "compare.summary":
    "Версия {from} сравнивается с версией {to}. Добавлено: {added}. Удалено: {removed}. Изменено: {changed}. Без изменений: {unchanged}.",
  "compare.none": "В обеих версиях одинаковые файлы.",
  "compare.caption": "Файлы, которые различаются в версиях {from} и {to}",
  "compare.column.file": "Файл",
  "compare.column.change": "Изменение",
  "compare.column.size": "Размер",
  "compare.change.added": "Добавлен",
  "compare.change.removed": "Удалён",
  "compare.change.changed": "Изменён",
  "compare.source": "Исходник",
  "compare.sizes": "{before} до, {after} после",
  "compare.noFile": "нет",
  "compare.show": "Показать изменения",
  "compare.showLabel": "Показать изменения в {path}",
  "compare.loadMore": "Показать ещё файлы",
  "diff.title": "Изменения в {path}",
  "diff.close": "Скрыть изменения",
  "diff.loading": "Загрузка изменений",
  "diff.counts": "Добавлено строк: {added}. Удалено строк: {removed}.",
  "diff.layout": "Вид",
  "diff.unified": "Единый",
  "diff.split": "Рядом",
  "diff.caption": "Изменения в {path} от версии {from} к версии {to}",
  "diff.column.before": "До",
  "diff.column.after": "После",
  "diff.column.change": "Изменение",
  "diff.column.text": "Текст",
  "diff.added": "Добавлена",
  "diff.removed": "Удалена",
  "diff.unchanged": "Без изменений",
  "diff.noNewline": "нет перевода строки в конце",
  "diff.hunk": "С строки {before} до и строки {after} после",
  "diff.more": "Показать ещё изменения",
  "diff.status.identical": "Этот файл одинаков в обеих версиях.",
  "diff.status.binary": "Этот файл не текстовый, поэтому сравнивается только его размер.",
  "diff.status.too_large": "Этот файл слишком большой для построчного сравнения.",
  "diff.status.too_many_lines": "В этом файле слишком много строк для построчного сравнения.",
  "diff.status.too_many_changes":
    "Этот файл изменился слишком сильно, чтобы показать его построчно.",
  "history.loading": "Загрузка версий",
  "history.error.title": "Не удалось загрузить версии",
  "history.caption": "Версии, сначала новые",
  "history.column.version": "Версия",
  "history.column.published": "Опубликована",
  "history.column.files": "Файлы",
  "history.column.kept": "Хранится до",
  "history.column.actions": "Действия",
  "history.version": "Версия {number}",
  "history.current": "Текущая",
  "history.whileCurrent": "Пока текущая",
  "history.files":
    "{count, plural, one {# файл} few {# файла} many {# файлов} other {# файла}}, {size}",
  "history.sources":
    "{count, plural, one {# исходный файл} few {# исходных файла} many {# исходных файлов} other {# исходного файла}}, {size}",
  "history.empty.title": "Пока нет версий",
  "history.empty.body": "Опубликуйте первую версию, и она появится здесь.",
  "history.loadMore": "Загрузить более старые версии",
  "history.download": "Скачать файлы",
  "history.downloadLabel": "Скачать файлы версии {number}",
  "history.downloadSources": "Скачать исходники",
  "history.downloadSourcesLabel": "Скачать исходники версии {number}",
  "history.downloading": "Скачивание и проверка файлов.",
  "history.downloaded": "{file} готов.",
  "history.downloadFailed.title": "Скачивание не завершилось",
  "download.integrity":
    "{path} не совпал с контрольной суммой, поэтому не сохранён. Попробуйте ещё раз.",
  "download.network": "Не удалось скачать {path}. Попробуйте ещё раз.",
  "history.rollback": "Откатить",
  "history.rollbackLabel": "Откатить к версии {number}",
  "history.rollbackUnavailable": "Откат доступен, пока artifact активен.",
  "history.confirmRollback.title": "Откатить к версии {number}?",
  "history.confirmRollback.body":
    "Её файлы будут опубликованы снова как новая версия, и 30-дневный срок начнётся заново. Круг тех, кто может открыть artifact, не изменится.",
  "history.confirmRollback.confirm": "Откатить",
  "history.rolledBack": "Версия {from} снова опубликована как версия {number}.",
  "history.actionFailed.title": "Действие не завершилось",
  "history.archive.title": "В архиве",
  "history.archive.body":
    "Этот artifact в архиве, и никто не может его открыть. Он будет удалён навсегда {date}, если вы его не восстановите. Скачать его версии по-прежнему можно.",
  "history.archive.noDate":
    "Он будет удалён навсегда через шесть месяцев, если вы его не восстановите.",
  "history.conversations.title": "Обсуждения прошлых версий",
  "history.conversations.description":
    "Ветки комментариев остаются с версией, к которой были написаны. Прошлые видите только вы, здесь и только для чтения; посетители видят ветки текущей версии.",
  "history.conversations.loading": "Загрузка обсуждений",
  "history.conversations.error": "Не удалось загрузить обсуждения",
  "history.conversations.refreshFailed": "Не удалось обновить обсуждения",
  "history.conversations.empty": "Ни у одной прошлой версии нет веток комментариев.",
  "history.conversations.counts":
    "{count, plural, one {# ветка} few {# ветки} many {# веток} other {# ветки}}, {open, plural, =0 {открытых нет} one {# открыта} few {# открыты} many {# открыто} other {# открыто}}",
  "history.conversations.version": "Версия {number}: {counts}",
  "history.conversations.unlisted": "Версии, которых больше нет в списке: {counts}",
  "suggest.mode.label": "Режим рецензирования",
  "suggest.mode.comment": "Комментарий",
  "suggest.mode.suggest": "Предложение",
  "suggest.mode.name": "Режим «{mode}»",
  "suggest.mode.on":
    "Режим предложений включён. Выделите текст в artifact, чтобы предложить правку.",
  "suggest.mode.off": "Режим комментариев включён.",
  "suggest.hint": "Выделите текст, который хотите изменить",
  "suggest.selection.received":
    "Текст выделен. «Предложить правку» появится следом, после artifact.",
  "suggest.selection.action": "Предложить правку",
  "suggest.discarded": "Страница изменилась, поэтому несохранённая правка отменена.",
  "suggest.editor.label": "Предложить правку для выделенного текста",
  "suggest.editor.page": "На странице {page}",
  "suggest.editor.title": "Предложить правку",
  "suggest.editor.reviewTitle": "Проверьте своё предложение",
  "suggest.editor.reviewHint": "Именно это и будет сохранено. Enter сохраняет, Escape отменяет.",
  "suggest.editor.after": "Новый текст",
  "suggest.editor.afterHint":
    "Одна строка простого текста. Enter запускает проверку изменения, Escape отменяет.",
  "suggest.editor.unchanged": "Измените текст, чтобы предложить правку.",
  "suggest.editor.note": "Заметка",
  "suggest.editor.noteHint":
    "Почему вы это предлагаете. Те, кто управляет artifact, увидят заметку вместе с изменением.",
  "suggest.editor.review": "Проверить",
  "suggest.editor.back": "Изменить снова",
  "suggest.editor.save": "Сохранить предложение",
  "suggest.editor.cancel": "Отмена",
  "suggest.saved": "Предложение сохранено.",
  "suggest.diff.removed": "Удалено",
  "suggest.diff.added": "Добавлено",
  "suggest.diff.character": "символ",
  "suggest.diff.empty": "(ничего)",
  "suggest.inspect": "Проверить символы",
  "suggest.inspect.after": "Кодовые точки нового текста",
  "suggest.block.label": "Предложенная правка",
  "suggest.badge": "Предложение",
  "suggest.state.pending": "Ожидает решения",
  "suggest.state.applying": "Применяется",
  "suggest.state.accepted": "Принято",
  "suggest.state.rejected": "Отклонено",
  "suggest.state.withdrawn": "Отозвано",
  "suggest.state.outdated": "Устарело",
  "suggest.state.unknown": "Неизвестное состояние",
  "suggest.carried": "Предложено в предыдущей версии",
  "suggest.attemptEnded": "Последнее принятие не завершилось: {reason}",
  "suggest.attempt.failed": "произошла ошибка. Примите снова, чтобы повторить.",
  "suggest.attempt.version_conflict": "за это время была опубликована новая версия.",
  "suggest.attempt.quota_exceeded": "достигнут лимит или список изменений заполнен.",
  "suggest.attempt.capacity_unavailable":
    "Portifact сейчас ограничивает новые задачи. Повторите попытку позже.",
  "suggest.attempt.plan_changed": "то, что было бы применено, изменилось. Проверьте снова.",
  "suggest.attempt.revoked": "за это время изменился доступ.",
  "suggest.attempt.unknown": "неизвестная причина.",
  "suggest.edit.withdrawn": "Правка отозвана.",
  "suggest.edit.unknown": "Эту правку нельзя показать здесь.",
  "suggest.edit.notText": "Изменение стиля или структуры.",
  "suggest.plan.check": "Проверить, что применится",
  "suggest.plan.lines": "Что сделает принятие, строка за строкой",
  "suggest.plan.summary":
    "{applied, plural, one {# изменение применяется автоматически} few {# изменения применяются автоматически} many {# изменений применяются автоматически} other {# изменения применяются автоматически}}; {listed, plural, one {# попадает в список изменений} few {# попадают в список изменений} many {# попадают в список изменений} other {# попадают в список изменений}}.",
  "suggest.tabs.label": "Предложенная правка",
  "suggest.tabs.plan": "Что применится",
  "suggest.tabs.preview": "Предпросмотр",
  "suggest.preview.loading": "Создание предпросмотра",
  "suggest.preview.title": "Предпросмотр предложенной правки",
  "suggest.preview.hint":
    "Копия страницы с изменением, без скриптов, изображений и внешних стилей. Опубликованная страница может выглядеть иначе.",
  "suggest.preview.unavailable": "Предпросмотра нет:",
  "suggest.preview.cssTooComplex": "Стили страницы слишком сложны для предпросмотра.",
  "suggest.accept": "Принять",
  "suggest.accept.title": "Принять это предложение?",
  "suggest.accept.body":
    "{applied, plural, one {# изменение публикуется как новая версия} few {# изменения публикуются как новая версия} many {# изменений публикуются как новая версия} other {# изменения публикуются как новая версия}}; {listed, plural, one {# попадает в список изменений} few {# попадают в список изменений} many {# попадают в список изменений} other {# попадают в список изменений}}.",
  "suggest.accept.confirm": "Принять и опубликовать",
  "suggest.accept.started": "Предложение принимается. Новая версия появится, когда будет готова.",
  "suggest.reject": "Отклонить",
  "suggest.reject.title": "Отклонить это предложение?",
  "suggest.reject.body":
    "Предложение останется в своей ветке как отклонённое. Ничего не публикуется.",
  "suggest.rejected": "Предложение отклонено.",
  "suggest.withdraw": "Отозвать",
  "suggest.withdraw.title": "Отозвать ваше предложение?",
  "suggest.withdraw.body":
    "Правка будет удалена, а ветка останется как обсуждение. Чтобы изменить её, отзовите и предложите заново.",
  "suggest.withdrawn": "Предложение отозвано.",
  "suggest.refusal.stale":
    "Страница изменилась с момента выделения этого текста. Выделите его снова.",
  "suggest.refusal.invalid_after":
    "Новый текст должен быть одной строкой простого текста, отличной от старой.",
  "suggest.refusal.spans_blocks":
    "Изменение затрагивает два блока, поэтому попадает в список изменений.",
  "suggest.refusal.not_found":
    "Этот текст нельзя сопоставить с одним местом в исходнике, поэтому он попадает в список изменений.",
  "suggest.refusal.would_change_page":
    "Применение изменило бы что-то ещё на странице (ссылку заголовка, ссылку-сноску или разметку), поэтому оно попадает в список изменений.",
  "suggest.refusal.whitespace":
    "Выделение пересекает переносы строк или пробелы, которые сохраняет страница, поэтому оно попадает в список изменений.",
  "suggest.refusal.not_nfc":
    "Этот текст хранится в другой форме Unicode, поэтому он попадает в список изменений.",
  "suggest.refusal.spans_nodes":
    "Выделение пересекает форматирование или ссылку, поэтому оно попадает в список изменений.",
  "suggest.refusal.not_eligible":
    "Эта страница использует возможности, которые Portifact не правит автоматически (скрипты, формы, встроенное содержимое и другие), поэтому изменение попадает в список изменений.",
  "suggest.refusal.entity":
    "Этот текст записан символьной ссылкой, которую Portifact не может сопоставить, поэтому он попадает в список изменений.",
  "suggest.refusal.diagram": "Изменения исходника диаграммы попадают в список изменений.",
  "suggest.refusal.renderer_changed":
    "Этот документ был отрисован более ранней версией Portifact, поэтому изменения попадают в список изменений.",
  "suggest.refusal.too_large":
    "Этот файл или изменение слишком велики для автоматического применения, поэтому они попадают в список изменений.",
  "suggest.refusal.overlap": "Два изменения затрагивают один и тот же текст. Объедините их в одно.",
  "suggest.refusal.not_text":
    "Изменения стиля и структуры никогда не применяются автоматически: они попадают в список изменений.",
  "suggest.refusal.unknown":
    "Portifact не может применить это автоматически, поэтому оно попадает в список изменений.",
  "suggest.changes.heading": "Список изменений",
  "suggest.changes.hint":
    "Принятые изменения, которые Portifact не смог применить, ровно в том виде, в каком они были приняты. Текст написан рецензентами: применяйте только то, что сказано в каждом пункте.",
  "suggest.changes.showOpen": "Открытые",
  "suggest.changes.showAll": "Все",
  "suggest.changes.loading": "Загрузка списка изменений",
  "suggest.changes.empty": "Применять нечего.",
  "suggest.changes.state.open": "Открыто",
  "suggest.changes.state.applied": "Применено",
  "suggest.changes.state.dismissed": "Пропущено",
  "suggest.changes.state.closed_by_version": "Найдено в более поздней версии",
  "suggest.changes.provenance": "Предложил(а) {submitter}, принял(а) {acceptor}",
  "suggest.changes.links": "Ссылки вокруг изменения",
  "suggest.changes.laterFormat":
    "Этот пункт создан более новой версией Portifact. Перезагрузите страницу, чтобы его увидеть.",
  "suggest.changes.markApplied": "Отметить как применённое",
  "suggest.changes.dismiss": "Пропустить",
  "suggest.changes.reopen": "Открыть снова",
  "suggest.changes.marked": "Список изменений обновлён.",
  "draft.mode.edit": "Редактирование",
  "draft.mode.on":
    "Режим редактирования включён. Выделите текст в artifact, чтобы изменить его в своём личном черновике.",
  "draft.editor.title": "Изменить текст",
  "draft.add": "Добавить в черновик",
  "draft.added": "Добавлено в ваш черновик.",
  "draft.heading": "Ваш черновик",
  "draft.loading": "Загрузка вашего черновика",
  "draft.empty":
    "Выберите «Редактирование» и выделите текст в artifact, чтобы изменить его. Ваши изменения остаются личными, пока вы их не опубликуете.",
  "draft.count":
    "{count, plural, one {# изменение} few {# изменения} many {# изменений} other {# изменения}}",
  "draft.changes": "Изменения в вашем черновике",
  "draft.remove": "Удалить изменение {number}",
  "draft.removeShort": "Удалить",
  "draft.stale":
    "Этот черновик создан на более ранней версии, поэтому его нельзя опубликовать. Отмените его и отредактируйте текущую версию.",
  "draft.attemptEnded": "Последняя публикация не завершилась: {reason}",
  "draft.publishingBadge": "Публикуется",
  "draft.publishing": "Ваш черновик публикуется. Новая версия появится, когда будет готова.",
  "draft.publish": "Опубликовать",
  "draft.publish.title": "Опубликовать этот черновик?",
  "draft.publish.confirm": "Опубликовать новую версию",
  "draft.discard": "Отменить",
  "draft.discard.title": "Отменить этот черновик?",
  "draft.discard.body": "Все изменения в нём будут удалены. Ничего не будет опубликовано.",
  "draft.discarded": "Черновик отменён.",
  "draft.conflict":
    "Ваш черновик изменился в другой вкладке или окне. Теперь он показывает последнее состояние; внесите изменение снова.",
  "draft.refused.stale":
    "Ваш черновик создан на более ранней версии. Отмените его, прежде чем редактировать текущую версию.",
  "draft.refused.other_page":
    "В вашем черновике есть изменения другой страницы. Опубликуйте или отмените его, прежде чем редактировать эту страницу.",
  "draft.refused.full":
    "В вашем черновике уже максимальное число изменений. Сначала опубликуйте или отмените его.",
  "draft.refused.invalid": "Это изменение нельзя добавить в черновик.",
  "suggest.editor.tabs": "Ваше изменение",
  "suggest.editor.tabs.change": "Изменение",
  "draft.tabs": "План вашего черновика",
  "draft.rebase": "Перенести черновик на текущую версию",
  "draft.rebased":
    "Черновик перенесён на текущую версию: {carried, plural, one {# изменение перенесено} few {# изменения перенесены} many {# изменений перенесено} other {# изменения перенесено}}, {left, plural, one {# нужно внести заново} few {# нужно внести заново} many {# нужно внести заново} other {# нужно внести заново}}.",
  "draft.conflicts": "Изменения, которые не удалось перенести, нужно внести заново",
  "draft.conflicts.dismiss": "Скрыть этот список",
  "suggest.search.heading": "Предложить изменение текста",
  "suggest.search.hint":
    "Найдите текст на странице, а не выделяйте его в artifact. Поиск читает опубликованную страницу, а не то, что показывают её скрипты.",
  "suggest.search.query": "Искомый текст",
  "suggest.search.find": "Найти",
  "suggest.search.found":
    "{count, plural, =0 {Мест не найдено.} one {Найдено # место.} few {Найдено # места.} many {Найдено # мест.} other {Найдено # места.}}",
  "suggest.search.none": "Текст не найден на этой странице.",
  "suggest.search.results": "Места с этим текстом",
  "suggest.search.choose": "Изменить текст в месте {number}",
  "suggest.search.refused":
    "Это место нельзя изменить. Попробуйте более короткий или более длинный фрагмент текста.",
  "suggest.search.unavailable":
    "Поиск доступен на HTML-страницах. На этой странице выделите текст в artifact.",
  "draft.conflictReason": "Изменённый текст в текущей версии другой или отсутствует.",
  "suggest.search.ownerOnly":
    "Поиск по странице пока недоступен рецензентам. Выделите текст в artifact.",
  "review.open": "Проверить и прокомментировать",
  "viewer.loading": "Открытие artifact",
  "viewer.unavailable.title": "Этот artifact нельзя открыть",
  "viewer.unavailable.body":
    "Он не существует, сейчас недоступен или ваш аккаунт не может его открыть.",
  "viewer.failed.title": "Не удалось открыть artifact",
  "viewer.dashboard": "Ваши artifacts",
  "viewer.skipLink": "Перейти к artifact",
  "viewer.brand": "Portifact",
  "viewer.version": "Версия {number}",
  "viewer.withoutBar": "Открыть без панели Portifact",
  "viewer.copyLink": "Копировать ссылку",
  "viewer.copied": "Ссылка скопирована.",
  "viewer.copyFailed": "Не удалось скопировать ссылку: {url}",
  "viewer.manage": "Управление",
  "viewer.comments": "Комментарии",
  "viewer.comments.open":
    "{count, plural, one {(# открытая ветка)} few {(# открытые ветки)} many {(# открытых веток)} other {(# открытой ветки)}}",
  "viewer.closeComments": "Закрыть комментарии",
  "viewer.more": "Ещё",
  "viewer.account": "Ваш аккаунт",
  "viewer.signIn": "Войти",
  "viewer.frame.label": "Artifact",
  "viewer.frame.title": "{name}, опубликовано в Portifact",
  "viewer.anonymous.body":
    "Войдите, чтобы читать комментарии к этому artifact и добавлять свои. После входа вы вернётесь на эту страницу.",
  "viewer.anonymous.signIn": "Войти, чтобы комментировать",
  "review.startFailed.title": "Не удалось связать комментарии с artifact",
  "review.frame.connecting": "Подключение к странице",
  "review.frame.isolated":
    "Artifact работает на собственном сайте и не видит ваш аккаунт, адрес почты или комментарии других людей. Выделение чего-либо в нём никогда не публикует комментарий: каждый комментарий вы пишете и подтверждаете здесь.",
  "review.status.unavailable.title": "Инструменты проверки недоступны в этом браузере",
  "review.status.unavailable.body":
    "Этот браузер блокирует cookie, нужный проверке внутри фрейма. Вы по-прежнему можете оставлять общие комментарии к странице.",
  "review.status.silent.title": "Страница не отвечает инструментам проверки",
  "review.status.silent.body":
    "Возможно, их блокирует её собственная политика безопасности. Вы по-прежнему можете оставлять общие комментарии к странице.",
  "review.tab.title": "Проверка в отдельной вкладке",
  "review.tab.body":
    "Откройте artifact в отдельной вкладке, чтобы увидеть его в режиме проверки. Вкладка показывает сам artifact, написанный его автором, а не Portifact: не входите и ничего там не вводите, даже если она похожа на Portifact. В ней нет инструментов проверки, поэтому пишите комментарии здесь. Сеанс проверки завершится через {minutes} мин. или когда вы нажмёте «Завершить проверку» во вкладке.",
  "review.tab.prepare": "Подготовить вкладку проверки",
  "review.tab.open": "Открыть вкладку проверки",
  "review.tab.ready": "Ссылка на вкладку проверки готова.",
  "review.tab.opened":
    "Вкладка проверки открыта. Когда закончите, нажмите во вкладке «Завершить проверку»; комментарии останутся здесь.",
  "review.tab.expired": "Срок ссылки истёк до того, как её открыли. Подготовьте новую.",
  "review.status.ended.title": "Этот сеанс проверки завершён",
  "review.status.ended.body":
    "Так сообщает страница во фрейме. Комментарии здесь продолжают работать; перезагрузите проверку, чтобы снова пользоваться инструментами проверки на странице.",
  "review.status.failed.title": "Срок ссылки на проверку истёк",
  "review.status.failed.body":
    "Так сообщает страница во фрейме. Комментарии здесь продолжают работать; перезагрузите проверку, чтобы снова открыть страницу.",
  "review.status.foreign.title": "Во фрейме работает не ваш сеанс проверки",
  "review.status.foreign.body":
    "Что-то, возможно другой artifact, открыло во фрейме другой сеанс проверки, поэтому инструменты проверки для него выключены. Перезагрузите проверку, чтобы снова запустить свою. Комментарии здесь не затронуты.",
  "review.status.lost.title": "Фрейм перестал отвечать от имени artifact",
  "review.status.lost.body":
    "Возможно, теперь в нём другой сайт, другой artifact или файл без инструментов проверки, поэтому не считайте показанное этим artifact. Перезагрузите проверку, чтобы снова показать artifact. Комментарии здесь не затронуты.",
  "review.reload": "Перезагрузить проверку",
  "review.newVersion.title": "Опубликована более новая версия",
  "review.newVersion.body":
    "Вы смотрите более старую версию. Новые комментарии попадают в самую новую версию.",
  "review.newVersion.action": "Проверить новую версию",
  "review.mode.off.owner.title": "Комментарии выключены",
  "review.mode.off.owner.body":
    "Включите их, чтобы люди, которые могут открыть этот artifact, могли комментировать.",
  "review.mode.off.turnOn": "Включить комментарии",
  "review.mode.off.turnedOn": "Комментарии включены.",
  "review.mode.off.visitor.title": "Комментарии к этому artifact выключены",
  "review.mode.off.visitor.body": "Владелец их не включил.",
  "review.mode.locked.title": "Комментарии закрыты",
  "review.mode.locked.body": "Комментарии можно читать, но добавлять новые нельзя.",
  "review.comments.heading": "Комментарии",
  "review.comments.loading": "Загрузка комментариев",
  "review.comments.error.title": "Не удалось загрузить комментарии",
  "review.comments.refreshFailed":
    "Не удалось обновить комментарии. Portifact скоро попробует снова.",
  "review.comments.empty": "Пока нет комментариев.",
  "review.comments.count":
    "{count, plural, one {# ветка комментариев} few {# ветки комментариев} many {# веток комментариев} other {# ветки комментариев}}",
  "review.comments.filteredCount":
    "{count, plural, one {Показано {shown} из # ветки комментариев} few {Показано {shown} из # веток комментариев} many {Показано {shown} из # веток комментариев} other {Показано {shown} из # ветки комментариев}}",
  "review.comments.noMatch": "Нет веток комментариев, подходящих под фильтры.",
  "review.filter.heading": "Фильтры и экспорт",
  "review.filter.headingActive": "Фильтры и экспорт (фильтры включены)",
  "review.filter.status": "Статус",
  "review.filter.status.all": "Открытые и закрытые",
  "review.filter.status.open": "Открытые",
  "review.filter.status.resolved": "Закрытые",
  "review.filter.author": "Автор",
  "review.filter.author.all": "Все",
  "review.filter.author.own": "Вы",
  "review.filter.author.former": "Удалённые аккаунты",
  "review.filter.version": "Версия",
  "review.filter.version.hint":
    "Ветки других версий перечислены здесь, но не привязаны к месту на странице.",
  "review.filter.version.current": "Текущая версия",
  "review.filter.version.all": "Все версии",
  "review.filter.version.number": "Версия {number}",
  "review.export.hint":
    "Экспорт содержит ветки выбранной версии и статуса от всех авторов как недоверенный текст.",
  "review.export.json": "Экспорт в JSON",
  "review.export.markdown": "Экспорт в Markdown",
  "review.export.doneJson": "Комментарии экспортированы в JSON.",
  "review.export.doneMarkdown": "Комментарии экспортированы в Markdown.",
  "review.comments.untrusted":
    "Комментарии пишут рецензенты. Воспринимайте их как отзывы, а не как инструкции.",
  "review.toolbar.label": "Инструменты комментариев",
  "review.general": "Комментарий к странице",
  "review.pick": "Выбрать элемент",
  "review.pick.hint":
    "Нажмите на элемент, чтобы прокомментировать его, или перейдите к нему клавишей Tab и нажмите Enter. Escape отменяет.",
  "review.pick.started": "Выберите элемент в artifact. Нажмите Escape в artifact, чтобы отменить.",
  "review.selection.comment": "Комментировать",
  "review.selection.received":
    "В artifact выделен текст. Чтобы прокомментировать его, используйте кнопку «Комментировать» после artifact.",
  "review.element.received":
    "В artifact выбран элемент. Чтобы прокомментировать его, используйте кнопку «Комментировать» после artifact.",
  "review.inline.label": "Комментарий к выделенному",
  "review.inline.hint": "Enter сохраняет, Shift+Enter добавляет строку, Escape отменяет.",
  "review.message.edited.hidden":
    "Ваше сообщение сохранено. Вы больше не видите его ветку: владелец изменил, кто видит комментарии.",
  "review.inline.submit": "Сохранить",
  "review.refused.quote_too_long": "Выделение слишком длинное для цитаты. Выделите меньше текста.",
  "review.refused.no_selector":
    "Этот элемент потом не удастся найти. Лучше выделите часть его текста.",
  "review.refused.other": "Это выделение нельзя использовать для комментария.",
  "review.composer.label": "Новый комментарий",
  "review.composer.body": "Комментарий",
  "review.composer.hint":
    "Простой текст. Его может прочитать владелец этого artifact; владелец решает, могут ли его читать и другие читатели.",
  "review.composer.hint.owner":
    "Простой текст. Его могут прочитать все, кто может открыть этот artifact.",
  "review.composer.submit": "Отправить",
  "review.composer.cancel": "Отмена",
  "review.composer.empty": "Напишите комментарий.",
  "review.composer.invalid": "Комментарий слишком длинный или содержит недопустимые символы.",
  "review.composer.posted": "Комментарий опубликован.",
  "review.humanCheck.body":
    "Перед публикацией комментария нужна короткая проверка, что вы человек. Комментарий будет опубликован сразу после неё.",
  "review.humanCheck.needed":
    "Перед публикацией комментария нужна короткая проверка, что вы человек.",
  "review.humanCheck.retry":
    "Проверка, что вы человек, не прошла. Пройдите её и сохраните ещё раз.",
  "review.humanCheck.unavailable":
    "Проверка, что вы человек, не загрузилась на этой странице. Перезагрузите страницу и попробуйте ещё раз.",
  "review.report": "Пожаловаться на artifact",
  "review.target.general": "Общий комментарий к {path}",
  "review.target.element": "Элемент {tag}",
  "review.target.quote": "Цитата",
  "review.thread.title": "Ветка {number}",
  "review.thread.titlePrefix": "Ветка ",
  "review.thread.more": "Другие действия с веткой {number}",
  "review.thread.showMessages":
    "{count, plural, one {Показать # комментарий} few {Показать # комментария} many {Показать # комментариев} other {Показать # комментария}}",
  "review.thread.hideMessages": "Свернуть комментарии",
  "review.thread.open": "Открыта",
  "review.thread.resolved": "Закрыта",
  "review.thread.replies":
    "{count, plural, one {# ответ} few {# ответа} many {# ответов} other {# ответа}}",
  "review.thread.hideReplies": "Скрыть ответы",
  "review.thread.otherVersion": "Прошлая версия",
  "review.thread.orphaned": "Без привязки",
  "review.thread.otherPage": "На {path}",
  "review.thread.show": "Показать в artifact",
  "review.thread.resolve": "Закрыть",
  "review.thread.reopen": "Открыть снова",
  "review.thread.reply": "Ответить",
  "review.thread.delete": "Удалить ветку",
  "review.thread.resolvedDone": "Ветка {number} закрыта.",
  "review.thread.reopenedDone": "Ветка {number} открыта снова.",
  "review.thread.deletedDone": "Ветка {number} удалена.",
  "review.thread.activated": "Выбрана ветка {number}.",
  "review.thread.activatedMany": "Выбраны ветки {numbers}.",
  "review.group.heading":
    "{count, plural, one {# ветка у текста, на который вы нажали} few {# ветки у текста, на который вы нажали} many {# веток у текста, на который вы нажали} other {# ветки у текста, на который вы нажали}}",
  "review.group.clear": "Показать все ветки",
  "review.thread.confirmDelete.title": "Удалить ветку {number}?",
  "review.thread.confirmDelete.body":
    "Все сообщения в ней будут удалены для всех. Это действие нельзя отменить.",
  "review.thread.confirmDelete.confirm": "Удалить ветку",
  "review.thread.confirmDelete.cancel": "Оставить",
  "review.message.formerAccount": "Удалённый аккаунт",
  "review.message.you": "Вы",
  "review.message.hidden": "Скрыто владельцем",
  "review.message.deleted": "Сообщение удалено",
  "review.message.edited": "Изменено",
  "review.message.hide": "Скрыть",
  "review.message.unhide": "Показать снова",
  "review.message.delete": "Удалить",
  "review.message.more": "Другие действия с сообщением от {author}",
  "review.message.moderated": "Сообщение обновлено.",
  "review.message.edit": "Изменить",
  "review.message.editLabel": "Изменить сообщение",
  "review.message.editBody": "Сообщение",
  "review.message.editSave": "Сохранить",
  "review.message.edited.done": "Сообщение изменено.",
  "review.message.editConflict":
    "Тем временем это сообщение изменили в другом месте. Показана последняя версия; измените её ещё раз.",
  "review.reply.label": "Ответ в ветке {number}",
  "review.reply.body": "Ответ",
  "review.reply.hint.owner":
    "Эту ветку начал владелец, поэтому ваш ответ увидят все, кто видит комментарии.",
  "review.reply.submit": "Ответить",
  "review.reply.posted": "Ответ опубликован.",
  "review.actionFailed.title": "Действие не завершилось",

  "notFound.title": "Страница не найдена",
  "notFound.body": "Этот адрес не соответствует ни одной странице кабинета.",

  "action.retry": "Повторить",

  "type.site": "Сайт",
  "type.markdown": "Markdown",
  "type.text": "Текст",

  "state.draft": "Черновик",
  "state.active": "Активен",
  "state.archived": "В архиве",
  "state.suspended": "Заблокирован",
  "state.purging": "Удаляется",
  "state.deleted": "Удалён",

  "access.public": "Публичный: любой, у кого есть ссылка",
  "access.authenticated": "Любой, кто вошёл в Portifact",
  "access.restricted": "Только вы и добавленные вами люди",

  "error.network": "Не удалось связаться с Portifact. Проверьте подключение и попробуйте ещё раз.",
  "error.unexpected": "Что-то пошло не так. Попробуйте ещё раз.",
  "error.invalid_input": "Недопустимый запрос.",
  "error.unauthenticated": "Сеанс завершён. Войдите снова.",
  "error.forbidden": "У вас нет прав на это действие.",
  "error.not_found": "Этот artifact больше не существует.",
  "error.version_conflict":
    "Тем временем artifact изменился. Перезагрузите страницу и попробуйте ещё раз.",
  "error.quota_exceeded":
    "Вы достигли лимита активных artifacts. Перенесите один в архив или удалите, затем попробуйте ещё раз.",
  "error.traffic_exceeded":
    "Ваши artifacts израсходовали трафик этого месяца. Они снова заработают в следующем месяце.",
  "error.upload_incomplete": "Загрузка ещё не завершена.",
  "error.artifact_archived": "Artifact в архиве. Сначала восстановите его.",
  "error.account_too_new_for_public": "Новые аккаунты пока не могут делать artifacts публичными.",
  "error.capacity_unavailable": "Сейчас Portifact перегружен. Попробуйте позже.",
  "error.sole_workspace_admin":
    "В рабочем пространстве должен остаться администратор, а вы единственный. Сначала назначьте администратором другого участника или попросите Portifact по адресу hello@portifact.com удалить рабочее пространство.",
  "error.seats_exhausted":
    "В рабочем пространстве заняты все места. Удалите участника или отзовите приглашение, либо попросите больше мест.",
  "error.rate_limited": "Слишком много запросов. Подождите немного и попробуйте ещё раз.",
  "error.reauthentication_required": "Для этого войдите снова.",
  "error.human_verification_required":
    "Первым комментариям к чужим artifacts нужна короткая проверка, что вы человек. Пройдите её и отправьте снова.",
  "error.plan_required": "Эта функция не входит в план владельца artifact.",
  "shareLinks.title": "Ссылки для доступа",
  "shareLinks.description":
    "Ссылки, по которым любой, у кого они есть, может читать этот artifact без учётной записи. Посетители читают только текущую версию: они не могут комментировать, и их никогда не идентифицируют.",
  "shareLinks.loading": "Загружаем ссылки для доступа",
  "shareLinks.loadFailed": "Не удалось загрузить ссылки для доступа",
  "shareLinks.paidTitle": "Ссылки для доступа входят в платный тариф",
  "shareLinks.paid":
    "Ваш тариф не включает ссылки для доступа. Добавление людей и публичный доступ работают как раньше.",
  "shareLinks.paused":
    "Ваш тариф больше не включает ссылки для доступа, поэтому эти ссылки не открываются. Они сохранены и снова заработают, если тариф будет включать ссылки для доступа. Их по-прежнему можно отозвать.",
  "shareLinks.publicNote":
    "Этот artifact публичный, поэтому его и так может открыть любой. Ссылки для доступа пригодятся, если позже вы ограничите доступ.",
  "shareLinks.created.title": "Ссылка «{label}» создана",
  "shareLinks.created.once":
    "Скопируйте её сейчас: ради безопасности она показывается только один раз. Любой, у кого есть эта ссылка, может читать artifact.",
  "shareLinks.created.label": "Ссылка для доступа",
  "shareLinks.created.copy": "Скопировать ссылку",
  "shareLinks.created.done": "Готово",
  "shareLinks.created.announce":
    "Ссылка для доступа создана. Скопируйте её сейчас; она показывается только один раз.",
  "shareLinks.empty": "Ссылок для доступа пока нет.",
  "shareLinks.list": "Ссылки для доступа к этому artifact",
  "shareLinks.expired": "Истекла",
  "shareLinks.noExpiry": "Без срока действия",
  "shareLinks.expires": "Истекает {date}",
  "shareLinks.withPassword": "Пароль",
  "shareLinks.noPassword": "Без пароля",
  "shareLinks.neverUsed": "Ещё не использовалась",
  "shareLinks.lastUsed": "Последнее использование: {date}",
  "shareLinks.revoke": "Отозвать",
  "shareLinks.revokeLabel": "Отозвать ссылку {label}",
  "shareLinks.revoked": "Ссылка {label} отозвана.",
  "shareLinks.revokeFailed": "Ссылка не отозвана",
  "shareLinks.confirm.title": "Отозвать «{label}»?",
  "shareLinks.confirm.body":
    "Все, у кого есть эта ссылка, потеряют доступ в течение минуты. Это нельзя отменить; у новой ссылки будет новый адрес.",
  "shareLinks.cancel": "Отмена",
  "shareLinks.create": "Создать ссылку",
  "shareLinks.createFailed": "Ссылка не создана",
  "shareLinks.full":
    "У этого artifact {max} активных ссылок, это максимум. Отзовите одну, чтобы создать другую.",
  "shareLinks.label.label": "Метка",
  "shareLinks.label.hint": "Её видите только вы, например, для кого эта ссылка.",
  "shareLinks.label.invalid": "Дайте ссылке метку длиной от 1 до {max} символов.",
  "shareLinks.expiry.label": "Срок действия",
  "shareLinks.expiry.never": "Бессрочно",
  "shareLinks.expiry.days": "{count, plural, one {# день} few {# дня} many {# дней} other {# дня}}",
  "shareLinks.password.label": "Пароль (необязательно)",
  "shareLinks.password.hint":
    "Не менее {min} символов. Посетители вводят его перед открытием artifact. Отправьте его отдельно от ссылки.",
  "shareLinks.password.short": "Используйте не менее {min} символов или оставьте поле пустым.",
  "domains.title": "Свой домен",
  "domains.description":
    "Открывайте этот artifact по своему домену, например docs.example.com. Адрес на Portifact продолжит работать.",
  "domains.loading": "Загрузка своего домена",
  "domains.loadFailed": "Не удалось загрузить свой домен",
  "domains.paidTitle": "Свои домены входят в платный тариф",
  "domains.paid": "С платным тарифом этот artifact можно открывать по вашему собственному домену.",
  "domains.unavailableTitle": "Свои домены пока недоступны",
  "domains.unavailable":
    "Portifact пока не обслуживает свои домены. Этот раздел откроется, когда они появятся.",
  "domains.removingNote": "{hostname} удаляется.",
  "domains.cardLabel": "Свой домен {hostname}",
  "domains.state.pending": "Ожидание DNS",
  "domains.state.provisioning": "Настройка",
  "domains.state.active": "Активен",
  "domains.state.removing": "Удаление",
  "domains.next.pending":
    "Создайте две записи ниже у своего DNS-провайдера, затем проверьте снова.",
  "domains.next.provisioning":
    "Домен подтверждён. Сертификат обычно выпускается за несколько минут; проверьте снова чуть позже.",
  "domains.next.active":
    "Artifact открывается по этому домену. Не удаляйте TXT-запись: её проверяют каждый день.",
  "domains.next.removing": "Домен удаляется.",
  "domains.problem.txt_missing": "TXT-запись не найдена",
  "domains.problem.txt_missing.hint":
    "Проверьте, что имя и значение записи совпадают точно. Изменения DNS могут появиться через несколько минут.",
  "domains.problem.certificate_pending": "Сертификат ещё не готов",
  "domains.problem.certificate_pending.hint":
    "Проверьте, что CNAME-запись указывает на значение ниже, и проверьте снова через несколько минут.",
  "domains.problem.cloudflare_unavailable": "Служба сертификатов не ответила",
  "domains.problem.cloudflare_unavailable.hint":
    "С вашей стороны всё в порядке. Скоро будет повторная попытка.",
  "domains.problem.cname_elsewhere": "Домен не указывает на Portifact",
  "domains.problem.cname_elsewhere.hint":
    "Его DNS больше не ведёт к цели CNAME ниже. Верните запись; активный домен удаляется после 3 таких ежедневных проверок подряд.",
  "domains.missedChecks":
    "{count, plural, one {TXT-запись отсутствовала при последней ежедневной проверке. После 3 пропусков подряд домен удаляется.} few {TXT-запись отсутствовала при последних # ежедневных проверках. После 3 пропусков подряд домен удаляется.} many {TXT-запись отсутствовала при последних # ежедневных проверках. После 3 пропусков подряд домен удаляется.} other {TXT-запись отсутствовала при последних # ежедневных проверках. После 3 пропусков подряд домен удаляется.}}",
  "domains.records": "Записи, которые нужно создать",
  "domains.records.type": "Запись {type}",
  "domains.records.txtHint": "Подтверждает, что домен ваш. Не удаляйте её и после активации.",
  "domains.records.cnameHint": "Направляет ваш домен на Portifact.",
  "domains.records.name": "Имя",
  "domains.records.value": "Значение",
  "domains.records.copy": "Копировать",
  "domains.claimExpires": "Добавьте записи до {date} или добавьте домен заново.",
  "domains.check": "Проверить снова",
  "domains.checkFailed": "Не удалось проверить домен",
  "domains.remove": "Удалить домен",
  "domains.removed": "{hostname} удалён.",
  "domains.removeFailed": "Не удалось удалить домен",
  "domains.confirm.title": "Удалить {hostname}?",
  "domains.confirm.body":
    "Artifact сразу перестанет открываться по этому домену и сохранит адрес на Portifact. Чтобы добавить домен снова, понадобится новая проверка DNS.",
  "domains.cancel": "Отмена",
  "domains.bar.title": "Пока панель Portifact включена, посещения открываются в просмотрщике",
  "domains.bar.body":
    "Пока панель включена, люди, открывшие ваш домен, попадают в просмотрщик на app.portifact.com. Выключите панель, чтобы в адресной строке оставался ваш домен.",
  "domains.bar.turnOff": "Выключить панель",
  "domains.bar.done": "Панель Portifact выключена.",
  "domains.add": "Добавить домен",
  "domains.added": "{hostname} добавлен. Теперь создайте его DNS-записи.",
  "domains.addFailed": "Не удалось добавить домен",
  "domains.full":
    "{count, plural, one {Ваш тариф включает # свой домен, и он уже используется.} few {Ваш тариф включает # своих домена, и все используются.} many {Ваш тариф включает # своих доменов, и все используются.} other {Ваш тариф включает # своего домена, и все используются.}}",
  "domains.hostname.label": "Имя хоста",
  "domains.hostname.hint":
    "Поддомен, которым вы управляете, например docs.example.com. Корневые домены и подстановочные знаки не поддерживаются.",
  "domains.hostname.invalid": "Введите имя хоста, например docs.example.com.",
  "accessLog.shareLink": "Ссылка для доступа: {label}",
  "webhooks.title": "Вебхуки",
  "webhooks.description": "Отправляйте события ваших artifacts в свои системы, Slack или Discord.",
  "webhooks.planTitle": "Вебхуки входят в платный тариф",
  "webhooks.planRequired":
    "Вебхуки входят в тариф {plan}. Добавленные вебхуки остаются здесь на паузе и снова заработают, когда тариф будет их включать.",
  "webhooks.add.title": "Добавить вебхук",
  "webhooks.add.hint":
    "События по каждому вашему artifact отправляются на этот адрес. Текст комментариев и адреса почты читателей не отправляются никогда.",
  "webhooks.add.url": "URL",
  "webhooks.add.urlHint": "Публичный адрес HTTPS на стандартном порту.",
  "webhooks.add.format": "Формат",
  "webhooks.format.generic": "Общий JSON с подписью",
  "webhooks.format.genericHint":
    "Проверяйте заголовок webhook-signature каждой доставки секретом подписи.",
  "webhooks.format.slack": "Slack",
  "webhooks.format.slackHint": "URL входящего вебхука Slack (hooks.slack.com).",
  "webhooks.format.discord": "Discord",
  "webhooks.format.discordHint": "URL вебхука канала Discord (discord.com/api/webhooks).",
  "webhooks.add.events": "События",
  "webhooks.event.comment.created": "Новые комментарии и ответы",
  "webhooks.event.thread.resolved": "Решённые обсуждения",
  "webhooks.event.artifact.published": "Новые версии",
  "webhooks.event.artifact.expiring": "Artifacts, срок которых скоро истекает",
  "webhooks.event.artifact.access_changed": "Изменения доступа",
  "webhooks.event.review.requested": "Запросы на ревью",
  "webhooks.event.review.completed": "Ревью одобрено или запрошены изменения",
  "webhooks.add.submit": "Добавить вебхук",
  "webhooks.add.noEvents": "Выберите хотя бы одно событие.",
  "webhooks.add.limit":
    "Можно иметь не больше {limit} вебхуков. Удалите один, чтобы добавить другой.",
  "webhooks.added": "Вебхук для {host} добавлен.",
  "webhooks.secret.title": "Скопируйте секрет подписи сейчас",
  "webhooks.secret.body":
    "Он показывается только один раз. Сохраните его в настройках получателя, чтобы проверять каждую доставку.",
  "webhooks.secret.label": "Секрет подписи для {host}",
  "webhooks.secret.copy": "Скопировать секрет",
  "webhooks.secret.done": "Я сохранил его",
  "webhooks.list.title": "Ваши вебхуки",
  "webhooks.list.loading": "Загружаем ваши вебхуки",
  "webhooks.list.error": "Не удалось загрузить вебхуки",
  "webhooks.empty.title": "Вебхуков пока нет",
  "webhooks.empty.body":
    "Добавьте вебхук, чтобы получать события ваших artifacts там, где работает команда.",
  "webhooks.state.active": "Активен",
  "webhooks.state.paused": "На паузе из-за тарифа",
  "webhooks.state.disabled": "Отключён",
  "webhooks.reason.manual": "Отключён администратором",
  "webhooks.reason.failures": "Отключён после повторных сбоев",
  "webhooks.reason.gone": "Отключён: получатель сообщил, что его больше нет",
  "webhooks.reason.invalid_url": "Отключён: этот URL больше не разрешён",
  "webhooks.failures": "Неудачных попыток подряд: {count}",
  "webhooks.lastAttempt": "Последняя попытка {when}: {outcome}",
  "webhooks.outcome.delivered": "доставлено",
  "webhooks.outcome.failed": "сбой",
  "webhooks.outcome.skipped": "пропущено",
  "webhooks.noAttempts": "Попыток пока не было",
  "webhooks.test": "Отправить тест",
  "webhooks.testLabel": "Отправить тест на {host}",
  "webhooks.testQueued":
    "Тестовое событие для {host} поставлено в очередь. Оно уйдёт примерно через две минуты.",
  "webhooks.enable": "Включить",
  "webhooks.enableLabel": "Включить вебхук для {host}",
  "webhooks.disable": "Отключить",
  "webhooks.disableLabel": "Отключить вебхук для {host}",
  "webhooks.enabled": "Вебхук для {host} включён.",
  "webhooks.disabled": "Вебхук для {host} отключён.",
  "webhooks.remove": "Удалить",
  "webhooks.removeLabel": "Удалить вебхук для {host}",
  "webhooks.removed": "Вебхук для {host} удалён.",
  "webhooks.confirm.title": "Удалить вебхук для {host}?",
  "webhooks.confirm.body":
    "Он перестанет получать события, а журнал доставок будет удалён. Это нельзя отменить.",
  "webhooks.deliveries": "Доставки",
  "webhooks.deliveriesOf": "Доставки вебхука для {host}",
  "webhooks.deliveries.loading": "Загружаем доставки",
  "webhooks.deliveries.error": "Не удалось загрузить доставки",
  "webhooks.deliveries.empty": "За последние {days} дн. попыток не было.",
  "webhooks.deliveries.time": "Время",
  "webhooks.deliveries.attempt": "Попытка",
  "webhooks.deliveries.outcome": "Результат",
  "webhooks.error.timeout": "истекло время ожидания",
  "webhooks.error.network": "нет соединения",
  "webhooks.error.redirect": "перенаправление не выполнено",
  "webhooks.error.invalid_url": "URL не разрешён",
  "webhooks.error.daily_cap": "достигнут дневной лимит",
  "webhooks.actionFailed": "Не получилось",
  "webhooks.notOfferedTitle": "Вебхуки пока недоступны",
  "webhooks.notOffered":
    "Portifact пока не отправляет вебхуки. Они появятся здесь, когда станут доступны.",
  "webhooks.reason.key_unavailable":
    "Отключён: ключ, который его защищает, больше недоступен. Удалите и добавьте его заново.",
  "webhooks.reason.unavailable": "Отключён: Portifact временно выключил вебхуки",
  "webhooks.error.key_unavailable": "ключ недоступен",
  "webhooks.via.dashboard": "Добавлен в панели",
  "webhooks.via.cli": "Добавлен через CLI Portifact",
  "webhooks.via.other": "Добавлен через другое приложение",
  "webhooks.via.by": "автор: {name}",
  "webhooks.probation":
    "Снова включён после сбоев: ещё несколько сбоев отключат его, пока доставка не пройдёт успешно.",
  "shell.brandingLink": "Бренд",
  "branding.title": "Бренд",
  "branding.description":
    "Показывайте своё название, логотип, цвет и ссылку на панели над вашими artifacts в просмотрщике. Отметка Portifact, адрес artifact и ссылка для жалобы всегда остаются на панели.",
  "branding.loading": "Загрузка бренда",
  "branding.error": "Не удалось загрузить бренд",
  "branding.paidTitle": "Бренд входит в платный тариф",
  "branding.paid":
    "Бренд на панели просмотрщика входит в тариф {plan}. Ваши artifacts показывают стандартную панель, а сохранённый бренд остаётся здесь до тех пор, пока тариф снова его не включит.",
  "branding.suspendedTitle": "Ваш бренд приостановлен",
  "branding.suspended":
    "Пока действует приостановка, ваши artifacts показывают стандартную панель. Напишите об этом на abuse@portifact.com.",
  "branding.form.title": "Бренд",
  "branding.form.hint":
    "Показывается как текст и ссылка. Ничто здесь не меняет вид самих artifacts.",
  "branding.form.name": "Название",
  "branding.form.nameHint": "До {max} символов. Оно не может читаться как Portifact.",
  "branding.form.nameRequired": "Введите название для показа.",
  "branding.form.nameTooLong": "Используйте не более {max} символов.",
  "branding.form.link": "Ссылка (необязательно)",
  "branding.form.linkHint":
    "Ваш собственный сайт, открывается в новой вкладке. Начинается с https://.",
  "branding.form.linkInvalid": "Введите адрес, который начинается с https://.",
  "branding.form.color": "Акцентный цвет (необязательно)",
  "branding.form.colorHint":
    "Цвет вида #1a2b3c. Он заливает плашку бренда, а текст на ней становится чёрным или белым, чтобы оставаться читаемым.",
  "branding.form.colorPicker": "Выбрать акцентный цвет",
  "branding.form.colorInvalid": "Используйте цвет вида #1a2b3c.",
  "branding.form.save": "Сохранить бренд",
  "branding.form.saved": "Бренд сохранён.",
  "branding.form.failed": "Не удалось сохранить бренд",
  "branding.form.invalid":
    "Проверьте название и ссылку: название не может читаться как Portifact, а ссылка должна быть https-адресом вашего собственного сайта.",
  "branding.logo.title": "Логотип",
  "branding.logo.hint":
    "Изображение PNG, JPEG или WebP не больше {kb} КБ и {px} на {px} пикселей, без анимации. Оно учитывается в вашем хранилище.",
  "branding.logo.needsName": "Сначала сохраните название бренда, затем добавьте логотип.",
  "branding.logo.none": "Логотипа пока нет.",
  "branding.logo.current": "{type}, {width} на {height} пикселей, {size}.",
  "branding.logo.choose": "Выбрать логотип",
  "branding.logo.replace": "Заменить логотип",
  "branding.logo.remove": "Удалить логотип",
  "branding.logo.uploaded": "Логотип сохранён.",
  "branding.logo.removed": "Логотип удалён.",
  "branding.logo.failed": "Не удалось сохранить логотип",
  "branding.logo.invalid":
    "Используйте изображение PNG, JPEG или WebP не больше {kb} КБ и {px} на {px} пикселей, без анимации и без сохранённого в нём текста.",
  "branding.logo.full": "Хранилище заполнено. Сначала удалите что-нибудь.",
  "branding.preview.title": "Предпросмотр",
  "branding.preview.hint":
    "Панель в каждой теме с тем, что указано в форме, сохранено это или нет.",
  "branding.preview.light": "Светлая тема",
  "branding.preview.dark": "Тёмная тема",
  "branding.preview.sample": "Квартальный отчёт",
  "branding.preview.noName": "Ваше название",
  "branding.preview.origin": "a1b2c3d4e5.portifact.dev",
  "branding.delete.title": "Удалить бренд",
  "branding.delete.hint":
    "Ваши artifacts снова показывают стандартную панель, а логотип удаляется.",
  "branding.delete.action": "Удалить бренд",
  "branding.delete.confirm": "Удалить бренд?",
  "branding.delete.body":
    "Название, цвет, ссылка и логотип удаляются, и просмотрщик показывает стандартную панель на всех ваших artifacts.",
  "branding.delete.done": "Бренд удалён.",
  "branding.delete.failed": "Не удалось удалить бренд",
  "branding.delete.cancel": "Отмена",
  "viewer.brandNewTab": "(откроется в новой вкладке)",
  "viewer.hosting.poweredBy": "Работает на Portifact",
  "viewer.hosting.origin": "Опубликовано на",
  // Workspaces (premium plan T1): the space menu, members, invitations and transfers.
  "space.label": "Пространство",
  "space.personal": "Личное",
  "space.personalDetail": "Ваше собственное пространство",
  "space.invitations":
    "{count, plural, one {# ожидающее приглашение} few {# ожидающих приглашения} many {# ожидающих приглашений} other {# ожидающего приглашения}}",
  "space.missing.title": "Workspace не найден",
  "space.missing.body":
    "Такого workspace нет, или вы не его участник. Попросите одного из его администраторов пригласить вас.",
  "space.missing.personal": "Перейти в личное пространство",
  "space.notAllowed.title": "Недоступно для вашей роли",
  "space.notAllowed.back": "К списку artifacts",
  "space.notAllowed.list":
    "Как участник {workspace}, вы читаете и комментируете artifacts, которыми с вами поделились, по их ссылкам. Видеть и вести все artifacts этого workspace могут только редакторы и администраторы: обратитесь к одному из администраторов.",
  "space.notAllowed.publish":
    "Для публикации в {workspace} нужна роль редактора или администратора. Обратитесь к одному из администраторов.",
  "space.notAllowed.usage": "Использование {workspace} видят его редакторы и администраторы.",
  "space.notAllowed.branding": "Бренд {workspace} задают только его администраторы.",
  "role.admin": "Администратор",
  "role.editor": "Редактор",
  "role.member": "Участник",
  "role.admin.hint":
    "управляет участниками, брендом и всеми artifacts и может выносить artifacts из workspace",
  "role.editor.hint": "публикует artifacts workspace и управляет ими",
  "role.member.hint": "читает и комментирует то, чем с ним поделились",
  "shell.membersLink": "Участники",
  "list.descriptionWorkspace":
    "Всё, что опубликовано в {workspace}, с состоянием, доступом и активностью.",
  "publish.descriptionWorkspace":
    "Публикация в {workspace}: HTML-файл, папка, ZIP или документ. Ничего не загружается, пока вы не проверите.",
  "publish.review.accessNewWorkspace":
    "Администраторы и редакторы {workspace}. После публикации вы сможете поделиться им на странице artifact.",
  "usage.descriptionWorkspace":
    "Квоты {workspace}, общие для всех, кто там публикует, и трафик за этот месяц.",
  "branding.descriptionWorkspace":
    "Бренд, который панель просмотрщика показывает на artifacts {workspace}.",
  "detail.section.space": "Пространство",
  "transfer.title": "Перенести в другое пространство",
  "transfer.description":
    "Этот artifact находится в {space}. Перенесите его в личное пространство или в workspace, где вы редактор или администратор.",
  "transfer.destination": "Куда",
  "transfer.move": "Перенести artifact",
  "transfer.blocked": "Этот artifact сейчас нельзя перенести",
  "transfer.notAdmin": "Выносить artifacts из {workspace} может только его администратор.",
  "transfer.domain":
    "У этого artifact есть собственный домен, действующий или ожидающий. Удалите его в разделе «Доступ», затем перенесите artifact.",
  "transfer.none":
    "Нет другого пространства, куда его можно перенести. Переносить artifacts можно в личное пространство и в workspaces, где вы редактор или администратор.",
  "transfer.noneInRegion":
    "Это пространство хранит данные в ЕС, поэтому artifact можно перенести только в другое пространство в ЕС, а у вас таких нет.",
  "transfer.confirm.title": "Перенести «{name}» в {space}?",
  "transfer.confirm.stays":
    "Не меняется: его ID, ссылка, версии, добавленные вами люди и комментарии.",
  "transfer.confirm.changes":
    "Меняется: им управляют администраторы и редакторы {space}, они видят, кто его открывал, в том числе до переноса, и он учитывается в использовании {space}.",
  "transfer.confirm.plan":
    "Закрепления и ссылки для доступа следуют тарифу {space}: если он их не включает, они перестают работать.",
  "transfer.confirm.blocks":
    "Перенос не выполнится, если в {space} нет для него места или ещё открыта загрузка.",
  "transfer.confirm.action": "Перенести",
  "transfer.done": "«{name}» перенесён в {space}.",
  "transfer.failed": "Artifact не перенесён",
  "transfer.error.quota_exceeded":
    "В {space} нет места для этого artifact. Сначала освободите там активный слот или хранилище.",
  "transfer.error.version_conflict":
    "Загрузка в этот artifact ещё открыта, или он тем временем изменился. Завершите или отмените загрузку, обновите страницу и попробуйте снова.",
  "transfer.error.invalid_input":
    "У этого artifact есть собственный домен, или он уже в этом пространстве. Сначала удалите домен.",
  "transfer.error.forbidden":
    "Ваша роль не позволяет выносить этот artifact из его пространства или переносить в это.",
  "transfer.error.artifact_archived": "Перенести можно только активный или архивный artifact.",
  "transfer.error.not_found": "Это пространство или этот artifact вам больше недоступны.",
  "members.title": "Участники",
  "members.description":
    "Люди в {workspace} и что может каждый. Администраторы управляют участниками и приглашениями.",
  "members.personal.title": "В личном пространстве нет участников",
  "members.personal.body":
    "Участники есть у workspaces. Выберите workspace в меню пространств, чтобы увидеть его участников.",
  "members.loading": "Загрузка участников",
  "members.loadFailed": "Не удалось загрузить участников",
  "members.seats": "Места",
  "members.seatsUsed": "Занятые места",
  "members.seatsValue": "{used} из {limit} ({percent})",
  "members.seatsHint":
    "Каждый участник и каждое ожидающее приглашение занимают место. Сколько их, определяет тариф workspace.",
  "members.listTitle": "Люди",
  "members.count":
    "{count, plural, one {# участник} few {# участника} many {# участников} other {# участника}}",
  "members.caption": "Участники {workspace}",
  "members.you": "Вы",
  "members.joined": "С нами с {date}",
  "members.roleLabel": "Роль: {name}",
  "members.remove": "Удалить",
  "members.removeNamed": "Удалить: {name}",
  "members.leave": "Покинуть workspace",
  "members.lastAdmin":
    "Единственный администратор: сначала назначьте администратором другого участника, затем меняйте эту роль, удаляйте или уходите.",
  "members.confirmRemove.title": "Удалить {name} из {workspace}?",
  "members.confirmRemove.body":
    "Человек сразу теряет доступ к artifacts этого workspace. Опубликованное им остаётся в workspace.",
  "members.confirmRemove.action": "Удалить участника",
  "members.confirmLeave.title": "Покинуть {workspace}?",
  "members.confirmLeave.body":
    "Вы сразу потеряете доступ к его artifacts. Чтобы вернуться, администратор должен пригласить вас снова.",
  "members.roleChanged": "Теперь у {name} роль «{role}».",
  "members.removed": "{name} удалён(а).",
  "members.left": "Вы покинули {workspace}.",
  "members.actionFailed": "Изменение не сохранено",
  "members.error.forbidden":
    "Ваша роль тем временем изменилась: участниками и приглашениями управляют только администраторы. Обновите страницу.",
  "members.error.version_conflict":
    "Участник тем временем изменился. Обновите страницу и попробуйте снова.",
  "members.error.not_found": "Этого человека больше нет в workspace.",
  "invite.title": "Пригласить",
  "invite.description":
    "Мы отправим по почте ссылку, действующую 7 дней. Человек присоединится, войдя с этим адресом.",
  "invite.email": "Электронная почта",
  "invite.role": "Роль",
  "invite.send": "Отправить приглашение",
  "invite.sent": "Приглашение отправлено на {email}.",
  "invite.emailInvalid": "Введите адрес электронной почты, например name@example.com.",
  "invite.alreadyMember": "{email} уже участник.",
  "invite.full.title": "Нет свободных мест",
  "invite.failed": "Приглашение не отправлено",
  "invite.error.invalid_input":
    "Этот адрес уже принадлежит участнику или это неверный адрес электронной почты.",
  "invite.error.rate_limited": "Слишком много приглашений. Подождите немного и попробуйте снова.",
  "invite.error.capacity_unavailable":
    "Portifact уже отправил все письма с приглашениями, возможные в этом месяце. Попробуйте в следующем месяце.",
  "invite.error.not_found": "Этого приглашения больше нет. Обновите страницу.",
  "pending.title": "Ожидающие приглашения",
  "pending.description":
    "Каждое занимает место, пока его не примут, не отклонят, не отзовут или пока не истечёт срок.",
  "pending.loading": "Загрузка приглашений",
  "pending.loadFailed": "Не удалось загрузить приглашения",
  "pending.empty": "Ожидающих приглашений нет.",
  "pending.detail": "{role}, пригласил(а) {inviter}, истекает {date}",
  "pending.unknownInviter": "бывший участник",
  "pending.resend": "Пригласить снова",
  "pending.resendNamed": "Пригласить снова: {email}",
  "pending.revoke": "Отозвать",
  "pending.revokeNamed": "Отозвать: {email}",
  "pending.confirmRevoke.title": "Отозвать приглашение для {email}?",
  "pending.confirmRevoke.body": "Ссылка перестанет работать, а место снова освободится.",
  "pending.confirmRevoke.action": "Отозвать приглашение",
  "pending.revoked": "Приглашение для {email} отозвано.",
  "pending.resent": "Новое приглашение отправлено на {email}. Прежняя ссылка больше не работает.",
  "invitation.title": "Приглашение в workspace",
  "invitation.signedOut.body":
    "Вас пригласили в workspace на Portifact. Войдите с адресом электронной почты, на который пришло приглашение, и примите или отклоните его здесь.",
  "invitations.signedOut.body":
    "Войдите, чтобы увидеть приглашения в workspaces, отправленные на ваш адрес.",
  "invitation.signIn": "Войти, чтобы ответить",
  "invitation.loading": "Загрузка приглашения",
  "invitation.loadFailed": "Не удалось загрузить приглашение",
  "invitation.invited.body": "{inviter} приглашает вас в {workspace} с ролью «{role}».",
  "invitation.invited.bodyNoInviter": "Вас пригласили в {workspace} с ролью «{role}».",
  "invitation.expiresTerm": "Истекает",
  "invitation.accept": "Принять",
  "invitation.acceptNamed": "Принять приглашение в {workspace}",
  "invitation.decline": "Отклонить",
  "invitation.declineNamed": "Отклонить приглашение в {workspace}",
  "invitation.confirmDecline.title": "Отклонить приглашение в {workspace}?",
  "invitation.confirmDecline.body":
    "Ссылка перестанет работать. Администратор сможет пригласить вас снова позже.",
  "invitation.confirmDecline.action": "Отклонить приглашение",
  "invitation.accepted": "Вы присоединились к {workspace}.",
  "invitation.declined": "Вы отклонили приглашение в {workspace}.",
  "invitation.failed": "Ваш ответ не сохранён",
  "invitation.other.title": "Это приглашение для другого адреса",
  "invitation.other.body":
    "Оно отправлено на {email}, а вы вошли как {current}. Войдите с {email}, чтобы ответить.",
  "invitation.other.unverified":
    "Оно отправлено на {email}, адрес этого аккаунта, который ещё не подтверждён. Выйдите и снова войдите с кодом, отправленным на {email}.",
  "invitation.switch": "Войти с другим аккаунтом",
  "invitation.missing.title": "Это приглашение больше не работает",
  "invitation.missing.body":
    "Срок истёк, его отозвали или уже использовали. Попросите администратора workspace пригласить вас снова.",
  "invitations.title": "Приглашения",
  "invitations.description":
    "Приглашения в workspaces, отправленные на ваш подтверждённый адрес электронной почты.",
  "invitations.loading": "Загрузка приглашений",
  "invitations.loadFailed": "Не удалось загрузить приглашения",
  "invitations.empty.title": "Ожидающих приглашений нет",
  "invitations.empty.body":
    "Когда администратор пригласит ваш адрес в workspace, приглашение появится здесь и в вашей почте.",
  "invitations.others": "Другие приглашения",
  "invitations.notice.title": "Вас пригласили в workspace",
  "invitations.notice.body":
    "{count, plural, one {У вас # ожидающее приглашение.} few {У вас # ожидающих приглашения.} many {У вас # ожидающих приглашений.} other {У вас # ожидающего приглашения.}}",
  "invitations.notice.link": "Открыть приглашения",
  "workspaces.title": "Workspaces",
  "workspaces.description":
    "Workspaces, в которых вы состоите, и ваша роль в каждом. Администраторы приглашают людей и меняют роли на странице «Участники» каждого workspace.",
  "workspaces.loading": "Загрузка workspaces",
  "workspaces.loadFailed": "Не удалось загрузить workspaces",
  "workspaces.none":
    "Вы не состоите ни в одном workspace. Portifact создаёт workspaces для команд, а администратор приглашает вас по почте.",
  "workspaces.leave": "Покинуть",
  "workspaces.leaveNamed": "Покинуть {workspace}",
  "account.delete.soleAdmin.title": "Вы единственный администратор workspace",
  "account.delete.soleAdmin.body":
    "У workspace должен остаться администратор. Назначьте администратором другого участника в каждом из этих workspaces или попросите Portifact по адресу hello@portifact.com удалить их, а затем удалите аккаунт.",
  "account.delete.soleAdmin.members": "Участники {workspace}",
  "webhooks.adminOnly.title": "Webhooks управляют только администраторы",
  "webhooks.adminOnly.body":
    "Webhooks отправляют события artifacts этого рабочего пространства в другие системы, поэтому видеть их и управлять ими могут только администраторы {workspace}. Обратитесь к одному из них, если вам нужен webhook.",
  "shell.planLink": "Тариф",
  "plan.title": "Тариф",
  "plan.description":
    "Тариф вашего личного пространства, его лимиты и функции, а также другие тарифы.",
  "plan.descriptionWorkspace": "Тариф {workspace}, его лимиты и функции, а также другие тарифы.",
  "plan.current.hint":
    "Что есть у этого пространства сейчас. На странице «Использование» видно, сколько из этого занято.",
  "plan.current.limits": "Лимиты текущего тарифа",
  "plan.current.usageLink": "Открыть использование",
  "plan.grace.title": "То, что хранил тариф {plan}, сохраняется до {date}",
  "plan.grace.body":
    "До этой даты ничего не удаляется: до {versions} предыдущих версий каждого артефакта в течение {days} дней, а журнал доступа и аналитика в течение {log} дней. После этой даты удаляется то, что тариф этого пространства не хранит.",
  "plan.grace.reads": "До этой даты по-прежнему доступно для чтения: {features}.",
  "plan.grace.download":
    "Скачайте нужное заранее: в истории каждого артефакта есть его версии, а журнал доступа и журнал аудита можно экспортировать. Или запросите тариф снова, чтобы сохранить всё.",
  "data.title": "Скачать данные",
  "data.description":
    "Всё, что хранится в этом пространстве и что можно забрать: сохранённые версии каждого артефакта и их исходники, журналы доступа и записи (настройки, правила доступа, ссылки для общего доступа, проверки, аналитика и комментарии), записи пространства, журнал аудита, а для личного пространства также данные вашего аккаунта. Файлы приходят напрямую из хранилища; на сервере ничего не упаковывается.",
  "data.adminsOnly": "Скачивать все данные {workspace} могут его администраторы.",
  "data.grace.title": "Что удалится и когда",
  "data.grace.hint":
    "Тариф, который истёк, был удалён или понижен, хранит то, что хранил, ещё 60 дней. После этого удаляется то, что тариф этого пространства не хранит.",
  "data.grace.body": "Скачайте нужное до этих дат или запросите тариф снова, чтобы сохранить всё.",
  "data.grace.loading": "Загружается, что удалится и когда",
  "data.grace.error": "Не удалось загрузить, что удалится и когда.",
  "data.grace.nothing": "По окончании льготного периода ничего из сохранённого не удалится.",
  "data.grace.caption": "Что удалится по окончании льготного периода и с какого дня",
  "data.grace.column.kind": "Что",
  "data.grace.column.count": "Сколько",
  "data.grace.column.from": "С",
  "data.kind.versions": "Предыдущие версии",
  "data.kind.accessLog": "Записи журнала доступа",
  "data.kind.analytics": "Ежедневные счётчики аналитики",
  "data.kind.auditEvents": "События аудита",
  "data.kind.pins": "Закреплённые артефакты (открепляются, затем архивируются как обычно)",
  "data.artifacts.title": "Артефакты",
  "data.artifacts.hint":
    "Откройте артефакт, чтобы скачать любую сохранённую версию: опубликованные файлы или исходники.",
  "data.artifacts.loading": "Загрузка артефактов",
  "data.artifacts.error": "Не удалось загрузить артефакты.",
  "data.artifacts.none": "В этом пространстве нет артефактов.",
  "data.artifacts.more": "Показать ещё артефакты",
  "data.artifact.summary":
    "{name}: {count, plural, one {# сохранённая версия} few {# сохранённые версии} many {# сохранённых версий} other {# сохранённой версии}}",
  "data.versions.title": "Версии {name}",
  "data.versions.caption": "Сохранённые версии {name}, от новых к старым",
  "data.versions.size": "Размер",
  "data.accessLog.csv": "Журнал доступа в CSV",
  "data.accessLog.json": "Журнал доступа в JSON",
  "data.accessLog.csvLabel": "Журнал доступа в CSV артефакта {name}",
  "data.accessLog.jsonLabel": "Журнал доступа в JSON артефакта {name}",
  "data.accessLog.saved": "Журнал доступа готов.",
  "data.records.button": "Записи (JSON)",
  "data.records.label": "Записи (JSON) артефакта {name}",
  "data.records.saved": "Записи готовы.",
  "data.records.later":
    "Некоторых частей нет, потому что сервер попросил подождать. Скачайте ещё раз через несколько минут.",
  "data.records.failed": "Не удалось скачать записи.",
  "data.space.title": "Записи пространства",
  "data.space.hint":
    "Настройки пространства без секретов. Для рабочего пространства: участники и роли, группы и их участники, приглашения, почтовые домены, политики, единый вход и сервисные токены. Для любого пространства: брендинг, вебхуки, интеграции и потоки аудита.",
  "data.space.download": "Скачать записи пространства (JSON)",
  "data.space.logo": "Скачать логотип бренда",
  "data.logs.title": "Журналы и аккаунт",
  "data.logs.hint":
    "У журнала аудита пространства есть свой экспорт, а личное пространство включает данные вашего аккаунта.",
  "data.logs.audit": "Экспортируйте журнал аудита на странице «Журнал аудита»",
  "data.logs.account": "Скачать данные аккаунта (JSON)",
  "data.logs.cli":
    "Чтобы забрать всё сразу, выполните portifact export <папка> в терминале: команда скачает каждую сохранённую версию и записи каждого артефакта, продолжит после прерывания и запишет манифест. Участники, приглашения и другие настройки, которые читает только панель, находятся в записях пространства выше.",
  "shell.grace.title": "То, что хранил тариф {plan}, сохраняется до {date}",
  "shell.grace.download": "Скачать данные",
  "shell.grace.request": "Запросить {plan} снова",
  "shell.grace.hide": "Скрыть на сегодня",
  "shell.grace.body":
    "После этой даты удаляется то, что тариф этого пространства не хранит. Скачайте нужное или запросите тариф снова, чтобы сохранить всё.",
  "shell.grace.bodyAskAdmin":
    "После этой даты удаляется то, что тариф этого пространства не хранит. Попросите администратора пространства скачать нужное или запросить тариф снова.",
  "plan.loading": "Загрузка тарифа",
  "plan.error": "Не удалось загрузить тариф.",
  "plan.compare.section": "Все тарифы",
  "plan.requestNote": "Запросить другой тариф могут только администраторы {workspace}.",
  "plan.hidden": "Тариф {workspace} видят его редакторы и администраторы.",
  "usage.plan.compare": "Сравнить тарифы",
  "shell.auditLink": "Журнал аудита",
  "audit.title": "Журнал аудита",
  "audit.description": "Кто и что изменил в этом пространстве. Изменения хранятся {days} дн.",
  "audit.planTitle": "Журнал аудита входит в платный тариф",
  "audit.planRequired":
    "Журнал аудита входит в тариф {plan}. Изменения уже записываются, поэтому после подключения тарифа здесь появятся последние 90 дней.",
  "audit.forbidden.title": "Журнал аудита могут читать только администраторы",
  "audit.forbidden.body":
    "Спросите администратора этого рабочего пространства, если нужно узнать, кто что изменил.",
  "audit.loading": "Загрузка журнала аудита",
  "audit.error.title": "Не удалось загрузить журнал аудита",
  "audit.empty.title": "Изменений не записано",
  "audit.empty.body": "За последние {days} дн. ничего не подходит под эти фильтры.",
  "audit.caption": "Изменения в этом пространстве, сначала новые",
  "audit.column.when": "Когда",
  "audit.column.who": "Кто",
  "audit.column.what": "Что",
  "audit.column.on": "Где",
  "audit.loadMore": "Показать более ранние изменения",
  "audit.filters": "Фильтры журнала аудита",
  "audit.filter.kind": "Вид изменения",
  "audit.filter.actor": "Кто",
  "audit.filter.period": "Период",
  "audit.group.all": "Все изменения",
  "audit.group.access": "Доступ и общий доступ",
  "audit.group.lifecycle": "Публикация и жизненный цикл",
  "audit.group.suggestions": "Предложения и список изменений",
  "audit.group.integrations": "Домены, вебхуки и бренд",
  "audit.group.members": "Участники, токены и тариф",
  "audit.actor.all": "Кто угодно",
  "audit.period.day": "Последние 24 часа",
  "audit.period.week": "Последние 7 дней",
  "audit.period.month": "Последние 30 дней",
  "audit.period.all": "Всё сохранённое",
  "audit.actor.removed": "Удалённый участник",
  "audit.actor.token": "{label} (сервисный токен)",
  "audit.actor.tokenGone": "Отозванный сервисный токен",
  "audit.actor.operator": "Оператор Portifact",
  "audit.actor.system": "Portifact",
  "audit.artifact.gone": "Удалённый artifact",
  "audit.target.space": "Это пространство",
  "audit.target.invitation": "Приглашение",
  "audit.kind.published": "Опубликовал(а) версию {version}",
  "audit.kind.publishedFirst": "Создал(а) с версией {version}",
  "audit.kind.rolledBack": "Вернул(а) файлы версии {from}, теперь это версия {version}",
  "audit.kind.renewed": "Продлил(а)",
  "audit.kind.archived": "Архивировал(а)",
  "audit.kind.restored": "Восстановил(а)",
  "audit.kind.deleted": "Удалил(а)",
  "audit.kind.pinned": "Закрепил(а)",
  "audit.kind.unpinned": "Открепил(а)",
  "audit.kind.transferredIn":
    "Перенёс(ла) сюда из {from, select, workspace {рабочего пространства} other {личного пространства}}",
  "audit.kind.transferredOut":
    "Перенёс(ла) в {to, select, workspace {рабочее пространство} other {личное пространство}}",
  "audit.kind.accessChanged": "Изменил(а) доступ: {changes}",
  "audit.access.mode":
    "{mode, select, public {сделал(а) публичным} authenticated {открыл(а) всем, кто вошёл} other {ограничил(а) читателями из списка}}",
  "audit.access.readersAdded":
    "{count, plural, one {добавил(а) # читателя} few {добавил(а) # читателей} many {добавил(а) # читателей} other {добавил(а) # читателя}}",
  "audit.access.readersRemoved":
    "{count, plural, one {удалил(а) # читателя} few {удалил(а) # читателей} many {удалил(а) # читателей} other {удалил(а) # читателя}}",
  "audit.access.domains": "из {domains}",
  "audit.access.exceptions":
    "{count, plural, one {изменил(а) видимость комментариев для # читателя} few {изменил(а) видимость комментариев для # читателей} many {изменил(а) видимость комментариев для # читателей} other {изменил(а) видимость комментариев для # читателя}}",
  "audit.access.bar":
    "{on, select, true {включил(а) панель Portifact} other {выключил(а) панель Portifact}}",
  "audit.access.comments":
    "{visibility, select, everyone {показал(а) комментарии всем} other {показал(а) комментарии только владельцу}}",
  "audit.access.indexable":
    "{on, select, true {разрешил(а) индексацию} other {запретил(а) индексацию}}",
  "audit.access.embeddable":
    "{on, select, true {разрешил(а) встраивание} other {запретил(а) встраивание}}",
  "audit.kind.shareLinkCreated":
    "Создал(а) ссылку для общего доступа{password, select, true { с паролем} other {}}{expires, select, true {, у которой есть срок} other {}}",
  "audit.kind.shareLinkRevoked": "Отозвал(а) ссылку для общего доступа",
  "detail.section.reviews": "Проверки",
  "approval.title": "Проверки на одобрение",
  "approval.description":
    "Попросите людей одобрить текущую версию. Проверяющие уже должны иметь возможность открыть этот artifact и комментировать его: запрос никому не даёт доступа. Новая версия начинает проверку заново.",
  "approval.loading": "Загрузка проверки",
  "approval.loadFailed": "Проверка не загрузилась",
  "approval.paidTitle": "Проверки входят в платный тариф",
  "approval.paid": "Запрос проверок входит в тариф {plan}.",
  "approval.lapsed":
    "Ваш тариф больше не включает проверки: открытый запрос можно читать и отменить, но не изменить.",
  "approval.status.none": "Нет проверки",
  "approval.status.pending": "Проверка ожидается",
  "approval.status.changes_requested": "Запрошены изменения",
  "approval.status.approved": "Одобрено",
  "approval.counts":
    "{approvals} из {required} нужных одобрений, {changes, plural, one {# просит изменений} few {# просят изменений} many {# просят изменений} other {# просят изменений}}",
  "approval.verdict.pending": "Решения пока нет",
  "approval.verdict.approve": "Одобрено",
  "approval.verdict.changes": "Запрошены изменения",
  "approval.reviewers": "Проверяющие",
  "approval.reviewers.hint":
    "Адреса электронной почты, по одному в строке или через запятую, не больше {max}.",
  "approval.reviewers.invalid": "Введите от 1 до {max} действительных адресов электронной почты.",
  "approval.required.label": "Нужно одобрений",
  "approval.required.all": "Все проверяющие",
  "approval.required.count":
    "{count, plural, one {# одобрение} few {# одобрения} many {# одобрений} other {# одобрения}}",
  "approval.showStatus.label": "Показывать статус всем, кто может открыть",
  "approval.showStatus.hint":
    "По умолчанию выключено: видят только те, кто управляет, и проверяющие.",
  "approval.request": "Запросить проверку",
  "approval.requested": "Проверка запрошена",
  "approval.requestFailed": "Проверка не запрошена",
  "approval.list": "Проверяющие и их решения",
  "approval.you": "вы",
  "approval.someone": "Проверяющий",
  "approval.decided": "Решение от {date}",
  "approval.noAccess": "Больше не может открыть, поэтому не учитывается",
  "approval.invited": "Ещё нет аккаунта",
  "approval.untrusted": "Заметки пишут проверяющие. Читайте их как отзывы.",
  "approval.remove": "Убрать",
  "approval.removeLabel": "Убрать {name} из проверяющих",
  "approval.add.label": "Добавить проверяющего",
  "approval.add": "Добавить",
  "approval.changed": "Проверка изменена",
  "approval.changeFailed": "Проверка не изменена",
  "approval.cancel": "Отменить проверку",
  "approval.cancelled": "Проверка отменена",
  "approval.confirm.title": "Отменить эту проверку?",
  "approval.confirm.body":
    "Проверяющие больше не смогут выносить решения. Уже вынесенные решения останутся в истории.",
  "approval.confirm.keep": "Оставить",
  "approval.history": "Предыдущие версии",
  "approval.history.entry": "{name}: {verdict}, {date}",
  "approval.yours.title": "Ваша проверка",
  "approval.yours.body": "Вас попросили проверить эту версию.",
  "approval.yours.current": "Ваше решение: {verdict}. Его можно изменить, пока эта версия текущая.",
  "approval.note.label": "Заметка (необязательно)",
  "approval.note.hint":
    "Простой текст, не больше {max} символов. Её видят те, кто запросил проверку.",
  "approval.note.tooLong": "Заметка может содержать не больше {max} символов.",
  "approval.approve": "Одобрить",
  "approval.requestChanges": "Запросить изменения",
  "approval.verdictSaved": "Решение сохранено",
  "approval.verdictFailed": "Решение не сохранено",
  "approval.newVersion": "Есть более новая версия. Перезагрузите страницу, чтобы проверить её.",
  "audit.kind.reviewRequested":
    "{reviewers, plural, one {Попросил(а) # человека проверить} few {Попросил(а) # человек проверить} many {Попросил(а) # человек проверить} other {Попросил(а) # человека проверить}}",
  "audit.kind.reviewChanged": "Изменил(а) запрос на проверку",
  "audit.kind.reviewCancelled": "Отменил(а) запрос на проверку",
  "audit.kind.suggestionAccepted":
    "Принял(а) предложение как версию {version}: применено {applied}, в список изменений {listed}",
  "audit.kind.suggestionAcceptedNothing":
    "Принял(а) предложение, ничего не применив: в список изменений {listed}",
  "audit.kind.draftPublished":
    "Опубликовал(а) черновик как версию {version}: применено {applied}, в список изменений {listed}",
  "audit.kind.draftPublishedNothing":
    "Опубликовал(а) черновик, ничего не применив: в список изменений {listed}",
  "audit.kind.suggestionRejected": "Отклонил(а) предложение",
  "audit.kind.suggestionWithdrawn": "Отозвал(а) предложение",
  "audit.kind.changeItemApplied": "Отметил(а) пункт списка изменений как применённый",
  "audit.kind.changeItemDismissed": "Отклонил(а) пункт списка изменений",
  "audit.kind.changeItemReopened": "Снова открыл(а) пункт списка изменений",
  "audit.kind.reviewVerdict":
    "{verdict, select, approve {Одобрил(а) версию {version}} other {Запросил(а) изменения в версии {version}}}",
  "audit.kind.domainAttached": "Подключил(а) домен {hostname}",
  "audit.kind.domainRemoved":
    "{reason, select, removed {Удалил(а) домен {hostname}} operator {Portifact удалил домен {hostname}} other {Домен {hostname} отключён автоматически}}",
  "audit.kind.webhookCreated":
    "Добавил(а) {format, select, slack {вебхук Slack} discord {вебхук Discord} other {подписанный вебхук}} на {host}",
  "audit.kind.webhookChanged":
    "{enabled, select, true {Включил(а) вебхук} false {Выключил(а) вебхук} other {Изменил(а) события вебхука}}",
  "audit.kind.webhookRemoved": "Удалил(а) вебхук",
  "audit.kind.brandChanged":
    "{logo, select, true {Изменил(а) логотип бренда} other {Изменил(а) название, цвет или ссылку бренда}}",
  "audit.kind.brandRemoved":
    "{logo, select, true {Удалил(а) логотип бренда} other {Удалил(а) бренд}}",
  "audit.kind.memberInvited": "Пригласил(а) пользователя из {domain} как {role}",
  "audit.kind.invitationRevoked": "Отозвал(а) приглашение",
  "audit.kind.memberJoined": "{member} присоединился(-ась) как {role}",
  "audit.kind.roleChanged": "Изменил(а) роль {member} с {from} на {to}",
  "audit.kind.memberRemoved": "Удалил(а) {member}",
  "audit.kind.memberLeft": "{member} вышел(-ла)",
  "audit.kind.planGranted":
    "Назначил тариф {plan} на {seats, plural, one {# место} few {# места} many {# мест} other {# места}}",
  "audit.kind.planGrantedUntil":
    "Назначил тариф {plan} на {seats, plural, one {# место} few {# места} many {# мест} other {# места}} до {until}",
  "audit.kind.graceStarted":
    "Начался льготный период ({reason}): то, что хранил тариф {plan}, сохраняется до {until}",
  "audit.kind.graceEnded":
    "Закончился льготный период для того, что хранил тариф {plan} ({reason})",
  "audit.graceStart.lowered": "тариф понижен",
  "audit.graceStart.removed": "тариф удалён",
  "audit.graceStart.expired": "тариф истёк",
  "audit.graceStart.unreadable": "льготный период не читается",
  "audit.graceEnd.renewed": "тариф продлён",
  "audit.graceEnd.operator": "завершён Portifact",
  "audit.graceEnd.expired": "срок прошёл",
  "audit.graceEnd.folded": "объединён с более поздним",
  "audit.kind.planRemoved": "Удалил тариф, пространство снова на Free",
  "audit.kind.tokenCreated":
    "Создал сервисный токен, который истекает через {days, plural, one {# день} few {# дня} many {# дней} other {# дня}}",
  "audit.kind.tokenRevoked": "Отозвал сервисный токен",
  "audit.export.label": "Экспорт журнала аудита",
  "audit.export.csv": "Экспорт в CSV",
  "audit.export.jsonl": "Экспорт в JSON Lines",
  "audit.export.hint":
    "Скачивает все сохранённые изменения, подходящие под фильтры, от новых к старым. Участники указаны по имени, никогда по адресу.",
  "audit.export.doneCsv": "Журнал аудита экспортирован в CSV.",
  "audit.export.doneJsonl": "Журнал аудита экспортирован в JSON Lines.",
  "audit.export.failed": "Не удалось экспортировать журнал аудита",
  "audit.export.planRequired": "Экспорт журнала аудита входит в тариф {plan}.",
  "audit.kind.exported":
    "{format, select, csv {Экспортировал журнал аудита в CSV} other {Экспортировал журнал аудита в JSON Lines}}",
  "audit.kind.emailDomainVerified": "Подтвердил(а) почтовый домен {domain}",
  "audit.kind.emailDomainRemoved":
    "{reason, select, removed {Удалил(а) почтовый домен {domain}} claimed {Почтовый домен {domain} удалён, потому что его подтвердил другой workspace} other {Почтовый домен {domain} удалён, потому что отсутствует его DNS-запись}}",
  "shell.serviceTokensLink": "Сервисные токены",
  "tokens.title": "Сервисные токены",
  "tokens.description":
    "Учётные данные, с которыми автоматизация, например CI, публикует в {workspace} без входа человека. У каждого токена есть роль, права и срок действия, и он перестаёт работать, как только вы его отзовёте.",
  "tokens.personal.title": "Сервисные токены принадлежат workspace",
  "tokens.personal.body":
    "Переключитесь на workspace, которым вы управляете, чтобы создать для него токены.",
  "tokens.adminOnly.title": "Сервисными токенами управляют только администраторы",
  "tokens.adminOnly.body": "Попросите токен у администратора этого workspace.",
  "tokens.planTitle": "Сервисных токенов нет в тарифе этого workspace",
  "tokens.planRequired":
    "Создание сервисных токенов входит в тариф {plan}. Существующие токены видны и их можно отозвать, но они не работают, пока тариф снова их не включит.",
  "tokens.list.title": "Токены",
  "tokens.loading": "Загрузка сервисных токенов",
  "tokens.loadFailed": "Не удалось загрузить сервисные токены",
  "tokens.empty.title": "Сервисных токенов пока нет",
  "tokens.empty.body":
    "Создайте токен для задачи CI, сохраните его как секрет PORTIFACT_TOKEN и запустите CLI portifact.",
  "tokens.secret.title": "Скопируйте токен сейчас",
  "tokens.secret.body":
    "Он показывается только один раз. Сохраните его как секрет вашего CI, например PORTIFACT_TOKEN. Любой, у кого он есть, может делать то, что разрешают его права, пока срок не истечёт или вы его не отзовёте.",
  "tokens.secret.label": "Сервисный токен {label}",
  "tokens.secret.copy": "Скопировать токен",
  "tokens.secret.done": "Я сохранил его",
  "tokens.create.title": "Создать токен",
  "tokens.create.hint":
    "Он действует от имени workspace, никогда от вашего, и никогда не бывает участником.",
  "tokens.create.limit":
    "В этом workspace уже максимум токенов ({limit}). Отзовите один, чтобы создать новый.",
  "tokens.create.label": "Название",
  "tokens.create.labelHint": "Где он используется, например предпросмотры GitHub",
  "tokens.create.labelError": "Введите название длиной от 1 до 80 символов.",
  "tokens.create.scopes": "Что ему разрешено",
  "tokens.create.scopesError": "Выберите хотя бы одно.",
  "tokens.create.expiry": "Истекает через",
  "tokens.create.expiryHint": "Когда срок истечёт, его заменит новый токен.",
  "tokens.create.days": "{days, plural, one {# день} few {# дня} many {# дней} other {# дня}}",
  "tokens.create.restriction": "Ограничить",
  "tokens.create.prefix": "Префикс ключа",
  "tokens.create.prefixHint":
    "Каждый artifact, который он публикует, должен иметь ключ с таким началом, например pr-.",
  "tokens.create.prefixError":
    "Используйте буквы, цифры, точки, подчёркивания, косые черты или дефисы, начиная с буквы или цифры.",
  "tokens.create.submit": "Создать токен",
  "tokens.scope.read": "Чтение",
  "tokens.scope.readHint": "Список artifacts и их версий",
  "tokens.scope.write": "Публикация",
  "tokens.scope.writeHint": "Публиковать новые artifacts и версии, продлевать и архивировать",
  "tokens.scope.share": "Доступ",
  "tokens.scope.shareHint":
    "Менять, кто может открыть artifact, в том числе делать его публичным. Утёкший токен может раскрыть artifacts.",
  "tokens.scope.delete": "Удаление",
  "tokens.scope.deleteHint":
    "Удалять artifacts навсегда. Утёкший токен может их уничтожить; ограничьте его префиксом ключа.",
  "tokens.restriction.none": "Все artifacts workspace",
  "tokens.restriction.noneHint": "Токен достаёт до каждого artifact этого workspace.",
  "tokens.restriction.own": "Artifacts, которые он создал",
  "tokens.restriction.ownHint":
    "Всё, что публикуют люди или другие токены, для него как будто не существует.",
  "tokens.restriction.key": "Artifacts с префиксом ключа",
  "tokens.restriction.keyHint":
    "Только artifacts, опубликованные с ключом под выбранным префиксом.",
  "tokens.created": "Токен {label} создан",
  "tokens.actionFailed": "Не получилось",
  "tokens.reach.none": "Достаёт до каждого artifact workspace",
  "tokens.reach.own": "Достаёт только до созданных им artifacts",
  "tokens.reach.key": "Достаёт только до ключей, начинающихся с {prefix}",
  "tokens.expired": "Истёк",
  "tokens.revoke": "Отозвать",
  "tokens.revokeLabel": "Отозвать {label}",
  "tokens.scopes": "Права: {scopes}",
  "tokens.expiresOn": "Истекает {date}",
  "tokens.expiredOn": "Истёк {date}",
  "tokens.lastUsed": "Последнее использование {when}",
  "tokens.neverUsed": "Не использовался",
  "tokens.createdBy": "Создал {name} {date}",
  "tokens.createdOn": "Создан {date}",
  "tokens.revoked": "Токен {label} отозван",
  "tokens.confirm.title": "Отозвать {label}?",
  "github.title": "GitHub Actions",
  "github.hint":
    "Разрешите workflow доверенного репозитория публиковать превью без сохранённого токена.",
  "github.off":
    "Вход через GitHub Actions в Portifact пока недоступен. Перечисленные здесь репозитории всё равно можно удалить.",
  "github.audience": "Аудитория",
  "github.audienceCopy": "Скопировать аудиторию",
  "github.audienceHint":
    "Workflow запрашивает у GitHub ID-токен с этой аудиторией. Action для превью и CLI делают это сами.",
  "github.loading": "Загрузка доверенных репозиториев",
  "github.loadFailed": "Не удалось загрузить доверенные репозитории.",
  "github.empty.title": "Нет доверенных репозиториев",
  "github.empty.body":
    "Доверьтесь репозиторию, чтобы его workflow публиковали превью в этом workspace без токена.",
  "github.create.title": "Доверять репозиторию",
  "github.create.hint":
    "Доверие привязано к числовым ID GitHub: переименованный репозиторий остаётся доверенным, а удалённый и созданный заново нет.",
  "github.create.repository": "Репозиторий",
  "github.create.repositoryHint": "В виде владелец/имя. Только для показа людям; не проверяется.",
  "github.create.repositoryError": "Укажите владелец/имя, например acme/site.",
  "github.create.repositoryId": "ID репозитория",
  "github.create.ownerId": "ID владельца",
  "github.create.idsHint":
    "Оба можно узнать командой gh api repos/OWNER/REPO --jq .id,.owner.id или из GITHUB_REPOSITORY_ID и GITHUB_REPOSITORY_OWNER_ID запуска.",
  "github.create.idError": "Укажите число, которое показывает GitHub.",
  "github.create.events": "События, которые могут публиковать",
  "github.create.eventsError": "Выберите хотя бы одно событие.",
  "github.event.push": "push",
  "github.event.pushHint": "Push в репозиторий. Делать push могут только люди с правом записи.",
  "github.event.pull_request": "pull_request",
  "github.event.pull_requestHint":
    "Pull request. В публичном репозитории запуск из форка не получает ID-токен, поэтому публикуют только ветки самого репозитория. В приватном репозитории с токенами записи для форков запуск из форка тоже может публиковать.",
  "github.event.workflow_dispatch": "workflow_dispatch",
  "github.event.workflow_dispatchHint": "Запуски, начатые вручную людьми с правом записи.",
  "github.event.merge_group": "merge_group",
  "github.event.merge_groupHint":
    "Запуски очереди слияния, которые GitHub начинает для репозитория.",
  "github.event.release": "release",
  "github.event.releaseHint": "Релизы, опубликованные в репозитории.",
  "github.event.schedule": "schedule",
  "github.event.scheduleHint": "Запуски ветки по умолчанию по расписанию.",
  "github.event.pull_request_target": "pull_request_target",
  "github.event.pull_request_targetHint":
    "Привилегированные запуски, которые может начать pull request из форка. Безопасны, только если workflow никогда не собирает код форка.",
  "github.event.workflow_run": "workflow_run",
  "github.event.workflow_runHint":
    "Привилегированные запуски, которые начинает другой workflow и которые может вызвать pull request из форка. Безопасны, только если workflow никогда не собирает код форка.",
  "github.create.privileged":
    "Я понимаю, что pull request из форка может начать эти запуски, а workflow никогда не собирает его код",
  "github.create.privilegedError":
    "Подтвердите, чтобы доверять pull_request_target или workflow_run.",
  "github.create.ref": "Ref (необязательно)",
  "github.create.refHint":
    "Точно, например refs/heads/main. У запуска pull request ref равен refs/pull/НОМЕР/merge, поэтому с ref ветки ни один pull request не публикует.",
  "github.create.refError": "Укажите полный ref, начинающийся с refs/.",
  "github.create.environment": "Окружение (необязательно)",
  "github.create.environmentHint":
    "Точное имя. GitHub применяет правила защиты окружения, например обязательных ревьюеров, до того как job получит токен.",
  "github.create.scopes": "Что могут делать его запуски",
  "github.create.scopesError": "Выберите хотя бы одно.",
  "github.create.submit": "Доверять репозиторию",
  "github.create.limit": "Workspace может доверять не более чем {limit} репозиториям.",
  "github.created": "{repository} теперь доверенный.",
  "github.rule.ids": "ID репозитория {repositoryId}, ID владельца {ownerId}",
  "github.rule.events": "События: {events}",
  "github.rule.prefix": "Публикует только ключи, начинающиеся с {prefix}",
  "github.rule.ref": "Ref: {ref}",
  "github.rule.environment": "Окружение: {environment}",
  "github.rule.live":
    "{count, plural, =0 {Нет действующих учётных данных} one {# действующие учётные данные} few {# действующих учётных данных} many {# действующих учётных данных} other {# действующих учётных данных}}",
  "github.remove": "Удалить",
  "github.removeLabel": "Удалить {repository}",
  "github.confirm.title": "Перестать доверять {repository}?",
  "github.confirm.body":
    "Его workflow больше не смогут публиковать, а уже выданные запускам учётные данные сразу перестанут работать.",
  "github.removed": "{repository} больше не доверенный.",
  "audit.kind.githubTrusted": "Начал доверять репозиторию GitHub {repository}",
  "audit.kind.githubTrustChanged": "Изменил доверие к репозиторию GitHub {repository}",
  "audit.kind.githubTrustRemoved": "Перестал доверять репозиторию GitHub {repository}",
  "audit.kind.githubExchanged":
    "Запуск GitHub {run} репозитория {repository} получил учётные данные",
  "tokens.confirm.body":
    "Всё, что его использует, перестанет работать со следующего запроса. Это нельзя отменить.",
  "access.workspace": "Весь workspace",
  "access.domain": "Workspace и его почтовые домены",
  "list.access.workspace": "Workspace",
  "list.access.domain": "Почтовый домен",
  "accessSettings.mode.workspace":
    "{count, plural, one {# участник этого workspace} few {Все # участника этого workspace} many {Все # участников этого workspace} other {Все # участника этого workspace}} после входа, в любой роли.",
  "accessSettings.mode.domain":
    "{count, plural, one {# участник этого workspace} few {Все # участника этого workspace} many {Все # участников этого workspace} other {Все # участника этого workspace}} и все, кто вошел с подтвержденным адресом в {domains}.",
  "accessSettings.mode.domainNone":
    "{count, plural, one {# участник этого workspace} few {Все # участника этого workspace} many {Все # участников этого workspace} other {Все # участника этого workspace}} и все, кто вошел с подтвержденным адресом в почтовых доменах workspace. Пока ни один домен не подтвержден: администратор добавляет его на странице «Участники».",
  "accessSettings.mode.listOnlyRestricted":
    "Люди из списка ниже могут открыть его, только пока доступ ограничен.",
  "accessSettings.mode.workspacePlan": "Входит в план {plan}.",
  "accessSettings.lapsed.title": "Пока этот artifact могут открыть только участники",
  "accessSettings.lapsed.body":
    "План workspace сейчас не включает доступ для почтовых доменов, поэтому только его участники могут открыть этот artifact, пока план снова его не включит. Ничего не изменено.",
  "emailDomains.title": "Почтовые домены",
  "emailDomains.description":
    "Любой, кто вошел в Portifact с подтвержденным адресом в одном из этих доменов, может открыть artifacts workspace, к которым открыт доступ для его почтовых доменов. Учитывается только точный домен, без поддоменов.",
  "emailDomains.loading": "Загрузка почтовых доменов",
  "emailDomains.loadFailed": "Не удалось загрузить почтовые домены",
  "emailDomains.rules":
    "Подтвердите каждый домен записью DNS. Публичные почтовые сервисы (например, gmail.com), общие суффиксы и домены Portifact не принимаются. Portifact проверяет запись каждый день и удаляет домен после 3 неудачных проверок подряд.",
  "emailDomains.addFailed": "Домен не добавлен",
  "emailDomains.add": "Добавить домен",
  "emailDomains.domain": "Домен",
  "emailDomains.domainHint":
    "Собственный домен вашей организации, например example.com. Не более {limit} доменов.",
  "emailDomains.domainRequired": "Введите домен.",
  "emailDomains.empty": "Почтовых доменов пока нет.",
  "emailDomains.added": "{domain} добавлен. Создайте его запись TXT, затем подтвердите.",
  "emailDomains.planTitle": "Почтовые домены входят в платный план",
  "emailDomains.plan":
    "Подтверждение почтовых доменов входит в план {plan}. Уже добавленные домены остаются, и их по-прежнему можно удалить.",
  "emailDomains.state.verified": "Подтвержден",
  "emailDomains.state.pending": "Ожидает запись DNS",
  "emailDomains.verifiedOn": "Подтвержден {date}.",
  "emailDomains.pendingUntil": "Создайте запись до {date}, иначе заявка будет отменена.",
  "emailDomains.failing.title": "Запись DNS отсутствует",
  "emailDomains.failing.body":
    "{count, plural, one {Запись отсутствовала при последней ежедневной проверке.} few {Запись отсутствовала при последних # ежедневных проверках подряд.} many {Запись отсутствовала при последних # ежедневных проверках подряд.} other {Запись отсутствовала при последних # ежедневных проверках подряд.}} {left, plural, one {Еще # неудачная проверка, и домен будет удален.} few {Еще # неудачные проверки, и домен будет удален.} many {Еще # неудачных проверок, и домен будет удален.} other {Еще # неудачной проверки, и домен будет удален.}}",
  "emailDomains.actionFailed": "Изменение не сохранено",
  "emailDomains.recordHint":
    "Создайте эту запись у вашего DNS-провайдера. Она может появиться не сразу.",
  "emailDomains.verify": "Подтвердить",
  "emailDomains.verifyNamed": "Подтвердить {domain}",
  "emailDomains.remove": "Удалить",
  "emailDomains.removeNamed": "Удалить {domain}",
  "emailDomains.verified": "{domain} подтвержден.",
  "emailDomains.removed": "{domain} удален.",
  "emailDomains.confirmRemove.title": "Удалить {domain}?",
  "emailDomains.confirmRemove.body":
    "Те, кто открывает artifacts только благодаря этому домену, потеряют доступ в течение минуты. Позже его можно добавить снова с новой записью.",
  "emailDomains.confirmRemove.action": "Удалить домен",
  "emailDomains.error.quota_exceeded": "У workspace уже максимальное число почтовых доменов.",
  "emailDomains.error.version_conflict":
    "Домен тем временем изменился, или другой workspace все еще подтверждает его в своем DNS. Обновите страницу и попробуйте снова.",
  "emailDomains.error.capacity_unavailable":
    "Сейчас не удалось проверить DNS. Попробуйте чуть позже.",
  "emailDomains.error.not_found": "Этого домена больше нет в списке.",
  "emailDomains.error.refused":
    "Этот домен нельзя добавить. Используйте собственный домен вашей организации: публичные почтовые сервисы, общие суффиксы, зарезервированные имена и домены Portifact не принимаются.",
  "emailDomains.error.recordMissing":
    "Запись TXT со значением этого домена пока не найдена. Изменения DNS могут появиться не сразу; попробуйте позже. Заявку старше 7 дней нужно добавить заново.",
  "transfer.confirm.accessReset":
    "Сейчас доступ к нему открыт для workspace или почтового домена, поэтому он станет ограниченным: читать его смогут только люди из списка читателей.",
  "shell.groupsLink": "Группы",
  "groups.title": "Группы",
  "groups.description":
    "Именованные наборы участников {workspace}. Добавьте группу к закрытому artifact, и её участники смогут открыть его, как читатели из списка.",
  "groups.personal.title": "Группы принадлежат workspace",
  "groups.personal.body":
    "Переключитесь на workspace, которым вы управляете, чтобы настроить его группы.",
  "groups.adminOnly.title": "Группами управляют только администраторы",
  "groups.adminOnly.body":
    "Редакторы выбирают группы в настройках доступа artifact. Попросите администратора этого workspace создать или изменить группу.",
  "groups.planTitle": "Группы не входят в тариф этого workspace",
  "groups.planRequired":
    "Группы входят в тариф {plan}. Существующие группы можно переименовать, очистить и удалить, но они никому не дают доступ, пока тариф снова их не включит.",
  "groups.list.title": "Группы",
  "groups.loading": "Загрузка групп",
  "groups.loadFailed": "Не удалось загрузить группы",
  "groups.empty.title": "Групп пока нет",
  "groups.empty.body":
    "Создайте группу, добавьте в неё участников, затем добавьте её в настройках доступа закрытого artifact.",
  "groups.create.title": "Создать группу",
  "groups.create.hint":
    "Администраторы и редакторы видят её название, когда выбирают, кто может открыть artifact.",
  "groups.create.limit": "В workspace может быть не больше {limit} групп. Сначала удалите одну.",
  "groups.create.name": "Название",
  "groups.create.submit": "Создать группу",
  "groups.nameError": "Используйте одну строку от 1 до {max} символов.",
  "groups.actionFailed": "Группа не изменилась",
  "groups.created": "Группа {name} создана.",
  "groups.memberCount":
    "{count, plural, one {# участник} few {# участника} many {# участников} other {# участника}}",
  "groups.showMembers": "Участники",
  "groups.hideMembers": "Скрыть участников",
  "groups.rename": "Переименовать",
  "groups.renameLabel": "Переименовать {name}",
  "groups.renameField": "Новое название для {name}",
  "groups.save": "Сохранить название",
  "groups.renamed": "Группа теперь называется {name}.",
  "groups.delete": "Удалить",
  "groups.deleteLabel": "Удалить {name}",
  "groups.deleted": "Группа {name} удалена.",
  "groups.confirm.title": "Удалить {name}?",
  "groups.confirm.body":
    "Её участники перестанут читать artifacts, в которые она добавлена, в течение минуты, если доступ им не даёт что-то другое. Это нельзя отменить.",
  "groups.membersLoading": "Загрузка участников группы",
  "groups.noMembers": "В этой группе пока никого нет.",
  "groups.membersOf": "Участники {name}",
  "groups.removeMember": "Убрать",
  "groups.removeMemberLabel": "Убрать {name} из {group}",
  "groups.memberRemoved": "{name} убран(а) из {group}.",
  "groups.addMember": "Добавить участника в {name}",
  "groups.chooseMember": "Выберите участника",
  "groups.add": "Добавить",
  "groups.memberAdded": "{name} добавлен(а) в {group}.",
  "groupAccess.title": "Группы",
  "groupAccess.hint":
    "Участники этих групп workspace могут открыть его после входа, как читатели из списка.",
  "groupAccess.onlyRestricted":
    "Группы дают доступ своим участникам, только пока доступ закрытый; в других режимах они сохраняют лишь исключения для комментариев.",
  "groupAccess.count": "{count} из {max} групп",
  "groupAccess.planTitle": "Группы не входят в тариф этого workspace",
  "groupAccess.planRequired":
    "Добавление групп входит в тариф {plan}. Уже добавленные группы никому не дают доступ, пока тариф снова их не включит, и вы по-прежнему можете их убрать.",
  "groupAccess.failed.title": "Группы не изменились",
  "groupAccess.empty": "Группы не добавлены.",
  "groupAccess.list": "Группы, которые могут открыть этот artifact",
  "groupAccess.removeLabel": "Убрать группу {name}",
  "groupAccess.removed": "Группа {name} убрана.",
  "groupAccess.full": "В artifact можно добавить не больше {max} групп.",
  "groupAccess.none":
    "В этом workspace пока нет групп. Администраторы создают их на странице Группы.",
  "groupAccess.added": "Группа {name} добавлена.",
  "groupAccess.pick": "Добавить группу",
  "groupAccess.choose": "Выберите группу",
  "groupAccess.option":
    "{name} ({count, plural, one {# участник} few {# участника} many {# участников} other {# участника}})",
  "groupAccess.add": "Добавить группу",
  "groupAccess.comments.label": "Комментарии, которые видит группа {name}",
  "groupAccess.comments.changed": "Группа {name} теперь видит: {choice}.",
  "groupAccess.comments.confirm.title": "Показать все комментарии группе {name}?",
  "groupAccess.comments.confirm.body":
    "Каждый участник {name} увидит все ветки комментариев этого artifact, включая те, что другие читатели начали раньше.",
  "audit.group.groups": "Группы",
  "audit.kind.groupCreated": "Создал(а) группу {group}",
  "audit.kind.groupRenamed": "Переименовал(а) группу, теперь {group}",
  "audit.kind.groupDeleted": "Удалил(а) группу {group}",
  "audit.kind.groupMemberAdded": "Добавил(а) {member} в группу {group}",
  "audit.kind.groupMemberRemoved": "Убрал(а) {member} из группы {group}",
  "audit.target.groupGone": "удалённая группа",
  "audit.access.groupsAdded":
    "{count, plural, one {добавил(а) # группу} few {добавил(а) # группы} many {добавил(а) # групп} other {добавил(а) # группы}}",
  "audit.access.groupsRemoved":
    "{count, plural, one {убрал(а) # группу} few {убрал(а) # группы} many {убрал(а) # групп} other {убрал(а) # группы}}",
  "audit.access.groupExceptions":
    "{count, plural, one {изменил(а) видимость комментариев для # группы} few {изменил(а) видимость комментариев для # групп} many {изменил(а) видимость комментариев для # групп} other {изменил(а) видимость комментариев для # группы}}",
  // Single sign-on (premium plan E1, decision 0016).
  "sso.title": "Единый вход",
  "sso.description":
    "Люди с адресом в подтверждённых почтовых доменах workspace могут входить через поставщика удостоверений вашей организации по OpenID Connect.",
  "sso.loadFailed": "Не удалось загрузить единый вход",
  "sso.stateLabel": "Состояние",
  "sso.state.off": "Не настроен",
  "sso.state.on": "Включён",
  "sso.state.plan": "Приостановлен: не входит в тариф",
  "sso.state.domains": "Приостановлен: нет подтверждённых доменов",
  "sso.planTitle": "Не входит в этот тариф",
  "sso.plan":
    "Единый вход входит в тариф {plan}. Уже настроенный поставщик остаётся, и вы всё ещё можете его удалить.",
  "sso.lapsedTitle": "Домен больше не подтверждён",
  "sso.lapsed":
    "{domains} больше не подтверждён, поэтому адреса в нём не могут входить так, пока домен не подтвердят снова.",
  "sso.membership":
    "Те, кто входит так, становятся участниками workspace, или получают роль из ожидающего приглашения, пока есть свободное место. Текущие участники сохраняют роль.",
  "sso.removalNote":
    "Тот, кого удалил администратор, не сможет вернуться через единый вход, пока администратор снова его не пригласит. Тот, кто ушёл сам, может.",
  "sso.redirectUri": "URI перенаправления",
  "sso.redirectPending":
    "Сохраните поставщика, чтобы получить URI перенаправления для регистрации у поставщика удостоверений. Он выглядит так: {pattern}.",
  "sso.saveFailed": "Изменение не сохранено",
  "sso.testOkTitle": "Обнаружение работает",
  "sso.testOk": "Вход идёт через {authorization}, токены приходят от {token}, ключи от {keys}.",
  "sso.testOkShort": "Обнаружение работает.",
  "sso.testFailed": "Обнаружение не удалось",
  "sso.formLabel": "Поставщик единого входа",
  "sso.issuer": "URL издателя",
  "sso.issuerHint":
    "Издатель вашего поставщика удостоверений, например https://login.example.com. Portifact читает его документ обнаружения. После сохранения его нельзя изменить.",
  "sso.clientId": "ID клиента",
  "sso.clientSecret": "Секрет клиента",
  "sso.secretHint": "Хранится в зашифрованном виде и больше не показывается.",
  "sso.secretKeep": "Оставьте пустым, чтобы сохранить текущий секрет.",
  "sso.domains": "Домены для входа",
  "sso.domainsHint":
    "Только подтверждённые почтовые домены workspace. Адрес из другого домена не может входить так.",
  "sso.noDomains": "Сначала подтвердите почтовый домен выше.",
  "sso.issuerRequired": "Введите URL издателя.",
  "sso.clientIdRequired": "Введите ID клиента.",
  "sso.secretRequired": "Введите секрет клиента.",
  "sso.domainsRequired": "Выберите хотя бы один домен.",
  "sso.save": "Сохранить",
  "sso.saveChanges": "Сохранить изменения",
  "sso.test": "Проверить издателя",
  "sso.remove": "Удалить единый вход",
  "sso.saved": "Единый вход сохранён.",
  "sso.removed": "Единый вход удалён.",
  "sso.scim":
    "Удаление человека у поставщика удостоверений не удаляет его здесь: удалите его из списка участников.",
  "sso.confirmRemove.title": "Удалить единый вход?",
  "sso.confirmRemove.body":
    "Больше никто не сможет войти через этого поставщика. Участники остаются участниками и сохраняют аккаунты; они входят с кодом по почте, через Google или GitHub. Новый поставщик получит новый URI перенаправления.",
  "sso.confirmRemove.action": "Удалить",
  "sso.problem.invalid_issuer": "Издатель должен быть публичным https URL без запроса и фрагмента.",
  "sso.problem.unreachable": "Не удалось связаться с поставщиком удостоверений.",
  "sso.problem.timeout": "Поставщик удостоверений отвечал слишком долго.",
  "sso.problem.redirect":
    "Поставщик удостоверений ответил перенаправлением, которому Portifact не следует. Укажите издателя, на которого он перенаправляет.",
  "sso.problem.http_error": "Поставщик удостоверений ответил ошибкой.",
  "sso.problem.too_large": "Ответ поставщика удостоверений слишком большой.",
  "sso.problem.not_json": "Документ обнаружения не является корректным JSON.",
  "sso.problem.issuer_mismatch":
    "Документ обнаружения указывает другого издателя. Укажите издателя точно так, как в документе.",
  "sso.problem.missing_endpoint":
    "В документе обнаружения нет конечной точки авторизации, токенов или ключей.",
  "sso.problem.invalid_endpoint":
    "Конечная точка в документе обнаружения не является публичным https URL.",
  "sso.problem.no_code_flow": "Поставщик удостоверений не поддерживает поток с кодом авторизации.",
  "sso.problem.no_pkce": "Поставщик удостоверений не поддерживает PKCE с S256.",
  "sso.problem.no_signing_algorithm":
    "Поставщик удостоверений подписывает ID-токены алгоритмом, который Portifact не принимает (семейства RS256, PS256, ES256 или EdDSA).",
  "sso.error.invalid_input":
    "Проверьте издателя, клиента и домены. «Проверить издателя» покажет, что не так с обнаружением.",
  "sso.error.capacity_unavailable": "Единый вход сейчас недоступен.",
  "sso.error.version_conflict":
    "Единый вход за это время изменился. Обновите страницу и попробуйте снова.",
  "sso.error.not_found": "Единый вход не настроен.",
  "audit.kind.memberJoinedSso": "{member} присоединяется как {role} через единый вход",
  "audit.kind.ssoCreated":
    "Настроил(а) единый вход с {host} для {count, plural, one {# домена} few {# доменов} many {# доменов} other {# доменов}}",
  "audit.kind.ssoChanged": "Изменил(а) единый вход",
  "audit.kind.ssoRemoved": "Удалил(а) единый вход",
  "shell.policiesLink": "Правила",
  "policies.title": "Правила",
  "policies.description":
    "Правила для всех артефактов {workspace}. Они действуют для всех, кто работает с его артефактами, включая администраторов и сервисные токены.",
  "policies.personal.title": "Правила есть у рабочих пространств",
  "policies.personal.body":
    "У личного пространства нет правил. Переключитесь на рабочее пространство, чтобы увидеть его правила.",
  "policies.loading": "Загрузка правил",
  "policies.loadFailed": "Не удалось загрузить правила",
  "policies.planTitle": "Настройка правил входит в тариф {plan}",
  "policies.planRequired":
    "Тариф рабочего пространства не включает правила. Уже заданные продолжают действовать, а администраторы по-прежнему могут ослабить или снять их.",
  "policies.readOnly.title": "Задаются администраторами",
  "policies.readOnly.body": "Менять правила могут только администраторы. Они действуют и для вас.",
  "policies.adminsToo": "Эти правила действуют и для администраторов.",
  "policies.public.legend": "Публичный доступ",
  "policies.public.allowed": "Разрешён",
  "policies.public.allowedHint":
    "Администраторы и редакторы могут сделать артефакт публичным, и тогда его откроет любой, у кого есть ссылка.",
  "policies.public.forbidden": "Запрещён",
  "policies.public.forbiddenHint":
    "Ни один артефакт рабочего пространства не может быть публичным. Публичные артефакты станут доступны рабочему пространству.",
  "policies.default.legend": "Доступ новых артефактов",
  "policies.default.hint":
    "С каким доступом создаётся новый артефакт рабочего пространства. Существующие сохраняют свой.",
  "policies.default.restricted": "Открыть его могут только владельцы и добавленные читатели.",
  "policies.default.workspace": "Открыть его может любой участник рабочего пространства.",
  "policies.default.domain":
    "Открыть его могут участники и все, кто вошёл с подтверждённым адресом на почтовых доменах рабочего пространства.",
  "policies.default.domainNone": "Сначала подтвердите почтовый домен на странице «Участники».",
  "policies.readers.legend": "Домены читателей",
  "policies.readers.any": "Любой адрес",
  "policies.readers.anyHint": "Читателей можно добавлять с любым адресом почты.",
  "policies.readers.only": "Только эти домены",
  "policies.readers.onlyHint":
    "Читателей можно добавлять только с адресами на этих почтовых доменах. Участников и группы это не касается.",
  "policies.readers.domains": "Разрешённые домены",
  "policies.readers.domainsHint": "По одному на строку, например example.com, не больше {max}.",
  "policies.readers.domainsError": "Укажите от 1 до {max} простых доменов, например example.com.",
  "policies.links.legend": "Ссылки для доступа",
  "policies.links.allowed": "Разрешены",
  "policies.links.allowedHint":
    "Администраторы и редакторы могут создавать ссылки для доступа, с паролем или без.",
  "policies.links.password_required": "Нужен пароль",
  "policies.links.password_requiredHint":
    "Каждой ссылке нужен пароль. Ссылки без пароля перестают открываться.",
  "policies.links.disabled": "Отключены",
  "policies.links.disabledHint": "Ссылок для доступа нет. Существующие отзываются.",
  "policies.lifetime.label": "Наибольший срок жизни ссылки, в днях",
  "policies.lifetime.hint":
    "Оставьте пустым, чтобы не ограничивать. Более старые ссылки перестают открываться.",
  "policies.lifetime.error": "Укажите целое число дней от 1 до {max} или оставьте поле пустым.",
  "policies.save": "Сохранить правила",
  "policies.saved": "Правила сохранены.",
  "policies.saveFailed": "Правила не сохранены",
  "policies.conflict":
    "Кто-то изменил правила за это время. Они загружены заново: проверьте их и сохраните.",
  "policies.impact.title": "Применить эти правила к существующим артефактам?",
  "policies.impact.body": "Сохранение изменит то, что уже есть в {workspace}:",
  "policies.impact.public":
    "{count, plural, one {# публичный артефакт станет доступен рабочему пространству} few {# публичных артефакта станут доступны рабочему пространству} many {# публичных артефактов станут доступны рабочему пространству} other {# публичного артефакта станут доступны рабочему пространству}}",
  "policies.impact.readers":
    "{count, plural, one {# читатель вне разрешённых доменов будет удалён} few {# читателя вне разрешённых доменов будут удалены} many {# читателей вне разрешённых доменов будут удалены} other {# читателя вне разрешённых доменов будут удалены}}",
  "policies.impact.revoked":
    "{count, plural, one {# ссылка будет отозвана} few {# ссылки будут отозваны} many {# ссылок будут отозваны} other {# ссылки будут отозваны}}",
  "policies.impact.password":
    "{count, plural, one {# ссылка без пароля перестанет открываться} few {# ссылки без пароля перестанут открываться} many {# ссылок без пароля перестанут открываться} other {# ссылки без пароля перестанут открываться}}",
  "policies.impact.lifetime":
    "{count, plural, one {# ссылка старше срока жизни перестанет открываться} few {# ссылки старше срока жизни перестанут открываться} many {# ссылок старше срока жизни перестанут открываться} other {# ссылки старше срока жизни перестанут открываться}}",
  "policies.impact.note":
    "Это происходит в фоне, небольшими порциями, и записывается в журнал аудита.",
  "policies.impact.confirm": "Применить и сохранить",
  "policies.impact.cancel": "Продолжить правку",
  "policies.note.publicForbidden": "Правило рабочего пространства запрещает публичный доступ.",
  "policies.note.readerDomains":
    "Правило рабочего пространства разрешает читателей только на {domains}.",
  "policies.note.linksDisabled": "Правило рабочего пространства не разрешает ссылки для доступа.",
  "policies.note.linksPassword": "Правило рабочего пространства требует пароль для каждой ссылки.",
  "policies.note.linksLifetime":
    "Правило рабочего пространства ограничивает ссылки сроком {days, plural, one {# день} few {# дня} many {# дней} other {# дня}}.",
  "error.policy_refused": "Правило рабочего пространства этого не разрешает.",
  "error.terms_not_accepted":
    "Примите действующие условия, чтобы продолжить. Перезагрузите страницу, чтобы ознакомиться с ними.",
  "audit.group.policies": "Правила",
  "audit.kind.policyChanged": "Изменены правила рабочего пространства: {changes}",
  "audit.kind.policyEnforced": "Применены правила рабочего пространства: {changes}",
  "audit.policy.public":
    "{value, select, forbidden {публичный доступ запрещён} other {публичный доступ разрешён}}",
  "audit.policy.default":
    "{mode, select, workspace {новые артефакты доступны рабочему пространству} domain {новые артефакты доступны почтовым доменам} other {новые артефакты ограничены}}",
  "audit.policy.readers": "читатели только на {domains}",
  "audit.policy.readersAny": "читатели на любом домене",
  "audit.policy.links":
    "{value, select, disabled {ссылки отключены} password_required {ссылкам нужен пароль} other {ссылки разрешены}}",
  "audit.policy.lifetime":
    "ссылки не дольше {days, plural, one {# дня} few {# дней} many {# дней} other {# дня}}",
  "audit.policy.lifetimeNone": "без ограничения срока ссылок",
  "audit.policy.narrowed":
    "{count, plural, one {# артефакт ограничен рабочим пространством} few {# артефакта ограничены рабочим пространством} many {# артефактов ограничены рабочим пространством} other {# артефакта ограничены рабочим пространством}}",
  "audit.policy.readersRemoved":
    "{count, plural, one {удалён # читатель} few {удалены # читателя} many {удалены # читателей} other {удалены # читателя}}",
  "audit.policy.linksRevoked":
    "{count, plural, one {отозвана # ссылка} few {отозваны # ссылки} many {отозваны # ссылок} other {отозваны # ссылки}}",
  "audit.policy.sessionsEnded":
    "{count, plural, one {завершён # сеанс по ссылке} few {завершены # сеанса по ссылке} many {завершены # сеансов по ссылке} other {завершены # сеанса по ссылке}}",
  "policies.impact.stale":
    "Изменения, которые правило вносит в существующие артефакты, выросли с момента вашей проверки. Сохраните ещё раз, чтобы проверить новые числа.",
  "policies.savedWithChanges":
    "Существующие артефакты приводятся в соответствие с правилами. Их страницы и журнал аудита показывают, что изменилось.",
  "policies.default.domainLapsed":
    "Нет подтверждённого почтового домена, поэтому новые артефакты создаются доступными рабочему пространству, пока домен не будет подтверждён снова.",
  "audit.access.byPolicy": "по правилу рабочего пространства",
  "audit.actor.directory": "{label} (каталог)",
  "audit.actor.directoryGone": "Каталог (отозванный токен SCIM)",
  "audit.kind.memberJoinedDirectory": "{member} присоединяется как {role} через каталог",
  "audit.kind.memberProvisioned":
    "Подготовлен человек из {domain} как {role}; присоединится при входе",
  "audit.kind.scimTokenCreated":
    "Создан токен SCIM ({days, plural, one {# день} few {# дня} many {# дней} other {# дня}})",
  "audit.kind.scimTokenRevoked": "Отозван токен SCIM",
  "audit.kind.scimEmailsOn": "Включены письма-приглашения для подготовленных людей",
  "audit.kind.scimEmailsOff": "Выключены письма-приглашения для подготовленных людей",
  "pending.directory": "Из каталога",
  "pending.directoryDetail":
    "{role}, подготовлен каталогом: присоединится при первом входе, занимает место до {date}",
  "scim.title": "Синхронизация каталога (SCIM)",
  "scim.description":
    "Позвольте поставщику удостоверений добавлять и удалять людей рабочего пространства. Он подготавливает адреса из ваших подтверждённых почтовых доменов; человек без аккаунта Portifact присоединится при первом входе с этим адресом.",
  "scim.loadFailed": "Не удалось загрузить синхронизацию каталога",
  "scim.baseUrl": "Базовый URL SCIM",
  "scim.baseUrlCopy": "Копировать URL",
  "scim.baseUrlHint":
    "Вставьте его в поставщике удостоверений как базовый URL SCIM или URL клиента, а токен ниже как токен на предъявителя.",
  "scim.planTitle": "Нет в этом тарифе",
  "scim.plan":
    "Синхронизации каталога нужен тариф {plan}. До тех пор запросы каталога отклоняются; отозвать его токены можно и сейчас.",
  "scim.rules":
    "Новые люди присоединяются как участники. Деактивация в каталоге удаляет человека из рабочего пространства и завершает все его сеансы; аккаунт и личное пространство остаются за ним. Того, кого удалили здесь вручную, следующая синхронизация не вернёт.",
  "scim.lastSync": "Последняя синхронизация",
  "scim.lastSyncNever": "Каталог ещё не подключался.",
  "scim.pendingLabel": "Ожидают входа",
  "scim.pending":
    "{count, plural, =0 {Никто} one {# человек, в ожидающих приглашениях} few {# человека, в ожидающих приглашениях} many {# человек, в ожидающих приглашениях} other {# человека, в ожидающих приглашениях}}",
  "scim.tokens": "Токены",
  "scim.tokensEmpty": "Токенов пока нет.",
  "scim.tokenExpires": "Истекает {date}",
  "scim.tokenExpired": "Истёк {date}",
  "scim.tokenUsed": "последнее использование {date}",
  "scim.tokenUnused": "не использовался",
  "scim.create": "Создать токен SCIM",
  "scim.label": "Название",
  "scim.labelHint": "Например, имя поставщика удостоверений.",
  "scim.labelRequired": "Введите название не длиннее 80 символов.",
  "scim.expiry": "Срок действия",
  "scim.days": "{count, plural, one {# день} few {# дня} many {# дней} other {# дня}}",
  "scim.limit":
    "У рабочего пространства не больше {count} токенов SCIM, чтобы один мог заменить другой без перерыва. Отзовите один, чтобы создать новый.",
  "scim.secret.title": "Скопируйте токен сейчас",
  "scim.secret.body":
    "Он показывается только один раз. Вставьте его в поставщике удостоверений как токен на предъявителя.",
  "scim.secret.label": "Токен SCIM {label}",
  "scim.secret.copy": "Копировать токен",
  "scim.secret.done": "Я сохранил",
  "scim.revoke": "Отозвать",
  "scim.revokeNamed": "Отозвать: {label}",
  "scim.confirmRevoke.title": "Отозвать {label}?",
  "scim.confirmRevoke.body":
    "Следующий запрос каталога с ним будет отклонён. Подготовленные им люди останутся как есть.",
  "scim.confirmRevoke.action": "Отозвать токен",
  "scim.revoked": "Токен {label} отозван.",
  "scim.created": "Токен {label} создан. Скопируйте его сейчас.",
  "scim.emails":
    "Отправлять письмо-приглашение людям, которых каталог подготавливает без аккаунта Portifact",
  "scim.emailsHint":
    "По умолчанию выключено: поставщики удостоверений обычно сами сообщают о новых приложениях. В любом случае человек присоединится при первом входе с этим адресом.",
  "scim.emailsSaved": "Сохранено.",
  "scim.actionFailed": "Изменение не сохранено",
  "audit.kind.scimRoleOn": "Выдал роль {role} участникам группы каталога",
  "audit.kind.scimRoleOff": "Перестал выдавать роль {role} через группу каталога",
  "groups.directory": "Управляется вашим каталогом",
  "groups.directoryNote":
    "Каталог вашей организации управляет этой группой через SCIM: меняйте её название и участников там.",
  "members.directoryRole": "В группе каталога с ролью",
  "scim.roles.title": "Роли из групп каталога",
  "scim.roles.description":
    "Участники выбранной группы получают эту роль, если она выше текущей. Каталог забирает только роль, которую выдал сам: он никогда не понижает роль, заданную администратором вручную, а роль, изменённая вручную, с этого момента ваша.",
  "scim.roles.access":
    "Группа, указанная у artifact, даёт её участникам читать его, поэтому теперь ваш каталог решает, кто читает эти artifacts.",
  "scim.roles.editor": "Группа, участники которой становятся редакторами",
  "scim.roles.admin": "Группа, участники которой становятся администраторами",
  "scim.roles.none": "Нет группы",
  "scim.roles.option":
    "{name} ({count, plural, one {# участник} few {# участника} many {# участников} other {# участника}})",
  "scim.roles.noGroups": "Ваш каталог ещё не передал ни одной группы.",
  "scim.roles.save": "Сохранить роли",
  "scim.roles.saved": "Роли сохранены.",
  "scim.roles.confirm.title": "Сделать участников {name} администраторами?",
  "scim.roles.confirm.body":
    "{count, plural, one {Сейчас в {name} # человек} few {Сейчас в {name} # человека} many {Сейчас в {name} # человек} other {Сейчас в {name} # человека}}, и {pending, plural, =0 {больше никто не добавится} one {ещё # добавится} few {ещё # добавятся} many {ещё # добавятся} other {ещё # добавятся}} при входе. Тот, кто управляет вашим каталогом, будет решать, кто администрирует это рабочее пространство: его участников, правила, токены и настройки.",
  "scim.roles.confirm.action": "Сделать администраторами",
  "groups.stopSync": "Остановить синхронизацию",
  "groups.stopSyncLabel": "Остановить синхронизацию {name}",
  "groups.stopSync.title": "Остановить синхронизацию {name} из каталога?",
  "groups.stopSync.body":
    "Каталог больше не будет управлять этой группой: теперь её меняют администраторы здесь. Сопоставление роли снимается, а люди, которых она сделала редакторами или администраторами, сохраняют роль. Если каталог позже передаст группу с тем же названием, она будет отклонена.",
  "groups.stopSync.done": "{name} больше не синхронизируется из каталога.",
  "audit.kind.groupSyncStopped": "Остановил синхронизацию группы {group} из каталога",
  "shell.integrationsLink": "Интеграции",
  "integrations.title": "Интеграции",
  "integrations.description":
    "Превращайте ветку комментариев в задачу в GitHub, Linear или Jira. Подключение действует с учётными данными, которые вставил администратор, поэтому задачи создаются от имени этой учётной записи.",
  "integrations.adminOnly.title": "Интеграциями управляют только администраторы",
  "integrations.adminOnly.body":
    "Попросите администратора {workspace} подключить GitHub, Linear или Jira.",
  "integrations.planTitle": "Не входит в этот тариф",
  "integrations.planRequired":
    "Интеграции входят в тариф {plan}. Уже созданные подключения сохраняются, но создавать через них задачи нельзя.",
  "integrations.list.title": "Подключения",
  "integrations.list.loading": "Загрузка подключений",
  "integrations.list.error": "Не удалось загрузить подключения.",
  "integrations.empty.title": "Подключений пока нет",
  "integrations.empty.body":
    "Подключите GitHub, Linear или Jira, чтобы администраторы и редакторы могли создавать задачи из веток комментариев.",
  "integrations.service.github": "GitHub",
  "integrations.service.linear": "Linear",
  "integrations.service.jira": "Jira",
  "integrations.service.other": "Другой сервис",
  "integrations.add.title": "Подключить сервис",
  "integrations.add.hint":
    "Учётные данные проверяются у сервиса, хранятся в зашифрованном виде и больше не показываются: Portifact показывает только последние четыре символа.",
  "integrations.add.service": "Сервис",
  "integrations.add.label": "Название",
  "integrations.add.labelHint": "Название, понятное вашей команде, например Репозиторий продукта.",
  "integrations.add.credential.github": "Детализированный персональный токен доступа",
  "integrations.add.credential.linear": "API-ключ Linear",
  "integrations.add.credential.jira": "API-токен Atlassian с областями доступа",
  "integrations.add.targets.github": "Репозитории",
  "integrations.add.targets.linear": "ID команд",
  "integrations.add.targets.jira": "Ключи проектов",
  "integrations.add.targetsHint.github": "Один владелец/репозиторий в строке, не больше {limit}.",
  "integrations.add.targetsHint.linear":
    "Один ID команды в строке, не больше {limit}. Linear показывает его в настройках команды.",
  "integrations.add.targetsHint.jira":
    "Один ключ проекта в строке, например ENG, не больше {limit}.",
  "integrations.add.account": "Email учётной записи Atlassian",
  "integrations.add.accountHint":
    "Email учётной записи, создавшей токен. Он хранится зашифрованным вместе с токеном и больше не показывается.",
  "integrations.add.site": "Сайт Jira",
  "integrations.add.siteHint": "Например, acme.atlassian.net.",
  "integrations.add.cloudId": "Cloud ID",
  "integrations.add.cloudIdHint":
    "Откройте в браузере ваш-сайт.atlassian.net/_edge/tenant_info и скопируйте значение cloudId.",
  "integrations.add.failed":
    "Сервис не принял учётные данные или один из репозиториев, команд или проектов. Сверьте их с шагами выше и попробуйте снова.",
  "integrations.add.submit": "Подключить",
  "integrations.add.limit":
    "В пространстве может быть не больше {limit} подключений. Удалите одно, чтобы добавить другое.",
  "integrations.howto.github.title": "Создайте токен GitHub с минимальными правами",
  "integrations.howto.github.1":
    "В GitHub откройте Settings, Developer settings, Personal access tokens, Fine-grained tokens и выберите Generate new token.",
  "integrations.howto.github.2":
    "Укажите владельцем ресурса учётную запись или организацию, которой принадлежат репозитории, и задайте срок действия.",
  "integrations.howto.github.3":
    "В Repository access выберите Only select repositories и отметьте репозитории, перечисленные здесь.",
  "integrations.howto.github.4":
    "В Repository permissions установите для Issues значение Read and write. Остальные права оставьте No access; Metadata остаётся только для чтения.",
  "integrations.howto.github.5":
    "Создайте токен и вставьте его сюда. Задачи создаются от имени учётной записи токена.",
  "integrations.howto.linear.title": "Создайте API-ключ Linear",
  "integrations.howto.linear.1":
    "В Linear откройте Settings, затем Security and access, и создайте персональный API-ключ.",
  "integrations.howto.linear.2":
    "Если Linear позволяет ограничить ключ, разрешите только создание задач и только в перечисленных здесь командах.",
  "integrations.howto.linear.3":
    "Вставьте ключ сюда. Задачи создаются от имени вашей учётной записи Linear.",
  "integrations.howto.jira.title": "Создайте токен Jira с минимальными правами",
  "integrations.howto.jira.1":
    "Войдите в Atlassian под учётной записью, от имени которой должны создаваться задачи (лучше отдельной), откройте настройки учётной записи, затем «Безопасность», и выберите создание API-токена с областями доступа.",
  "integrations.howto.jira.2": "Задайте имя и срок действия и выберите Jira в качестве приложения.",
  "integrations.howto.jira.3":
    "Выберите только области read:jira-user, read:jira-work и write:jira-work.",
  "integrations.howto.jira.4":
    "Создайте токен и вставьте его сюда вместе с email учётной записи, сайтом и его cloud ID. Токен без областей доступа не работает.",
  "integrations.howto.jira.5":
    "Задачи создаются от имени этой учётной записи в проектах, которые вы здесь перечислите.",
  "integrations.connected": "{label} подключено.",
  "integrations.identity": "Действует как {identity}",
  "integrations.credential": "Учётные данные заканчиваются на {hint}",
  "integrations.site": "Сайт {site}",
  "integrations.attention.credential_rejected":
    "Сервис отклонил эти учётные данные. Вставьте новые и проверьте их.",
  "integrations.attention.key_unavailable":
    "Сохранённые учётные данные больше нельзя открыть. Вставьте их заново.",
  "integrations.attention.site_mismatch":
    "Этот cloud ID больше не относится к этому сайту Jira: сайт сменил адрес. Удалите это подключение и подключите сайт заново с его текущим именем.",
  "integrations.state.ready": "Готово",
  "integrations.state.attention": "Требует внимания",
  "integrations.test": "Проверить",
  "integrations.testLabel": "Проверить {label}",
  "integrations.testPassed":
    "{label} работает. Действует как {identity}, и все репозитории, команды или проекты доступны.",
  "integrations.testRefreshed":
    "Теперь Portifact создаёт задачи в {targets} с текущим типом задач проекта.",
  "integrations.problem.credential_rejected":
    "Сервис отклонил учётные данные: они неверны, истекли или отозваны.",
  "integrations.problem.missing_permission":
    "Сервис принял учётные данные, но они не могут прочитать собственную учётную запись.",
  "integrations.problem.target_unreachable":
    "Учётные данные не дают доступа к {target}. Проверьте доступ.",
  "integrations.problem.issues_disabled": "Задачи отключены в {target}.",
  "integrations.problem.service_unavailable": "Сервис не ответил. Попробуйте позже.",
  "integrations.problem.rate_limited":
    "Сервис ограничивает запросы с этими учётными данными. Попробуйте позже.",
  "integrations.problem.site_mismatch":
    "Этот cloud ID не принадлежит этому сайту Jira. Скопируйте оба значения с сайта заново.",
  "integrations.edit": "Изменить",
  "integrations.editLabel": "Изменить {label}",
  "integrations.edit.title": "Изменить {label}",
  "integrations.edit.credentialHint": "Оставьте пустым, чтобы сохранить текущие учётные данные.",
  "integrations.edit.accountHint":
    "Нужно вместе с новым токеном: email его учётной записи Atlassian.",
  "integrations.edit.save": "Сохранить",
  "integrations.saved": "{label} сохранено.",
  "integrations.remove": "Удалить",
  "integrations.removeLabel": "Удалить {label}",
  "integrations.confirm.title": "Удалить {label}?",
  "integrations.confirm.body":
    "Учётные данные удаляются из Portifact. Уже созданные задачи сохраняют ссылки; задачи, которые ещё создаются, завершатся ошибкой. Отзовите токен или ключ и в самом сервисе.",
  "integrations.removed": "{label} удалено.",
  "integrations.actionFailed": "Не получилось",
  "integrations.service.slack": "Slack",
  "integrations.state.pending": "Не завершено",
  "integrations.attention.pending":
    "Завершите подключение: вставьте bot token и signing secret приложения Slack.",
  "integrations.attention.app_uninstalled":
    "Slack сообщает, что приложение удалено или его токены отозваны. Установите его в Slack снова и вставьте новый bot token и signing secret.",
  "integrations.howto.slack.title": "Как подключить Slack",
  "integrations.howto.slack.1":
    "Начните здесь с названия. Затем Portifact покажет манифест для вашего собственного приложения Slack; в Slack пока ничего не отправляется.",
  "integrations.howto.slack.2":
    "Откройте ссылку, чтобы создать приложение в Slack по этому манифесту, и установите его в своё пространство Slack. Для этого нужно право создавать и устанавливать там приложения.",
  "integrations.howto.slack.3":
    "Скопируйте Bot User OAuth Token (начинается с xoxb-) в разделе OAuth & Permissions и Signing Secret в разделе Basic Information и вставьте их сюда.",
  "integrations.howto.slack.4":
    "В настройках приложения в Slack откройте Event Subscriptions и нажмите Verify рядом с Request URL.",
  "integrations.slack.start": "Начать",
  "integrations.slack.started":
    "Подключение {label} начато. Создайте приложение Slack по его манифесту, чтобы завершить.",
  "integrations.slack.previews":
    "Когда кто-то публикует в вашем рабочем пространстве Slack ссылку на один из публичных артефактов этого пространства, приложение показывает под ней название и тип артефакта. Больше ничего не отправляется: ни содержимое, ни сведения об артефактах, которые не являются публичными.",
  "integrations.slack.previewsStay":
    "Slack сохраняет превью в сообщении: если артефакт перестаёт быть публичным, прежние превью по-прежнему показывают его название и тип, а новые публикации его ссылки превью не получают.",
  "integrations.slack.notices":
    "Уведомления в канал приходят через вебхуки: добавьте incoming webhook в то же приложение Slack и вставьте его URL на странице «Вебхуки».",
  "integrations.slack.noticesLink": "Открыть вебхуки",
  "integrations.slack.pending.title": "Завершите подключение Slack",
  "integrations.slack.pending.body":
    "Создайте приложение по этому манифесту и установите его в своё пространство Slack, затем вставьте ниже его bot token и signing secret. Подключение, не завершённое за 24 часа, удаляется.",
  "integrations.slack.create": "Создать приложение в Slack",
  "integrations.slack.manifest": "Манифест приложения",
  "integrations.slack.requestUrl": "Request URL",
  "integrations.slack.copyRequestUrl": "Скопировать Request URL",
  "integrations.slack.copyManifest": "Скопировать манифест",
  "integrations.slack.copied": "Скопировано",
  "integrations.slack.botToken": "Bot User OAuth Token",
  "integrations.slack.botTokenHint":
    "В разделе OAuth & Permissions настроек приложения в Slack. Начинается с xoxb-.",
  "integrations.slack.signingSecret": "Signing Secret",
  "integrations.slack.signingSecretHint":
    "В разделе Basic Information настроек приложения в Slack, в блоке App Credentials.",
  "integrations.slack.finish": "Завершить подключение",
  "integrations.slack.verify":
    "Теперь откройте Event Subscriptions в настройках приложения в Slack и нажмите Verify рядом с Request URL. Если Slack не может её проверить, signing secret неверен: вставьте его здесь снова.",
  "integrations.slack.rename":
    "Приложение называется Portifact. Чтобы различать два пространства, подключённых к одному пространству Slack, переименуйте приложение в его настройках в Slack (Basic Information, Display Information).",
  "integrations.slack.team": "Пространство Slack {team}",
  "integrations.slack.outdatedTitle": "Устаревший манифест",
  "integrations.slack.outdated":
    "Это приложение создано по более старому манифесту. Обновите манифест приложения в Slack тем, что ниже.",
  "integrations.slack.setup": "Манифест и Request URL",
  "integrations.slack.eu":
    "Данные этого пространства хранятся в ЕС. Подключённое приложение Slack получает то, что ему отправляет Portifact, например названия публичных артефактов, ссылки на которые публикуют, и Slack может хранить это за пределами ЕС.",
  "integrations.edit.slackHint":
    "Оставьте оба поля пустыми, чтобы сохранить текущие токен и секрет. Новый bot token передаётся вместе с signing secret.",
  "integrations.confirm.slackBody":
    "Bot token и signing secret удаляются из Portifact, и Portifact отзывает bot token в Slack. Удалите приложение и в Slack.",
  "issues.create": "Создать задачу",
  "issues.dialog.title": "Создать задачу из ветки {number}",
  "issues.dialog.close": "Закрыть",
  "issues.dialog.connection": "Подключение",
  "issues.dialog.target": "Репозиторий, команда или проект",
  "issues.dialog.issueTitle": "Заголовок задачи",
  "issues.dialog.parts": "Что отправить",
  "issues.dialog.part.link": "Ссылку на эту ветку",
  "issues.dialog.part.artifactName": "Название artifact",
  "issues.dialog.part.quote": "Цитируемый текст",
  "issues.dialog.part.quoteHint": "Фрагмент artifact. Он покидает Portifact.",
  "issues.dialog.part.message": "Первое сообщение ветки",
  "issues.dialog.part.messageHint":
    "Чьи-то слова. Они покидают Portifact и остаются в задаче, даже если комментарий потом удалят.",
  "issues.dialog.preview": "Ровно то, что будет отправлено",
  "issues.dialog.previewHint":
    "Текст комментариев уходит как обычный текст: упоминания, ссылки и изображения в нём не срабатывают. Он перечитывается при создании задачи, поэтому отправляется последняя правка.",
  "issues.dialog.never":
    "Никогда не отправляются: адреса электронной почты читателей, содержимое artifact, другие сообщения ветки и заметки рецензентов.",
  "issues.dialog.visible":
    "Все, кто видит эту ветку, включая читателей вне вашей команды, видят ссылку на созданную задачу и название её репозитория, команды или проекта, даже закрытого.",
  "issues.failure.target_removed":
    "администратор убрал этот репозиторий, команду или проект из подключения.",
  "issues.failure.artifact_moved": "artifact перенесён в другое пространство.",
  "issues.failure.requester_left": "вы больше не можете создавать задачи для этого пространства.",
  "issues.failure.thread_gone": "ветка удалена.",
  "issues.failure.site_changed": "адрес сайта Jira изменился.",
  "issues.failure.other": "её не удалось создать.",
  "issues.dialog.eu":
    "Это пространство хранит данные в ЕС. То, что вы отправите, уходит в {service}, за пределы ЕС.",
  "issues.dialog.submit": "Создать задачу",
  "issues.dialog.noConnections":
    "Ни одно подключение нельзя использовать. Попросите администратора подключить GitHub, Linear или Jira или исправить подключение, которому нужно внимание.",
  "issues.requested": "Задача запрошена. Ссылка появится в ветке через несколько минут.",
  "issues.list": "Задачи",
  "issues.link": "Задача {key} в {target}",
  "issues.pending": "Задача в {target} создаётся",
  "issues.failed": "Задача в {target} не создана: {reason}",
  "issues.failure.credential_rejected": "учётные данные подключения больше не работают.",
  "issues.failure.target_unreachable": "учётные данные не могут создавать там задачи.",
  "issues.failure.rejected": "сервис её отклонил.",
  "issues.failure.connection_removed": "подключение удалено.",
  "issues.failure.unavailable": "интеграции недоступны.",
  "issues.failure.plan_lapsed": "тариф больше не включает интеграции.",
  "issues.failure.service_unavailable": "сервис не ответил.",
  "issues.failure.invalid_response": "сервис ответил так, что Portifact не смог это использовать.",
  "audit.kind.integrationConnected":
    "Подключил {service, select, github {GitHub} linear {Linear} jira {Jira} slack {Slack} other {{service}}} с {targets, plural, one {# репозиторием или командой} few {# репозиториями или командами} many {# репозиториями или командами} other {# репозитория или команды}}",
  "audit.kind.integrationConnectedOnly":
    "Подключил {service, select, github {GitHub} linear {Linear} jira {Jira} slack {Slack} other {{service}}}",
  "audit.kind.integrationChanged":
    "{credential, select, true {Заменил учётные данные подключения} other {Изменил название или цели подключения}}",
  "audit.kind.integrationRemoved":
    "Удалил подключение {service, select, github {GitHub} linear {Linear} jira {Jira} slack {Slack} other {{service}}}",
  "audit.kind.integrationFailing":
    "{reason, select, app_uninstalled {Приложение Slack подключения было удалено} site_mismatch {Сайт Jira подключения сменил адрес} key_unavailable {Учётные данные подключения больше нельзя открыть} other {{service, select, github {GitHub} linear {Linear} jira {Jira} slack {Slack} other {{service}}} отклонил учётные данные подключения}}",
  "audit.kind.issueCreated":
    "Создал задачу {service, select, github {GitHub} linear {Linear} jira {Jira} slack {Slack} other {{service}}} в {target} из ветки {message, select, true {с её первым сообщением} other {без текста комментариев}}",
  "policies.networks.legend": "Сети для людей",
  "policies.networks.hint":
    "Участники, включая администраторов, работают в рабочем пространстве и читают его artifacts, открытые только для рабочего пространства, только из этих сетей. Публичные artifacts, ссылки для общего доступа и внешние люди, с которыми вы поделились, не затрагиваются.",
  "policies.networks.any": "Любая сеть",
  "policies.networks.anyHint": "Люди могут работать с рабочим пространством откуда угодно.",
  "policies.networks.only": "Только эти сети",
  "policies.networks.onlyHint": "Запросы с других адресов отклоняются с сообщением о причине.",
  "policies.networks.ranges": "Разрешенные IP-адреса и диапазоны",
  "policies.networks.rangesHint":
    "По одному в строке, например 192.0.2.0/24 или 2001:db8::/32, не более {max}. Один адрес соответствует одному устройству.",
  "policies.networks.rangesError":
    "Укажите от 1 до {max} IP-адресов или диапазонов, например 192.0.2.0/24. Диапазон всех адресов (/0) не допускается.",
  "policies.networks.yourIp":
    "Ваш текущий адрес: {ip}. Список должен его включать, иначе после сохранения вы потеряете доступ.",
  "policies.networks.notStored":
    "Portifact проверяет адрес, который Cloudflare сообщает для каждого запроса, и никогда его не хранит.",
  "policies.networks.hidden":
    "Люди могут работать с этим рабочим пространством только из одобренных сетей. Список видят его администраторы.",
  "policies.networks.limits":
    "Это не остановит того, кто попадет в одобренную сеть, например через общий VPN, и ограничивает учетные записи людей, а не artifacts, которыми уже поделились за пределами рабочего пространства.",
  "policies.tokenNetworks.legend": "Сети для сервисных токенов",
  "policies.tokenNetworks.hint":
    "Сервисные токены не ограничены списком для людей. Задайте для них отдельный список, например адреса ваших CI-раннеров.",
  "policies.tokenNetworks.anyHint": "Сервисные токены работают откуда угодно.",
  "policies.tokenNetworks.onlyHint":
    "Сервисные токены, используемые с других адресов, отклоняются.",
  "policies.tokenNetworks.hidden":
    "Сервисные токены работают только из одобренных сетей. Список видят администраторы рабочего пространства.",
  "policies.impact.networksTitle": "Ограничить сети, из которых доступно это рабочее пространство?",
  "policies.impact.members":
    "{count, plural, one {# участник сможет} few {# участника смогут} many {# участников смогут} other {# участника смогут}} работать с рабочим пространством только из разрешенных сетей",
  "policies.impact.tokens":
    "{count, plural, one {# сервисный токен будет} few {# сервисных токена будут} many {# сервисных токенов будут} other {# сервисного токена будут}} работать только из разрешенных сетей",
  "policies.impact.networksNote":
    "Portifact не хранит ничьи адреса, поэтому не может определить, кто сейчас находится вне этих сетей. Ваш собственный адрес включен.",
  "policies.impact.networksConfirm": "Ограничить сети",
  "space.blocked.title": "Недоступно из этой сети",
  "space.blocked.body":
    "{workspace} разрешает доступ только из одобренных сетей, а эта сеть не входит в их число. Подключитесь к одобренной сети или обратитесь к администратору рабочего пространства. Ваши другие пространства продолжают работать.",
  "audit.policy.networks":
    "люди только из {count, plural, one {# сети} few {# сетей} many {# сетей} other {# сети}}",
  "audit.policy.networksAny": "люди из любой сети",
  "audit.policy.tokenNetworks":
    "сервисные токены только из {count, plural, one {# сети} few {# сетей} many {# сетей} other {# сети}}",
  "audit.policy.tokenNetworksAny": "сервисные токены из любой сети",
  "policies.networks.bothFamilies":
    "Сетям, использующим IPv4 и IPv6, нужны оба диапазона: браузер может обращаться к Portifact по любому из протоколов, а запросы по семейству, которого нет в списке, отклоняются.",
  "policies.impact.singleFamily":
    "{list, select, people {Список для людей} other {Список для сервисных токенов}} содержит только диапазоны {family, select, ipv4 {IPv4} other {IPv6}}: запросы по {family, select, ipv4 {IPv6} other {IPv4}} будут отклонены, даже из этих сетей",
  "policies.impact.unboundTokens":
    "{count, plural, one {# сервисный токен продолжает} few {# сервисных токена продолжают} many {# сервисных токенов продолжают} other {# сервисного токена продолжают}} работать из любой сети. Задайте список для сервисных токенов, чтобы ограничить и их",
  "policies.impact.familiesConfirm": "Понятно, сохранить",
  "audit.group.exports": "Экспорт и потоки",
  "audit.kind.streamCreated":
    "Начал отправлять журнал на {host}{start, select, oldest { с самого старого сохранённого события} other {}}",
  "audit.kind.streamChanged":
    "{state, select, active {Возобновил поток на {host}} paused {Приостановил поток на {host}} other {{secret, select, true {Выдал потоку на {host} новый секрет подписи} other {Изменил поток на {host}}}}}",
  "audit.kind.streamRemoved": "Удалил поток на {host}",
  "audit.kind.streamPaused":
    "{reason, select, failures {Поток на {host} приостановлен: конечная точка продолжала отвечать ошибками} plan {Поток на {host} приостановлен: тариф больше его не включает} invalid_url {Поток на {host} приостановлен: его URL больше не проходит проверки} other {Поток на {host} приостановлен: его URL и секрет больше нельзя открыть}}",
  "audit.stream.title": "Отправка в вашу SIEM",
  "audit.stream.description":
    "Portifact отправляет каждое событие этого журнала на вашу конечную точку HTTPS в виде подписанных JSON Lines, по порядку и хотя бы один раз: сохраняйте каждый ID события только один раз. Событие отправляется, когда ему исполняется {minutes} минут.",
  "region.leaves.title": "Адресат может находиться за пределами ЕС",
  "region.leaves.webhooks":
    "Данные этого пространства хранятся в ЕС. Webhook-уведомления отправляются на указанные вами адреса, которые могут находиться где угодно: их содержимое покидает ЕС.",
  "region.leaves.integrations":
    "Данные этого пространства хранятся в ЕС. Задачи, которые вы создаёте, уходят в GitHub, Linear или Jira, которые могут хранить их где угодно: то, что вы отправляете, покидает ЕС.",
  "audit.stream.euTitle": "Ваша конечная точка может быть вне ЕС",
  "audit.stream.eu":
    "Данные этого пространства хранятся в ЕС. Выбранная конечная точка может находиться где угодно: полученные ею события покидают ЕС.",
  "audit.stream.planTitle": "Нет в вашем тарифе",
  "audit.stream.planRequired":
    "Отправка журнала аудита входит в тариф {plan}. Существующие потоки остаются приостановленными и сохраняют позицию.",
  "audit.stream.list": "Ваши потоки аудита",
  "audit.stream.empty": "Потоков пока нет",
  "audit.stream.emptyBody":
    "Добавьте конечную точку, чтобы получать каждое новое событие этого журнала.",
  "audit.stream.add.title": "Добавить поток",
  "audit.stream.add.label": "Название",
  "audit.stream.add.url": "URL конечной точки",
  "audit.stream.add.urlHint": "Только HTTPS. После сохранения показывается только хост.",
  "audit.stream.add.start": "Начать с",
  "audit.stream.add.submit": "Добавить поток",
  "audit.stream.add.limit":
    "В пространстве может быть не больше {limit} потоков. Удалите один, чтобы добавить другой.",
  "audit.stream.start.now": "Сейчас",
  "audit.stream.start.nowHint": "Только события с этого момента.",
  "audit.stream.start.oldest": "Самого старого сохранённого события",
  "audit.stream.start.oldestHint":
    "Всё, что журнал ещё хранит (до {days} дней), а затем новые события.",
  "audit.stream.added": "Поток на {host} добавлен",
  "audit.stream.secret.title": "Скопируйте секрет подписи сейчас",
  "audit.stream.secret.body":
    "Он показывается только один раз. Ваша конечная точка проверяет с его помощью, что каждый запрос пришёл от Portifact.",
  "audit.stream.secret.label": "Секрет подписи {label} ({host})",
  "audit.stream.secret.copy": "Скопировать секрет",
  "audit.stream.secret.done": "Я сохранил",
  "audit.stream.rotate.body":
    "Старый секрет ещё 24 часа подписывает запросы вместе с новым, чтобы конечная точка перешла на него без потери запросов.",
  "audit.stream.verify.title": "Проверяйте каждый запрос",
  "audit.stream.verify.body":
    "Каждый запрос содержит webhook-id, webhook-timestamp и webhook-signature, по той же схеме, что и вебхуки Portifact. Пересчитайте подпись по исходному телу, отклоняйте метки времени, отличающиеся больше чем на 5 минут, и пропускайте события, ID которых уже сохранён. Строки с полем record не являются событиями: это пропуск или проверка.",
  "audit.stream.verify.sample": "Проверка подписи в Node.js",
  "audit.stream.state.active": "Активен",
  "audit.stream.state.paused": "Приостановлен",
  "audit.stream.state.attention": "Требует внимания",
  "audit.stream.reason.manual": "Приостановлен администратором.",
  "audit.stream.reason.plan":
    "Приостановлен: тариф больше не включает отправку журнала. Возобновите, когда снова будет включать; поток продолжит с того места, где остановился.",
  "audit.stream.reason.failures":
    "Приостановлен после 3 дней ошибок конечной точки. Исправьте её, отправьте проверку и возобновите.",
  "audit.stream.reason.invalid_url":
    "Приостановлен: его URL больше не проходит проверки Portifact. Измените URL.",
  "audit.stream.reason.key_unavailable":
    "Приостановлен: его URL и секрет больше нельзя открыть. Удалите его и добавьте заново.",
  "audit.stream.through": "Доставлено по {when}",
  "audit.stream.notYet": "Пока ничего не доставлено",
  "audit.stream.failures":
    "{count, plural, one {# запрос не удался} few {# запроса подряд не удались} many {# запросов подряд не удались} other {# запроса подряд не удались}}",
  "audit.stream.lastAttempt": "Последний запрос {when}: {outcome}",
  "audit.stream.noAttempts": "Запросов пока нет",
  "audit.stream.testPending": "Проверка ожидает отправки.",
  "audit.stream.gapTitle": "Некоторые события могут так и не дойти до этой конечной точки",
  "audit.stream.gap":
    "События, записанные с {from} по {to}, были или будут удалены по сроку хранения журнала до того, как эта конечная точка их получила; всё, что ещё хранилось, отправлено. Конечная точка получила запись о пропуске с этой информацией.",
  "audit.stream.test": "Отправить проверку",
  "audit.stream.testLabel": "Отправить проверку на {label}",
  "audit.stream.testQueued": "Проверка для {label} поставлена в очередь",
  "audit.stream.pause": "Приостановить",
  "audit.stream.pauseLabel": "Приостановить поток {label}",
  "audit.stream.paused": "Поток {label} приостановлен",
  "audit.stream.resume": "Возобновить",
  "audit.stream.resumeLabel": "Возобновить поток {label}",
  "audit.stream.resumed": "Поток {label} возобновлён",
  "audit.stream.rotate": "Новый секрет",
  "audit.stream.rotateLabel": "Новый секрет для {label}",
  "audit.stream.rotated": "Новый секрет для {label} создан",
  "audit.stream.remove": "Удалить",
  "audit.stream.removeLabel": "Удалить поток {label}",
  "audit.stream.removed": "Поток {label} удалён",
  "audit.stream.confirm.title": "Удалить поток {label}?",
  "audit.stream.confirm.body":
    "Portifact сразу прекращает отправку. Конечная точка сохраняет то, что получила; новый поток начнётся заново с текущего момента.",
  "audit.stream.failed": "Не получилось",
  "audit.stream.deliveries": "Запросы",
  "audit.stream.deliveriesOf": "Запросы потока {label}",
  "audit.stream.deliveries.loading": "Загрузка запросов",
  "audit.stream.deliveries.error": "Не удалось загрузить запросы.",
  "audit.stream.deliveries.empty": "За последние {days} дней запросов не было.",
  "audit.stream.deliveries.time": "Время",
  "audit.stream.deliveries.events": "События",
  "audit.stream.deliveries.outcome": "Результат",
  "audit.stream.outcome.delivered": "доставлен",
  "audit.stream.outcome.failed": "ошибка",
  "audit.stream.outcome.skipped": "пропущен",
  "audit.stream.outcome.test": "проверка",
  "audit.stream.error.unreachable": "не удалось подключиться",
  "audit.stream.error.certificate": "сертификат не принят",
  "audit.stream.error.timeout": "время ожидания истекло",
  "audit.stream.error.redirect": "перенаправление, не выполнено",
  "audit.stream.error.refused": "отклонён",
  "audit.stream.error.invalid_url": "URL больше не принимается",
  "audit.stream.error.key_unavailable": "нельзя открыть",
  "audit.stream.error.daily_cap": "достигнут дневной лимит",
  "audit.stream.revokeNow": "Заменить сейчас",
  "audit.stream.revokeNowLabel": "Заменить сейчас секрет {label}",
  "audit.stream.revokeConfirm.title": "Заменить секрет {label} сейчас?",
  "audit.stream.revokeConfirm.body":
    "Старый секрет сразу перестаёт подписывать запросы. Пока у конечной точки нет нового, она отклоняет запросы Portifact; ничего не теряется, они будут отправлены снова, когда она их примет. Используйте это, если старый секрет утёк.",
  "audit.stream.revokedNow": "Новый секрет для {label}; старый больше не подписывает",
  "audit.stream.revokeNow.body":
    "Старый секрет больше не подписывает. Передайте конечной точке этот сейчас.",
  "policies.session.legend": "Длительность сеанса",
  "policies.session.hint":
    "Сколько времени после входа человек может действовать в рабочем пространстве. Потом панель, CLI и подключённые приложения просят войти заново; никто не выходит из системы и ничего не удаляется.",
  "policies.session.any": "Без ограничения",
  "policies.session.anyHint": "Вход действует в рабочем пространстве, пока он длится.",
  "policies.session.only": "Просить войти заново",
  "policies.session.onlyHint": "Люди входят заново, когда их вход старше ограничения.",
  "policies.session.hours": "Часов после входа",
  "policies.session.hoursHint": "Целое число от {min} до {max}.",
  "policies.session.hoursError": "Укажите целое число часов от {min} до {max}.",
  "policies.session.yours":
    "Вы вошли {count, plural, one {# час} few {# часа} many {# часов} other {# часа}} назад. Более короткое ограничение заблокирует вас, поэтому сначала войдите заново, если оно нужно.",
  "policies.session.tokens": "Сервисные токены не входят в систему и не ограничиваются.",
  "policies.session.limits":
    "CLI отсчитывает время от `portifact login`, а приложение от момента подключения, сколько бы раз они ни обновляли токены.",
  "policies.clients.legend": "Приложения, которым можно действовать",
  "policies.clients.hint":
    "Какие виды приложений могут действовать в рабочем пространстве от имени вошедшего человека. Панель разрешена всегда.",
  "policies.clients.any": "Любое приложение",
  "policies.clients.anyHint":
    "Панель, CLI Portifact и приложения, которые подключают люди, например MCP-клиенты.",
  "policies.clients.only": "Только выбранные здесь приложения",
  "policies.clients.onlyHint": "Остальные приложения получают отказ с объяснением причины.",
  "policies.clients.which": "Разрешённые приложения",
  "policies.clients.dashboard": "Панель (разрешена всегда)",
  "policies.clients.cli": "CLI Portifact",
  "policies.clients.cliHint":
    "Собственная командная строка Portifact, распознаётся по постоянной записи клиента.",
  "policies.clients.apps": "Другие подключённые приложения",
  "policies.clients.appsHint":
    "MCP-клиенты и любые другие приложения, которые человек подключает через OAuth.",
  "policies.clients.tokens": "Сервисные токены не ограничиваются.",
  "policies.clients.limits":
    "Приложения, которые регистрируются сами, выбирают себе имя, поэтому Portifact разрешает или запрещает их одной группой, а не по имени. Это не мешает человеку скопировать то, что он может прочитать, в другое приложение.",
  "policies.impact.signInsTitle": "Изменить, как люди входят в это рабочее пространство?",
  "policies.impact.signInMembers":
    "Затронет {count, plural, one {# участника} few {# участников} many {# участников} other {# участника}}",
  "policies.impact.staleMembers":
    "{count, plural, one {# участнику} few {# участникам} many {# участникам} other {# участника}} придётся войти заново при следующем действии: в панели, CLI или подключённом приложении",
  "policies.impact.clientMembers":
    "{count, plural, one {# участник использует} few {# участника используют} many {# участников используют} other {# участника используют}} приложение, которое это запретит",
  "policies.impact.signInsNote":
    "Никто не выходит из системы: при следующем действии в рабочем пространстве людей попросят войти заново или использовать другое приложение.",
  "policies.impact.signInsConfirm": "Сохранить",
  "space.blockedSession.title": "Войдите заново, чтобы продолжить",
  "space.blockedSession.body":
    "{workspace} через какое-то время просит войти заново, а ваш вход старше допустимого. Войдите заново, чтобы вернуться сюда. Другие ваши пространства продолжают работать.",
  "space.blockedSession.action": "Войти заново",
  "audit.policy.session":
    "входить заново каждые {count, plural, one {# час} few {# часа} many {# часов} other {# часа}}",
  "audit.policy.sessionAny": "без ограничения длительности сеанса",
  "audit.policy.clients":
    "{kinds, select, none {действовать может только панель} cli {действовать могут только панель и CLI} oauth_apps {действовать могут только панель и подключённые приложения} both {действовать могут панель, CLI и подключённые приложения} other {действовать может любое приложение}}",
  "space.blockedSso.title": "Войдите через единый вход, чтобы продолжить",
  "space.blockedSso.body":
    "{workspace} требует входа через свой единый вход, а этот браузер вошёл иначе. Войдите через единый вход, чтобы вернуться сюда: аккаунт останется прежним, а другие пространства продолжат работать. Если ваш адрес не обслуживается поставщиком удостоверений пространства, обратитесь к администратору. Покинуть пространство по-прежнему можно на странице ваших рабочих пространств.",
  "space.blockedSso.action": "Войти через единый вход",
  "policies.sso.legend": "Единый вход",
  "policies.sso.hint":
    "Нужно ли входить через собственного поставщика удостоверений этого пространства, чтобы работать в нём из панели, CLI и подключённых приложений.",
  "policies.sso.any": "Любой вход",
  "policies.sso.anyHint": "Работают коды по почте, Google, GitHub и единый вход.",
  "policies.sso.only": "Только через единый вход",
  "policies.sso.onlyHint":
    "Включая администраторов. CLI и приложения работают, если человек одобрил их из сеанса единого входа. Сервисные токены не затрагиваются.",
  "policies.sso.notUsable":
    "Сначала настройте единый вход с подтверждённым почтовым доменом на тарифе, который его включает. До этого его нельзя требовать.",
  "policies.sso.signInFirst":
    "Сначала войдите через единый вход в этом браузере, чтобы убедиться, что он работает, прежде чем его требовать. Вы вернётесь сюда.",
  "policies.sso.tradeoff":
    "Администраторы тоже обязаны, чтобы ни один аккаунт не мог обойти поставщика удостоверений. Если поставщик недоступен или настроен неверно, никто не сможет работать в пространстве, пока он не заработает или поддержка Portifact не снимет требование по просьбе администратора; остальные пространства у всех продолжают работать.",
  "policies.sso.required": "Чтобы работать в этом пространстве, входят через его единый вход.",
  "policies.sso.suspended":
    "Единый вход требуется, но поставщик сейчас никого не может авторизовать (он не обслуживает подтверждённый домен или тариф его больше не включает), поэтому требование не применяется, пока это не изменится.",
  "policies.impact.ssoTitle": "Требовать единый вход?",
  "policies.impact.ssoConfirm": "Требовать единый вход",
  "policies.impact.ssoMembers":
    "{count, plural, one {# участник будет} few {# участника будут} many {# участников будут} other {# участника будут}} работать в пространстве только через единый вход.",
  "policies.impact.ssoOutside":
    "{count, plural, one {Адрес # участника не относится} few {Адреса # участников не относятся} many {Адреса # участников не относятся} other {Адреса # участника не относятся}} к домену поставщика: войти через него они не смогут и получат отказ, пока администратор не снимет требование или адрес не изменится.",
  "policies.impact.ssoWithout":
    "{count, plural, one {У # участника} few {У # участников} many {У # участников} other {У # участника}} ещё нет сеанса единого входа; при следующем действии им предложат войти через него.",
  "policies.impact.ssoNote":
    "Никто не выходит из системы. Входы CLI и подключённые приложения, одобренные из другого вида входа, будут отклоняться в этом пространстве, пока человек не одобрит их снова из сеанса единого входа.",
  "account.sessions.column.method": "Способ входа",
  "account.apps.method": "Одобрено из входа через",
  "account.method.code": "Код по почте",
  "account.method.google": "Google",
  "account.method.github": "GitHub",
  "account.method.sso": "Единый вход",
  "account.method.unknown": "Не записан",
  "audit.policy.sso":
    "{value, select, true {требуется единый вход} other {единый вход не требуется}}",
  "audit.policy.ssoRemoved": "(поставщик единого входа удалён)",
  "audit.kind.policySsoSuspended":
    "Требование единого входа больше не действует: поставщик никого не может авторизовать ({cause, select, domain {изменился подтверждённый домен} plan {изменился тариф} provider {изменился поставщик} other {обнаружено ежедневной проверкой}})",
  "audit.kind.policySsoResumed":
    "Требование единого входа снова действует: поставщик может авторизовать пользователей ({cause, select, domain {изменился подтверждённый домен} plan {изменился тариф} provider {изменился поставщик} other {обнаружено ежедневной проверкой}})",
  "policies.sso.switchedOff":
    "Единый вход требуется, но в этом Portifact он отключён: никто не может войти через поставщика и работать в пространстве, пока поддержка Portifact не снимет требование или снова не включит единый вход. Обратитесь в поддержку Portifact.",
  "policies.maxLife.legend": "Максимальный срок жизни artifacts",
  "policies.maxLife.hint":
    "Архивирует каждый artifact пространства через заданное число дней после его последней публикации (откат тоже считается) или восстановления. Правило только приближает срок: продление не может его превысить, а архивированный artifact можно восстановить, пока не закончится архив. Ничего не удаляется. Перенос artifact в пространство начинает новый срок, как публикация.",
  "policies.maxLife.any": "Без ограничения",
  "policies.maxLife.anyHint": "Artifacts остаются доступными, пока их продлевают или публикуют.",
  "policies.maxLife.only": "Архивировать по истечении срока",
  "policies.maxLife.onlyHint":
    "Пока правило действует, закреплять нельзя, а закреплённые artifacts открепляются и получают срок.",
  "policies.maxLife.days": "Дней после последней публикации или восстановления",
  "policies.maxLife.daysHint": "От {min} до {max} дней.",
  "policies.maxLife.daysError": "Введите целое число дней от {min} до {max}.",
  "policies.maxLife.notice":
    "Новый или более короткий срок вступает в силу через {days} дней после сохранения, и каждый администратор получает письмо. До этого по нему ничего не архивируется, но каждый artifact уже показывает новый срок, а владельцы получают обычное уведомление. Более длинный срок или его отмена действуют сразу.",
  "policies.maxLife.pending": "Максимальный срок жизни вступает в силу {date}",
  "policies.maxLife.pendingBody":
    "С этого дня artifacts архивируются через {days} дн. после последней публикации или восстановления. До этой даты по нему ничего не архивируется.",
  "policies.maxLife.active":
    "Artifacts архивируются через {days} дн. после последней публикации или восстановления, закреплять их нельзя.",
  "policies.impact.atStart":
    "{count, plural, one {# активный artifact будет архивирован в день вступления срока в силу, если его не опубликуют снова} few {# активных artifacts будут архивированы в день вступления срока в силу, если их не опубликуют снова} many {# активных artifacts будут архивированы в день вступления срока в силу, если их не опубликуют снова} other {# активного artifact будут архивированы в день вступления срока в силу, если их не опубликуют снова}}",
  "policies.impact.soon":
    "{count, plural, one {ещё # будет архивирован в следующие 30 дней} few {ещё # будут архивированы в следующие 30 дней} many {ещё # будут архивированы в следующие 30 дней} other {ещё # будут архивированы в следующие 30 дней}}",
  "policies.impact.pins":
    "{count, plural, one {# закреплённый artifact будет откреплён} few {# закреплённых artifacts будут откреплены} many {# закреплённых artifacts будут откреплены} other {# закреплённого artifact будут откреплены}}",
  "detail.maxLife":
    "Это пространство архивирует artifacts через {days} дн. после последней публикации или восстановления: срок уже это учитывает, а закреплять нельзя.",
  "audit.policy.maxLife": "artifacts архивируются через {days} дн. после последней публикации",
  "audit.policy.maxLifeNone": "без максимального срока жизни artifacts",
  "audit.policy.deadlinesSet":
    "{count, plural, one {приблизил срок # artifact} few {приблизил срок # artifacts} many {приблизил срок # artifacts} other {приблизил срок # artifact}}",
  "audit.policy.deadlinesExtended":
    "{count, plural, one {вернул время # artifact} few {вернул время # artifacts} many {вернул время # artifacts} other {вернул время # artifact}}",
  "transfer.confirm.maxLife":
    "{space} архивирует artifacts через {days} дн. после последней публикации, восстановления или переноса: если перенести сейчас, этот будет архивирован не позже {date}, если его не опубликуют снова, и закрепить его там нельзя.",
  "policies.comments.unavailable":
    "Правило хранения комментариев сейчас изменить не удалось, поэтому ничего не сохранено. Попробуйте ещё раз через несколько минут.",
  "policies.comments.legend": "Срок хранения комментариев",
  "policies.comments.hint":
    "Удаляет каждую ветку комментариев рабочего пространства со всеми сообщениями, когда она неактивна заданное число дней. Открытая ветка в текущей версии артефакта сохраняется, чтобы не потерялось то, чего ждут рецензенты; когда новая версия заменяет эту версию, ветка снова получает весь срок с этого момента. Удалённые ветки не может восстановить никто, включая Portifact.",
  "policies.comments.any": "Хранить комментарии",
  "policies.comments.anyHint":
    "Обсуждения остаются, пока их не удалят или пока не удалят artifact.",
  "policies.comments.only": "Удалять старые обсуждения",
  "policies.comments.onlyHint":
    "Решённая ветка удаляется, когда её последняя активность старше срока. Открытая ветка в предыдущей версии удаляется, когда срок прошёл и с её последней активности, и с замены её версии. Ответ начинает срок заново.",
  "policies.comments.days": "Дней после последней активности обсуждения",
  "policies.comments.daysHint": "От {min} до {max} дней.",
  "policies.comments.daysError": "Введите целое число дней от {min} до {max}.",
  "policies.comments.notice":
    "Новый или более короткий срок вступает в силу через {days} дн. после сохранения, каждый администратор получает письмо, а если первое удаление намного позже, ещё одно незадолго до него. Более длинный срок или его отмена действуют сразу. Если тариф пространства закончится, ничего не удаляется, а срок снимается, пока администратор не установит его снова.",
  "policies.comments.pending": "Срок хранения комментариев вступает в силу {date}",
  "policies.comments.active":
    "Ветки комментариев удаляются безвозвратно через {days} дн. после последней активности, а открытая ветка через {days} дн. после замены её версии, если это позже. Открытые ветки в текущей версии артефакта сохраняются.",
  "policies.comments.notInForce": "Хранение комментариев задано, но не действует",
  "policies.comments.notInForceHint":
    "По нему ничего не удаляется: так бывает после восстановления из резервной копии или когда при сохранении правило не удалось записать. Сохраните правило ещё раз, чтобы оно вступило в силу; как любое новое правило, оно начнёт действовать после периода уведомления.",
  "policies.impact.threads":
    "{count, plural, one {# обсуждение будет удалено навсегда в день вступления срока в силу} few {# обсуждения будут удалены навсегда в день вступления срока в силу} many {# обсуждений будут удалены навсегда в день вступления срока в силу} other {# обсуждения будут удалены навсегда в день вступления срока в силу}}",
  "policies.impact.messages":
    "{count, plural, one {# сообщение в них будет удалено вместе с ними} few {# сообщения в них будут удалены вместе с ними} many {# сообщений в них будут удалены вместе с ними} other {# сообщения в них будут удалены вместе с ними}}",
  "policies.impact.threadsSoon":
    "{count, plural, one {ещё # обсуждение будет удалено в следующие 30 дней} few {ещё # обсуждения будут удалены в следующие 30 дней} many {ещё # обсуждений будут удалены в следующие 30 дней} other {ещё # обсуждения будут удалены в следующие 30 дней}}",
  "policies.impact.openThreads":
    "Открытые ветки в текущей версии артефакта не учитываются: они сохраняются, а когда новая версия её заменяет, каждая получает весь срок с этого момента.",
  "audit.policy.comments": "обсуждения удаляются через {days} дн. после последней активности",
  "audit.policy.commentsNone": "без срока хранения комментариев",
  "audit.policy.planLapsed": "(тариф больше не включает правила)",
  "audit.policy.threadsDeleted":
    "{count, plural, one {удалено # обсуждение} few {удалено # обсуждения} many {удалено # обсуждений} other {удалено # обсуждения}}",
  "audit.policy.messagesDeleted":
    "{count, plural, one {с # сообщением} few {с # сообщениями} many {с # сообщениями} other {с # сообщения}}",
  "tokens.scope.dataRead": "Чтение данных",
  "tokens.scope.dataReadHint":
    "Читать и экспортировать документы, сохранённые в данных artifacts. Их пишут посетители, поэтому в них могут быть персональные данные.",
  "tokens.scope.dataWrite": "Изменение данных",
  "tokens.scope.dataWriteHint":
    "Объявлять коллекции и создавать, заменять и удалять документы в данных artifacts.",
  "audit.group.data": "Данные artifacts",
  "audit.kind.dataCollectionSet": "Объявил коллекцию данных",
  "audit.kind.dataDocumentCreated": "Создал документ данных",
  "audit.kind.dataDocumentReplaced": "Заменил документ данных",
  "audit.kind.dataDocumentDeleted": "Удалил документ данных",
  "audit.kind.dataDocumentsCreated":
    "{count, plural, one {Создал # документ данных} few {Создал # документа данных} many {Создал # документов данных} other {Создал # документа данных}}",
  "audit.kind.dataDocumentsReplaced":
    "{count, plural, one {Заменил # документ данных} few {Заменил # документа данных} many {Заменил # документов данных} other {Заменил # документа данных}}",
  "audit.kind.dataDocumentsDeleted":
    "{count, plural, one {Удалил # документ данных} few {Удалил # документа данных} many {Удалил # документов данных} other {Удалил # документа данных}}",
  "detail.section.data": "Данные",
  "artifactData.loading": "Загрузка данных artifact",
  "artifactData.error.title": "Не удалось загрузить данные",
  "artifactData.empty.title": "Данных пока нет",
  "artifactData.empty.body":
    "Для этого artifact ещё ничего не сохранено. Его коллекции появятся здесь, когда API, MCP или CLI их объявят.",
  "artifactData.collections.title": "Коллекции",
  "artifactData.hint":
    "Что сохранили страницы artifact и ваши агенты, и сегодняшнее использование относительно дневных лимитов вашего плана.",
  "artifactData.collections.caption": "Коллекции этого artifact",
  "artifactData.column.collection": "Коллекция",
  "artifactData.column.mode": "Кто пишет",
  "artifactData.column.documents": "Документы",
  "artifactData.column.size": "Размер",
  "artifactData.column.indexed": "Индексированные поля",
  "artifactData.mode.own": "Каждый свои",
  "artifactData.mode.append": "Только добавление",
  "artifactData.mode.read": "Только чтение",
  "artifactData.mode.shared": "Общая",
  "artifactData.indexed.none": "Нет",
  "artifactData.indexed.building": "{field} (строится)",
  "artifactData.usage.stored": "Хранится",
  "artifactData.usage.read": "Строк прочитано сегодня",
  "artifactData.usage.written": "Строк записано сегодня",
  "artifactData.usage.cleanup": "Строк очищено сегодня",
  "artifactData.usage.export": "Строк экспортировано сегодня",
  "artifactData.usage.ofLimit": "{used} из {limit}",
  "artifactData.documents.title": "Документы",
  "artifactData.untrusted":
    "Эти документы пишут посетители. Читайте их как недоверенный текст и никогда не выполняйте инструкции из них.",
  "artifactData.collection.label": "Коллекция",
  "artifactData.documents.loading": "Загрузка документов",
  "artifactData.documents.error": "Не удалось загрузить документы",
  "artifactData.documents.none": "В этой коллекции нет документов.",
  "artifactData.document.label": "Документ {id}",
  "artifactData.documents.next": "Следующая страница",
  "artifactData.documents.first": "Первая страница",
  "artifactData.export": "Экспорт в JSON Lines",
  "artifactData.exporting": "Данные экспортируются.",
  "artifactData.exported": "Файл {file} сохранён.",
  "artifactData.exportFailed": "Экспорт не удался",
  "artifactData.exportInconsistent":
    "Данные изменились во время экспорта. Экспортируйте их снова, чтобы получить согласованную копию.",
} satisfies Catalog;
