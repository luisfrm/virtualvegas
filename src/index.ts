import { z } from "zod";
import { unixNow } from "./core/time";
import { assertSecrets, type Env } from "./env";
import { RoomDO } from "./rooms/RoomDO";

export { RoomDO };

/**
 * Entrada del Worker. Solo hay dos rutas y un `if` por ruta es más claro que
 * una dependencia HTTP; si algún día aparecen muchas rutas propias (mini app,
 * panel de admin, pagos externos), migrar a Hono es sencillo.
 *
 * El Worker es **sin estado**: valida el origen, descarta reenvíos y enruta al
 * Durable Object de la sala. Todo el diálogo vive en el DO.
 */

const updateEnvelope = z.object({ update_id: z.number().int() });

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, environment: env.ENVIRONMENT });
    }
    if (url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // 1. ¿Viene de Telegram? El secret token se configuró en setWebhook.
  const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!provided || !timingSafeEqual(provided, env.WEBHOOK_SECRET)) {
    return new Response("forbidden", { status: 403 });
  }

  // 2. Forma mínima del update. Se guarda el objeto crudo para reenviarlo tal cual.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  const envelope = updateEnvelope.safeParse(raw);
  if (!envelope.success) {
    // 400 porque un payload mal formado no se arregla reintentando.
    return new Response("invalid update", { status: 400 });
  }

  try {
    assertSecrets(env);
  } catch (error) {
    console.error("secretos mal configurados", error);
    return new Response("misconfigured", { status: 500 });
  }

  const { update_id: updateId } = envelope.data;
  const chatId = extractChatId(raw);

  // 3. Telegram reenvía webhooks. Reservamos el update_id antes de procesar:
  //    si ya estaba, es un duplicado y se ignora.
  const claimed = await claimUpdate(env.DB, updateId, chatId);
  if (!claimed) {
    return new Response(null, { status: 200 });
  }

  // 4. Enrutado: todo lo de un chat pasa por su misma sala.
  if (chatId === null) {
    // Updates sin chat (inline_query, poll…). No hay sala a la que enrutarlos.
    await settleUpdate(env.DB, updateId, true);
    return new Response(null, { status: 200 });
  }

  try {
    const id = env.ROOMS.idFromName(String(chatId));
    const response = await env.ROOMS.get(id).fetch("https://room/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(raw),
    });

    if (!response.ok) {
      // Un fallo de infraestructura sí merece un reintento de Telegram: se
      // libera la reserva del update para que el reenvío vuelva a intentarlo.
      await settleUpdate(env.DB, updateId, false);
      console.error("la sala devolvió error", { chatId, status: response.status });
      return new Response("room error", { status: 500 });
    }

    await settleUpdate(env.DB, updateId, true);
    return new Response(null, { status: 200 });
  } catch (error) {
    await settleUpdate(env.DB, updateId, false);
    console.error("fallo enrutando al Durable Object", { chatId, error });
    return new Response("internal error", { status: 500 });
  }
}

/**
 * Reserva el update. Cualquier fallo al leer/escribir aquí devuelve `true`
 * (seguimos adelante): perder un update es peor que procesarlo dos veces, y los
 * comandos de dinero son idempotentes por su clave de idempotencia.
 */
async function claimUpdate(db: D1Database, updateId: number, chatId: number | null): Promise<boolean> {
  try {
    const result = await db
      .prepare(
        `INSERT INTO processed_updates (update_id, status, chat_id, created_at)
         VALUES (?, 'processing', ?, ?)
             ON CONFLICT(update_id) DO NOTHING`,
      )
      .bind(updateId, chatId, unixNow())
      .run();
    return (result.meta?.changes ?? 0) === 1;
  } catch (error) {
    console.error("no se pudo reservar el update", { updateId, error });
    return true;
  }
}

async function settleUpdate(db: D1Database, updateId: number, ok: boolean): Promise<void> {
  try {
    if (ok) {
      await db
        .prepare(`UPDATE processed_updates SET status = 'done' WHERE update_id = ?`)
        .bind(updateId)
        .run();
    } else {
      await db
        .prepare(`DELETE FROM processed_updates WHERE update_id = ?`)
        .bind(updateId)
        .run();
    }
  } catch (error) {
    console.error("no se pudo cerrar el update", { updateId, ok, error });
  }
}

/**
 * De qué chat viene el update. Se recorren solo las rutas que nos interesan y
 * ninguna implica leer el contenido del mensaje.
 *
 * Nota para la Fase 4: si un grupo se convierte en supergrupo, Telegram avisa
 * con `migrate_to_chat_id` y el `chat_id` cambia. Un Durable Object no se puede
 * renombrar, así que lo previsto es una tabla de mapeo en D1
 * (`chat_id` → `active_chat_id`) y enrutar siempre por el id activo.
 */
const CHAT_PATHS: readonly (readonly string[])[] = [
  ["message"],
  ["edited_message"],
  ["channel_post"],
  ["edited_channel_post"],
  ["callback_query", "message"],
  ["my_chat_member"],
  ["chat_member"],
  ["chat_join_request"],
  ["message_reaction"],
];

function extractChatId(update: unknown): number | null {
  for (const path of CHAT_PATHS) {
    let node: unknown = update;
    for (const key of path) {
      if (typeof node !== "object" || node === null) {
        node = undefined;
        break;
      }
      node = (node as Record<string, unknown>)[key];
    }
    if (typeof node === "object" && node !== null) {
      const id = (node as { chat?: { id?: unknown } }).chat?.id;
      if (typeof id === "number") return id;
    }
  }
  return null;
}

/**
 * Comparación en tiempo constante. El token del webhook es un secreto corto:
 * comparar con `===` filtraría por temporización cuántos caracteres acertó.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
