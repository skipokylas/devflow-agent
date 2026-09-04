import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rememberServeUrl } from "./tunnel";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
}

// Пишемо у справжній ~/.devflow/.env, тому спершу зберігаємо вміст і відновимо.
const file = path.join(os.homedir(), ".devflow", ".env");
const original = await fs.readFile(file, "utf8").catch(() => null);

try {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "ANTHROPIC_API_KEY=sk-test\nGITHUB_TOKEN=ghp-test\n", { mode: 0o600 });

  await rememberServeUrl("https://example.trycloudflare.com");
  let body = await fs.readFile(file, "utf8");
  check("адреса записана", body.includes("DEVFLOW_SERVE_URL=https://example.trycloudflare.com"));
  check("наявні секрети не зачеплені", body.includes("ANTHROPIC_API_KEY=sk-test") && body.includes("GITHUB_TOKEN=ghp-test"));

  await rememberServeUrl("https://second.trycloudflare.com");
  body = await fs.readFile(file, "utf8");
  check("повторний запис не дублює рядок", (body.match(/DEVFLOW_SERVE_URL=/g) ?? []).length === 1);
  check("адреса оновлена", body.includes("second.trycloudflare.com"));

  await rememberServeUrl(null);
  body = await fs.readFile(file, "utf8");
  check("після зупинки адреса прибрана", !body.includes("DEVFLOW_SERVE_URL"));
  check("секрети лишились", body.includes("ANTHROPIC_API_KEY=sk-test"));

  const mode = (await fs.stat(file)).mode & 0o777;
  check("права лишаються 0600", mode === 0o600, mode.toString(8));
} finally {
  if (original === null) await fs.rm(file, { force: true });
  else await fs.writeFile(file, original, { mode: 0o600 });
}

console.log(failed === 0 ? "\nусі перевірки пройшли" : `\nпровалено: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
