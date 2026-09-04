import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { envFile } from "./env";

/**
 * Публічна адреса для локального сервера трейсів. Без неї посилання в коментарі
 * веде на localhost — тобто не відкривається ні з телефона, ні в колеги, а саме
 * заради цього serve і робився.
 *
 * Швидкий тунель Cloudflare не потребує акаунта, але видає нову адресу на кожен
 * запуск — тому її треба записувати, а не запамʼятовувати.
 */

export type Tunnel = { url: string; stop: () => void };

const URL_LINE = /https:\/\/[\w-]+\.trycloudflare\.com/;

export async function openTunnel(port: number, log: (l: string) => void): Promise<Tunnel | null> {
  let child: ChildProcess;
  try {
    child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    log("cloudflared не знайдено: brew install cloudflared");
    return null;
  }

  const url = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 30_000);
    const onData = (chunk: Buffer): void => {
      const found = URL_LINE.exec(chunk.toString());
      if (!found) return;
      clearTimeout(timer);
      resolve(found[0]);
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData); // cloudflared пише адресу саме сюди
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });

  if (!url) {
    child.kill();
    log("тунель не піднявся; чи встановлено cloudflared?");
    return null;
  }

  return { url, stop: () => child.kill() };
}

/**
 * Адреса потрібна не цьому процесу, а планувальнику, який складає звіт, — тому
 * лягає у спільний ~/.devflow/.env, а не в памʼять.
 */
export async function rememberServeUrl(url: string | null): Promise<void> {
  const file = envFile();
  const current = await fs.readFile(file, "utf8").catch(() => "");
  const without = current
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("DEVFLOW_SERVE_URL="))
    .join("\n");

  const body = url ? `${without}\nDEVFLOW_SERVE_URL=${url}\n` : `${without}\n`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body.replace(/^\n+/, ""), { mode: 0o600 });
}
