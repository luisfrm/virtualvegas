import { DAY_SECONDS, RESCUE_COOLDOWN_SECONDS, RESCUE_TARGET, RESCUE_THRESHOLD } from "../config";
import { unixNow, utcDay } from "./time";

/**
 * Capa de dinero. TODO movimiento de créditos pasa por aquí.
 *
 * Por qué SQL a mano y no el query builder: el saldo lo mueven tres sentencias
 * que dependen de `changes()` y de `batch()`. Necesito ver exactamente el SQL
 * que se ejecuta, porque de él depende que nunca haya saldo negativo.
 *
 * Cómo se garantiza la atomicidad sin transacciones interactivas (D1 no las
 * tiene, solo `batch()`):
 *
 *   1. D1 ejecuta un `batch()` como UNA transacción, con las sentencias en
 *      orden y sobre la misma conexión.
 *   2. El débito es un UPDATE guardado: `WHERE credits >= ?`. Si no pasa, no
 *      modifica ninguna fila.
 *   3. El asiento del ledger se inserta condicionado a que el UPDATE anterior
 *      haya tocado algo: `... WHERE ... AND changes() = 1`. Así es imposible
 *      que quede un asiento sin su movimiento (o al revés).
 *   4. La clave de idempotencia es UNIQUE. Si dos peticiones idénticas corren a
 *      la vez, una falla por la restricción y su batch entero se revierte.
 *
 * El resultado de todo esto es la invariante que se comprueba en los tests:
 * `users.credits === SUM(transactions.amount)` para todo usuario, y
 * `users.credits >= 0` siempre.
 */

export type LedgerReason =
  | "initial"
  | "bonus"
  | "rescue"
  | "bet"
  | "payout"
  | "refund"
  | "purchase";

/** El brief de monetización pide poder distinguir de dónde viene cada crédito. */
export type LedgerOrigin = "bonus" | "game" | "purchase";

export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InsufficientFundsError extends WalletError {}
export class UnknownUserError extends WalletError {}
export class BonusAlreadyClaimedError extends WalletError {}
export class RescueNotAvailableError extends WalletError {}
export class RescueCooldownError extends WalletError {
  readonly remainingSeconds: number;
  constructor(remainingSeconds: number) {
    super(`rescate en enfriamiento, faltan ${remainingSeconds}s`);
    this.remainingSeconds = remainingSeconds;
  }
}
/** La invariante se rompió y no se pudo aplicar el movimiento. El llamante puede reintentar. */
export class ConcurrentModificationError extends WalletError {}

export interface MoveParams {
  userId: number;
  /** Entero positivo; el signo lo pone la capa de dinero, nunca el llamante. */
  amount: number;
  reason: LedgerReason;
  origin: LedgerOrigin;
  /**
   * Clave determinista. Reintentar el mismo movimiento con la misma clave no
   * vuelve a mover dinero: devuelve `applied: false`.
   */
  idempotencyKey: string;
  gameId?: string | null;
  chatId?: number | null;
  now?: number;
}

export interface MoveResult {
  /** `false` cuando la clave ya estaba aplicada y no se movió nada. */
  applied: boolean;
  /** Magnitud movida, siempre positiva. El signo lo decide el tipo de operación. */
  amount: number;
  balance: number;
}

// --------------------------------------------------------------------------
// Helpers internos
// --------------------------------------------------------------------------

function assertPositiveInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new WalletError(`${name} debe ser un entero positivo, recibido: ${value}`);
  }
}

function changesOf(result: D1Result<unknown> | undefined): number {
  return result?.meta?.changes ?? 0;
}

function balanceOf(result: D1Result<unknown> | undefined): number {
  const row = result?.results?.[0] as { credits?: number } | undefined;
  if (typeof row?.credits !== "number") {
    throw new WalletError("la sentencia de saldo no devolvió filas");
  }
  return row.credits;
}

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message);
}

interface LedgerRow {
  amount: number;
  balanceAfter: number;
}

async function findByKey(db: D1Database, idempotencyKey: string): Promise<LedgerRow | null> {
  const row = await db
    .prepare(
      `SELECT amount, balance_after AS balanceAfter
         FROM transactions WHERE idempotency_key = ? LIMIT 1`,
    )
    .bind(idempotencyKey)
    .first<LedgerRow>();
  return row ?? null;
}

