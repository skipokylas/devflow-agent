import { priceOf, type Span } from "./types";

type Node = { span: Span; children: Node[] };

/** JSONL пишеться в порядку завершення, тому дерево збираємо за parentId, не за порядком. */
export function toTree(spans: Span[]): Node[] {
  const byId = new Map(spans.map((s) => [s.id, { span: s, children: [] } as Node]));
  const roots: Node[] = [];

  for (const node of byId.values()) {
    const parent = node.span.parentId ? byId.get(node.span.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const byStart = (a: Node, b: Node) => a.span.startedAt - b.span.startedAt;
  for (const node of byId.values()) node.children.sort(byStart);
  return roots.sort(byStart);
}

export function summary(spans: Span[]) {
  return {
    cacheRead: spans.reduce((n, s) => n + (s.cost?.cacheReadTokens ?? 0), 0),
    cacheWrite: spans.reduce((n, s) => n + (s.cost?.cacheWriteTokens ?? 0), 0),
    llmCalls: spans.filter((s) => s.type === "llm_call").length,
    toolCalls: spans.filter((s) => s.type === "tool_call").length,
    errors: spans.filter((s) => s.error).length,
    inputTokens: spans.reduce((n, s) => n + (s.cost?.inputTokens ?? 0), 0),
    outputTokens: spans.reduce((n, s) => n + (s.cost?.outputTokens ?? 0), 0),
    cost: spans.reduce((n, s) => n + priceOf(s.cost), 0),
    durationMs: Math.max(...spans.map((s) => s.endedAt)) - Math.min(...spans.map((s) => s.startedAt)),
  };
}

// ─────────────────────────── форми даних у спанах ───────────────────────────

type Block = { type: string; text?: string; name?: string; id?: string; input?: unknown; content?: unknown; is_error?: boolean; tool_use_id?: string };
type Message = { role: string; content: string | Block[] };
type LlmInput = { step: number; system: string; tools: string[]; messages: Message[] };
type LlmOutput = { stopReason: string | null; content: Block[] };
type RunOutput = { status: string; answer: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isLlmInput = (v: unknown): v is LlmInput => isObj(v) && "messages" in v && "system" in v;
const isLlmOutput = (v: unknown): v is LlmOutput => isObj(v) && "stopReason" in v && "content" in v;
const isRunOutput = (v: unknown): v is RunOutput => isObj(v) && "status" in v && "answer" in v;

/** Питання й відповідь беруться з кореневих спанів — вони обрамляють увесь прогін. */
export function conversation(spans: Span[]): { task: string; answer: string; status: string } {
  const roots = toTree(spans).map((n) => n.span);
  const first = roots[0];
  const last = roots[roots.length - 1];
  const out = last && isRunOutput(last.output) ? last.output : null;
  return {
    task: typeof first?.input === "string" ? first.input : "",
    answer: out?.answer ?? "",
    status: out?.status ?? (last?.error ? "failed" : ""),
  };
}

const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);
const money = (n: number) => (n === 0 ? "" : `$${n.toFixed(4)}`);
const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();

/** Однорядковий підсумок: що модель сказала або що вона попросила. */
function headline(span: Span): string {
  if (span.error) return `✗ ${span.error}`;
  const out = span.output;
  if (isRunOutput(out)) return out.status;
  if (!isLlmOutput(out)) return String(out ?? "");

  const text = out.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join(" ");
  if (text.trim()) return text;
  const tools = out.content.filter((b) => b.type === "tool_use").map((b) => b.name).join(", ");
  return tools ? `просить: ${tools}` : String(out.stopReason ?? "");
}

function brief(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (isLlmInput(input)) return `крок ${input.step}`;
  const text = oneLine(typeof input === "string" ? input : JSON.stringify(input));
  return text.length > 34 ? `${text.slice(0, 34)}…` : text;
}

// ─────────────────────────── текстовий рендер ───────────────────────────

export function toText(spans: Span[]): string {
  const lines: string[] = [];
  const { task, answer } = conversation(spans);
  if (task) lines.push(`питання:  ${oneLine(task)}`, "");

  function walk(nodes: Node[], prefix: string): void {
    nodes.forEach((node, i) => {
      const { span, children } = node;
      const last = i === nodes.length - 1;
      const branch = prefix === "" ? "" : `${prefix}${last ? "└─ " : "├─ "}`;
      const label =
        span.type === "llm_call" || span.type === "run" ? span.name : `${span.name} ${brief(span.input)}`;
      const cell = `${branch}${label}`;
      lines.push(
        `${cell.padEnd(46).slice(0, 46)} ${ms(span.endedAt - span.startedAt).padStart(7)}  ` +
          `${money(priceOf(span.cost)).padStart(8)}  ${oneLine(headline(span)).slice(0, 46)}`,
      );
      walk(children, prefix === "" ? "  " : `${prefix}${last ? "   " : "│  "}`);
    });
  }

  walk(toTree(spans), "");
  if (answer) lines.push("", "відповідь:", answer.split("\n").map((l) => `  ${l}`).join("\n"));
  return lines.join("\n");
}

// ─────────────────────────── переглядач ───────────────────────────

const esc = (t: string): string => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
const json = (v: unknown): string => esc(JSON.stringify(v, null, 2) ?? "");

function block(b: Block): string {
  if (b.type === "text") return `<div class="blk txt">${esc(b.text ?? "")}</div>`;
  if (b.type === "tool_use") {
    return `<div class="blk call"><div class="blk-h">викликає <b>${esc(b.name ?? "")}</b></div><pre>${json(b.input)}</pre></div>`;
  }
  if (b.type === "tool_result") {
    const body = typeof b.content === "string" ? b.content : JSON.stringify(b.content, null, 2);
    return `<div class="blk res ${b.is_error ? "bad" : ""}"><div class="blk-h">${b.is_error ? "помилка інструмента" : "результат інструмента"}</div><pre>${esc(body ?? "")}</pre></div>`;
  }
  if (b.type === "thinking") return `<div class="blk think"><div class="blk-h">роздуми</div><pre>${esc(String(b.text ?? ""))}</pre></div>`;
  return `<div class="blk"><pre>${json(b)}</pre></div>`;
}

function messages(list: Message[]): string {
  return list
    .map((m) => {
      const body = typeof m.content === "string" ? `<div class="blk txt">${esc(m.content)}</div>` : m.content.map(block).join("");
      return `<div class="msg ${esc(m.role)}"><div class="role">${esc(m.role)}</div><div class="blocks">${body}</div></div>`;
    })
    .join("");
}

function section(title: string, body: string, open = true): string {
  return `<details ${open ? "open" : ""}><summary>${esc(title)}</summary><div class="sec">${body}</div></details>`;
}

function detail(span: Span): string {
  const parts: string[] = [];
  const stamp = `<div class="facts">
    <span>${esc(span.type)}</span><span>${ms(span.endedAt - span.startedAt)}</span>
    ${span.cost ? `<span>${span.cost.inputTokens}→${span.cost.outputTokens} токенів</span><span>${money(priceOf(span.cost))}</span>` : ""}
    ${span.error ? `<span class="bad">помилка</span>` : ""}
  </div>`;

  if (isLlmInput(span.input)) {
    parts.push(section("що пішло — системний промпт", `<pre>${esc(span.input.system)}</pre>`, false));
    parts.push(section(`що пішло — інструменти (${span.input.tools.length})`, `<pre>${esc(span.input.tools.join("\n"))}</pre>`, false));
    parts.push(section(`що пішло — повідомлення (${span.input.messages.length})`, messages(span.input.messages)));
  } else if (span.input !== null) {
    parts.push(section("що пішло", `<pre>${json(span.input)}</pre>`));
  }

  if (span.error) parts.push(section("помилка", `<pre class="bad">${esc(span.error)}</pre>`));
  else if (isLlmOutput(span.output)) {
    parts.push(section(`що прийшло — ${esc(String(span.output.stopReason ?? ""))}`, span.output.content.map(block).join("")));
  } else if (isRunOutput(span.output)) {
    parts.push(section(`що прийшло — ${esc(span.output.status)}`, `<div class="blk txt">${esc(span.output.answer)}</div>`));
  } else if (span.output !== null) {
    parts.push(section("що прийшло", `<pre>${esc(typeof span.output === "string" ? span.output : JSON.stringify(span.output, null, 2))}</pre>`));
  }

  return stamp + parts.join("");
}

export function toHtml(runId: string, spans: Span[]): string {
  const s = summary(spans);
  const c = conversation(spans);
  const items: string[] = [];
  const panels: string[] = [];
  let first = "";

  function walk(nodes: Node[], ancestors: boolean[]): void {
    nodes.forEach((node, i) => {
      const { span, children } = node;
      const last = i === nodes.length - 1;
      if (!first) first = span.id;
      const guides =
        ancestors.map((more) => `<i class="g${more ? " line" : ""}"></i>`).join("") +
        (ancestors.length === 0 ? "" : `<i class="g elbow${last ? " end" : ""}"></i>`);
      items.push(`<button class="item" data-id="${span.id}">
  ${guides}
  <span class="chip ${span.type}">${esc(span.type)}</span>
  <span class="nm">${esc(span.name)}</span>
  <span class="sub">${esc(brief(span.input))}</span>
  <span class="t">${ms(span.endedAt - span.startedAt)}</span>
  ${span.cost ? `<span class="c">${money(priceOf(span.cost))}</span>` : ""}
  ${span.error ? `<span class="dot bad"></span>` : ""}
</button>`);
      panels.push(`<section class="panel" data-for="${span.id}" hidden>
  <h2>${esc(span.name)} <span class="hl">${esc(oneLine(headline(span)).slice(0, 90))}</span></h2>
  ${detail(span)}
</section>`);
      walk(children, [...ancestors, !last]);
    });
  }
  walk(toTree(spans), []);

  return `<!doctype html><html lang="uk"><meta charset="utf-8"><title>${esc(runId)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#eef1f0;--card:#fbfcfb;--fg:#16202a;--dim:#5d6b6a;--line:#d2d9d7;--soft:#e6eae8;
  --acc:#1f6354;--warn:#9c5c16;--bad:#93382d;
  --sans:ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
@media(prefers-color-scheme:dark){:root{--bg:#0d1317;--card:#131c21;--fg:#dde5e3;--dim:#8b9b98;
  --line:#25333a;--soft:#1a252b;--acc:#66b7a0;--warn:#d59a55;--bad:#d9796a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 var(--sans)}
header{padding:18px 22px;border-bottom:1px solid var(--line);background:var(--card)}
.top{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
h1{font-size:15px;margin:0;font-family:var(--mono)}
.metrics{color:var(--dim);font-family:var(--mono);font-size:12px}
.qa{margin-top:12px;display:grid;gap:8px}
.qa .lbl{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim)}
.qa .body{white-space:pre-wrap;word-break:break-word;max-height:8.5em;overflow:auto;
  background:var(--soft);border-radius:6px;padding:9px 12px}
.app{display:grid;grid-template-columns:minmax(240px,340px) minmax(0,1fr);height:calc(100vh - 1px);
  align-items:stretch}
@media(max-width:820px){.app{grid-template-columns:1fr;height:auto}}
.steps{border-right:1px solid var(--line);overflow:auto;background:var(--card);padding:8px 0}
.item{display:flex;align-items:center;gap:7px;width:100%;border:0;background:none;color:inherit;
  font:inherit;text-align:left;padding:6px 12px 6px 10px;cursor:pointer;border-left:2px solid transparent}
.g{position:relative;width:14px;height:26px;flex:none;align-self:stretch}
.g.line::before,.g.elbow::before{content:"";position:absolute;left:6px;top:0;bottom:0;
  border-left:1px solid var(--line)}
.g.elbow::after{content:"";position:absolute;left:6px;top:50%;width:8px;border-top:1px solid var(--line)}
.g.elbow.end::before{bottom:50%}
.item:hover{background:var(--soft)}
.item[aria-current="true"]{background:var(--soft);border-left-color:var(--acc)}
.item .nm{font-family:var(--mono);font-size:12px;white-space:nowrap}
.item .sub{color:var(--dim);font-size:11px;font-family:var(--mono);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;flex:1}
.item .t,.item .c{color:var(--dim);font-size:11px;font-family:var(--mono);font-variant-numeric:tabular-nums}
.dot{width:7px;height:7px;border-radius:50%;background:var(--bad);flex:none}
.chip{font-size:9.5px;font-family:var(--mono);padding:1px 5px;border-radius:9px;border:1px solid var(--line);
  color:var(--dim);flex:none}
.chip.llm_call{border-color:var(--acc);color:var(--acc)}
.chip.question,.chip.answer{border-color:var(--warn);color:var(--warn)}
.detail{overflow:auto;padding:18px 22px 60px}
.panel h2{font-size:15px;margin:0 0 12px;font-family:var(--mono);font-weight:600}
.panel h2 .hl{font-family:var(--sans);font-weight:400;color:var(--dim);font-size:13px}
.facts{display:flex;gap:14px;flex-wrap:wrap;color:var(--dim);font-family:var(--mono);font-size:11.5px;
  margin-bottom:14px}
details{border:1px solid var(--line);border-radius:7px;margin-bottom:12px;background:var(--card)}
summary{cursor:pointer;padding:9px 13px;font-weight:600;font-size:13px;list-style:none}
summary::-webkit-details-marker{display:none}
summary::before{content:"▸ ";color:var(--acc)}
details[open]>summary::before{content:"▾ "}
.sec{padding:0 13px 12px}
.msg{border-top:1px solid var(--line);padding:10px 0}
.msg:first-child{border-top:0}
.role{font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);
  margin-bottom:6px}
.msg.assistant .role{color:var(--acc)}
.blk{margin:6px 0}
.blk-h{font-size:11px;color:var(--dim);font-family:var(--mono);margin-bottom:3px}
.blk.txt{white-space:pre-wrap;word-break:break-word}
.blk.call pre{border-left:2px solid var(--acc)}
.blk.res pre{border-left:2px solid var(--line)}
.blk.res.bad pre{border-left-color:var(--bad)}
pre{margin:0;background:var(--soft);border-radius:6px;padding:9px 12px;overflow:auto;max-height:460px;
  font-family:var(--mono);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.bad{color:var(--bad)}
</style>
<header>
  <div class="top"><h1>${esc(runId)}</h1>
  <div class="metrics">${s.llmCalls} звернень · ${s.toolCalls} інструментів · ${s.errors} помилок ·
  ${ms(s.durationMs)} · ${s.inputTokens}→${s.outputTokens} токенів · ${money(s.cost) || "$0"} · ${esc(c.status)}</div></div>
  <div class="qa">
    ${c.task ? `<div><div class="lbl">питання</div><div class="body">${esc(c.task)}</div></div>` : ""}
    ${c.answer ? `<div><div class="lbl">відповідь</div><div class="body">${esc(c.answer)}</div></div>` : ""}
  </div>
</header>
<div class="app">
  <nav class="steps">${items.join("")}</nav>
  <main class="detail">${panels.join("")}</main>
</div>
<script>
var items = document.querySelectorAll(".item");
function show(id) {
  document.querySelectorAll(".panel").forEach(function (p) { p.hidden = p.dataset.for !== id; });
  items.forEach(function (b) { b.setAttribute("aria-current", String(b.dataset.id === id)); });
}
items.forEach(function (b) { b.addEventListener("click", function () { show(b.dataset.id); }); });
document.addEventListener("keydown", function (e) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  var list = Array.prototype.slice.call(items);
  var i = list.findIndex(function (b) { return b.getAttribute("aria-current") === "true"; });
  var next = list[Math.min(list.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))];
  if (next) { show(next.dataset.id); next.scrollIntoView({ block: "nearest" }); e.preventDefault(); }
});
show(${JSON.stringify(first)});
</script>
</html>`;
}
