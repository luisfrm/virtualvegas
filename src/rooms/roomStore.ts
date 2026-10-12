import type { PlayerRow } from "../games/types";

/**
 * Estado de la sala, en el almacenamiento SQLite del propio Durable Object.
 *
 * Es SQLite y no D1 por dos razones: vive al lado de la partida (sin latencia
 * de red) y no cuenta para las escrituras de D1 del plan gratuito. Aquí se
 * guarda todo lo efímero y lo secreto; en D1 solo queda el dinero.
 *
 * El DO es de un solo hilo, así que no hay carreras entre sentencias. Lo que sí
 * puede llegar repetido es el update de Telegram, y eso se resuelve con
 * transiciones guardadas (`WHERE phase = ?`) y con la tabla `handled_actions`.
 */

export type Phase = "IDLE" | "LOBBY" | "PLAYING" | "FINISHED";

export interface RoomRow {
  chatId: number;
  phase: Phase;
  gameId: string | null;
  gameType: string | null;
  bet: number | null;
  hostId: number | null;
  messageId: number | null;
  /** Vencimiento en milisegundos unix, o `null` si no se espera nada. */
  deadline: number | null;
  /** Estado propio del juego, tal cual lo devolvió `GameStep.state`. */
  stateJson: string | null;
  updatedAt: number;
}

