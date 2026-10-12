/**
 * `callback_data` admite **64 bytes** como máximo (no caracteres: bytes UTF-8).
 * Si se pasa, Telegram rechaza el mensaje entero, así que se comprueba al
 * construir el botón y no al enviarlo.
 *
 * Formato: `<ámbito>:<nonce>:<acción>` para los juegos, `<ámbito>:<acción>` para
 * el lobby.
 *
 * El `nonce` son los primeros caracteres del id de la partida. Sirve para que un
 * botón de una partida anterior, que sigue visible en el chat, no pueda actuar
 * sobre la partida nueva: la sala compara el nonce con el de la partida en curso
 * y descarta el clic.
 */

export const CALLBACK_LIMIT_BYTES = 64;

export type LobbyAction = "join" | "leave" | "start";

export type DecodedCallback =
  | { scope: "lobby"; action: LobbyAction }
  | { scope: "game"; nonce: string; action: string };

const LOBBY_ACTIONS: readonly LobbyAction[] = ["join", "leave", "start"];
const ACTION_PATTERN = /^[a-z0-9_-]{1,16}$/;

const encoder = new TextEncoder();

export function callbackBytes(data: string): number {
  return encoder.encode(data).length;
}

/** Falla en nuestro código, no en Telegram, si un botón no cabe. */
export function assertCallbackFits(data: string): string {
  const size = callbackBytes(data);
  if (size > CALLBACK_LIMIT_BYTES) {
    throw new Error(
      `callback_data de ${size} bytes supera el límite de ${CALLBACK_LIMIT_BYTES}: ${data}`,
    );
  }
  return data;
}

export function lobbyCallback(action: LobbyAction): string {
  return assertCallbackFits(`l:${action}`);
}

export function gameCallback(nonce: string, action: string): string {
  if (!ACTION_PATTERN.test(action)) {
    throw new Error(`acción de juego inválida: ${action}`);
  }
  return assertCallbackFits(`g:${nonce}:${action}`);
}

/** El nonce de una partida: corto para que quepa, único dentro de la sala. */
export function nonceFor(gameId: string): string {
  return gameId.replace(/[^a-z0-9]/gi, "").slice(0, 8);
}

export function decodeCallback(raw: string | undefined): DecodedCallback | null {
  if (!raw) return null;
  const parts = raw.split(":");

  if (parts[0] === "l" && parts.length === 2) {
    const action = parts[1] as LobbyAction;
    return LOBBY_ACTIONS.includes(action) ? { scope: "lobby", action } : null;
  }

  if (parts[0] === "g" && parts.length === 3) {
    const nonce = parts[1] ?? "";
    const action = parts[2] ?? "";
    if (nonce.length === 0 || !ACTION_PATTERN.test(action)) return null;
    return { scope: "game", nonce, action };
  }

  return null;
}
