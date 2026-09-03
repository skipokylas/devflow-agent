import http from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { realLlm } from "./agent/llm";
import { fakeText } from "./agent/llm";

// Локальний сервер замість api.anthropic.com — показує, що саме шле SDK.
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    console.log(`${req.method} ${req.url}\n`);
    console.log("ЗАГОЛОВКИ:");
    for (const [k, v] of Object.entries(req.headers)) {
      if (["host", "connection", "accept-encoding", "content-length"].includes(k)) continue;
      console.log(`  ${k}: ${k === "x-api-key" ? "<приховано>" : v}`);
    }
    console.log("\nТІЛО ЗАПИТУ:");
    console.log(JSON.stringify(JSON.parse(body), null, 2));

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(fakeText("Відповідь від підробленого сервера.")));
  });
});

await new Promise<void>((r) => server.listen(8787, "127.0.0.1", r));

const llm = realLlm(new Anthropic({ apiKey: "test-key", baseURL: "http://127.0.0.1:8787" }));
const response = await llm({
  model: "claude-opus-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "додай magic links" }],
});

console.log("\nТІЛО ВІДПОВІДІ (як його бачить наш код):");
console.log(JSON.stringify({ content: response.content, stop_reason: response.stop_reason }, null, 2));

server.close();
