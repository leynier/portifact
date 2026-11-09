// Russian messages of the MCP compatibility page and the chrome of the legal pages, keyed by
// their markers. The legal texts themselves stay in English.
import type { PageMessages } from "../../markers.ts";

export const documents: PageMessages = {
  // Chrome of the legal pages (terms, privacy, acceptable-use), shared across the three.
  "legal.skip": "Перейти к содержимому",
  "legal.home": "Главная Portifact",
  "legal.footer.license": "Portifact распространяется с открытым кодом по лицензии GNU AGPL v3.0.",
  "legal.footer.nav": "Правовая информация",
  "legal.footer.terms": "Условия",
  "legal.footer.privacy": "Конфиденциальность",
  "legal.footer.acceptableUse": "Допустимое использование",
  "legal.terms.title": "Условия обслуживания: Portifact",
  "legal.terms.description":
    "Условия использования Portifact, сервиса, который публикует статические artifacts с контролем доступа и проверкой.",
  "legal.privacy.title": "Политика конфиденциальности: Portifact",
  "legal.privacy.description":
    "Какие данные хранит Portifact, зачем и как долго, кто их обрабатывает и как реализовать свои права.",
  "legal.acceptableUse.title": "Правила допустимого использования: Portifact",
  "legal.acceptableUse.description":
    "Что нельзя публиковать и делать в Portifact, как сообщить о нарушении и что происходит, когда правила нарушены.",

  // MCP compatibility page.
  "mcp.meta.title": "Совместимость с MCP: Portifact",
  "mcp.meta.description":
    "Какие MCP-клиенты работают с удалённым MCP-сервером Portifact, как они выполняют вход и чего ждать от каждого.",
  "mcp.chrome.skip": "Перейти к содержимому",
  "mcp.chrome.home": "Главная Portifact",
  "mcp.intro.title": "Совместимость с MCP",
  "mcp.intro.tested":
    'Последняя проверка: <time datetime="2026-11-08">8 ноября 2026 г.</time>, с Portifact 0.11.0. Обновление токена в Codex CLI и инструменты комментариев перепроверены в тот же день с Portifact 0.13.0.',
  "mcp.intro.server":
    "Portifact предоставляет удалённый MCP-сервер по адресу <code>https://app.portifact.com/mcp</code> (Streamable HTTP). Добавьте его в свой клиент и войдите в браузере со своим аккаунтом Portifact. При первом входе запрашивается только просмотр ваших artifacts; клиент снова запросит разрешение, когда инструменту понадобится больше, например публикация или удаление.",
  "mcp.toc.title": "На этой странице",
  "mcp.matrix.title": "Проверенные клиенты",
  "mcp.matrix.intro":
    "Каждый клиент вывел список, опубликовал, прочитал обратно и удалил документ. Все три входят через OAuth с PKCE и представляются опубликованным документом метаданных клиента.",
  "mcp.matrix.caption": "MCP-клиенты, проверенные с Portifact",
  "mcp.matrix.client": "Клиент",
  "mcp.matrix.version": "Версия",
  "mcp.matrix.protocol": "Протокол",
  "mcp.matrix.moreAccess": "Когда инструменту нужно больше доступа",
  "mcp.matrix.status": "Статус",
  "mcp.matrix.claudeAiVersion": "Веб, ноябрь 2026 г.",
  "mcp.matrix.notRecorded": "Не записано",
  "mcp.matrix.claudeAiMoreAccess": "Просит разрешить это в браузере",
  "mcp.matrix.claudeCodeMoreAccess": "Предлагает выполнить <code>/mcp</code> и войти снова",
  "mcp.matrix.codexMoreAccess": "Вызов завершается ошибкой; войдите снова с нужными разрешениями",
  "mcp.matrix.works": "Работает",
  "mcp.claudeAi.body":
    "Добавьте пользовательский коннектор с адресом сервера и войдите. Когда Claude впервые публикует, он просит разрешить и публикацию. Коннектор показывает 24 инструмента: 9 только для чтения и 15 для записи или удаления.",
  "mcp.claudeCode.body":
    "Добавьте сервер командой <code>claude mcp add --transport http portifact https://app.portifact.com/mcp</code>, затем выберите его в <code>/mcp</code> и войдите. Когда инструменту нужен доступ, которого вы ещё не дали, вызов завершается ошибкой с названием недостающего разрешения. Выполните <code>/mcp</code>, выберите Re-authenticate и разрешите доступ; Claude Code сохраняет то, что вы разрешили раньше. Неинтерактивные запуски (<code>claude -p</code>) не могут выполнить вход, поэтому сначала войдите в интерактивном сеансе.",
  "mcp.codex.body":
    "Добавьте сервер командой <code>codex mcp add portifact --url https://app.portifact.com/mcp</code>; Codex сразу начнёт вход. Codex сам не запрашивает дополнительный доступ, поэтому при входе укажите всё, что понадобится агенту, например:",
  "mcp.codex.comments":
    "Добавьте <code>annotations:read</code>, <code>annotations:write</code> или <code>annotations:moderate</code> для инструментов комментариев; со всеми тремя Codex включил комментарии, прокомментировал, ответил, закрыл ветки и экспортировал комментарии документа. Перед запуском инструментов, которые удаляют, Codex просит вашего подтверждения. Он сам продлевает доступ, когда истекает токен, действующий один час.",
  "mcp.other.title": "Другие клиенты",
  "mcp.other.body":
    'Должен работать любой клиент, поддерживающий удалённые MCP-серверы с OAuth: Portifact следует спецификации авторизации MCP от 2026-07-28, а также поддерживает динамическую регистрацию клиентов и редакции протокола 2025 года. Если ваш клиент не работает, CLI <code>portifact</code> и навык для агентов работают в любом агенте с командной оболочкой. Расскажите нам об этом на <a href="https://github.com/leynier/portifact/issues">GitHub</a>.',
  "mcp.footer.license": "Portifact распространяется с открытым кодом по лицензии GNU AGPL v3.0.",
  "mcp.footer.nav": "Правовая информация",
  "mcp.footer.terms": "Условия",
  "mcp.footer.privacy": "Конфиденциальность",
  "mcp.footer.acceptableUse": "Допустимое использование",
};
