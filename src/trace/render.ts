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
    llmCalls: spans.filter((s) => s.type === "llm_call").length,
    toolCalls: spans.filter((s) => s.type === "tool_call").length,
    errors: spans.filter((s) => s.error).length,
    inputTokens: spans.reduce((n, s) => n + (s.cost?.inputTokens ?? 0), 0),
    outputTokens: spans.reduce((n, s) => n + (s.cost?.outputTokens ?? 0), 0),
    cost: spans.reduce((n, s) => n + priceOf(s.cost), 0),
    durationMs: Math.max(...spans.map((s) => s.endedAt)) - Math.min(...spans.map((s) => s.startedAt)),
  };
}

const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);
const money = (n: number) => (n === 0 ? "" : `$${n.toFixed(4)}`);

export function toText(spans: Span[]): string {
  const lines: string[] = [];

  function walk(nodes: Node[], depth: number): void {
    for (const { span, children } of nodes) {
      const pad = "  ".repeat(depth);
      const label = span.type === "llm_call" || span.type === "run" ? span.name : `${span.name} ${brief(span.input)}`;
      const status = oneLine(span.error ? `✗ ${span.error}` : String(span.output ?? ""));
      const cell = `${pad}${label}`;
      lines.push(
        `${cell.padEnd(46).slice(0, 46)} ${ms(span.endedAt - span.startedAt).padStart(7)}  ` +
          `${money(priceOf(span.cost)).padStart(8)}  ${status.slice(0, 46)}`,
      );
      walk(children, depth + 1);
    }
  }

  walk(toTree(spans), 0);
  return lines.join("\n");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function brief(input: unknown): string {
  if (input === null || input === undefined) return "";
  const text = oneLine(typeof input === "string" ? input : JSON.stringify(input));
  return text.length > 34 ? `${text.slice(0, 34)}…` : text;
}

export function toHtml(runId: string, spans: Span[]): string {
  const s = summary(spans);
  const t0 = Math.min(...spans.map((x) => x.startedAt));
  const total = Math.max(s.durationMs, 1);
  const rows: string[] = [];

  function walk(nodes: Node[], depth: number): void {
    for (const { span, children } of nodes) {
      const left = ((span.startedAt - t0) / total) * 100;
      const width = Math.max(((span.endedAt - span.startedAt) / total) * 100, 0.6);
      rows.push(`<tr class="${span.error ? "err" : ""}">
  <td class="name" style="padding-left:${8 + depth * 18}px">
    <span class="chip ${span.type}">${span.type}</span> ${escape(span.name)}
    <span class="arg">${escape(brief(span.input))}</span>
  </td>
  <td class="bar"><i style="left:${left}%;width:${width}%"></i></td>
  <td class="num">${ms(span.endedAt - span.startedAt)}</td>
  <td class="num">${span.cost ? `${span.cost.inputTokens}→${span.cost.outputTokens}` : ""}</td>
  <td class="num">${money(priceOf(span.cost))}</td>
  <td class="out">${escape(oneLine(String(span.error ?? span.output ?? "")).slice(0, 200))}</td>
</tr>`);
      walk(children, depth + 1);
    }
  }
  walk(toTree(spans), 0);

  return `<!doctype html><meta charset="utf-8"><title>trace ${runId}</title>
<style>
:root{--bg:#fbfcfb;--fg:#16202a;--dim:#5d6b6a;--line:#dfe4e2;--bar:#1f6354;--err:#93382d}
@media(prefers-color-scheme:dark){:root{--bg:#0d1317;--fg:#dde5e3;--dim:#8b9b98;--line:#25333a;--bar:#66b7a0;--err:#d9796a}}
body{background:var(--bg);color:var(--fg);font:13px/1.5 ui-monospace,Menlo,monospace;margin:0;padding:28px}
h1{font-size:17px;margin:0 0 4px} .meta{color:var(--dim);margin-bottom:20px}
table{width:100%;border-collapse:collapse} td{border-bottom:1px solid var(--line);padding:5px 8px;vertical-align:top}
.name{white-space:nowrap} .arg{color:var(--dim)} .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.out{color:var(--dim);max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar{width:34%;position:relative;min-width:120px} .bar i{position:absolute;top:8px;height:7px;background:var(--bar);border-radius:2px}
tr.err .bar i{background:var(--err)} tr.err .out{color:var(--err)}
.chip{display:inline-block;font-size:10px;padding:1px 5px;border-radius:9px;border:1px solid var(--line);color:var(--dim);margin-right:6px}
.chip.llm_call{border-color:var(--bar);color:var(--bar)} .chip.question,.chip.answer{border-color:#9c5c16;color:#9c5c16}
</style>
<h1>${runId}</h1>
<div class="meta">${s.llmCalls} звернень до моделі · ${s.toolCalls} викликів інструментів · ${s.errors} помилок ·
${ms(s.durationMs)} · ${s.inputTokens}→${s.outputTokens} токенів · ${money(s.cost) || "$0"}</div>
<table>${rows.join("")}</table>`;
}

function escape(text: string): string {
  return text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
}
