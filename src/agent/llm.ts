import Anthropic from "@anthropic-ai/sdk";

export type LlmParams = Anthropic.MessageCreateParamsNonStreaming;

/** Порт: усе, що вміє відповісти на запит. Ядро агента знає тільки цей тип. */
export type Llm = (params: LlmParams) => Promise<Anthropic.Message>;

/** Реальна модель. Мережа, гроші, недетермінованість. */
export function realLlm(client: Anthropic = new Anthropic()): Llm {
  return (params) => client.messages.create(params);
}

/** Записані наперед відповіді. Без мережі, безкоштовно, однаково щоразу. */
export function scriptedLlm(script: Anthropic.Message[]): Llm {
  let i = 0;
  return async () => {
    const next = script[i++];
    if (!next) throw new Error(`scriptedLlm: скрипт вичерпано на виклику №${i}`);
    return next;
  };
}

/** Message має ~10 обовʼязкових полів, з яких у тестах цікаві два. Решта — шум. */
export function fakeMessage(
  content: Anthropic.ContentBlock[],
  stop_reason: Anthropic.StopReason = "end_turn",
): Anthropic.Message {
  return {
    id: `msg_fake_${Math.random().toString(36).slice(2, 8)}`,
    type: "message",
    role: "assistant",
    model: "claude-fake",
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    container: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
  };
}

export function fakeText(text: string): Anthropic.Message {
  return fakeMessage([{ type: "text", text, citations: null }]);
}

export function fakeToolUse(
  name: string,
  input: Record<string, unknown>,
  id = `toolu_fake_${Math.random().toString(36).slice(2, 8)}`,
): Anthropic.Message {
  return fakeMessage(
    [{ type: "tool_use", id, name, input, caller: { type: "direct" } }],
    "tool_use",
  );
}

/**
 * Офлайн-агент для наскрізної перевірки: відповідає, дивлячись на довжину історії.
 * На відміну від scriptedLlm працює й між процесами — стан бере з messages, а не з лічильника.
 */
export function demoLlm(): Llm {
  return async ({ messages }) => {
    if (messages.length <= 1) return fakeToolUse("read_file", { path: "package.json" });
    if (messages.length <= 3) {
      return fakeToolUse("ask_human", {
        question: "Який провайдер пошти використовувати для magic links?",
        options: ["resend", "postmark", "власний SMTP"],
      });
    }
    return fakeText("План:\n1) таблиця magic_links\n2) POST /auth/request\n3) GET /auth/verify");
  };
}
