import { loadEnv } from "./env";

import Anthropic from "@anthropic-ai/sdk";

loadEnv();

// Ключ не передаємо явно — SDK сам читає process.env.ANTHROPIC_API_KEY.
const client = new Anthropic();

const response = await client.messages.create({
  model: "claude-opus-5",
  max_tokens: 1024,
  messages: [
    { role: "user", content: "Одним реченням: чому Messages API називають stateless?" },
  ],
});

for (const block of response.content) {
  if (block.type === "text") console.log(block.text);
}

console.log("stop_reason:", response.stop_reason);
console.log("usage:", response.usage.input_tokens, "→", response.usage.output_tokens);
