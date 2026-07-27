# claph · Native Telegram Threads — Design Spec

**Дата:** 2026-07-18
**Статус:** дизайн одобрен, ждёт плана реализации
**Контекст:** Threaded Mode включён в BotFather (`Disallow users to create new
threads` = ON). Эмпирически проверено: `createForumTopic` на приватном `chat_id`
создаёт тред и возвращает `message_thread_id`; `sendRichMessage` с
`message_thread_id` шлёт в тред (`is_topic_message=True`); rich рендерится в тредах.

## Цель

Развести вкладки Claude Code по нативным Telegram-тредам (каждая вкладка = своя
тема в боте), не плодя дубли-темы при закрытии/переоткрытии вкладок. Плюс убрать
`ambiguous`-роутинг и обрезку длинных ответов `[…]`.

---

## 1. Вкладка → тред: идентификация по label-ключу

**Корреляция MCP↔хуки (выяснено эмпирически + гайд Claude Code):** stdio-MCP-сервер
получает только `CLAUDECODE=1`, **не** получает `session_id`. `session_id` виден
**только хукам** (в JSON payload). Единственный ключ, который надёжно видят **и**
`session-mcp`, **и** хуки — это **унаследованные env launch-шелла + `cwd`**. Поэтому
слот-пул с «детектом живости» (прошлая версия) заменён на стабильный **label-ключ**.

- **Ключ вкладки = `CLAPH_LABEL` env, иначе `basename(cwd)`.** Вычисляется
  ОДИНАКОВО в `session-mcp` (TS, уже так делает: `process.env.CLAPH_LABEL ||
  basename(process.cwd())`) и в хуках (Python: `os.environ.get('CLAPH_LABEL')`
  иначе `basename(payload.cwd)`). Общий, стабильный, переживает рестарты.
- **Маппинг `label → message_thread_id`** персистится в `threads.json`.
- **Переоткрыл вкладку с тем же label → тот же тред.** Дубли не плодятся —
  label сам стабильный ключ, «детект живости» для аллокации НЕ нужен.
- **Одна вкладка/репо** → label = имя папки авто, из коробки.
- **Worktree** → свой `cwd` → свой label авто (можно добавить `⑂ ветка` в
  отображаемое имя темы, но ключ = basename пути worktree).
- **Две вкладки одного репо:** пользователь задаёт разные `CLAPH_LABEL`
  (`работа`/`чат`) при запуске из терминала → разные треды по всем каналам. Без
  этого — делят один тред (осознанный выбор, не баг).
- **Создание треда:** `createForumTopic(chat_id, name, icon_color?)` — работает на
  приватном чате при Threaded Mode (недокументировано, проверено живьём).
- **Аллокатор — daemon** (единственный владелец Bot API и писатель `threads.json`).
  `session-mcp` при register зовёт `/ensure-thread {label}` → daemon создаёт-или-
  переиспользует тред, пишет `threads.json`, возвращает `thread_id`. Хуки только
  ЧИТАЮТ `threads.json` (нет гонки создания).

## 2. Жизненный цикл при закрытии вкладки

- Тред **не удаляется** — история переписки сохраняется, и тот же label его
  переиспользует. Аллокация НЕ зависит от живости (label — стабильный ключ), так
  что «детект живости слотов» больше не нужен.
- **Статус в названии темы (косметика):** `🟢 Label` (вкладка активна) / `💤 Label`
  (закрыта, история на месте). `session-mcp` на register → `🟢`, на `/deregister`
  → `💤` (`editForumTopic`). Если статус залипнет (краш без deregister) — поправится
  при следующем register того же label. Статус не влияет на маршрутизацию.
- **Удаление тем — только вручную** (команда пользователя «прибери треды»), чтобы
  ничего ценного не снести авто.

## 3. Создание тредов — только бот

`Disallow users to create new threads` = ON (правильно): связь односторонняя
`терминал Claude → мост → тема`. Telegram не может запустить терминал; ручной тред
был бы пустышкой без вкладки. Пользователь темы сам не заводит.

## 4. Стриминг ответа — НЕ делаем (архитектурный факт)

Токен-потока из **интерактивной** сессии Claude Code наружу не существует: хуки
дают только полный текст в `Stop`, transcript пишется целыми сообщениями. Живой
токен-стрим есть лишь в headless (`claude -p --output-format stream-json
--include-partial-messages`) / Agent SDK (`include_partial_messages`) — это
отдельная программная сессия, не рабочий терминал. Поэтому `sendRichMessageDraft`
не применяем. Живой сигнал = **строка прогресса** (по инструментам,
`editMessageText`) + **финальный ответ**, оба в треде вкладки.

