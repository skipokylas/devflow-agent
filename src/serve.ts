import http from "node:http";
import type { Run } from "./agent/types";
import type { Storage } from "./db/storage";
import type { TraceSink } from "./trace/sink";
import { esc, toHtml } from "./trace/render";

/**
 * Той самий водоспад, що пише `devflow trace`, але за посиланням. Окремого
 * сховища немає: сервер читає ті самі трейси й ті самі runs, тому нічого не
 * треба експортувати чи синхронізувати — досить запустити процес.
 */

/** Типовий порт. Змінюється через DEVFLOW_PORT. */
export const DEFAULT_PORT = 4700;

export type ServeOptions = {
  storage: Storage;
  trace: TraceSink;
  port: number;
  log: (line: string) => void;
};

/** Id зі шляху йде в імʼя файлу, тому все, що не схоже на id прогону, відкидаємо. */
const RUN_ID = /^[\w-]{1,64}$/;

export async function serve(o: ServeOptions): Promise<void> {
  const server = http.createServer((req, res) => void respond(req, res, o));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, () => resolve());
  });

  o.log(`http://localhost:${o.port}  Ctrl+C щоб зупинити\n`);

  // Процес живе, поки живий сервер. Keep-alive зʼєднання не дали б close()
  // завершитись, тому браузерні вкладки рвемо явно — інакше Ctrl+C підвисає.
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => {
      o.log("зупиняю сервер");
      server.close(() => resolve());
      server.closeAllConnections();
    });
  });
}

async function respond(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  o: ServeOptions,
): Promise<void> {
  const send = (status: number, body: string): void => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    // На HEAD віддаємо самі заголовки: тіло там зайве за визначенням методу.
    if (req.method === "HEAD") res.end();
    else res.end(body);
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    send(405, page("405", "<p>сервер тільки читає: доступний лише GET</p>"));
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    const answer = await route(url, o);
    o.log(`${answer.status} ${url.pathname}`);
    send(answer.status, answer.body);
  } catch (err) {
    // Один зіпсований трейс не має вбивати сервер: показуємо причину й живемо далі.
    const message = err instanceof Error ? err.message : String(err);
    o.log(`500 ${url.pathname}: ${message}`);
    send(500, page("500", `<p>помилка: ${esc(message)}</p>`));
  }
}

async function route(url: URL, o: ServeOptions): Promise<{ status: number; body: string }> {
  if (url.pathname === "/") return { status: 200, body: index(await o.storage.list()) };

  const id = /^\/trace\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  if (!id) return { status: 404, body: page("404", `<p>немає такої сторінки</p>${home}`) };

  const runId = decode(id);
  if (!runId || !RUN_ID.test(runId)) {
    return { status: 400, body: page("400", `<p>це не схоже на id прогону</p>${home}`) };
  }

  const spans = await o.trace.read(runId);
  if (spans.length === 0) {
    return { status: 404, body: page("404", `<p>для <code>${esc(runId)}</code> немає трейсу</p>${home}`) };
  }

  return { status: 200, body: toHtml(runId, spans) };
}

/** Побитий percent-encoding — це поганий запит, а не збій сервера. */
function decode(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** Перший рядок задачі: те саме, що показує `devflow list`. */
function taskOf(run: Run): string {
  const first = run.messages[0];
  const text =
    typeof first?.content === "string"
      ? first.content
      : (first?.content ?? []).map((b) => ("text" in b ? b.text : "")).join(" ");
  return text.replace(/\s+/g, " ").trim().slice(0, 90);
}

function index(runs: Run[]): string {
  if (runs.length === 0) return page("прогони", "<p>немає жодного прогону</p>");

  // Найсвіжіші зверху: список відкривають, щоб подивитись щойно завершену роботу.
  const rows = [...runs]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .map(
      (run) => `<li>
  <a href="/trace/${encodeURIComponent(run.id)}">${esc(run.id)}</a>
  <span class="st">${esc(run.status)}</span>
  <span class="task">${esc(taskOf(run))}</span>
</li>`,
    )
    .join("");

  return page("прогони", `<ul class="runs">${rows}</ul>`);
}

const home = `<p><a href="/">до списку прогонів</a></p>`;

/**
 * Сторінки навколо водоспаду. Кольори ті самі, що в `toHtml`, але без його
 * розмітки: тягнути сюди стилі переглядача заради списку з десяти рядків
 * дорожче, ніж повторити пʼять правил.
 */
function page(title: string, body: string): string {
  return `<!doctype html><html lang="uk"><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#eef1f0;--card:#fbfcfb;--fg:#16202a;--dim:#5d6b6a;--line:#d2d9d7;--acc:#1f6354;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
@media(prefers-color-scheme:dark){:root{--bg:#0d1317;--card:#131c21;--fg:#dde5e3;--dim:#8b9b98;
  --line:#25333a;--acc:#66b7a0}}
body{margin:0;padding:24px;background:var(--bg);color:var(--fg);
  font:14px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
h1{font-size:15px;margin:0 0 16px;font-family:var(--mono)}
a{color:var(--acc)}
code{font-family:var(--mono)}
.runs{list-style:none;margin:0;padding:0;max-width:900px}
.runs li{display:flex;gap:12px;align-items:baseline;padding:8px 12px;background:var(--card);
  border:1px solid var(--line);border-radius:7px;margin-bottom:6px}
.runs a{font-family:var(--mono);font-size:12px;text-decoration:none}
.st{color:var(--dim);font-family:var(--mono);font-size:11px;min-width:96px}
.task{color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style>
<h1>${esc(title)}</h1>
${body}
</html>`;
}