interface UserRow {
  credits: number;
  bonusAt: number | null;
  rescueAt: number | null;
}

async function getUserRow(db: D1Database, userId: number): Promise<UserRow | null> {
  const row = await db
    .prepare(
      `SELECT credits, bonus_at AS bonusAt, rescue_at AS rescueAt
         FROM users WHERE user_id = ? AND deleted_at IS NULL`,
    )
    .bind(userId)
    .first<UserRow>();
  return row ?? null;
}

/**
 * Devuelve el movimiento ya aplicado si la clave existe, o `null` si no.
 * Sirve para que un reintento sea barato y no dependa de capturar el error de
 * la restricción UNIQUE.
 */
async function existingMove(db: D1Database, idempotencyKey: string): Promise<MoveResult | null> {
  const prior = await findByKey(db, idempotencyKey);
  if (!prior) return null;
  // `amount` va con signo en el ledger; aquí se devuelve la magnitud.
  return { applied: false, amount: Math.abs(prior.amount), balance: prior.balanceAfter };
}

// --------------------------------------------------------------------------
// Movimientos
// --------------------------------------------------------------------------

/** Quita créditos. Falla con `InsufficientFundsError` si no hay saldo. */
export async function debit(db: D1Database, params: MoveParams): Promise<MoveResult> {
  const { userId, amount, reason, origin, idempotencyKey } = params;
  assertPositiveInt(amount, "amount");

  const replay = await existingMove(db, idempotencyKey);
  if (replay) return replay;

  const now = params.now ?? unixNow();
  const gameId = params.gameId ?? null;
  const chatId = params.chatId ?? null;

  try {
    const results = await db.batch([
      db
        .prepare(
          `UPDATE users SET credits = credits - ?, updated_at = ?
            WHERE user_id = ? AND credits >= ?
        RETURNING credits`,
        )
        .bind(amount, now, userId, amount),
      db
        .prepare(
          `INSERT INTO transactions
             (user_id, amount, balance_after, reason, origin, game_id, chat_id, idempotency_key, created_at)
           SELECT ?, ?, credits, ?, ?, ?, ?, ?, ?
             FROM users WHERE user_id = ? AND changes() = 1`,
        )
        .bind(userId, -amount, reason, origin, gameId, chatId, idempotencyKey, now, userId),
    ]);

    if (changesOf(results[0]) === 0) {
      // El guard no pasó: o no existe el usuario, o no llega el saldo.
      const user = await getUserRow(db, userId);
      if (!user) throw new UnknownUserError(`usuario ${userId} no reservado`);
      throw new InsufficientFundsError(
        `saldo insuficiente para ${userId}: ${user.credits} < ${amount}`,
      );
    }

    return { applied: true, amount, balance: balanceOf(results[0]) };
  } catch (error) {
    // Carrera con otra petición idéntica: el batch entero se revirtió.
    if (isUniqueViolation(error)) {
      const replayAfterRace = await existingMove(db, idempotencyKey);
      if (replayAfterRace) return replayAfterRace;
    }
    throw error;
  }
}

/** Añade créditos. Uso interno: bono, rescate, pago, premio. */
export async function credit(db: D1Database, params: MoveParams): Promise<MoveResult> {
  const { userId, amount, reason, origin, idempotencyKey } = params;
  assertPositiveInt(amount, "amount");

  const replay = await existingMove(db, idempotencyKey);
  if (replay) return replay;

  const now = params.now ?? unixNow();
  const gameId = params.gameId ?? null;
  const chatId = params.chatId ?? null;

  try {
    const results = await db.batch([
      db
        .prepare(
          `UPDATE users SET credits = credits + ?, updated_at = ?
            WHERE user_id = ? AND deleted_at IS NULL
        RETURNING credits`,
        )
        .bind(amount, now, userId),
      db
        .prepare(
          `INSERT INTO transactions
             (user_id, amount, balance_after, reason, origin, game_id, chat_id, idempotency_key, created_at)
           SELECT ?, ?, credits, ?, ?, ?, ?, ?, ?
             FROM users WHERE user_id = ? AND changes() = 1`,
        )
        .bind(userId, amount, reason, origin, gameId, chatId, idempotencyKey, now, userId),
    ]);

    if (changesOf(results[0]) === 0) {
      throw new UnknownUserError(`usuario ${userId} no reservado`);
    }

    return { applied: true, amount, balance: balanceOf(results[0]) };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const replayAfterRace = await existingMove(db, idempotencyKey);
      if (replayAfterRace) return replayAfterRace;
    }
    throw error;
  }
}

