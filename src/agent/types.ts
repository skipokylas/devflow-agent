import type Anthropic from "@anthropic-ai/sdk";

export type RunStatus = "running" | "waiting_human" | "done" | "failed";

/** Стан паузи: все, що потрібно, щоб відновити ітерацію після відповіді людини. */
export type Pending = {
  /** id блока tool_use, на який чекає відповідь. Без нього API не звʼяже result із запитом. */
  toolUseId: string;
  question: string;
  options: string[];
  /** Результати інших інструментів з тієї ж ітерації — підуть одним user-повідомленням разом з відповіддю. */
  partialResults: Anthropic.ToolResultBlockParam[];
};

export type Run = {
  id: string;
  status: RunStatus;
  /** Уся памʼять агента. Зберігається як є — те, що піде в messages.create. */
  messages: Anthropic.MessageParam[];
  /** null, коли run не на паузі. Саме null, а не undefined — щоб пережити JSON. */
  pending: Pending | null;
  /** Оптимістичне блокування: save проходить, тільки якщо у сховищі та сама версія. */
  version: number;
};
