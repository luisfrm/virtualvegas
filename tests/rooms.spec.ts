import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_BET, INITIAL_CREDITS, MIN_BET } from "../src/config";
import { touchUser } from "../src/core/users";
import { auditLedger, debit } from "../src/core/wallet";
import { gameCallback, lobbyCallback, callbackBytes } from "../src/telegram/callbackData";
import {
  WEBHOOK_PATH,
  answeredCallbacks,
  callbackUpdate,
  editedMessages,
  installTelegramStub,
  resetDatabase,
  resetSentMessages,
  sentMessages,
  textUpdate,
  webhookInit,
} from "./helpers";

/**
 * Motor de salas de punta a punta: los tests entran por el webhook, como
 * Telegram, y pasan por Worker → Durable Object → D1.
 *
 * Cada test usa un chat distinto a propósito. El plugin de Vitest ya no aísla el
 * almacenamiento por test, así que el estado del Durable Object sobrevive de un
 * test al siguiente; con un chat nuevo, cada test estrena sala.
 */

const ANA = 7001;
const BETO = 7002;
const CARLA = 7003;

let groupCounter = -1000;
function nextGroup(): number {
  groupCounter -= 1;
  return groupCounter;
}

let updateCounter = 1;
function nextUpdateId(): number {
  updateCounter += 1;
  return updateCounter;
}

async function post(update: unknown): Promise<Response> {
  return exports.default.fetch(WEBHOOK_PATH, webhookInit(update));
}

async function openLobby(chatId: number, bet: number, userId = ANA): Promise<void> {
  await post(
    textUpdate({
      updateId: nextUpdateId(),
      text: `/sorteo ${bet}`,
      userId,
      chatId,
      chatType: "supergroup",
    }),
  );
}

async function click(
  chatId: number,
  userId: number,
  data: string,
  callbackId: string,
  firstName?: string,
): Promise<void> {
  await post(
    callbackUpdate({
      updateId: nextUpdateId(),
      userId,
      chatId,
      callbackId,
      data,
      ...(firstName === undefined ? {} : { firstName }),
    }),
  );
}

async function balance(userId: number): Promise<number | null> {
  const row = await env.DB.prepare(`SELECT credits FROM users WHERE user_id = ?`)
    .bind(userId)
    .first<{ credits: number }>();
  return row?.credits ?? null;
}

