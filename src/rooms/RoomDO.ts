import { DurableObject } from "cloudflare:workers";
import type { Api, Bot, InlineKeyboard } from "grammy";
import type { Chat, Update, User } from "grammy/types";
import { LOBBY_SECONDS } from "../config";
import { translator, type TranslationKey } from "../core/i18n";
import { cryptoRng } from "../core/rng";
import { credit, debit, getBalance } from "../core/wallet";
import { getEngine } from "../games/registry";
import type { GameEngine, GameStep, PlayerRow, Translator } from "../games/types";
import type { Env } from "../env";
import { createBot } from "../telegram/bot";
import { createTelegramApi } from "../telegram/api";
import { decodeCallback, nonceFor } from "../telegram/callbackData";
import type { RoomControl } from "./control";
import { displayNameFrom, joinBlock, renderLobby, secondsLeft } from "./lobby";
import {
  addPlayer,
  clearPlayers,
  ensureRoom,
  ensureSchema,
  forgetActionsBefore,
  listPlayers,
  patchRoom,
  readRoom,
  rememberAction,
  removePlayer,
  transition,
  type RoomRow,
} from "./roomStore";
import { sourcesFor } from "./stateMachine";

/**
 * Sala: un Durable Object por `chat_id`.
 *
 * Aquí vive todo lo efímero y lo secreto de una partida (el estado va en su
 * SQLite, ver `roomStore.ts`), y aquí se mueve el dinero llamando a la billetera
 * de `core/wallet.ts`. El dinero sigue viviendo en D1: la sala solo pide los
 * movimientos con claves de idempotencia deterministas.
 *
 * El DO es de un solo hilo, así que los updates de un mismo chat se atienden de
 * uno en uno: eso es lo que serializa los turnos sin necesidad de locks. Lo que
 * sí puede repetirse es la entrega de un update, y de eso se encargan la
 * deduplicación del Worker y las transiciones guardadas de aquí.
 */

/** Cuánto se guardan los ids de acciones ya atendidas. */
const HANDLED_ACTION_TTL_MS = 24 * 60 * 60 * 1000;

export class RoomDO extends DurableObject<Env> implements RoomControl {
  private readonly sql: SqlStorage;
  private readonly api: Api;
  /** Rellena antes de atender nada: esquema y fila de la sala. */
  private readonly ready: Promise<void>;

  private bot: Bot | null = null;
  private botReady: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.api = createTelegramApi(env);

