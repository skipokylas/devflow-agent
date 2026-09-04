# Потоки даних і чекліст перевірок

## Карта: що є, чого немає

```
src/agent/types.ts    runSchema (zod) → Run, Pending; поле error
src/agent/llm.ts      Llm, realLlm, scriptedLlm, demoLlm, fake*
src/agent/tools.ts    ToolRegistry, ask_human, list_files, read_file, access
src/agent/loop.ts     advance() / resume() / retry()
src/agent/channel.ts  Channel (порт) + src/channel/cli.ts
src/db/storage.ts     Storage, FileStorage (create/load/save, version)
src/trace/            Span, TraceSink, FileSink, Tracer, рендер тексту й HTML
src/board/            Board (порт), Ticket, TicketStatus, InMemoryBoard, маркери
src/board/github/     http (fetch + ETag), projects (GraphQL), GitHubBoard
src/config.ts         .devflow/config.json через zod
src/guard.ts          звірка дошки з remote, привʼязка run до репо
src/init.ts           devflow init: remote, проєкт, звірка колонок
src/env.ts            секрети з ~/.devflow/.env
bin/devflow.js        глобальна команда після npm link
src/scheduler.ts      watch: черга, відповіді з коментарів, відновлення
src/channel/board.ts  BoardChannel — питання коментарем під квитком
src/cli.ts            run | reply | retry | watch | list | trace | show
src/deps.ts           composition root
src/repo.ts           ідентичність репо за remote URL, тека стану
src/ping.ts           один виклик моделі          ← навчальний
src/memory.ts         накопичення історії вручну  ← навчальний
src/try-*.ts          п'ять сценаріїв перевірки
```

---

## Потік 1. Один виклик моделі — що йде по мережі

Знято реальним перехопленням (`npm run try-wire`), не з памʼяті.

```
client.messages.create({ model, max_tokens, messages })
        │
        ▼  POST https://api.anthropic.com/v1/messages
   anthropic-version: 2023-06-01
   x-api-key: <з process.env.ANTHROPIC_API_KEY>
   content-type: application/json

   { "model": "claude-opus-5",
     "max_tokens": 1024,
     "messages": [ { "role": "user", "content": "додай magic links" } ] }
        │
        ▼  200 OK
   { "id": "msg_...", "type": "message", "role": "assistant",
     "content": [ { "type": "text", "text": "...", "citations": null } ],
     "stop_reason": "end_turn",
     "usage": { "input_tokens": …, "output_tokens": …, ... } }
```

Що з цього важливо:

- тіло запиту = рівно те, що ти передав, плюс нічого. Сервер не додає ні історії, ні стану.
- `content` — масив блоків. Типи блоків: `text`, `thinking`, `tool_use`. Тому `content[0].text` некоректний у загальному випадку.
- `stop_reason` — керуючий сигнал циклу: `end_turn` (завершити), `tool_use` (виконати інструмент і повернутись), `max_tokens` (обрізано).
- `usage` рахується від **усього** надісланого масиву. Історія оплачується заново щоразу.

---

## Потік 2. Як росте `messages` у циклі (буде в `advance`)

Один прогін `agent run "додай magic links"`. Ліворуч — індекс у масиві, праворуч — хто це поклав.

```
[0] user       "додай magic links"                        ← CLI, з аргументу
      │  POST #1  (messages = [0])
      ▼
[1] assistant  [ tool_use id=t1 read_file {path:"README"} ]  ← модель
      │  воркер виконує інструмент
[2] user       [ tool_result id=t1 "вміст README" ]          ← наш код
      │  POST #2  (messages = [0,1,2])   ← весь масив знову
      ▼
[3] assistant  [ tool_use id=t2 ask_human {...} ]            ← модель
      │  ask_human НЕ виконується. Пауза:
      │     status = waiting_human
      │     pending = { toolUseId: "t2", question, options, partialResults: [] }
      │     save() → .runs/run_x.json
      │     process.exit(0)          ← процес помер, масив зник
      ╎
      ╎  (інший процес, будь-коли пізніше)
      ╎  agent reply run_x "варіант 2"
      ╎     load() → масив [0..3] відновлено з диска
      ▼
[4] user       [ tool_result id=t2 "варіант 2" ]             ← відповідь людини
      │  POST #3  (messages = [0,1,2,3,4])
      ▼
[5] assistant  "План: 1) ... 2) ..."   stop_reason=end_turn  ← done
```

Правила, які тут зашиті:

- `tool_result.tool_use_id` мусить дорівнювати `id` блока `tool_use`. Інакше 400.
- усі `tool_result` **однієї** ітерації йдуть одним `user`-повідомленням. Якщо модель в одному ході покликала `read_file` і `ask_human`, готовий результат `read_file` чекає в `pending.partialResults` і піде разом з відповіддю людини.
- `assistant`-повідомлення кладеться цілим `response.content`, не витягнутим текстом — інакше блок `tool_use` зникне і наступний запит впаде.
- єдина різниця між `run` і `reply` — звідки взявся масив: з аргументу CLI чи з диска.

---

## Потік 3. Персистенція — що відбувається з байтами