## 5. Роутинг входящих

- Входящее из треда несёт `message_thread_id` → **однозначно вкладка**. Свайп-реплай
  и `ambiguous` больше не нужны для тредовых сообщений.
- Сообщение в General / «Все» (без `thread_id`): бот отвечает мягкой подсказкой
  «напиши в тему нужной вкладки», никуда не роутится (вариант A). General — просто
  оглавление, диалог идёт в темах.

## 6. Зеркало ответа: краткая выжимка + `<details>` полный

- **Выжимка** = явная TG-сводка, которую Claude даёт скрытым маркером
  (`<!-- tg: суть 1-2 фразы -->`), видна только хуку, не в терминале. Формат сводки:
  «что сделано / что дальше / что важно», не отписка.
- **Полный ответ** — под нативным сворачиваемым блоком `<details><summary>Подробнее
  </summary>…</details>` (Rich Message collapsible, у пользователя подтверждён
  рабочим). Callback-кнопки/состояние не нужны.
- **Fallback без маркера:** короткий ответ показывается как есть; длинный — по
  границе абзаца + `<details>`. **Никогда не резать на полуслове с `[…]`.**
- Старый `LIMIT = 900` в `stop-notify.py` снимается: rich держит 32768 символов;
  plain-fallback режется до 4096 (лимит Telegram plain).

## 7. Как хуки узнают thread_id вкладки

- Ключ — **label** (не `session_id`, т.к. MCP-сервер его не видит; см. §1).
- daemon пишет `threads.json`: `{ "<label>": {thread_id, name, status, ts} }` при
  `/ensure-thread`.
- Хуки `stop-notify.py` / `progress-notify.py` вычисляют свой label
  (`os.environ.get('CLAPH_LABEL')` иначе `basename(payload['cwd'])`), читают
  `threads.json[label].thread_id` и добавляют `message_thread_id` во все исходящие.
- Если `threads.json` нет записи для label (daemon ещё не создал тред / Threaded
  Mode выкл) → хук шлёт **без** `message_thread_id` (fallback на плоский чат).
- **Гонки нет:** тред создаёт только daemon (через `/ensure-thread` от
  `session-mcp` при register, до любого хук-события). Хуки только читают.

## 8. Миграция со старого плоского чата

- Старый плоский чат **не трогаем**; ничего не удаляем.
- Новые сообщения идут в треды. General не переносим.
- Обратной совместимости достаточно: если Threaded Mode вдруг выключат, мост должен
  падать назад на текущее плоское поведение (thread_id отсутствует → шлём как
  раньше).

---

## Затрагиваемые файлы (обзор, детали — в плане)

- `shared.ts` — `THREADS_FILE` путь + типы `ThreadRecord`/`ThreadsFile`; helpers
  `labelKey()`, `readThreads()`, `writeThreads()` (atomic temp+rename).
- `daemon.ts` — `/ensure-thread {label}` (create-or-reuse тред, пишет
  `threads.json`, статус `🟢`); `/send`+`/edit` принимают `message_thread_id`;
  `sendToUser`/`editMessage`/`deliverClassic` прокидывают `message_thread_id`;
  роутинг входящих по `message_thread_id` (thread→label→handle); `/deregister`
  ставит `💤`; `/rename-thread {label,name}`.
- `session-mcp.ts` — после register зовёт `/ensure-thread {label:LABEL}`, хранит
  `threadId`, прокидывает в `/send`/`/edit`; MCP-инструмент `rename_thread {name}`.
- `stop-notify.py` — вычислить label, читать `threads.json[label].thread_id`, слать
  с `message_thread_id`; выжимка (`<!-- tg: -->`) + `<details>`; снять `LIMIT=900`.
- `progress-notify.py` — вычислить label, читать thread_id, слать/править строку
  прогресса в треде.

## Открытые вопросы — решены для плана

- **Формат `threads.json`:** `{ "<label>": { "thread_id": number, "name": string,
  "status": "active"|"idle", "ts": number } }`. Пишет только daemon (atomic:
  temp+rename). Хуки читают.
- **Живость для аллокации не нужна** (label-ключ стабилен). `🟢/💤` — косметика.
- **Разбор входящего `message_thread_id`** — в `routeText` (`daemon.ts`): есть
  `message_thread_id` → label по `threads.json` → handle живой сессии этого label;
  иначе текущий swipe/ambiguous fallback.
- **Граница «выжимка | детали»:** приоритет — маркер `<!-- tg: … -->`. Без маркера:
  текст ≤ 600 симв → как есть; иначе первый абзац (до первого `\n\n`, пропуская
  ведущий заголовок-строку `##`) = выжимка + остальное в `<details>`.