    this.ready = ctx.blockConcurrencyWhile(async () => {
      ensureSchema(this.sql);
      ensureRoom(this.sql, this.chatIdFromName(), Date.now());
    });
  }

  // ------------------------------------------------------------------ fetch

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/update") return new Response("not found", { status: 404 });
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    let update: Update;
    try {
      update = await request.json<Update>();
    } catch {
      return new Response("invalid json", { status: 400 });
    }

    await this.ready;
    const bot = await this.getBot();
    await bot.handleUpdate(update);

    return new Response(null, { status: 204 });
  }

  // ----------------------------------------------------------------- alarma

  /**
   * Vencimiento. Telegram solo deja **una** alarma por Durable Object, así que
   * no se pone una por cada cosa que podría vencer: se guarda el próximo
   * vencimiento y aquí se decide qué toca.
   *
   * El hecho de que la alarma suene significa que el plazo se cumplió; no hace
   * falta comparar con el reloj. `setAlarm` reemplaza la anterior, así que nunca
   * hay una alarma vieja pendiente de un plazo que ya no existe.
   */
  override async alarm(): Promise<void> {
    await this.ready;

    const room = readRoom(this.sql);
    if (!room) return;
    const now = Date.now();

    forgetActionsBefore(this.sql, now - HANDLED_ACTION_TTL_MS);

    if (room.phase === "LOBBY") {
      await this.cancelLobby(room, "lobby.cancelled");
      return;
    }

    if (room.phase === "PLAYING" && room.gameId && room.gameType) {
      const engine = getEngine(room.gameType);
      const players = listPlayers(this.sql, room.gameId);
      const tr = translator("es");

      if (!engine?.timeout) {
        // Un juego que se cuelga sin saber reaccionar al timeout no debe dejar
        // las apuestas dentro: se devuelve todo y se cierra la mesa.
        await this.abortGame(room, players, tr);
        return;
      }

      const state = parseState(room.stateJson);
      const step = await engine.timeout({ state, players, bet: room.bet ?? 0, rng: cryptoRng, tr });
      await this.applyStep(room, step);
      return;
    }

    // IDLE o FINISHED: no había nada que venciera.
  }

  // ----------------------------------------------------------- RoomControl

  async openLobby(params: {
    chat: Chat;
    from: User;
    engineType: string;
    bet: number;
    tr: Translator;
  }): Promise<void> {
    await this.ready;
    const { chat, from, engineType, bet, tr } = params;
    const now = Date.now();

    const engine = getEngine(engineType);
    if (!engine) {
      console.error("juego desconocido", { engineType });
      return;
    }

    const room = readRoom(this.sql);
    if (!room || room.phase !== "IDLE") {
      await this.reply(chat.id, tr("lobby.error.busy"));
      return;
    }

    // Se reserva la sala antes de cobrar nada: si el guard falla, es que otro
    // update se nos ha adelantado y este no debe hacer nada.
    const gameId = crypto.randomUUID();
    const deadline = now + LOBBY_SECONDS * 1000;
    const claimed = transition(
      this.sql,
      sourcesFor("LOBBY"),
      { phase: "LOBBY", gameId, gameType: engine.type, bet, hostId: from.id, deadline },
      now,
    );
    if (!claimed) {
      await this.reply(chat.id, tr("lobby.error.busy"));
      return;
    }

    // El chat_id bueno se fija aquí: la fila de la sala se creó al despertar el
    // DO, cuando el nombre del objeto todavía puede no ser un chat_id usable.
    patchRoom(this.sql, { chatId: chat.id }, now);

    try {
      await debit(this.env.DB, {
        userId: from.id,
        amount: bet,
        reason: "bet",
        origin: "game",
        idempotencyKey: `bet:${gameId}:${from.id}`,
        gameId,
        chatId: chat.id,
      });
    } catch (error) {
      // No hay saldo: se suelta la sala tal y como estaba.
      console.warn("no se pudo cobrar la apuesta del anfitrión", error);
      transition(
        this.sql,
        sourcesFor("IDLE"),
        { phase: "IDLE", gameId: null, gameType: null, bet: null, hostId: null, deadline: null },
        Date.now(),
      );
      const credits = await getBalance(this.env.DB, from.id).catch(() => 0);
      await this.reply(chat.id, tr("lobby.error.no_funds", { credits, bet }));
      return;
    }

    addPlayer(this.sql, gameId, { userId: from.id, displayName: displayNameFrom(from), amount: bet }, now);

    const view = renderLobby({
      tr,
      title: tr(engine.titleKey),
      bet,
      players: listPlayers(this.sql, gameId),
      maxPlayers: engine.maxPlayers,
      secondsLeft: secondsLeft(deadline, now),
      viewerId: from.id,
    });

    const message = await this.api.sendMessage(chat.id, view.text, {
      parse_mode: "HTML",
      reply_markup: view.keyboard,
    });
    patchRoom(this.sql, { messageId: message.message_id }, Date.now());
    await this.ctx.storage.setAlarm(deadline);
  }

  async handleCallback(params: {
    callbackId: string;
    data: string | undefined;
    from: User;
    chatId: number | null;
    tr: Translator;
  }): Promise<string | undefined> {
    await this.ready;
    const { callbackId, data, from, tr } = params;
    const now = Date.now();

    // Un clic reenviado por Telegram no debe contar dos veces.
    if (!rememberAction(this.sql, callbackId, now)) return undefined;

    const decoded = decodeCallback(data);
    if (!decoded) return undefined;

    const room = readRoom(this.sql);
    if (!room) return undefined;

    if (decoded.scope === "lobby") {
      return this.handleLobbyAction(room, decoded.action, from, tr, now);
    }

    // Los botones de una partida anterior siguen visibles en el chat: el nonce
    // evita que actúen sobre la partida nueva.
    if (room.phase !== "PLAYING" || !room.gameId || !room.gameType) {
      return tr("game.stale_button");
    }
    if (decoded.nonce !== nonceFor(room.gameId)) {
      return tr("game.stale_button");
    }

    const players = listPlayers(this.sql, room.gameId);
    if (!players.some((player) => player.userId === from.id)) {
      return tr("game.not_playing");
    }

    const engine = getEngine(room.gameType);
    if (!engine?.action) return tr("game.stale_button");

    const state = parseState(room.stateJson);
    const step = await engine.action({
      state,
      players,
      bet: room.bet ?? 0,
      rng: cryptoRng,
      tr,
      userId: from.id,
      action: decoded.action,
    });
    await this.applyStep(room, step);
    return step.answer;
  }

  // ------------------------------------------------------------- lobby

  private async handleLobbyAction(
    room: RoomRow,
    action: "join" | "leave" | "start",
    from: User,
    tr: Translator,
    now: number,
  ): Promise<string | undefined> {
    if (room.phase !== "LOBBY" || !room.gameId || !room.gameType || room.bet === null) {
      return tr("lobby.error.stale");
    }

    const engine = getEngine(room.gameType);
    if (!engine) return tr("lobby.error.stale");

    const players = listPlayers(this.sql, room.gameId);

    if (action === "join") {
      const blocked = joinBlock(players, from.id, engine.maxPlayers);
      if (blocked === "already") return tr("lobby.error.already");
      if (blocked === "full") return tr("lobby.error.full", { max: engine.maxPlayers });

      try {
        await debit(this.env.DB, {
          userId: from.id,
          amount: room.bet,
          reason: "bet",
          origin: "game",
          idempotencyKey: `bet:${room.gameId}:${from.id}`,
          gameId: room.gameId,
          chatId: room.chatId,
        });
      } catch {
        const credits = await getBalance(this.env.DB, from.id).catch(() => 0);
        return tr("lobby.error.no_funds", { credits, bet: room.bet });
      }

      addPlayer(
        this.sql,
        room.gameId,
        { userId: from.id, displayName: displayNameFrom(from), amount: room.bet },
        now,
      );
      await this.refreshLobby(room, engine, tr, now);
      const updated = listPlayers(this.sql, room.gameId);
      return tr("lobby.joined", { count: updated.length, max: engine.maxPlayers });
    }

    if (action === "leave") {
      const amount = removePlayer(this.sql, room.gameId, from.id);
      if (amount === null) return tr("lobby.error.not_member");

      await this.refund(room.gameId, room.chatId, from.id, amount);
      await this.refreshLobby(room, engine, tr, now);
      return tr("lobby.left", { amount });
    }

    // start
    if (from.id !== room.hostId) return tr("lobby.error.not_host");
    if (players.length < engine.minPlayers) {
      return tr("lobby.error.not_enough", { min: engine.minPlayers });
    }

    await this.startGame(room, engine, players, tr, now);
    return undefined;
  }

  private async refreshLobby(
    room: RoomRow,
    engine: GameEngine<unknown>,
    tr: Translator,
    now: number,
  ): Promise<void> {
    if (!room.gameId) return;
    const players = listPlayers(this.sql, room.gameId);
    const view = renderLobby({
      tr,
      title: tr(engine.titleKey),
      bet: room.bet ?? 0,
      players,
      maxPlayers: engine.maxPlayers,
      secondsLeft: secondsLeft(room.deadline, now),
      // El teclado es el mismo para todos, así que se dibuja como si lo mirara
      // alguien de fuera; quien quiera salir ya tiene su botón en su copia.
      viewerId: -1,
    });
    await this.editMessage(room.chatId, room.messageId, view.text, view.keyboard);
  }

  private async startGame(
    room: RoomRow,
    engine: GameEngine<unknown>,
    players: readonly PlayerRow[],
    tr: Translator,
    now: number,
  ): Promise<void> {
    if (!room.gameId) return;

    const started = transition(this.sql, sourcesFor("PLAYING"), { phase: "PLAYING" }, now);
    if (!started) return; // ya había arrancado

    await this.reply(room.chatId, tr("lobby.starting"));

    const step = await engine.start({
      players,
      bet: room.bet ?? 0,
      rng: cryptoRng,
      tr,
    });
    await this.applyStep(room, step);
  }

  // ------------------------------------------------------------- pasos

  /**
   * Aplica un paso devuelto por un juego: pinta el mensaje, guarda el estado,
   * paga y rearma (o quita) la alarma.
   */
  private async applyStep(room: RoomRow, step: GameStep<unknown>): Promise<void> {
    if (!room.gameId) return;
    const now = Date.now();

    if (step.text !== undefined) {
      await this.editMessage(room.chatId, room.messageId, step.text, step.keyboard);
    }

    if (step.payouts && step.payouts.length > 0) {
      // Clave determinista por posición: reintentar el mismo paso no paga dos
      // veces, y el orden del reparto no depende de nada externo.
      for (const [index, payout] of step.payouts.entries()) {
        if (payout.amount <= 0) continue;
        await credit(this.env.DB, {
          userId: payout.userId,
          amount: payout.amount,
          reason: "payout",
          origin: "game",
          idempotencyKey: `payout:${room.gameId}:${index}`,
          gameId: room.gameId,
          chatId: room.chatId,
          now: Math.floor(now / 1000),
        });
      }
    }

    const deadline =
      step.timeoutSeconds && step.timeoutSeconds > 0
        ? now + step.timeoutSeconds * 1000
        : null;

    patchRoom(
      this.sql,
      {
        stateJson: JSON.stringify(step.state ?? null),
        deadline,
        messageId: room.messageId,
      },
      now,
    );

    if (deadline !== null) {
      await this.ctx.storage.setAlarm(deadline);
    } else {
      await this.ctx.storage.deleteAlarm();
    }

    if (step.finished) {
      await this.clearTable(room, "PLAYING");
    }
  }

  /**
   * Cierra la mesa y la deja libre.
   *
   * `from` es la fase desde la que se cierra, y no es un detalle: una partida
   * jugada pasa por FINISHED antes de volver a IDLE, pero un lobby cancelado va
   * de LOBBY a IDLE directamente. Encadenar siempre FINISHED dejaba el lobby
   * cancelado atascado en LOBBY y el chat sin poder abrir otra partida.
   */
  private async clearTable(room: RoomRow, from: "LOBBY" | "PLAYING"): Promise<void> {
    if (!room.gameId) return;
    const now = Date.now();

    if (from === "PLAYING") {
      transition(this.sql, sourcesFor("FINISHED"), { phase: "FINISHED" }, now);
    }
    clearPlayers(this.sql, room.gameId);
    transition(
      this.sql,
      sourcesFor("IDLE"),
      { phase: "IDLE", gameId: null, gameType: null, bet: null, hostId: null, deadline: null, stateJson: null },
      now,
    );
    await this.ctx.storage.deleteAlarm();
  }

  // ------------------------------------------------------- cancelar y abortar

  private async cancelLobby(room: RoomRow, messageKey: TranslationKey): Promise<void> {
    if (!room.gameId) return;
    const players = listPlayers(this.sql, room.gameId);
    // La cancelación no la provoca nadie del chat, así que el aviso va en el
    // idioma por defecto del bot.
    const tr = translator("es");

    const refunded = await this.refundAll(room, players);
    await this.clearTable(room, "LOBBY");

    const text =
      refunded === 0
        ? tr("lobby.cancelled_empty")
        : tr(messageKey, { count: refunded });
    await this.editMessage(room.chatId, room.messageId, text, undefined);
  }

  /** Un juego que se cuelga sin reaccionar al timeout: se devuelve todo. */
  private async abortGame(
    room: RoomRow,
    players: readonly PlayerRow[],
    tr: Translator,
  ): Promise<void> {
    await this.refundAll(room, players);
    await this.clearTable(room, "PLAYING");
    await this.editMessage(room.chatId, room.messageId, tr("game.timeout"), undefined);
  }

  /**
   * Devuelve las apuestas. La clave `refund:<partida>:<jugador>` hace que
   * devolver dos veces sea imposible, aunque la alarma se repita.
   */
  private async refundAll(room: RoomRow, players: readonly PlayerRow[]): Promise<number> {
    let refunded = 0;
    for (const player of players) {
      if (player.amount <= 0) continue;
      const moved = await this.refund(room.gameId, room.chatId, player.userId, player.amount);
      if (moved) refunded += 1;
    }
    return refunded;
  }

  private async refund(
    gameId: string | null,
    chatId: number,
    userId: number,
    amount: number,
  ): Promise<boolean> {
    if (!gameId || amount <= 0) return false;
    const result = await credit(this.env.DB, {
      userId,
      amount,
      reason: "refund",
      origin: "game",
      idempotencyKey: `refund:${gameId}:${userId}`,
      gameId,
      chatId,
    });
    return result.applied;
  }

  // ------------------------------------------------------------- mensajes

  private async editMessage(
    chatId: number,
    messageId: number | null,
    text: string,
    keyboard: InlineKeyboard | undefined,
  ): Promise<void> {
    if (messageId === null) return;
    try {
      await this.api.editMessageText(chatId, messageId, text, {
        parse_mode: "HTML",
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
    } catch (error) {
      // Telegram devuelve error si el texto es idéntico: no es un fallo.
      if (isNotModified(error)) return;
      console.warn("no se pudo editar el mensaje de la sala", error);
    }
  }

  private async reply(chatId: number, text: string): Promise<void> {
    try {
      await this.api.sendMessage(chatId, text, { parse_mode: "HTML" });
    } catch (error) {
      console.warn("no se pudo enviar el mensaje de la sala", error);
    }
  }

  private chatIdFromName(): number {
    const name = this.ctx.id.name;
    const parsed = name === undefined ? Number.NaN : Number.parseInt(name, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private async getBot(): Promise<Bot> {
    if (this.bot === null) {
      this.bot = createBot(this.env, this, { roomLabel: this.ctx.id.toString() });
    }
    if (this.botReady === null) {
      this.botReady = this.bot.init().then(
        () => undefined,
        (error: unknown) => {
          this.botReady = null;
          throw error;
        },
      );
    }
    await this.botReady;
    return this.bot;
  }
}

function parseState(stateJson: string | null): unknown {
  if (stateJson === null) return null;
  try {
    return JSON.parse(stateJson);
  } catch {
    return null;
  }
}

function isNotModified(error: unknown): boolean {
  const description = (error as { description?: string }).description ?? String(error);
  return description.toLowerCase().includes("message is not modified");
}
