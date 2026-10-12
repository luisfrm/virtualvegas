/**
 * Doble de la API de Telegram.
 *
 * El plugin actual ya no trae `fetchMock`, así que se intercepta el `fetch`
 * global. grammY lo lee al construir su cliente (`customFetch ?? fetch`), y el
 * cliente se construye de forma perezosa en la primera petición de cada sala,
 * así que basta con instalar el stub antes de mandar el primer update.
 */

export const TELEGRAM_ORIGIN = "https://api.telegram.org";

export const BOT_INFO = {
  id: 1_234_567_890,
  is_bot: true,
  first_name: "VirtualVegas",
  username: "virtualvegas_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

export interface SentMessage {
  chat_id: number;
  text?: string;
  parse_mode?: string;
  reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
}

export interface EditedMessage {
  chat_id: number;
  message_id: number;
  text?: string;
  reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
}

/** Todo lo que el bot ha enviado, en orden. */
export const sentMessages: SentMessage[] = [];

/** Ediciones de mensajes: el lobby y la partida se pintan editando el original. */
export const editedMessages: EditedMessage[] = [];

/** Respuestas a los botones. Telegram deja el botón girando si no se contesta. */
export const answeredCallbacks: { callback_query_id: string; text?: string }[] = [];

/** Peticiones de red que no son a la API de Telegram: no debería haber ninguna. */
export const unexpectedRequests: string[] = [];

let installed = false;

export function installTelegramStub(): void {
  if (installed) return;
  installed = true;

  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (!url.startsWith(TELEGRAM_ORIGIN)) {
      unexpectedRequests.push(url);
      throw new Error(`petición de red no simulada: ${url}`);
    }

    const method = url.split("/").pop();

    if (method === "getMe") {
      return json({ ok: true, result: BOT_INFO });
    }

    if (method === "sendMessage") {
      const payload = JSON.parse(String(init?.body ?? "{}")) as SentMessage;
      sentMessages.push(payload);
      return json({
        ok: true,
        result: {
          message_id: sentMessages.length,
          date: 1_700_000_000,
          from: BOT_INFO,
          chat: { id: payload.chat_id, type: "private" },
          text: payload.text ?? "",
        },
      });
    }

    if (method === "editMessageText") {
      const payload = JSON.parse(String(init?.body ?? "{}")) as EditedMessage;
      editedMessages.push(payload);
      return json({
        ok: true,
        result: {
          message_id: payload.message_id,
          date: 1_700_000_000,
          from: BOT_INFO,
          chat: { id: payload.chat_id, type: "private" },
          text: payload.text ?? "",
        },
      });
    }

    if (method === "answerCallbackQuery") {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        callback_query_id: string;
        text?: string;
      };
      answeredCallbacks.push(payload);
      return json({ ok: true, result: true });
    }

    // Cualquier otro método del Bot API se declara como no simulado: si un test
    // falla por aquí, es que falta por cubrir, no que Telegram se haya caído.
    return json({ ok: false, error_code: 404, description: `método no simulado: ${method}` }, 404);
  };

  (globalThis as unknown as { fetch: typeof fetch }).fetch = stub as unknown as typeof fetch;
}

export function resetSentMessages(): void {
  sentMessages.length = 0;
  editedMessages.length = 0;
  answeredCallbacks.length = 0;
  unexpectedRequests.length = 0;
}

export function textsSentTo(chatId: number): string[] {
  return sentMessages
    .filter((m) => m.chat_id === chatId)
    .map((m) => m.text ?? "");
}

/** Todos los textos enviados, sea cual sea el chat. */
export function allTexts(): string[] {
  return sentMessages.map((m) => m.text ?? "");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export interface UpdateOptions {
  updateId: number;
  text: string;
  userId: number;
  /** Por defecto, el chat privado del propio usuario. */
  chatId?: number;
  chatType?: "private" | "group" | "supergroup";
  /** Para poder distinguir jugadores en los mensajes. */
  firstName?: string;
}

export function textUpdate(options: UpdateOptions): Record<string, unknown> {
  const { updateId, text, userId } = options;
  const chatId = options.chatId ?? userId;
  const chatType = options.chatType ?? "private";
  const firstName = options.firstName ?? "Ana";
  const command = text.split(/\s+/)[0] ?? text;

  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: userId, is_bot: false, first_name: firstName, language_code: "es" },
      chat:
        chatType === "private"
          ? { id: chatId, type: "private", first_name: firstName }
          : { id: chatId, type: chatType, title: "Sala de pruebas" },
      date: 1_700_000_000,
      text,
      entities: [{ type: "bot_command", offset: 0, length: command.length }],
    },
  };
}

/**
 * Vacía el estado global entre tests.
 *
 * El plugin de Vitest actual ya no trae aislamiento de almacenamiento por test
 * (no hay opción `isolatedStorage`), así que sin esto un test hereda el saldo y
 * los asientos del anterior. Se limpia a mano para que cada test sea
 * independiente y no dependa del orden en que se ejecute.
 */
export async function resetDatabase(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM transactions"),
    db.prepare("DELETE FROM processed_updates"),
    db.prepare("DELETE FROM payments"),
    db.prepare("DELETE FROM users"),
  ]);
}

export interface CallbackOptions {
  updateId: number;
  userId: number;
  chatId: number;
  /** `callback_query.id`: el dedupe de clics va por aquí. */
  callbackId: string;
  data: string;
  messageId?: number;
  firstName?: string;
}

/** Un clic en un botón inline, tal y como lo entrega Telegram. */
export function callbackUpdate(options: CallbackOptions): Record<string, unknown> {
  const { updateId, userId, chatId, callbackId, data } = options;
  return {
    update_id: updateId,
    callback_query: {
      id: callbackId,
      from: {
        id: userId,
        is_bot: false,
        first_name: options.firstName ?? "Ana",
        language_code: "es",
      },
      message: {
        message_id: options.messageId ?? 1,
        from: BOT_INFO,
        chat: { id: chatId, type: "supergroup", title: "Sala de pruebas" },
        date: 1_700_000_000,
        text: "(mensaje del lobby)",
      },
      chat_instance: "1",
      data,
    },
  };
}

export const WEBHOOK_PATH = "https://virtualvegas.test/webhook";

export function webhookInit(
  body: unknown,
  headers: Record<string, string> = {},
): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret-0123456789",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}
