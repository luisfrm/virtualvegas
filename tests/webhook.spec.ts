import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DAILY_BONUS, INITIAL_CREDITS } from "../src/config";
import {
  WEBHOOK_PATH,
  allTexts,
  installTelegramStub,
  resetDatabase,
  resetSentMessages,
  textUpdate,
  textsSentTo,
  unexpectedRequests,
  webhookInit,
} from "./helpers";

const USER = 777;
const SECRET = "test-webhook-secret-0123456789";

/** Llama al worker tal y como lo haría Telegram. */
async function post(update: unknown, headers?: Record<string, string>): Promise<Response> {
  return exports.default.fetch(WEBHOOK_PATH, webhookInit(update, headers));
}

async function balanceOf(userId: number): Promise<number | null> {
  const row = await env.DB.prepare(`SELECT credits FROM users WHERE user_id = ?`)
    .bind(userId)
    .first<{ credits: number }>();
  return row?.credits ?? null;
}

async function ledgerRows(userId: number): Promise<{ amount: number; reason: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT amount, reason FROM transactions WHERE user_id = ? ORDER BY id`,
  )
    .bind(userId)
    .all<{ amount: number; reason: string }>();
  return results ?? [];
}

beforeAll(() => {
  installTelegramStub();
});

beforeEach(async () => {
  resetSentMessages();
  await resetDatabase(env.DB);
});

describe("rutas del Worker", () => {
  it("/health responde sin tocar nada más", async () => {
    const response = await exports.default.fetch("https://virtualvegas.test/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it("una ruta desconocida devuelve 404", async () => {
    const response = await exports.default.fetch("https://virtualvegas.test/otra");
    expect(response.status).toBe(404);
  });
});

describe("aislamiento de los tests", () => {
  /**
   * El plugin carga los secretos de .dev.vars (que tiene el token de verdad),
   * así que hay que comprobar que las bindings del test ganan. Si esto fallara,
   * un test podría llegar a llamar a la API real de Telegram con el token real.
   */
  it("usa los secretos de mentira, no los de .dev.vars", () => {
    expect(env.BOT_TOKEN).toBe("1234567890:TEST-token-aaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(env.WEBHOOK_SECRET).toBe(SECRET);
  });
});

describe("validación del webhook", () => {
  it("rechaza el POST sin secret token", async () => {
    const response = await exports.default.fetch(WEBHOOK_PATH, {
      method: "POST",
      body: JSON.stringify(textUpdate({ updateId: 1, text: "/ping", userId: USER })),
    });
    expect(response.status).toBe(403);
    expect(textsSentTo(USER)).toHaveLength(0);
  });

  it("rechaza el secret token equivocado", async () => {
    const response = await post(textUpdate({ updateId: 2, text: "/ping", userId: USER }), {
      "X-Telegram-Bot-Api-Secret-Token": "secreto-inventado-0123456789",
    });
    expect(response.status).toBe(403);
  });

  it("rechaza el método GET", async () => {
    const response = await exports.default.fetch(WEBHOOK_PATH, {
      headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET },
    });
    expect(response.status).toBe(405);
  });

  it("rechaza un cuerpo que no es un update", async () => {
    const response = await post({ hola: "mundo" });
    expect(response.status).toBe(400);
  });
});

describe("/ping de punta a punta", () => {
  it("responde atravesando Worker, Durable Object y D1", async () => {
    const response = await post(textUpdate({ updateId: 10, text: "/ping", userId: USER }));
    expect(response.status).toBe(200);

    const textos = textsSentTo(USER);
    expect(textos).toHaveLength(1);
    expect(textos[0]).toContain("pong");
    expect(textos[0]).toContain("Worker");
    expect(textos[0]).toContain("D1");
    // La sala existe de verdad: el mensaje lleva el id del Durable Object.
    expect(textos[0]).toMatch(/Sala <code>[0-9a-f]{8}<\/code>/);
  });

  it("cuenta en D1 los jugadores registrados", async () => {
    await post(textUpdate({ updateId: 11, text: "/ping", userId: USER }));
    expect(textsSentTo(USER)[0]).toContain("1 jugadores registrados");
  });
});

describe("deduplicación de webhooks reenviados", () => {
  it("el mismo update_id solo se atiende una vez", async () => {
    const update = textUpdate({ updateId: 20, text: "/ping", userId: USER });

    const primera = await post(update);
    const repetida = await post(update);

    expect(primera.status).toBe(200);
    expect(repetida.status).toBe(200);
    expect(textsSentTo(USER)).toHaveLength(1);
  });

  it("el mismo update reenviado a la vez tampoco se duplica", async () => {
    const update = textUpdate({ updateId: 21, text: "/ping", userId: USER });
    const respuestas = await Promise.all([post(update), post(update), post(update)]);

    expect(respuestas.every((r) => r.status === 200)).toBe(true);
    expect(textsSentTo(USER)).toHaveLength(1);
  });

  it("updates distintos sí se atienden los dos", async () => {
    await post(textUpdate({ updateId: 30, text: "/ping", userId: USER }));
    await post(textUpdate({ updateId: 31, text: "/ping", userId: USER }));
    expect(textsSentTo(USER)).toHaveLength(2);
  });
});

describe("comandos de Fase 1", () => {
  it("/saldo reserva la cuenta con el saldo inicial y su asiento", async () => {
    await post(textUpdate({ updateId: 40, text: "/saldo", userId: USER }));

    expect(await balanceOf(USER)).toBe(INITIAL_CREDITS);
    expect(await ledgerRows(USER)).toEqual([{ amount: INITIAL_CREDITS, reason: "initial" }]);
    expect(textsSentTo(USER)[0]).toContain("100");
  });

  it("/bono paga una sola vez por día", async () => {
    await post(textUpdate({ updateId: 41, text: "/bono", userId: USER }));
    await post(textUpdate({ updateId: 42, text: "/bono", userId: USER }));

    expect(await balanceOf(USER)).toBe(INITIAL_CREDITS + DAILY_BONUS);
    expect(await ledgerRows(USER)).toEqual([
      { amount: INITIAL_CREDITS, reason: "initial" },
      { amount: DAILY_BONUS, reason: "bonus" },
    ]);
    expect(textsSentTo(USER)[1]).toContain("Ya has cobrado");
  });

  /**
   * Un mismo usuario pidiendo el bono desde seis grupos distintos a la vez:
   * cada grupo es un Durable Object diferente, así que aquí SÍ hay escrituras
   * concurrentes contra D1. La clave de idempotencia por día y el guard del
   * UPDATE son lo único que impide que cobre seis veces.
   *
   * (Dentro de un mismo chat la carrera es imposible: el DO serializa todos los
   * updates de su chat por diseño.)
   */
  it("pedir el bono desde varios grupos a la vez no multiplica el pago", async () => {
    const chats = [-1001, -1002, -1003, -1004, -1005, -1006];

    const respuestas = await Promise.all(
      chats.map((chatId, index) =>
        post(
          textUpdate({
            updateId: 100 + index,
            text: "/bono",
            userId: USER,
            chatId,
            chatType: "supergroup",
          }),
        ),
      ),
    );

    expect(respuestas.every((r) => r.status === 200)).toBe(true);
    expect(await balanceOf(USER)).toBe(INITIAL_CREDITS + DAILY_BONUS);

    const asientos = await ledgerRows(USER);
    expect(asientos.filter((a) => a.reason === "bonus")).toHaveLength(1);

    const cobrados = allTexts().filter((t) => t.includes("Bono diario"));
    expect(cobrados).toHaveLength(1);
  });

  it("/ranking en privado muestra la tabla global", async () => {
    await post(textUpdate({ updateId: 50, text: "/saldo", userId: USER }));
    await post(textUpdate({ updateId: 51, text: "/ranking", userId: USER }));

    expect(textsSentTo(USER)[1]).toContain("Ranking global");
  });

  it("un comando desconocido recibe el aviso de /ayuda", async () => {
    await post(textUpdate({ updateId: 60, text: "/tragamonedas", userId: USER }));
    expect(textsSentTo(USER)[0]).toContain("/ayuda");
  });

  it("no hace ninguna petición de red que no sea al Bot API", async () => {
    await post(textUpdate({ updateId: 70, text: "/saldo", userId: USER }));
    expect(unexpectedRequests).toEqual([]);
  });
});
