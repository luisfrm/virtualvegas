import { z } from "zod";
import type { RoomDO } from "./rooms/RoomDO";

/**
 * Bindings y secretos. Los bindings se declaran en wrangler.toml; los secretos
 * se suben con `wrangler secret put` y nunca viven en el repositorio.
 *
 * Hay UN solo nombre de secreto, `BOT_TOKEN`, y su valor cambia por entorno.
 * La razón de tener dos bots de BotFather no es el nombre de la variable: es
 * que Telegram admite una única URL de webhook por bot, así que un bot no puede
 * apuntar a dev y a producción a la vez.
 */
export interface Env {
  /** D1: usuarios, ledger, pagos. La fuente de verdad del dinero. */
  DB: D1Database;
  /** Durable Objects: una sala por chat_id. */
  ROOMS: DurableObjectNamespace<RoomDO>;
  /** Token del bot (secreto). */
  BOT_TOKEN: string;
  /** Token para validar que el POST viene de Telegram (secreto). */
  WEBHOOK_SECRET: string;
  /** "dev" | "production". */
  ENVIRONMENT: string;
}

export const secretSchema = z.object({
  BOT_TOKEN: z.string().min(20, "BOT_TOKEN vacío o incompleto"),
  WEBHOOK_SECRET: z.string().min(16, "WEBHOOK_SECRET demasiado corto (mínimo 16 caracteres)"),
});

/**
 * Falla pronto y con un mensaje claro si falta un secreto, en vez de dejar que
 * Telegram devuelva un 401 confuso más tarde.
 */
export function assertSecrets(env: Env): void {
  const parsed = secretSchema.safeParse({ BOT_TOKEN: env.BOT_TOKEN, WEBHOOK_SECRET: env.WEBHOOK_SECRET });
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Configuración inválida: ${detail}`);
  }
}
