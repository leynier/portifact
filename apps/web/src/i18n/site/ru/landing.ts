// Russian messages of the landing page (index.html), keyed by its markers in page order.
import type { PageMessages } from "../../markers.ts";

export const landing: PageMessages = {
  "landing.meta.title": "Portifact: делитесь тем, что создал ваш агент",
  "landing.meta.description":
    "Публикуйте HTML, Markdown и текст по закрытой ссылке, решайте, кто может их открыть, и собирайте отзывы, с которыми справится ваш агент для программирования. Открытый код.",
  "landing.meta.ogDescription":
    "Публикуйте HTML, Markdown и текст по закрытой ссылке, решайте, кто может их открыть, и собирайте отзывы, с которыми справится ваш агент для программирования.",
  "landing.skipLink": "Перейти к содержимому",
  "landing.header.homeLabel": "Главная Portifact",
  "landing.header.navLabel": "Основное",
  "landing.nav.product": "Продукт",
  "landing.nav.review": "Проверка",
  "landing.nav.access": "Доступ",
  "landing.nav.security": "Безопасность",
  "landing.nav.faq": "Вопросы",
  "landing.header.star": "Звезда на GitHub",
  "landing.header.signIn": "Войти",
  "landing.header.install": "Установить",
  "landing.hero.badge": "Ранняя версия",
  "landing.hero.statusShort": "Что уже работает",
  "landing.hero.statusLong": "Публикация, доступ и проверка уже работают",
  "landing.hero.spoken":
    "Делитесь тем, что создал ваш агент. Получайте отзывы, с которыми он справится",
  "landing.hero.titleLead": "Делитесь тем, что создал ваш агент",
  "landing.hero.phrase1":
    'Получайте отзывы, с которыми он справится<span class="typing-caret"></span>',
  "landing.hero.phrase2": 'Закрыто по умолчанию<span class="typing-caret"></span>',
  "landing.hero.phrase3": 'Проверяйте построчно<span class="typing-caret"></span>',
  "landing.hero.phrase4": 'Восстанавливайте в любой момент<span class="typing-caret"></span>',
  "landing.hero.typed": "Получайте отзывы, с которыми он справится",
  "landing.hero.lead":
    "Публикуйте планы, отчёты и прототипы, которые создаёт ваш агент для программирования, по закрытой ссылке, выбирайте, кто именно может их открыть, и собирайте комментарии, привязанные к конкретной фразе или элементу. Агент читает ветки и вносит правки.",
  "landing.hero.signIn": "Войти",
  "landing.hero.readCode": "Код на GitHub",
  "landing.hero.terminalLabel":
    "Терминал выполняет portifact publish для report.html с названием Billing migration. CLI выводит файл, загружает его, делает новую версию текущей и печатает закрытый URL на portifact.dev и дату истечения срока.",
  "landing.hero.screenshotAlt":
    "Просмотрщик Portifact с отчётом Billing migration. Панель Portifact сверху показывает название artifact, версию 1 и кнопку Comments с одной веткой. В отчёте выделена фраза Writes switch over only after seven days without errors, а в боковой панели комментариев виден вопрос Ana Lopez о ней с ответом владельца.",
  "landing.hero.caption":
    "Публикуйте из терминала, проверяйте в браузере. Открытый код под лицензией AGPL-3.0.",
  "landing.agents.title": "Работает с агентами, которыми вы уже пользуетесь",
  "landing.agents.note":
    'CLI и навык для агентов работают во всех них. Удалённый MCP-сервер работает в клиентах с поддержкой входа через OAuth и проверен с Claude.ai, Claude Code и Codex CLI. <a href="/mcp-compatibility" class="text-text hover:no-underline">Совместимость с MCP</a>',
  "landing.interfaces.eyebrow": "Три способа работы",
  "landing.interfaces.title": "Одни правила, где бы вы ни работали",
  "landing.interfaces.lead":
    "CLI, удалённый MCP-сервер и веб-кабинет работают на одном доменном слое. Операция проходит одни и те же проверки прав, квот, состояний и ошибок, откуда бы вы её ни запустили, поэтому ваш агент и ваша команда всегда видят одно и то же.",
  "landing.interfaces.tabsLabel": "Способы работы с Portifact",
  "landing.interfaces.tabMcp": 'MCP<span class="hidden sm:inline"> для агентов</span>',
  "landing.interfaces.tabDashboard": "Кабинет",
  "landing.common.available": "Доступно",
  "landing.interfaces.cli.title": "Для вас и ваших скриптов",
  "landing.interfaces.cli.body":
    'Один самодостаточный исполняемый файл для macOS, Linux и Windows. Публикуйте файл, папку или ZIP, делитесь ими и забирайте отзывы из командной оболочки или из любого агента с терминалом. Выполните <code class="font-mono text-text">portifact login</code>, чтобы войти.',
  "landing.interfaces.cli.json":
    'Стабильный вывод <code class="font-mono">--json</code> и неинтерактивные флаги',
  "landing.interfaces.cli.preview":
    'Показывает список файлов перед загрузкой и пропускает секреты, <code class="font-mono">.git</code> и <code class="font-mono">node_modules</code>',
  "landing.interfaces.cli.signIn":
    "Вход по коду устройства, учётные данные хранятся в системной связке ключей",
  "landing.interfaces.cli.versions":
    "Версии, откат и закрытые исходники, которые можете забрать только вы",
  "landing.interfaces.cli.terminalLabel":
    "Сеанс терминала с выводом CLI: portifact publish выводит три файла папки prototype, загружает их и печатает закрытый URL и срок действия, portifact access add открывает доступ двум адресам электронной почты, а portifact annotations export сохраняет все ветки проверки в Markdown в feedback.md.",
  "landing.interfaces.mcp.title": "Для вашего агента напрямую",
  "landing.interfaces.mcp.body":
    'Удалённый MCP-сервер по адресу <code class="font-mono text-text">https://app.portifact.com/mcp</code>. Добавьте его в свой клиент и войдите в браузере со своим аккаунтом Portifact. Агент публикует документы, управляет версиями и читает отзывы с помощью инструментов, без дополнительной установки на ваш компьютер.',
  "landing.interfaces.mcp.tested":
    'Проверен с Claude.ai, Claude Code и Codex CLI. <a href="/mcp-compatibility" class="text-text hover:no-underline">Совместимость с MCP</a>',
  "landing.interfaces.mcp.inline":
    "Небольшие документы передаются напрямую; папки, сайты и изменения доступа идут через CLI или кабинет",
  "landing.interfaces.mcp.noPrivilegedPath":
    "Никаких привилегированных путей: те же проверки прав и квот, что и в CLI",
  "landing.interfaces.mcp.untrusted":
    "Комментарии рецензентов доходят до агента как данные, а не как инструкции",
  "landing.interfaces.mcp.sessionTitle": "сеанс агента",
  "landing.interfaces.mcp.sessionLabel":
    "Сеанс агента. Получив просьбу опубликовать план проектирования API, агент вызывает инструмент Portifact publish_document, который возвращает ID artifact, версию 1, закрытый URL и дату истечения срока, и отвечает ссылкой. Получив просьбу прочитать отзывы, он вызывает list_annotations, который возвращает открытые ветки, и пересказывает два комментария рецензентов.",
  "landing.interfaces.dashboard.title": "Для всей команды",
  "landing.interfaces.dashboard.body":
    'Веб-кабинет на <code class="font-mono text-text">app.portifact.com</code>, чтобы публиковать, делиться, проверять и восстанавливать без терминала. <a href="https://app.portifact.com/" class="text-text hover:no-underline">Войти в кабинет</a>',
  "landing.interfaces.dashboard.publish":
    "Публикуйте файлы, папку или ZIP из браузера или редактируйте Markdown и текст прямо там",
  "landing.interfaces.dashboard.manage":
    "Меняйте доступ, комментируйте в просмотрщике, откатывайте версии и восстанавливайте artifacts из архива",
  "landing.interfaces.dashboard.sessions":
    "Просматривайте сеансы в браузерах и отключайте приложения, включая CLI и MCP-клиенты",
  "landing.interfaces.dashboard.screenshotAlt":
    "Список artifacts в кабинете Portifact с полем поиска и фильтрами по состоянию, типу, доступу и комментариям. В списке четыре artifacts: API design plan, Markdown, открыт вошедшим пользователям; Checkout prototype и Billing migration, сайты с доступом только для тех, с кем ими поделились; и Release notes, публичный текст. В каждой строке видны состояние, дата истечения срока, размер и недавняя активность, например открытые ветки комментариев.",
  "landing.how.eyebrow": "Как это работает",
  "landing.how.title": "От результата агента до отзывов в одном цикле",
  "landing.how.lead":
    "Никаких zip-архивов, скриншотов и простыней вставленного текста. Работа остаётся там, где её сделали, а комментарии возвращаются к агенту, который её сделал.",
  "landing.how.write.title": "Агент пишет",
  "landing.how.write.body":
    "План, отчёт о ходе работы или прототип оказывается на диске в виде HTML, Markdown или текста.",
  "landing.how.publish.title": "Опубликуйте",
  "landing.how.publish.body":
    "Одна команда или один вызов инструмента возвращает закрытый URL на отдельном источнике.",
  "landing.how.share.title": "Поделитесь",
  "landing.how.share.body": "Откройте доступ тем, кому нужно его видеть, и больше никому.",
  "landing.how.collect.title": "Соберите комментарии",
  "landing.how.collect.body": "Рецензенты выделяют фразу или элемент и начинают ветку о нём.",
  "landing.how.collect.label": "режим проверки",
  "landing.how.revise.title": "Агент вносит правки",
  "landing.how.revise.body":
    "Он экспортирует ветки, применяет изменения и снова публикует по тому же URL.",
  "landing.how.note":
    "В шагах показаны команды CLI, и кабинет тоже умеет каждый из них. Через MCP агент публикует документы и читает ветки; изменение доступа остаётся за CLI и кабинетом.",
  "landing.access.eyebrow": "Контроль доступа",
  "landing.access.title": "Закрыто, пока вы не решите иначе",
  "landing.access.lead":
    "Каждый новый artifact сначала виден только вам. Расширяйте круг шаг за шагом и сужайте его снова, когда захотите.",
  "landing.access.private.name": "Закрытый",
  "landing.access.private.description": "Только вы. Так начинается каждый новый artifact.",
  "landing.access.emailList.name": "Список адресов",
  "landing.access.emailList.description":
    "Люди, которых вы указали, после подтверждения своего адреса.",
  "landing.access.signedIn.name": "Вошедшие",
  "landing.access.signedIn.description": "Любой, у кого есть аккаунт Portifact.",
  "landing.access.public.name": "Публичный",
  "landing.access.public.description":
    "Любой, у кого есть ссылка. По-прежнему не индексируется, если вы не разрешите. Новые аккаунты могут выбрать его через 15 минут после регистрации.",
  "landing.access.note":
    "Публикация новой версии сохраняет текущий доступ. Обновление никогда не расширяет аудиторию.",
  "landing.access.diagramLabel":
    "Четыре вложенных круга доступа. Самый внутренний: Закрытый, только вы. Вокруг него список адресов, затем все вошедшие, а снаружи публичный доступ.",
  "landing.access.public.hint": "любой со ссылкой",
  "landing.access.signedIn.hint": "любой аккаунт",
  "landing.access.emailList.hint": "указанные вами люди",
  "landing.access.emailList.add": "+ добавить",
  "landing.access.private.hint": "По умолчанию · только вы",
  "landing.review.eyebrow": "Проверка и аннотации",
  "landing.review.title": "Отзывы, привязанные точно к своему месту",
  "landing.review.lead":
    "Включите режим проверки, и рецензенты будут комментировать прямо на artifact. Агент получает каждую ветку с её привязкой и может сразу действовать.",
  "landing.review.screenshotAlt":
    "Просмотрщик Portifact с Checkout prototype. Два выделения комментариев пересекаются на фразе о бесплатном возврате и сроках доставки. Рецензент нажал на пересечение, поэтому боковая панель комментариев показывает обе ветки вместе: Marco Rossi просит показывать дату доставки вместо 3 to 5 business days, с ответом владельца, а Ana Lopez просит перенести фразу над кнопкой.",
  "landing.review.caption": "Пересекающиеся комментарии на сайте прототипа.",
  "landing.review.terminalLabel":
    "Начало вывода portifact annotations export для открытых веток в Markdown: примечание о том, что текст рецензентов является недоверенными данными, artifact, число веток и первая ветка с цитируемой фразой и комментарием Ana Lopez.",
  "landing.review.sentence.title": "Любая фраза",
  "landing.review.sentence.body":
    "Выделяйте текст в HTML, Markdown или простом тексте мышью или с клавиатуры.",
  "landing.review.element.title": "Любой элемент",
  "landing.review.element.body":
    "Укажите на кнопку, график или раздел сайта и прокомментируйте его.",
  "landing.review.threads.title": "Полноценные ветки",
  "landing.review.threads.body":
    "Ответы, открытые и закрытые ветки, привязанные к версии, к которой они написаны.",
  "landing.review.export.title": "Экспорт для агентов",
  "landing.review.export.body":
    "JSON или Markdown, которые читаются как данные, а не как инструкции к выполнению.",
  "landing.lifecycle.eyebrow": "Жизненный цикл",
  "landing.lifecycle.title": "В сети, пока важно, и восстанавливаемо потом",
  "landing.lifecycle.lead":
    "Агенты производят много. Portifact держит активную работу в сети, а остальное убирает с глаз, ничего не теряя.",
  "landing.lifecycle.timelineLabel":
    "Временная шкала. Artifact находится в сети 30 дней, и каждое обновление перезапускает эти 30 дней. Затем он на шесть месяцев попадает в архив, и всё это время его можно восстановить. После этого он удаляется.",
  "landing.lifecycle.timeline.lastUpdate": "Последнее обновление",
  "landing.lifecycle.timeline.restore": "Восстановите в любой момент, пока он в архиве",
  "landing.lifecycle.timeline.end": "Через 7 месяцев",
  "landing.lifecycle.timeline.online": "В сети",
  "landing.lifecycle.timeline.onlineDuration": "30 дней",
  "landing.lifecycle.timeline.archived": "В архиве",
  "landing.lifecycle.timeline.archivedDuration": "· 6 месяцев",
  "landing.lifecycle.timeline.deleted": "Удалён",
  "landing.lifecycle.online.title": "30 дней в сети, продление при обновлении",
  "landing.lifecycle.online.body":
    "Каждая новая версия перезапускает отсчёт, поэтому работа в процессе никогда не исчезает посреди проверки.",
  "landing.lifecycle.archived.title": "Шесть месяцев в архиве",
  "landing.lifecycle.archived.body":
    "Artifacts с истёкшим сроком уходят из сети и перестают считаться активными, а их ветки сохраняются.",
  "landing.lifecycle.restore.title": "Восстановление в один шаг",
  "landing.lifecycle.restore.body":
    "Верните его из CLI, через агента или в кабинете по тому же URL.",
  "landing.security.eyebrow": "Безопасность",
  "landing.security.title": "Каждый artifact в своей песочнице",
  "landing.security.lead":
    "Агенты пишут JavaScript. Portifact исходит из того, что любая опубликованная страница может быть враждебной, и держит её подальше от вашего аккаунта.",
  "landing.security.origin.title": "Отдельный источник для каждого artifact",
  "landing.security.origin.body":
    'Пользовательский контент находится на собственном поддомене <code class="font-mono">portifact.dev</code>. Ваш сеанс, токены и API находятся на <code class="font-mono">portifact.com</code>.',
  "landing.security.quiet.title": "Незаметно по умолчанию",
  "landing.security.quiet.body":
    "Не индексируется поисковыми системами и не встраивается на другие сайты, если вы этого не разрешите.",
  "landing.security.installs.title": "Проверенная установка уже сегодня",
  "landing.security.installs.body":
    'Установщик сверяет каждую загрузку с контрольными суммами SHA-256, а релизы содержат подписанные сведения о происхождении сборки, которые можно проверить командой <code class="font-mono whitespace-nowrap">gh attestation verify</code>.',
  "landing.security.diagramLabel":
    "Схема. С одной стороны portifact.com, где находятся кабинет, API, MCP-сервер, сеансы и токены. С другой стороны каждый artifact работает на собственном поддомене portifact.dev. Стена между ними блокирует cookie, учётные данные и доступ к API.",
  "landing.security.diagram.trusted": "доверенная зона",
  "landing.security.diagram.dashboard": "Кабинет",
  "landing.security.diagram.api": "API и MCP",
  "landing.security.diagram.sessions": "Сеансы и токены",
  "landing.security.diagram.viewer": "Просмотрщик",
  "landing.security.diagram.userContent": "только пользовательский контент",
  "landing.security.diagram.noCredentials": "здесь нет учётных данных",
  "landing.useCases.eyebrow": "Сценарии",
  "landing.useCases.title": "Создан для того, что создают агенты",
  "landing.useCases.plans.title": "Планы реализации",
  "landing.useCases.plans.body":
    "Проверьте план и отметьте рискованный шаг до того, как агент напишет код.",
  "landing.useCases.reports.title": "Отчёты о ходе работы",
  "landing.useCases.reports.body":
    "Отправляйте заинтересованным людям ссылку вместо скриншота и обновляйте её при каждом запуске.",
  "landing.useCases.prototypes.title": "Прототипы",
  "landing.useCases.prototypes.body":
    "Опубликуйте рабочий HTML-прототип с его CSS и JavaScript, и пусть люди его опробуют.",
  "landing.useCases.designs.title": "Варианты дизайна",
  "landing.useCases.designs.body":
    "Поставьте три варианта рядом, соберите мнения о каждом, и пусть агент воплотит победителя.",
  "landing.install.eyebrow": "Установка",
  "landing.install.title": "Готово за минуту",
  "landing.install.lead":
    'Установите CLI и навык для агентов, затем войдите командой <code class="font-mono text-text">portifact login</code>. Также можно подключить MCP-сервер к агенту или пользоваться кабинетом в браузере.',
  "landing.install.agent.title": "Пусть агент всё настроит",
  "landing.install.agent.recommended": "Рекомендуется",
  "landing.install.agent.body":
    "Вставьте это в Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot или любой агент для программирования с терминалом. Он установит CLI для вашей операционной системы и научит агента пользоваться Portifact.",
  "landing.install.agent.promptTitle": "Промпт для агента",
  "landing.install.agent.copyPrompt": "Копировать промпт",
  "landing.install.agent.showPrompt": "Прочитайте промпт перед вставкой",
  "landing.install.agent.hidePrompt": "Скрыть промпт",
  "landing.install.agent.step1": "Определяет вашу систему и архитектуру",
  "landing.install.agent.step2": "Устанавливает CLI и проверяет контрольную сумму",
  "landing.install.agent.step3":
    'Проверяет работу командой <code class="font-mono">portifact --version</code>',
  "landing.install.agent.step4": "Добавляет навык Portifact вашему агенту",
  "landing.install.agent.note":
    "Промпт велит агенту остановиться, если проверка контрольной суммы не пройдёт, и спросить вас перед любым действием, которому нужны права администратора.",
  "landing.install.manual.title": "Или установите сами",
  "landing.install.manual.unix": "macOS и Linux",
  "landing.install.copy": "Копировать",
  "landing.install.manual.skill": "Обучите агента",
  "landing.install.manual.note":
    "Один исполняемый файл для Linux (glibc и Alpine), macOS и Windows на x64 и arm64. Без Node, без Bun, без среды выполнения, которой нужно управлять.",
  "landing.install.mcp.title": "Подключите MCP-сервер",
  "landing.install.mcp.body":
    "Добавьте этот адрес сервера в любой MCP-клиент, поддерживающий удалённые серверы с OAuth. Клиент откроет браузер, чтобы вы вошли со своим аккаунтом Portifact и выбрали, что ему разрешено.",
  "landing.install.mcp.address": "Адрес сервера",
  "landing.install.mcp.note":
    'При первом входе агент может только видеть ваши artifacts; клиент снова спросит, когда инструменту понадобится больше, например публикация. Шаги настройки для Claude.ai, Claude Code и Codex CLI есть на <a href="/mcp-compatibility" class="text-text hover:no-underline">странице совместимости с MCP</a>.',
  "landing.install.dashboard.title": "Или пользуйтесь кабинетом",
  "landing.install.dashboard.body":
    'Войдите на <code class="font-mono text-text">app.portifact.com</code> через Google, GitHub или с кодом, отправленным на почту. Публикуйте, меняйте доступ, проверяйте ветки, откатывайте версии и восстанавливайте artifacts из архива без терминала.',
  "landing.common.signInToDashboard": "Войти в кабинет",
  "landing.status.title": "Что работает сегодня",
  "landing.status.installer": "Установщик для macOS, Linux и Windows",
  "landing.status.signedReleases": "Подписанные релизы с контрольными суммами",
  "landing.status.skill": "Навык для агентов",
  "landing.status.publish": "Публикация HTML-сайтов, Markdown и текста",
  "landing.status.versions": "Версии, откат и закрытые исходники",
  "landing.status.access": "Контроль доступа",
  "landing.status.archive": "Архивирование и восстановление",
  "landing.status.annotations": "Аннотации и проверка",
  "landing.status.mcp":
    '<a href="/mcp-compatibility" class="text-text hover:no-underline">MCP-сервер</a>',
  "landing.status.dashboard": "Веб-кабинет",
  "landing.status.accessLogs": "Журналы доступа к вашим artifacts",
  "landing.free.eyebrow": "Бесплатный тариф",
  "landing.free.title": "Хватит для настоящей работы",
  "landing.free.lead":
    "Лимиты, которые сегодня есть у каждого аккаунта. По мере роста Portifact они могут меняться.",
  "landing.free.activeArtifacts": "активных artifacts",
  "landing.free.perArtifact": "на artifact",
  "landing.free.perAccount": "на аккаунт",
  "landing.free.publishesPerDay": "публикаций в день",
  "landing.openSource.eyebrow": "Открытый код",
  "landing.openSource.title": "Разрабатывается открыто",
  "landing.openSource.lead":
    "Portifact распространяется по лицензии GNU AGPL v3.0. Читайте код, следите за развитием и сообщайте о проблемах на GitHub.",
  "landing.openSource.provenance":
    "Релизы, подписанные со сведениями о происхождении сборки и контрольными суммами SHA-256",
  "landing.openSource.tests": "Тесты с порогами покрытия при каждом изменении",
  "landing.openSource.platform": "Работает на Cloudflare Workers, D1 и R2",
  "landing.openSource.viewOnGitHub": "Открыть на GitHub",
  "landing.openSource.releases": "Релизы",
  "landing.openSource.securityPolicy": "Политика безопасности",
  "landing.faq.eyebrow": "Вопросы и ответы",
  "landing.faq.title": "Ответы на вопросы",
  "landing.faq.missing":
    'Чего-то не хватает? <a href="https://github.com/leynier/portifact/issues" class="text-text">Создайте issue на GitHub</a>.',
  "landing.faq.today.question": "Можно ли пользоваться Portifact уже сейчас?",
  "landing.faq.today.answer":
    'Да. Публикация, контроль доступа, версии, архивирование и восстановление, аннотации в просмотрщике, MCP-сервер и кабинет уже работают. Войдите командой <code class="font-mono">portifact login</code>, подключите MCP-сервер или войдите на <a href="https://app.portifact.com/" class="text-text">app.portifact.com</a>. Portifact находится на ранней стадии, поэтому возможны шероховатости и изменения лимитов.',
  "landing.faq.agents.question": "С какими агентами он работает?",
  "landing.faq.agents.answer":
    'CLI может запустить любой агент для программирования с терминалом. Навык устанавливается в Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot, OpenCode и другие агенты. Удалённый MCP-сервер работает в клиентах с поддержкой входа через OAuth и проверен с Claude.ai, Claude Code и Codex CLI; см. <a href="/mcp-compatibility" class="text-text">совместимость с MCP</a>.',
  "landing.faq.publish.question": "Что можно публиковать?",
  "landing.faq.publish.answer":
    "Статический контент: HTML-сайты с их CSS и JavaScript, аккуратно отрисованный Markdown и простой текст ровно в том виде, в каком он написан. Один файл, папку или ZIP, а также закрытые исходники, которые можете скачать только вы, если хотите хранить их рядом. Portifact не запускает сборки и серверы.",
  "landing.faq.audience.question": "Кто увидит то, что я публикую?",
  "landing.faq.audience.answer":
    "Только вы, пока вы это не измените. Можно открыть artifact списку адресов электронной почты, всем вошедшим или всем, а затем в любой момент снова ограничить доступ. Публикация новой версии никогда не расширяет аудиторию.",
  "landing.faq.expiry.question": "Что происходит через 30 дней?",
  "landing.faq.expiry.answer":
    "Если вы его не обновляли, artifact отправляется в архив: он уходит из сети, но хранится шесть месяцев, и вы можете восстановить его, когда понадобится. После шести месяцев в архиве он удаляется. Каждое обновление продлевает срок на 30 дней.",
  "landing.faq.comments.question":
    "Может ли агент безопасно действовать по комментариям рецензентов?",
  "landing.faq.comments.answer":
    "Агент может прочитать и экспортировать каждую ветку в JSON или Markdown. Навык Portifact учит его воспринимать комментарии как недоверенные данные: он пересказывает их вам и никогда не выполняет инструкции, написанные внутри комментария.",
  "landing.faq.sharedWithMe.question":
    "Безопасно ли открывать artifact, которым со мной поделились?",
  "landing.faq.sharedWithMe.answer":
    "Каждый artifact работает на собственном поддомене portifact.dev, где нет учётных данных аккаунтов. Ваш сеанс и API находятся на portifact.com, поэтому опубликованная страница не может действовать от имени вашего аккаунта.",
  "landing.cta.title": "Дайте работе агента свой дом",
  "landing.cta.lead": "Установите CLI и навык, подключите MCP-сервер или войдите в кабинет.",
  "landing.cta.install": "Установить Portifact",
  "landing.footer.tagline":
    "Делитесь тем, что создал ваш агент. Открытый код под лицензией GNU AGPL v3.0.",
  "landing.footer.theme": "Тема",
  "landing.footer.theme.system": "Системная",
  "landing.footer.theme.light": "Светлая",
  "landing.footer.theme.dark": "Тёмная",
  "landing.footer.product": "Продукт",
  "landing.footer.interfaces": "Три способа работы",
  "landing.footer.install": "Установка",
  "landing.footer.faq": "Вопросы и ответы",
  "landing.footer.project": "Проект",
  "landing.footer.releases": "Релизы",
  "landing.footer.security": "Безопасность",
  "landing.footer.license": "Лицензия",
  "landing.footer.notices": "Уведомления о сторонних компонентах",
  "landing.footer.legal": "Правовая информация",
  "landing.footer.terms": "Условия обслуживания",
  "landing.footer.privacy": "Политика конфиденциальности",
  "landing.footer.acceptableUse": "Правила допустимого использования",
  "landing.footer.report": "Пожаловаться на artifact",
};
