#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// __dirname в ESM не існує — шлях виводимо з import.meta.url.
const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "src", "cli.ts");
const tsx = path.join(here, "..", "node_modules", ".bin", "tsx");

const result = spawnSync(tsx, [entry, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
