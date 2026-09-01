import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

// Ось вона, вся "памʼять" — звичайна змінна.
const messages: Anthropic.MessageParam[] = [
  { role: "user", content: "Запамʼятай: мене звати Михайло." },
];

const first = await client.messages.create({
  model: "claude-opus-5",
  max_tokens: 1024,
  messages,
});

// Крок, якого не було в ping.ts: дописуємо відповідь моделі назад в історію.
// Кладемо весь first.content, а не витягнутий текст.
messages.push({ role: "assistant", content: first.content });

// Тепер наступне питання йде разом з усім, що було до нього.
messages.push({ role: "user", content: "Як мене звати?" });

const second = await client.messages.create({
  model: "claude-opus-5",
  max_tokens: 1024,
  messages,
});

for (const block of second.content) {
  if (block.type === "text") console.log(block.text);
}

console.log("\nдовжина історії:", messages.length);
console.log("input_tokens: 1-й виклик", first.usage.input_tokens, "| 2-й", second.usage.input_tokens);