export interface RoomPatch {
  phase?: Phase;
  chatId?: number;
  gameId?: string | null;
  gameType?: string | null;
  bet?: number | null;
  hostId?: number | null;
  messageId?: number | null;
  deadline?: number | null;
  stateJson?: string | null;
  updatedAt?: number;
}

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS room (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     chat_id INTEGER NOT NULL,
     phase TEXT NOT NULL,
     game_id TEXT,
     game_type TEXT,
     bet INTEGER,
     host_id INTEGER,
     message_id INTEGER,
     deadline INTEGER,
     state TEXT,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS players (
     game_id TEXT NOT NULL,
     user_id INTEGER NOT NULL,
     display_name TEXT NOT NULL,
     amount INTEGER NOT NULL,
     joined_at INTEGER NOT NULL,
     PRIMARY KEY (game_id, user_id)
   )`,
  `CREATE TABLE IF NOT EXISTS handled_actions (
     action_id TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL
   )`,
];

export function ensureSchema(sql: SqlStorage): void {
  for (const statement of STATEMENTS) {
    sql.exec(statement);
  }
}

/** Crea la fila de la sala si es la primera vez que se despierta este DO. */
export function ensureRoom(sql: SqlStorage, chatId: number, now: number): void {
  sql.exec(
    `INSERT OR IGNORE INTO room (id, chat_id, phase, updated_at) VALUES (1, ?, 'IDLE', ?)`,
    chatId,
    now,
  );
}

export function readRoom(sql: SqlStorage): RoomRow | null {
  const rows = sql
    .exec<{
      chatId: number;
      phase: string;
      gameId: string | null;
      gameType: string | null;
      bet: number | null;
      hostId: number | null;
      messageId: number | null;
      deadline: number | null;
      stateJson: string | null;
      updatedAt: number;
    }>(
      `SELECT chat_id AS chatId, phase, game_id AS gameId, game_type AS gameType, bet,
              host_id AS hostId, message_id AS messageId, deadline, state AS stateJson,
              updated_at AS updatedAt
         FROM room WHERE id = 1`,
    )
    .toArray();

  const row = rows[0];
  if (!row) return null;
  return { ...row, phase: row.phase as Phase };
}

/**
 * Cambia de fase solo si la fase actual es la esperada, y aplica el resto de
 * cambios en la misma sentencia. Devuelve `false` si el estado ya había
 * avanzado (por ejemplo, un clic repetido).
 */
export function transition(
  sql: SqlStorage,
  expected: readonly Phase[],
  patch: RoomPatch & { phase: Phase },
  now: number,
): boolean {
  const columns: string[] = ["phase = ?", "updated_at = ?"];
  const values: (string | number | null)[] = [patch.phase, now];

  const assign = (column: string, value: string | number | null): void => {
    columns.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.chatId !== undefined) assign("chat_id", patch.chatId);
  if (patch.gameId !== undefined) assign("game_id", patch.gameId);
  if (patch.gameType !== undefined) assign("game_type", patch.gameType);
  if (patch.bet !== undefined) assign("bet", patch.bet);
  if (patch.hostId !== undefined) assign("host_id", patch.hostId);
  if (patch.messageId !== undefined) assign("message_id", patch.messageId);
  if (patch.stateJson !== undefined) assign("state", patch.stateJson);
  if (patch.deadline !== undefined) assign("deadline", patch.deadline);

  const placeholders = expected.map(() => "?").join(", ");
  const result = sql.exec(
    `UPDATE room SET ${columns.join(", ")} WHERE id = 1 AND phase IN (${placeholders})`,
    ...values,
    ...expected,
  );
  return result.rowsWritten > 0;
}

/** Aplica cambios sin tocar la fase (mensaje, deadline, estado del juego). */
export function patchRoom(sql: SqlStorage, patch: RoomPatch, now: number): void {
  const columns: string[] = [];
  const values: (string | number | null)[] = [];

  const assign = (column: string, value: string | number | null): void => {
    columns.push(`${column} = ?`);
    values.push(value);
  };

  if (patch.phase !== undefined) assign("phase", patch.phase);
  if (patch.chatId !== undefined) assign("chat_id", patch.chatId);
  if (patch.gameId !== undefined) assign("game_id", patch.gameId);
  if (patch.gameType !== undefined) assign("game_type", patch.gameType);
  if (patch.bet !== undefined) assign("bet", patch.bet);
  if (patch.hostId !== undefined) assign("host_id", patch.hostId);
  if (patch.messageId !== undefined) assign("message_id", patch.messageId);
  if (patch.stateJson !== undefined) assign("state", patch.stateJson);
  if (patch.deadline !== undefined) assign("deadline", patch.deadline);

  assign("updated_at", now);
  sql.exec(`UPDATE room SET ${columns.join(", ")} WHERE id = 1`, ...values);
}

/** Devuelve `false` si el jugador ya estaba dentro. */
export function addPlayer(
  sql: SqlStorage,
  gameId: string,
  player: PlayerRow,
  now: number,
): boolean {
  const result = sql.exec(
    `INSERT OR IGNORE INTO players (game_id, user_id, display_name, amount, joined_at)
     VALUES (?, ?, ?, ?, ?)`,
    gameId,
    player.userId,
    player.displayName,
    player.amount,
    now,
  );
  return result.rowsWritten > 0;
}

/** Devuelve el importe que tenía apostado, o `null` si no estaba. */
export function removePlayer(sql: SqlStorage, gameId: string, userId: number): number | null {
  const rows = sql
    .exec<{ amount: number }>(
      `DELETE FROM players WHERE game_id = ? AND user_id = ? RETURNING amount`,
      gameId,
      userId,
    )
    .toArray();
  return rows[0]?.amount ?? null;
}

export function listPlayers(sql: SqlStorage, gameId: string): PlayerRow[] {
  return sql
    .exec<{ userId: number; displayName: string; amount: number }>(
      `SELECT user_id AS userId, display_name AS displayName, amount
         FROM players WHERE game_id = ? ORDER BY joined_at ASC, user_id ASC`,
      gameId,
    )
    .toArray();
}

export function clearPlayers(sql: SqlStorage, gameId: string): void {
  sql.exec(`DELETE FROM players WHERE game_id = ?`, gameId);
}

/**
 * Marca una acción como atendida. Devuelve `false` si ya lo estaba.
 * Con esto un clic reenviado por Telegram no cuenta dos veces.
 */
export function rememberAction(sql: SqlStorage, actionId: string, now: number): boolean {
  const result = sql.exec(
    `INSERT OR IGNORE INTO handled_actions (action_id, created_at) VALUES (?, ?)`,
    actionId,
    now,
  );
  return result.rowsWritten > 0;
}

/** Limpieza: los ids de acciones no hace falta guardarlos para siempre. */
export function forgetActionsBefore(sql: SqlStorage, cutoff: number): void {
  sql.exec(`DELETE FROM handled_actions WHERE created_at < ?`, cutoff);
}
