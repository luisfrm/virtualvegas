import { Bot, type Context } from "grammy";
import { DAILY_BONUS, DEFAULT_MAX_BET, MIN_BET, RANKING_LIMIT, RESCUE_THRESHOLD } from "../config";
import { escapeHtml, translator } from "../core/i18n";
import { touchUser } from "../core/users";
import {
  BonusAlreadyClaimedError,
  RescueCooldownError,
  RescueNotAvailableError,
  UnknownUserError,
  claimDailyBonus,
  claimRescue,
  getBalance,
  recentMovements,
  topByBalance,
  topByGroupNet,
} from "../core/wallet";
import { SORTEO_TYPE } from "../games/sorteo";
import type { Env } from "../env";
import type { RoomControl } from "../rooms/control";
import { parseBet } from "../rooms/lobby";

const HTML = { parse_mode: "HTML" } as const;

export interface BotOptions {
  /** Identificador de la sala, solo para poder demostrarlo en /ping. */
  roomLabel: string;
}

/**
 * Un bot grammY por sala. Se crea una sola vez por instancia del Durable
 * Object y se reutiliza: así `init()` (la llamada a `getMe`) se hace una vez y
 * no en cada update.
 *
 * Todo el diálogo vive aquí, incluidos los comandos globales. El Worker solo
 * valida, deduplica y enruta; mantener una sola ruta de código evita tener dos
 * instancias de grammY con dos ciclos de init. Lo que sí es de la sala —lobby,
 * apuestas, turnos— se le pide a `room`, que es quien sabe el estado.
 */
