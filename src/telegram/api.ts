import { Api } from "grammy";
import type { Env } from "../env";

/**
 * Cliente del Bot API, compartido por el Worker y el Durable Object.
 *
 * Se usa un cliente suelto (y no el `ctx` de un handler) porque la sala tiene
 * que poder editar mensajes y mover cosas **sin** que nadie haya escrito: cuando
 * salta la alarma de un lobby vencido no hay petición entrante que responder.
 *
 * Se crea una vez por instancia del DO y se reutiliza.
 */
export function createTelegramApi(env: Env): Api {
  return new Api(env.BOT_TOKEN);
}
