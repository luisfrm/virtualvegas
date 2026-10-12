import { z } from "zod";
import { MAX_DISPLAY_NAME, MIN_BET } from "../config";
import { escapeHtml } from "../core/i18n";
import type { PlayerRow, Translator } from "../games/types";
import type { InlineKeyboard } from "grammy";
import { lobbyKeyboard } from "../telegram/keyboards";

/**
 * Lógica del lobby que no toca ni dinero ni base de datos: cómo se dibuja y qué
 * validaciones hacen falta antes de dejar entrar a alguien. La orquestación
 * (cobrar, guardar, editar el mensaje) vive en la sala.
 */

export interface LobbyView {
  text: string;
  keyboard: InlineKeyboard;
}

export function displayNameFrom(user: {
  id: number;
  first_name?: string | undefined;
  username?: string | undefined;
}): string {
  const raw = user.username ? `@${user.username}` : (user.first_name ?? `jugador ${user.id}`);
  return raw.slice(0, MAX_DISPLAY_NAME);
}

export function renderLobby(params: {
  tr: Translator;
  title: string;
  bet: number;
  players: readonly PlayerRow[];
  maxPlayers: number;
  secondsLeft: number | null;
  viewerId: number;
}): LobbyView {
  const { tr, title, bet, players, maxPlayers, secondsLeft, viewerId } = params;

  const lines = [tr("lobby.header", { title, bet })];
  if (secondsLeft !== null) {
    lines.push(tr("lobby.timer", { seconds: secondsLeft }));
  }
  lines.push("", tr("lobby.players", { count: players.length, max: maxPlayers }));

  if (players.length === 0) {
    lines.push(tr("lobby.empty"));
  } else {
    for (const player of players) {
      lines.push(`· ${escapeHtml(player.displayName)}`);
    }
  }
  lines.push("", tr("lobby.hint"));

  const joined = players.some((player) => player.userId === viewerId);
  return { text: lines.join("\n"), keyboard: lobbyKeyboard(tr, { joined }) };
}

export type JoinBlock = "already" | "full";

export function joinBlock(
  players: readonly PlayerRow[],
  userId: number,
  maxPlayers: number,
): JoinBlock | null {
  if (players.some((player) => player.userId === userId)) return "already";
  if (players.length >= maxPlayers) return "full";
  return null;
}

export function secondsLeft(deadline: number | null, now: number): number | null {
  if (deadline === null) return null;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/**
 * Apuesta del comando. Sin argumento se apuesta lo mínimo: nunca debe sorprender
 * a nadie con una apuesta alta por olvidarse de escribir el número.
 */
export function parseBet(raw: string | undefined, max: number): number | null {
  const schema = z
    .string()
    .trim()
    .regex(/^\d+$/)
    .transform((value) => Number.parseInt(value, 10))
    .pipe(z.number().int().min(MIN_BET).max(max));

  const parsed = schema.safeParse(raw ?? String(MIN_BET));
  return parsed.success ? parsed.data : null;
}