export function createBot(env: Env, room: RoomControl, options: BotOptions): Bot {
  const bot = new Bot(env.BOT_TOKEN);
  const { roomLabel } = options;

  // --- Registro implícito: la primera vez que alguien escribe, se le da cuenta.
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    const chat = ctx.chat;
    if (!from || from.is_bot || !chat) return next();
    if (chat.type === "channel") return next();

    await touchUser(env.DB, {
      userId: from.id,
      username: from.username ?? null,
      firstName: from.first_name ?? null,
      languageCode: from.language_code ?? null,
    });
    return next();
  });

  // --- /ping: la prueba de humo de la Fase 0. Recorre Worker → DO → D1.
  bot.command("ping", async (ctx) => {
    const tr = translator(ctx.from?.language_code);
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
    const label = roomLabel.replace(/[^0-9a-f]/gi, "").slice(0, 8) || "local";
    await ctx.reply(tr("ping.ok", { room: label, users: count?.n ?? 0 }), HTML);
  });

  const sendHelp = async (ctx: Context): Promise<void> => {
    const tr = translator(ctx.from?.language_code);
    await ctx.reply(`${tr("help.title")}\n\n${tr("help.body")}\n\n${tr("help.games_soon")}`, HTML);
  };
  bot.command("start", sendHelp);
  bot.command("ayuda", sendHelp);
  bot.command("help", sendHelp);

  // --- /saldo
  bot.command("saldo", async (ctx) => {
    const tr = translator(ctx.from?.language_code);
    const userId = ctx.from?.id;
    if (userId === undefined) return;

    const [balance, movements] = await Promise.all([
      getBalance(env.DB, userId),
      recentMovements(env.DB, userId, 5),
    ]);

    const lines = [tr("balance.title", { credits: balance })];
    if (movements.length === 0) {
      lines.push(tr("balance.empty"));
    } else {
      lines.push("", `<b>${tr("balance.movements")}</b>`);
      for (const movement of movements) {
        const sign = movement.amount >= 0 ? "+" : "";
        lines.push(`${sign}${movement.amount} · ${tr(`reason.${movement.reason}`)}`);
      }
    }
    await ctx.reply(lines.join("\n"), HTML);
  });

  // --- /bono
  bot.command("bono", async (ctx) => {
    const tr = translator(ctx.from?.language_code);
    const userId = ctx.from?.id;
    if (userId === undefined) return;

    try {
      const { balance } = await claimDailyBonus(env.DB, userId, DAILY_BONUS);
      await ctx.reply(tr("bonus.ok", { bonus: DAILY_BONUS, credits: balance }), HTML);
    } catch (error) {
      if (error instanceof BonusAlreadyClaimedError) {
        await ctx.reply(tr("bonus.already"), HTML);
        return;
      }
      throw error;
    }
  });

  // --- /rescate
  bot.command("rescate", async (ctx) => {
    const tr = translator(ctx.from?.language_code);
    const userId = ctx.from?.id;
    if (userId === undefined) return;

    try {
      const { amount, balance } = await claimRescue(env.DB, userId);
      await ctx.reply(tr("rescue.ok", { amount, credits: balance }), HTML);
    } catch (error) {
      if (error instanceof RescueNotAvailableError) {
        const balance = await getBalance(env.DB, userId);
        await ctx.reply(
          tr("rescue.not_needed", { credits: balance, threshold: RESCUE_THRESHOLD }),
          HTML,
        );
        return;
      }
      if (error instanceof RescueCooldownError) {
        await ctx.reply(tr("rescue.cooldown", { minutes: Math.ceil(error.remainingSeconds / 60) }), HTML);
        return;
      }
      if (error instanceof UnknownUserError) {
        await ctx.reply(tr("error.unknown_user"));
        return;
      }
      throw error;
    }
  });

  // --- /ranking
  bot.command("ranking", async (ctx) => {
    const tr = translator(ctx.from?.language_code);
    const chat = ctx.chat;
    const isGroup = chat !== undefined && (chat.type === "group" || chat.type === "supergroup");

    const rows = isGroup
      ? await topByGroupNet(env.DB, chat.id, RANKING_LIMIT)
      : await topByBalance(env.DB, RANKING_LIMIT);

    const header = isGroup ? tr("ranking.group") : tr("ranking.global");
    if (rows.length === 0) {
      await ctx.reply(`${header}\n\n${tr("ranking.empty")}`, HTML);
      return;
    }

    const lines = [header, ""];
    rows.forEach((row, index) => {
      const name = escapeHtml(row.displayName?.trim() || `jugador ${row.userId}`);
      lines.push(tr("ranking.row", { position: index + 1, name, value: row.value }));
    });
    await ctx.reply(lines.join("\n"), HTML);
  });

  // --- /sorteo [apuesta]: abre el lobby del juego de prueba de la Fase 2.
  bot.command("sorteo", async (ctx) => {
    const tr = translator(ctx.from?.language_code);
    const chat = ctx.chat;
    const from = ctx.from;
    if (!chat || !from) return;

    if (chat.type !== "group" && chat.type !== "supergroup") {
      await ctx.reply(tr("lobby.error.group_only"), HTML);
      return;
    }

    const raw = typeof ctx.match === "string" && ctx.match.trim() !== "" ? ctx.match : undefined;
    const bet = parseBet(raw, DEFAULT_MAX_BET);
    if (bet === null) {
      await ctx.reply(
        tr("lobby.error.bet_range", { min: MIN_BET, max: DEFAULT_MAX_BET }),
        HTML,
      );
      return;
    }

    await room.openLobby({ chat, from, engineType: SORTEO_TYPE, bet, tr });
  });

  // --- Botones.
  bot.on("callback_query:data", async (ctx) => {
    const tr = translator(ctx.from?.language_code);
    const from = ctx.from;
    if (!from) return;

    let answer: string | undefined;
    try {
      answer = await room.handleCallback({
        callbackId: ctx.callbackQuery.id,
        data: ctx.callbackQuery.data,
        from,
        chatId: ctx.chat?.id ?? null,
        tr,
      });
    } catch (error) {
      console.error("fallo atendiendo un botón", error);
      answer = tr("error.generic");
    } finally {
      // Siempre hay que contestar al callback, incluso sin texto: si no,
      // Telegram deja el botón girando para quien lo pulsó.
      try {
        await ctx.answerCallbackQuery(answer ? { text: answer } : undefined);
      } catch (error) {
        console.warn("no se pudo responder al callback", error);
      }
    }
  });

  bot.on("message:text", async (ctx) => {
    const tr = translator(ctx.from?.language_code);
    await ctx.reply(tr("error.not_a_command"));
  });

  // Un update roto no debe tumbar la sala. Se registra y se sigue: devolver
  // error aquí haría que Telegram reintentara en bucle un update envenenado.
  bot.catch((error) => {
    console.error("error atendiendo un update", {
      updateId: error.ctx.update.update_id,
      error: error.error instanceof Error ? error.error.message : String(error.error),
    });
  });

  return bot;
}