// --------------------------------------------------------------------------
// Bono diario y rescate
// --------------------------------------------------------------------------

/**
 * Bono diario. La clave de idempotencia es determinista por usuario y día UTC
 * (`bonus:<user>:<día>`), así que ni un reintento ni dos peticiones a la vez
 * pueden pagarlo dos veces.
 */
export async function claimDailyBonus(
  db: D1Database,
  userId: number,
  bonus: number,
  now: number = unixNow(),
): Promise<MoveResult> {
  assertPositiveInt(bonus, "bonus");
  const day = utcDay(now);
  const idempotencyKey = `bonus:${userId}:${day}`;

  const user = await getUserRow(db, userId);
  if (!user) throw new UnknownUserError(`usuario ${userId} no reservado`);
  if (user.bonusAt !== null && utcDay(user.bonusAt) === day) {
    throw new BonusAlreadyClaimedError("el bono de hoy ya está cobrado");
  }

  try {
    const results = await db.batch([
      db
        .prepare(
          `UPDATE users SET credits = credits + ?, bonus_at = ?, updated_at = ?
            WHERE user_id = ? AND (bonus_at IS NULL OR (bonus_at / ?) < ?)
        RETURNING credits`,
        )
        .bind(bonus, now, now, userId, DAY_SECONDS, day),
      db
        .prepare(
          `INSERT INTO transactions
             (user_id, amount, balance_after, reason, origin, game_id, chat_id, idempotency_key, created_at)
           SELECT ?, ?, credits, 'bonus', 'bonus', NULL, NULL, ?, ?
             FROM users WHERE user_id = ? AND changes() = 1`,
        )
        .bind(userId, bonus, idempotencyKey, now, userId),
    ]);

    if (changesOf(results[0]) === 0) {
      throw new BonusAlreadyClaimedError("el bono de hoy ya está cobrado");
    }
    return { applied: true, amount: bonus, balance: balanceOf(results[0]) };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new BonusAlreadyClaimedError("el bono de hoy ya está cobrado");
    }
    throw error;
  }
}

/**
 * Rescate: si el saldo está por debajo del umbral, lo repone hasta el objetivo,
 * con enfriamiento. Usa compare-and-set sobre el saldo leído para que el importe
 * del asiento sea exacto aunque otra petición toque el saldo entre medias.
 */
export async function claimRescue(
  db: D1Database,
  userId: number,
  now: number = unixNow(),
  attempts = 3,
): Promise<MoveResult> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const user = await getUserRow(db, userId);
    if (!user) throw new UnknownUserError(`usuario ${userId} no reservado`);
    if (user.credits >= RESCUE_THRESHOLD) {
      throw new RescueNotAvailableError("tu saldo está por encima del umbral de rescate");
    }
    if (user.rescueAt !== null && now - user.rescueAt < RESCUE_COOLDOWN_SECONDS) {
      throw new RescueCooldownError(RESCUE_COOLDOWN_SECONDS - (now - user.rescueAt));
    }

    const delta = RESCUE_TARGET - user.credits;
    if (delta <= 0) throw new RescueNotAvailableError("no hay nada que reponer");

    const idempotencyKey = `rescue:${userId}:${Math.floor(now / RESCUE_COOLDOWN_SECONDS)}`;

    try {
      const results = await db.batch([
        db
          .prepare(
            `UPDATE users SET credits = ?, rescue_at = ?, updated_at = ?
              WHERE user_id = ? AND credits = ? AND (rescue_at IS NULL OR rescue_at <= ?)
          RETURNING credits`,
          )
          .bind(RESCUE_TARGET, now, now, userId, user.credits, now - RESCUE_COOLDOWN_SECONDS),
        db
          .prepare(
            `INSERT INTO transactions
               (user_id, amount, balance_after, reason, origin, game_id, chat_id, idempotency_key, created_at)
             SELECT ?, ?, credits, 'rescue', 'bonus', NULL, NULL, ?, ?
               FROM users WHERE user_id = ? AND changes() = 1`,
          )
          .bind(userId, delta, idempotencyKey, now, userId),
      ]);

      if (changesOf(results[0]) === 0) continue; // el saldo cambió: reintentar
      return { applied: true, amount: delta, balance: balanceOf(results[0]) };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RescueCooldownError(RESCUE_COOLDOWN_SECONDS);
      }
      throw error;
    }
  }
  throw new ConcurrentModificationError("no se pudo aplicar el rescate, reintenta");
}

