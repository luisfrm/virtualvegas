import { InlineKeyboard } from "grammy";
import type { Translator } from "../games/types";
import { lobbyCallback } from "./callbackData";

/**
 * Teclado del lobby.
 *
 * Ojo: un teclado inline es **el mismo para todos** los que ven el mensaje. No
 * se puede esconder el botón de "Empezar" a quien no es el anfitrión, ni quitar
 * el de "Unirme" a quien ya está dentro. Por eso el botón se enseña siempre y
 * quien autoriza es el manejador de la sala, que sí sabe quién ha pulsado.
 */
export function lobbyKeyboard(tr: Translator, options: { joined: boolean }): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (options.joined) {
    keyboard.text(tr("lobby.btn.leave"), lobbyCallback("leave"));
  } else {
    keyboard.text(tr("lobby.btn.join"), lobbyCallback("join"));
  }

  keyboard.text(tr("lobby.btn.start"), lobbyCallback("start"));
  return keyboard;
}
