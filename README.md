# devflow-agent

AI Software Development Manager — агентна система, що веде життєвий цикл розробки:
читає репозиторій, складає план, створює issues, стежить за PR і CI, готує release notes.

Один агент на один репозиторій. Веде журнал рішень поруч із кодом, розбиває задачі,
заводить їх на борді, виконує, верифікує й відкриває PR.

TypeScript, голий `@anthropic-ai/sdk`, без агентних фреймворків.

## Швидкий старт

```bash
npm install
cp .env.example .env      # ANTHROPIC_API_KEY потрібен лише для справжньої моделі
npm run typecheck
```

Наскрізний прогін без ключа й без витрат:

```bash
AGENT_LLM=demo npm run dev -- run "додай passwordless-авторизацію через email magic links"
npm run dev -- show <runId>
AGENT_LLM=demo npm run dev -- reply <runId> "resend"
```

Перший процес зупиняється на питанні й завершується, стан лягає в `.runs/<runId>.json`,
другий процес піднімає його з диска й доводить до кінця.

## Документація

| Файл | Про що |
|---|---|
| `CLAUDE.md` | що будуємо, закриті рішення, архітектура, конвенції коду |
| `ROADMAP.md` | де ми зараз, фази з критеріями, відкриті питання, техборг |
| `CHECKLIST.md` | три потоки даних під капотом і 49 перевірок |

## Команди

```bash
npm run dev -- run "<задача>"          створити run і працювати до паузи
npm run dev -- reply <id> "<текст>"    продовжити run, що чекає на людину
npm run dev -- retry <id>              повторити перерваний run
npm run dev -- watch                   планувальник: дошка → черга → робота
npm run dev -- list                    усі runs цього репозиторію
npm run dev -- trace <id>              дерево кроків, час і вартість
npm run dev -- show <id>               стан run

npm run try-wire      справжній HTTP-запит через локальний сервер-підміну
npm run try-storage   перевірки сховища
npm run try-tools     перевірки реєстру інструментів
npm run try-llm       перевірки підробленої моделі
npm run try-loop      перевірки циклу
```

Змінні: `AGENT_LLM=demo` (офлайн-модель), `MODEL`, `MAX_STEPS`, `AGENT_PROMPT`,
`AGENT_REPO`. Стан прогонів — у `~/.devflow/<repo-slug>/`, поза репозиторієм.