// --------------------------------------------------------------------------
// Consultas
// --------------------------------------------------------------------------

export async function getBalance(db: D1Database, userId: number): Promise<number> {
  const row = await getUserRow(db, userId);
  if (!row) throw new UnknownUserError(`usuario ${userId} no reservado`);
  return row.credits;
}

export interface Movement {
  amount: number;
  balanceAfter: number;
  reason: LedgerReason;
  createdAt: number;
}

export async function recentMovements(
  db: D1Database,
  userId: number,
  limit = 5,
): Promise<Movement[]> {
  const { results } = await db
    .prepare(
      `SELECT amount, balance_after AS balanceAfter, reason, created_at AS createdAt
         FROM transactions WHERE user_id = ?
        ORDER BY id DESC LIMIT ?`,
    )
    .bind(userId, limit)
    .all<Movement>();
  return results ?? [];
}

export interface RankedPlayer {
  userId: number;
  displayName: string | null;
  value: number;
}

/** Ranking global: por saldo actual. */
export async function topByBalance(db: D1Database, limit: number): Promise<RankedPlayer[]> {
  const { results } = await db
    .prepare(
      `SELECT user_id AS userId, COALESCE(username, first_name) AS displayName, credits AS value
         FROM users WHERE deleted_at IS NULL
        ORDER BY credits DESC, user_id ASC LIMIT ?`,
    )
    .bind(limit)
    .all<RankedPlayer>();
  return results ?? [];
}

/**
 * Ranking por grupo: ganancia neta *jugada* en ese chat. Filtra por
 * `origin = 'game'`, así que los bonos y rescates no inflan la tabla.
 */
export async function topByGroupNet(
  db: D1Database,
  chatId: number,
  limit: number,
): Promise<RankedPlayer[]> {
  const { results } = await db
    .prepare(
      `SELECT t.user_id AS userId,
              COALESCE(u.username, u.first_name) AS displayName,
              SUM(t.amount) AS value
         FROM transactions t
         LEFT JOIN users u ON u.user_id = t.user_id
        WHERE t.chat_id = ? AND t.origin = 'game'
        GROUP BY t.user_id
        ORDER BY value DESC, t.user_id ASC LIMIT ?`,
    )
    .bind(chatId, limit)
    .all<RankedPlayer>();
  return results ?? [];
}

// --------------------------------------------------------------------------
// Auditoría
// --------------------------------------------------------------------------

export interface AuditReport {
  ok: boolean;
  usersChecked: number;
  /** Usuarios cuyo saldo cacheado no cuadra con la suma del ledger. */
  broken: { userId: number; credits: number; ledgerSum: number }[];
}

/**
 * Invariante del sistema: el saldo es una caché del ledger. Si esto falla,
 * alguien escribió créditos saltándose `wallet.ts`.
 */
export async function auditLedger(db: D1Database): Promise<AuditReport> {
  const { results } = await db
    .prepare(
      `SELECT u.user_id AS userId,
              u.credits AS credits,
              COALESCE(SUM(t.amount), 0) AS ledgerSum
         FROM users u
         LEFT JOIN transactions t ON t.user_id = u.user_id
        GROUP BY u.user_id
       HAVING u.credits <> COALESCE(SUM(t.amount), 0)`,
    )
    .all<{ userId: number; credits: number; ledgerSum: number }>();

  const broken = results ?? [];
  const count = await db.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
  return { ok: broken.length === 0, usersChecked: count?.n ?? 0, broken };
}