async function ledger(userId: number): Promise<{ amount: number; reason: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT amount, reason FROM transactions WHERE user_id = ? ORDER BY id`,
  )
    .bind(userId)
    .all<{ amount: number; reason: string }>();
  return results ?? [];
}

async function roomPhase(chatId: number): Promise<string | undefined> {
  const stub = env.ROOMS.get(env.ROOMS.idFromName(String(chatId)));
  const rows = await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ phase: string }>(`SELECT phase FROM room WHERE id = 1`)
      .toArray(),
  );
  return rows[0]?.phase;
}

/** Todo el texto que el bot ha puesto en un chat, enviado o editado. */
function textsTo(chatId: number): string[] {
  return [
    ...sentMessages.filter((m) => m.chat_id === chatId).map((m) => m.text ?? ""),
    ...editedMessages.filter((m) => m.chat_id === chatId).map((m) => m.text ?? ""),
  ];
}

/** La última respuesta suelta del bot en ese chat (no una edición). */
function lastReply(chatId: number): string {
  return sentMessages.filter((m) => m.chat_id === chatId).at(-1)?.text ?? "";
}

beforeAll(() => {
  installTelegramStub();
});

beforeEach(async () => {
  resetSentMessages();
  await resetDatabase(env.DB);
});

describe("sorteo de punta a punta", () => {
  it("completa el ciclo: lobby, arranque, reparto y mesa libre", async () => {
    const chat = nextGroup();

    await openLobby(chat, 5);
    expect(await balance(ANA)).toBe(INITIAL_CREDITS - 5);
    expect(await roomPhase(chat)).toBe("LOBBY");

    await click(chat, BETO, lobbyCallback("join"), "cb-join", "Beto");
    expect(await balance(BETO)).toBe(INITIAL_CREDITS - 5);

    await click(chat, ANA, lobbyCallback("start"), "cb-start");

    const saldos = [await balance(ANA), await balance(BETO)];
    // El pozo son 10 y con un pozo tan pequeño la casa no se lleva nada.
    expect(saldos.reduce<number>((total, saldo) => total + (saldo ?? 0), 0)).toBe(
      INITIAL_CREDITS * 2,
    );
    expect([...saldos].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([95, 105]);

    const ganador = saldos[0] === 105 ? ANA : BETO;
    const perdedor = ganador === ANA ? BETO : ANA;
    expect((await ledger(ganador)).map((row) => row.reason)).toEqual([
      "initial",
      "bet",
      "payout",
    ]);
    expect(await ledger(perdedor)).toEqual([
      { amount: INITIAL_CREDITS, reason: "initial" },
      { amount: -5, reason: "bet" },
    ]);

    // Lo que de verdad importa: el saldo cacheado sigue cuadrando con el ledger.
    expect(await auditLedger(env.DB)).toMatchObject({ ok: true, broken: [] });

    // Y la mesa queda libre para la siguiente partida.
    expect(await roomPhase(chat)).toBe("IDLE");
  });

  it("deja el ranking del grupo midiendo solo lo jugado", async () => {
    const chat = nextGroup();

    await openLobby(chat, 5);
    await click(chat, BETO, lobbyCallback("join"), "cb-join", "Beto");
    await click(chat, ANA, lobbyCallback("start"), "cb-start");

    const ganadorEsAna = (await balance(ANA)) === 105;
    const ganador = ganadorEsAna ? "Ana" : "Beto";

    await post(
      textUpdate({
        updateId: nextUpdateId(),
        text: "/ranking",
        userId: ANA,
        chatId: chat,
        chatType: "supergroup",
      }),
    );

    const ranking = lastReply(chat);
    expect(ranking).toContain("Ranking de este grupo");
    // Ganancia neta jugada: el ganador se llevó el pozo y pagó su apuesta.
    expect(ranking).toContain(`1. ${ganador} — <b>5</b>`);
  });
});

describe("lobby cancelado", () => {
  it("devuelve las apuestas cuando vence el plazo", async () => {
    const chat = nextGroup();

    await openLobby(chat, 7);
    await click(chat, BETO, lobbyCallback("join"), "cb-join", "Beto");
    expect(await balance(ANA)).toBe(INITIAL_CREDITS - 7);
    expect(await balance(BETO)).toBe(INITIAL_CREDITS - 7);

    const stub = env.ROOMS.get(env.ROOMS.idFromName(String(chat)));
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    expect(await balance(ANA)).toBe(INITIAL_CREDITS);
    expect(await balance(BETO)).toBe(INITIAL_CREDITS);
    expect(await ledger(ANA)).toEqual([
      { amount: INITIAL_CREDITS, reason: "initial" },
      { amount: -7, reason: "bet" },
      { amount: 7, reason: "refund" },
    ]);
    expect(await auditLedger(env.DB)).toMatchObject({ ok: true });
    expect(await roomPhase(chat)).toBe("IDLE");
    expect(textsTo(chat).join("\n")).toContain("Apuestas devueltas");
  });

  it("no devuelve el dinero dos veces si la alarma vuelve a sonar", async () => {
    const chat = nextGroup();

    await openLobby(chat, 10);
    await click(chat, BETO, lobbyCallback("join"), "cb-join", "Beto");

    const stub = env.ROOMS.get(env.ROOMS.idFromName(String(chat)));
    await runDurableObjectAlarm(stub);

    // Se vuelve a invocar el manejador de la alarma aunque la mesa ya esté
    // cerrada: es la garantía que importa, porque una alarma puede repetirse.
    // Se llama al método directamente en vez de rearmar la alarma para que la
    // prueba no dependa de cuándo decide workerd dispararla.
    await runInDurableObject(stub, (instance) => instance.alarm());

    expect(await balance(ANA)).toBe(INITIAL_CREDITS);
    expect(await balance(BETO)).toBe(INITIAL_CREDITS);
    const devoluciones = (await ledger(ANA)).filter((row) => row.reason === "refund");
    expect(devoluciones).toHaveLength(1);
    expect(await auditLedger(env.DB)).toMatchObject({ ok: true });
    expect(await roomPhase(chat)).toBe("IDLE");
  });
});

describe("validaciones del lobby", () => {
  it("no deja empezar a quien no abrió la partida", async () => {
    const chat = nextGroup();
    await openLobby(chat, 5);
    await click(chat, BETO, lobbyCallback("join"), "cb-join", "Beto");

    await click(chat, BETO, lobbyCallback("start"), "cb-start-beto");

    expect(answeredCallbacks.at(-1)?.text).toContain("Solo quien abrió la partida");
    expect(await roomPhase(chat)).toBe("LOBBY");
  });

  it("no arranca con menos jugadores del mínimo", async () => {
    const chat = nextGroup();
    await openLobby(chat, 5);

    await click(chat, ANA, lobbyCallback("start"), "cb-start-sola");

    expect(answeredCallbacks.at(-1)?.text).toContain("al menos 2 jugadores");
    expect(await roomPhase(chat)).toBe("LOBBY");
  });

  it("no deja entrar cuando la partida está llena", async () => {
    const chat = nextGroup();
    await openLobby(chat, 1);

    // El anfitrión ya ocupa una plaza; el sorteo admite 8 en total.
    for (let i = 0; i < 7; i += 1) {
      await click(chat, 8100 + i, lobbyCallback("join"), `cb-join-${i}`, `Jugador ${i}`);
    }

    await click(chat, 8199, lobbyCallback("join"), "cb-join-tarde", "Tarde");
    expect(answeredCallbacks.at(-1)?.text).toContain("está llena");
  });

  it("no deja apostar más de lo que se tiene, y suelta la mesa", async () => {
    const chat = nextGroup();

    await touchUser(env.DB, {
      userId: CARLA,
      username: null,
      firstName: "Carla",
      languageCode: "es",
    });
    await debit(env.DB, {
      userId: CARLA,
      amount: INITIAL_CREDITS - 3,
      reason: "bet",
      origin: "game",
      idempotencyKey: "test:carla:casi-sin-saldo",
    });

    await openLobby(chat, DEFAULT_MAX_BET, CARLA);

    expect(textsTo(chat).join("\n")).toContain("No te llega el saldo");
    // La sala no se queda abierta con una apuesta que nadie ha pagado.
    expect(await roomPhase(chat)).toBe("IDLE");
  });

  it("rechaza apuestas que no son un entero dentro del rango", async () => {
    const chat = nextGroup();

    for (const raw of ["0", "999", "abc", "-5", "2.5"]) {
      await post(
        textUpdate({
          updateId: nextUpdateId(),
          text: `/sorteo ${raw}`,
          userId: ANA,
          chatId: chat,
          chatType: "supergroup",
        }),
      );
      expect(lastReply(chat)).toContain(`entre ${MIN_BET} y ${DEFAULT_MAX_BET}`);
    }

    // El registro del middleware es implícito, así que la cuenta existe; lo que
    // no puede haber es ningún cargo: la partida no llegó a abrirse.
    expect(await balance(ANA)).toBe(INITIAL_CREDITS);
    expect((await ledger(ANA)).map((row) => row.reason)).toEqual(["initial"]);
  });

  it("avisa de que los juegos grupales van en un grupo", async () => {
    await post(textUpdate({ updateId: nextUpdateId(), text: "/sorteo 5", userId: ANA }));
    expect(lastReply(ANA)).toContain("en un grupo");
  });
});

describe("botones", () => {
  it("responde siempre al callback, incluso si el botón no vale", async () => {
    const chat = nextGroup();
    await openLobby(chat, 5);

    const antes = answeredCallbacks.length;
    await click(chat, BETO, "basura", "cb-basura");

    expect(answeredCallbacks.length).toBe(antes + 1);
    expect(answeredCallbacks.at(-1)?.callback_query_id).toBe("cb-basura");
    expect(answeredCallbacks.at(-1)?.text).toBeUndefined();
  });

  it("descarta los botones de una partida que ya no está en marcha", async () => {
    const chat = nextGroup();
    await openLobby(chat, 5);

    // Botón de juego con un nonce que no es el de la partida en curso.
    await click(chat, ANA, gameCallback("deadbeef", "pass"), "cb-viejo");

    expect(answeredCallbacks.at(-1)?.text).toContain("partida que ya no está en marcha");
  });

  it("un clic reenviado no se cobra dos veces", async () => {
    const chat = nextGroup();
    await openLobby(chat, 5);

    const clic = () =>
      post(
        callbackUpdate({
          updateId: nextUpdateId(),
          userId: BETO,
          chatId: chat,
          callbackId: "cb-repetido",
          data: lobbyCallback("join"),
          firstName: "Beto",
        }),
      );

    await clic();
    await clic();

    expect(await balance(BETO)).toBe(INITIAL_CREDITS - 5);
    expect((await ledger(BETO)).filter((row) => row.reason === "bet")).toHaveLength(1);
  });

  it("salir del lobby devuelve la apuesta", async () => {
    const chat = nextGroup();
    await openLobby(chat, 8);
    await click(chat, BETO, lobbyCallback("join"), "cb-join", "Beto");
    expect(await balance(BETO)).toBe(INITIAL_CREDITS - 8);

    await click(chat, BETO, lobbyCallback("leave"), "cb-leave");

    expect(await balance(BETO)).toBe(INITIAL_CREDITS);
    expect(answeredCallbacks.at(-1)?.text).toContain("Has salido");
    expect(await auditLedger(env.DB)).toMatchObject({ ok: true });
  });
});

describe("callback_data", () => {
  it("todos los botones caben en los 64 bytes que admite Telegram", () => {
    for (const action of ["join", "leave", "start"] as const) {
      expect(callbackBytes(lobbyCallback(action))).toBeLessThanOrEqual(64);
    }
    // El caso más largo posible: nonce de 8 y acción de 16 caracteres.
    expect(callbackBytes(gameCallback("12345678", "abcdefghijklmnop"))).toBeLessThanOrEqual(64);
  });

  it("los botones que el lobby envía caben de verdad", async () => {
    const chat = nextGroup();
    await openLobby(chat, 5);

    const keyboard = sentMessages.find((m) => m.chat_id === chat)?.reply_markup?.inline_keyboard;
    expect(keyboard).toBeDefined();
    const buttons = (keyboard ?? []).flat();
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(callbackBytes(button.callback_data)).toBeLessThanOrEqual(64);
    }
  });
});
