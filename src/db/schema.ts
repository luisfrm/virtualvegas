import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Estado global en D1. Todo el dinero vive aquí.
 *
 * Reglas de oro del esquema:
 *  - `users.credits` es una columna *cacheada*: la fuente de verdad es el
 *    ledger (`transactions`). Solo se escribe desde `src/core/wallet.ts`, con
 *    sentencias guardadas (`WHERE credits >= ?`), nunca con un SET a pelo.
 *  - `transactions` es de solo escritura (append-only). No se actualiza ni se
 *    borra una fila nunca.
 *  - La invariante que deben cumplir los tests es:
 *        users.credits === SUM(transactions.amount)   para todo usuario.
 */

export const users = sqliteTable(
  "users",
  {
    userId: integer("user_id").primaryKey(),
    username: text("username"),
    firstName: text("first_name"),
    languageCode: text("language_code"),
    /** Saldo cacheado. Sin DEFAULT a propósito: siempre se escribe junto al asiento del ledger. */
    credits: integer("credits").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    /** Última vez que cobró el bono diario (unix seconds UTC). */
    bonusAt: integer("bonus_at"),
    /** Último rescate (unix seconds UTC). */
    rescueAt: integer("rescue_at"),
    /** Borrado lógico para /borrar_mis_datos (Fase 4). */
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("users_credits_idx").on(t.credits)],
);

export const TRANSACTION_REASONS = [
  "initial",
  "bonus",
  "rescue",
  "bet",
  "payout",
  "refund",
  "purchase",
] as const;

/** Distingue de dónde sale el crédito, tal y como pide el brief de monetización. */
export const TRANSACTION_ORIGINS = ["bonus", "game", "purchase"] as const;

export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    /** Con signo: negativo debita, positivo acredita. */
    amount: integer("amount").notNull(),
    /** Saldo justo después de aplicar esta fila. Para auditar sin recalcular. */
    balanceAfter: integer("balance_after").notNull(),
    reason: text("reason", { enum: TRANSACTION_REASONS }).notNull(),
    origin: text("origin", { enum: TRANSACTION_ORIGINS }).notNull(),
    /** Partida a la que pertenece el movimiento (Fase 2+). */
    gameId: text("game_id"),
    /** Grupo en el que ocurrió, para el ranking por grupo. NULL en privado. */
    chatId: integer("chat_id"),
    /** Clave de idempotencia determinista: reintentar el mismo pago no duplica. */
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("transactions_idempotency_key_uidx").on(t.idempotencyKey),
    index("transactions_user_created_idx").on(t.userId, t.createdAt),
    index("transactions_chat_origin_idx").on(t.chatId, t.origin),
  ],
);

/** Dedupe de webhooks reenviados por Telegram. Una fila por update_id. */
export const processedUpdates = sqliteTable(
  "processed_updates",
  {
    updateId: integer("update_id").primaryKey(),
    /** 'processing' mientras se atiende, 'done' cuando terminó bien. */
    status: text("status", { enum: ["processing", "done"] }).notNull(),
    chatId: integer("chat_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("processed_updates_created_idx").on(t.createdAt)],
);

/** Catálogo de créditos (Fase 6). Se crea ahora para no migrar después. */
export const products = sqliteTable("products", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  /** Precio en Telegram Stars (XTR). */
  stars: integer("stars").notNull(),
  credits: integer("credits").notNull(),
  active: integer("active").notNull().default(1),
});

/** Pagos en Stars (Fase 6). `chargeId` es el telegram_payment_charge_id. */
export const payments = sqliteTable(
  "payments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    productId: text("product_id").notNull(),
    chargeId: text("charge_id").notNull(),
    stars: integer("stars").notNull(),
    credits: integer("credits").notNull(),
    status: text("status", { enum: ["paid", "refunded"] }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("payments_charge_id_uidx").on(t.chargeId),
    index("payments_user_idx").on(t.userId),
  ],
);
