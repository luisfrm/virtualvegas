import { INITIAL_CREDITS } from "../config";
import { unixNow } from "./time";

/**
 * Capa de identidad. El registro es implícito: la primera vez que alguien
 * escribe un comando, se le reserva la cuenta, se le dan los créditos iniciales
 * y se deja el asiento `initial` en el ledger — todo en un solo `batch()`.
 *
 * Guarda lo mínimo (id, username, nombre) por privacidad.
 */

export interface UserProfile {
  userId: number;
  username: string | null;
  firstName: string | null;
  languageCode: string | null;
}

export interface TouchResult {
  /** `true` si la cuenta se acaba de crear (y por tanto hubo saldo inicial). */
  created: boolean;
  balance: number;
}

export async function touchUser(
  db: D1Database,
  profile: UserProfile,
  now: number = unixNow(),
): Promise<TouchResult> {
  const { userId, username, firstName, languageCode } = profile;

  const results = await db.batch([
    // 1. Reserva la cuenta con el saldo inicial. Si ya existía, no toca nada.
    db
      .prepare(
        `INSERT OR IGNORE INTO users
           (user_id, username, first_name, language_code, credits, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(userId, username, firstName, languageCode, INITIAL_CREDITS, now, now),

    // 2. El asiento del saldo inicial SOLO si la acaba de crear la sentencia 1.
    //    Sin esto, el ledger y el saldo podrían divergir desde el minuto cero.
    db
      .prepare(
        `INSERT INTO transactions
           (user_id, amount, balance_after, reason, origin, game_id, chat_id, idempotency_key, created_at)
         SELECT ?, ?, credits, 'initial', 'bonus', NULL, NULL, ?, ?
           FROM users WHERE user_id = ? AND changes() = 1`,
      )
      .bind(userId, INITIAL_CREDITS, `initial:${userId}`, now, userId),

    // 3. Refresca la identidad solo si de verdad cambió: los comandos repetidos
    //    no deben gastar escrituras del plan gratuito.
    db
      .prepare(
        `UPDATE users SET username = ?, first_name = ?, language_code = ?, updated_at = ?
          WHERE user_id = ?
            AND (username IS NOT ? OR first_name IS NOT ? OR language_code IS NOT ?)`,
      )
      .bind(username, firstName, languageCode, now, userId, username, firstName, languageCode),

    // 4. Saldo actual, para no tener que hacer otra ida y vuelta.
    db.prepare(`SELECT credits FROM users WHERE user_id = ?`).bind(userId),
  ]);

  const balanceRow = results[3]?.results?.[0] as { credits?: number } | undefined;
  return {
    created: (results[0]?.meta?.changes ?? 0) === 1,
    balance: balanceRow?.credits ?? INITIAL_CREDITS,
  };
}