```
save(run)                                  load(id)
   │                                          │
   ├─ load з диска, звірка version            ├─ readFile → рядок
   │     не збіглась → VersionConflict        ├─ JSON.parse → any
   │                                          └─ runSchema.parse → Run
   ├─ JSON.stringify({...run, version+1})           не збіглось → ZodError
   ├─ writeFile → run_x.json.<uuid>.tmp
   └─ rename(tmp → run_x.json)   ← атомарно
```

Помилка будь-де в `advance` не лишає run у `running`: вона перехоплюється,
статус стає `failed`, причина лягає в поле `error`. Продовжити такий run —
`agent retry <id>`. Поле `error` додане зі схемним `.default(null)`, тому файли,
записані до його появи, читаються далі.

`rename` у межах однієї ФС атомарний: на диску або старий файл цілком, або новий цілком. Прямий `writeFile` у цільовий файл дав би обрізаний JSON, якби процес помер посеред запису.

`save` повертає новий обʼєкт і не мутує аргумент — тому виклик завжди `run = await storage.save(run)`. Забуте присвоєння = вічний `VersionConflict` на наступному кроці.

---

## Порти: де проходять межі

```
ядро (advance/resume) залежить тільки від типів зліва

Llm       ──►  realLlm(client)      мережа, гроші
          └─►  scriptedLlm([...])   памʼять, $0, детерміновано

Storage      ──►  FileStorage(".runs")    JSON-файли
          └─►  SqliteStorage           коли знадобляться запити по статусу

Channel   ──►  CliChannel           друк у stdout        (ще не створено)
          └─►  TelegramChannel      фаза 6
```

Наслідок: увесь сценарій паузи й відновлення тестується без мережі й без витрат. Реальна модель потрібна тільки щоб перевірити зміст промпта.

---

## Чекліст

### A. Оточення

- [ ] `npm run typecheck` — без помилок
- [ ] `npm run dev` — друкує `ok`
- [ ] `.env` існує, у ньому справжній `ANTHROPIC_API_KEY`
- [ ] `git status` — `.env` не відстежується, у списку тільки `.env.example`

### B. Персистенція — `npm run try-storage` (14 перевірок)

Має бути 11 галочок. Кожна доводить окрему властивість:

- [ ] `create → version 1` — нова сутність починає з версії 1, не 0
- [ ] `create → файл на диску` — стан вийшов за межі процесу
- [ ] `save → version 2` — кожен запис піднімає версію
- [ ] `load → історія збережена` — `messages` пережили серіалізацію
- [ ] `load → статус збережений` — union-рядок лягає в JSON без конвертації
- [ ] `save зі старою версією → VersionConflict` — compare-and-set працює
- [ ] `після конфлікту файл не змінився` — відхилений запис нічого не зіпсував
- [ ] `load неіснуючого → RunNotFound` — типізована помилка, не `undefined`
- [ ] `create того самого id → RunAlreadyExists` — без тихого перезапису
- [ ] `невалідний status → ZodError на load` — межа довіри тримає
- [ ] `list` повертає всі runs і парсить кожен через схему
- [ ] `list` переживає зіпсований файл — один поганий не ховає решту
- [ ] `тимчасові файли прибрані` — `.tmp` не накопичуються

Далі руками: `cat .runs/try/run_demo.json` — переконайся, що структура файлу збігається з `runSchema`.

### C. Підроблена модель — `npm run try-llm` (7 перевірок)

- [ ] `виклик 1 → stop_reason tool_use` — сигнал «виконай інструмент»
- [ ] `виклик 1 → блок tool_use з id` — id, за яким потім знайдеться `tool_result`
- [ ] `виклик 1 → input дійшов` — аргументи інструмента доїхали
- [ ] `виклик 2 → stop_reason end_turn` — сигнал «цикл завершено»
- [ ] `виклик 2 → текстовий блок` — фінальна відповідь приходить як `text`
- [ ] `виклик 3 → скрипт вичерпано` — падає гучно, а не віддає `undefined`
- [ ] `токени не витрачені` — мережі не було

### D. Мережа — `npm run try-wire`

Ключ не потрібен, запит іде на локальний сервер.

- [ ] шлях `POST /v1/messages`
- [ ] заголовок `anthropic-version: 2023-06-01`
- [ ] у тілі рівно `model`, `max_tokens`, `messages` — нічого зайвого
- [ ] у відповіді `content` — масив, а не рядок

### E. Реальна модель (потрібен ключ, коштує гроші)

- [ ] `npm run ping` — приходить текст
- [ ] `npm run memory` — на друге питання відповідає правильно, `input_tokens` другого виклику більший за перший
- [ ] порівняй вартість: той самий `ping` з `claude-haiku-4-5` замість `claude-opus-5`

### F. Реєстр інструментів — `npm run try-tools` (20 перевірок)

- [ ] `read_file` повертає справжній вміст
- [ ] `list_files` показує дерево й пропускає `node_modules`
- [ ] `list_files` без аргументів працює з кореня
- [ ] `list_files` за межі кореня → відмова
- [ ] невалідний `input` від моделі ловить zod
- [ ] шлях `../../.ssh/id_rsa` відбито
- [ ] невідома назва → `UnknownTool`
- [ ] `ask_human` реєстром не виконується
- [ ] `access: write` без дозволу → `NotApproved`

