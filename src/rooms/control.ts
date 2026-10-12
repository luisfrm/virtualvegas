import type { Chat, User } from "grammy/types";
import type { Translator } from "../games/types";

/**
 * Lo que el bot necesita de la sala.
 *
 * El bot (que solo traduce updates a llamadas) depende de esta interfaz, no de la
 * clase del Durable Object. Así no hay ciclo de importaciones entre
 * `rooms/RoomDO.ts` y `telegram/bot.ts`, y en los tests se puede usar un doble.
 */
export interface RoomControl {
  /** Abre un lobby en el chat si no hay nada en marcha. */
  openLobby(params: {
    chat: Chat;
    from: User;
    engineType: string;
    bet: number;
    tr: Translator;
  }): Promise<void>;

  /**
   * Atiende un botón.
   * Devuelve el texto corto para `answerCallbackQuery` (puede ser `undefined`).
   * Quien llama **siempre** debe responder al callback, incluso si no hay texto:
   * Telegram deja el botón girando si no se le contesta.
   */
  handleCallback(params: {
    callbackId: string;
    data: string | undefined;
    from: User;
    chatId: number | null;
    tr: Translator;
  }): Promise<string | undefined>;
}