### G. Цикл, untrusted і трейс — `npm run try-loop` (41 перевірка)

- [ ] помилка інструмента → `tool_result` з `is_error: true`, run іде далі
- [ ] `maxSteps` вичерпано → `failed`
- [ ] пауза: `pending.toolUseId` = id блока `ask_human`
- [ ] `partialResults` зберігає результат інструмента з тієї ж ітерації
- [ ] `resume` віддає обидва `tool_result` одним `user`-повідомленням
- [ ] `resume` не на паузі → `NotWaiting`
- [ ] помилка моделі → `failed`, причина в `run.error`, не застрягання в `running`
- [ ] `retry` після падіння доводить до `done` і очищає `error`
- [ ] `retry` на `done` → `NotRetryable`
- [ ] спани записані, `tool_call` висить на `llm_call`
- [ ] два корені в дереві: `run` і `reply` — межа процесів видна
- [ ] `question` і `answer` потрапили у трейс
- [ ] write-дія без дозволу зупиняє цикл, інструмент не виконується
- [ ] намір збережений у `pending.approval`, питання називає дію й аргументи
- [ ] відмова не виконує дію, run завершується нормально
- [ ] згода виконує саме відкладену дію, дозвіл записується як клас `write`
- [ ] після дозволу інший write-інструмент проходить без нової паузи
- [ ] вміст файлу загорнутий у `<untrusted>`
- [ ] закриваючий тег усередині вмісту знешкоджений

### H. Наскрізний прогін фази 0 (без витрат)

```bash
AGENT_LLM=demo npm run dev -- run "додай magic links"
npm run dev -- show <runId>
AGENT_LLM=demo npm run dev -- reply <runId> "resend"
```

- [ ] перший процес завершується зі статусом `waiting_human`
- [ ] `show` між процесами показує історію й питання
- [ ] `reply` в новому процесі доводить run до `done`, нічого не перепитуючи

### J. Планувальник — `npm run try-watch` (44 перевірки)

- [ ] на кожен готовий квиток створюється run
- [ ] квиток у черзі лишається в `Ready`, у `In progress` іде лише той, що в роботі
- [ ] пауза не блокує чергу: другий квиток береться, поки перший чекає
- [ ] відповідь у коментарі продовжує run до `done`
- [ ] квиток переводиться в `in_review`, у ньому питання і фінальний звіт
- [ ] `finishStatus: done` у конфігу міняє цю поведінку
- [ ] видалений квиток → run `failed` із причиною, черга не блокується
- [ ] `write_file` зупиняється на воротах дозволу
- [ ] після дозволу правка лягає в робочу копію, не в теку користувача
- [ ] без remote PR не створюється, гілка лишається локальною
- [ ] з remote і forge: гілка запушена, PR відкрито з правильної гілки в базову
- [ ] провалений `typecheck` повертається в модель із виводом команди
- [ ] обірваний `running` після перезапуску повертається в `queued`
- [ ] повторний оберт не створює дублів на той самий квиток
- [ ] звіт — один коментар, що редагується, а не низка нових
- [ ] у звіті видно задачу, питання агента, відповідь людини й підсумок
- [ ] доопрацювання додає повідомлення в ту саму історію, run не задвоюється
- [ ] після доопрацювання редагується той самий коментар

### L. Декомпозиція — `npm run try-board`

- [ ] `create_issues` створює всі підзадачі однією дією
- [ ] підзадачі лягають у `Backlog`, планувальник їх не підхоплює
- [ ] повторний виклик не дублює: маркер знайдено, «вже існує»
- [ ] порожній план і задачі з коротким описом відкидаються схемою
- [ ] після відмови нічого не створено

### K. GitHub — `npm run try-github` (9 перевірок, без мережі)

- [ ] `ready` бере лише колонку, що мапиться на `todo`
- [ ] issue розібраний у `Ticket`: заголовок, посилання, мітки
- [ ] картка в іншій колонці не потрапляє в `ready`
- [ ] `get` мапить колонку назад у наш статус
- [ ] `setStatus` шле мутацію з `optionId` потрібної колонки
- [ ] свій коментар відрізняється від чужого за логіном токена
- [ ] відсутня в проєкті колонка → зрозуміла помилка, не тиха

### M. Робоча копія — `npm run try-workspace` (14 перевірок)

- [ ] `git worktree` дає окрему копію зі спільною історією
- [ ] правки агента не торкаються основної теки
- [ ] повторний виклик підхоплює наявне дерево
- [ ] неоднозначний фрагмент у `edit_file` відхилено з поясненням
- [ ] команда поза переліком не запускається
- [ ] чисте дерево прибирається, зі змінами — лишається

### I. Ще немає

- [ ] повторний `run` не створює дублікатів issues (фаза 3)
- [ ] untrusted-обгортка для даних із GitHub
- [ ] таблиця `events` (llm_call / tool_call / вартість)
