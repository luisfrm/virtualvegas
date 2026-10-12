import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DAILY_BONUS,
  INITIAL_CREDITS,
  RESCUE_COOLDOWN_SECONDS,
  RESCUE_TARGET,
  RESCUE_THRESHOLD,
} from "../src/config";
import { touchUser } from "../src/core/users";
import { resetDatabase } from "./helpers";
import {
  BonusAlreadyClaimedError,
  InsufficientFundsError,
  RescueCooldownError,
  RescueNotAvailableError,
  auditLedger,
  claimDailyBonus,
  claimRescue,
  credit,
  debit,
  getBalance,
  recentMovements,
  type MoveParams,
} from "../src/core/wallet";

const db = env.DB;
const USER = 1001;
const T0 = 1_700_000_000; // instante fijo para que los tests no dependan del reloj

async function reservarCuenta(userId = USER, now = T0): Promise<void> {
  await touchUser(
    db,
    { userId, username: "ana", firstName: "Ana", languageCode: "es" },
    now,
  );
}

// Cada test parte de una base vacía y de una cuenta recién creada.
beforeEach(async () => {
  await resetDatabase(db);
  await reservarCuenta();
});

async function contarAsientos(userId = USER): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("alta de usuario", () => {
  it("da 100 créditos y deja el asiento inicial en el ledger", async () => {
    expect(await getBalance(db, USER)).toBe(INITIAL_CREDITS);

    const movimientos = await recentMovements(db, USER, 10);
    expect(movimientos).toHaveLength(1);
    expect(movimientos[0]).toMatchObject({
      amount: INITIAL_CREDITS,
      reason: "initial",
      balanceAfter: INITIAL_CREDITS,
    });
    expect((await auditLedger(db)).ok).toBe(true);
  });

  it("es idempotente: repetir el alta no regala créditos otra vez", async () => {
    await reservarCuenta(USER, T0 + 10);
    await reservarCuenta(USER, T0 + 20);

    expect(await getBalance(db, USER)).toBe(INITIAL_CREDITS);
    expect(await contarAsientos()).toBe(1);
  });
});

describe("débito", () => {
  it("descuenta y anota el saldo resultante", async () => {
    const result = await debit(db, {
      userId: USER,
      amount: 20,
      reason: "bet",
      origin: "game",
      idempotencyKey: "bet:1",
      chatId: -1001,
      now: T0,
    });

    expect(result).toEqual({ applied: true, amount: 20, balance: 80 });
    const movimientos = await recentMovements(db, USER, 1);
    expect(movimientos[0]).toMatchObject({ amount: -20, reason: "bet", balanceAfter: 80 });
  });

  it("rechaza el débito sin saldo y no deja rastro en el ledger", async () => {
    await expect(
      debit(db, {
        userId: USER,
        amount: INITIAL_CREDITS + 1,
        reason: "bet",
        origin: "game",
        idempotencyKey: "bet:sin-fondos",
        now: T0,
      }),
    ).rejects.toBeInstanceOf(InsufficientFundsError);

    expect(await getBalance(db, USER)).toBe(INITIAL_CREDITS);
    expect(await contarAsientos()).toBe(1); // solo el alta
  });

  it("rechaza importes no enteros o no positivos", async () => {
    const base: Omit<MoveParams, "amount"> = {
      userId: USER,
      reason: "bet",
      origin: "game",
      idempotencyKey: "bet:raro",
      now: T0,
    };
    await expect(debit(db, { ...base, amount: 1.5 })).rejects.toThrow(/entero positivo/);
    await expect(debit(db, { ...base, amount: 0 })).rejects.toThrow(/entero positivo/);
  });

  /**
   * El test que sostiene todo lo demás. D1 no tiene transacciones interactivas,
   * así que la garantía viene del UPDATE guardado (`WHERE credits >= ?`) más el
   * asiento condicionado a `changes() = 1`: si el guard no pasa, el batch entero
   * se revierte y no queda un asiento huérfano.
   */
  it("con débitos simultáneos no genera saldo negativo y acierta el número de apuestas", async () => {
    const apuesta = 7;
    const intentos = 40;
    const esperadas = Math.floor(INITIAL_CREDITS / apuesta); // 14

    const resultados = await Promise.allSettled(
      Array.from({ length: intentos }, (_, i) =>
        debit(db, {
          userId: USER,
          amount: apuesta,
          reason: "bet",
          origin: "game",
          idempotencyKey: `bet:simultanea:${i}`,
          chatId: -1001,
          now: T0,
        }),
      ),
    );

    const aceptadas = resultados.filter((r) => r.status === "fulfilled").length;
    const rechazadas = resultados.filter(
      (r) => r.status === "rejected" && r.reason instanceof InsufficientFundsError,
    ).length;

    expect(aceptadas).toBe(esperadas);
    expect(rechazadas).toBe(intentos - esperadas);

    const saldo = await getBalance(db, USER);
    expect(saldo).toBe(INITIAL_CREDITS - esperadas * apuesta);
    expect(saldo).toBeGreaterThanOrEqual(0);

    // Un asiento por apuesta aceptada, ni uno más: nada de huérfanos.
    expect(await contarAsientos()).toBe(1 + esperadas);
    expect((await auditLedger(db)).ok).toBe(true);
  });

  it("un reintento con la misma clave no vuelve a cobrar", async () => {
    const params: MoveParams = {
      userId: USER,
      amount: 30,
      reason: "bet",
      origin: "game",
      idempotencyKey: "bet:reintento",
      now: T0,
    };

    const primera = await debit(db, params);
    const segunda = await debit(db, params);

    expect(primera.applied).toBe(true);
    expect(segunda).toEqual({ applied: false, amount: 30, balance: 70 });
    expect(await getBalance(db, USER)).toBe(70);
    expect(await contarAsientos()).toBe(2);
  });

  it("dos peticiones idénticas a la vez se resuelven en un solo débito", async () => {
    const params: MoveParams = {
      userId: USER,
      amount: 30,
      reason: "bet",
      origin: "game",
      idempotencyKey: "bet:carrera",
      now: T0,
    };

    const [a, b] = await Promise.all([debit(db, params), debit(db, params)]);

    expect(await getBalance(db, USER)).toBe(70);
    expect(await contarAsientos()).toBe(2);
    expect([a.applied, b.applied].filter(Boolean)).toHaveLength(1);
  });

  it("rechaza el débito de un usuario que no existe", async () => {
    await expect(
      debit(db, {
        userId: 99999,
        amount: 1,
        reason: "bet",
        origin: "game",
        idempotencyKey: "bet:fantasma",
        now: T0,
      }),
    ).rejects.toThrow(/no reservado/);
  });
});

describe("crédito", () => {
  it("suma y anota", async () => {
    const result = await credit(db, {
      userId: USER,
      amount: 25,
      reason: "payout",
      origin: "game",
      idempotencyKey: "payout:1",
      now: T0,
    });

    expect(result).toEqual({ applied: true, amount: 25, balance: 125 });
    expect((await auditLedger(db)).ok).toBe(true);
  });
});

describe("bono diario", () => {
  it("paga una vez al día (UTC)", async () => {
    const primero = await claimDailyBonus(db, USER, DAILY_BONUS, T0);
    expect(primero).toEqual({ applied: true, amount: DAILY_BONUS, balance: 110 });

    await expect(claimDailyBonus(db, USER, DAILY_BONUS, T0 + 60)).rejects.toBeInstanceOf(
      BonusAlreadyClaimedError,
    );
    expect(await getBalance(db, USER)).toBe(110);
  });

  it("vuelve a pagar al día siguiente", async () => {
    await claimDailyBonus(db, USER, DAILY_BONUS, T0);
    const manana = await claimDailyBonus(db, USER, DAILY_BONUS, T0 + 86_400);

    expect(manana.balance).toBe(120);
    expect(await contarAsientos()).toBe(3); // alta + dos bonos
  });

  it("El bono se cobra a las 00:00 UTC, no a las 24 h de haberlo cobrado", async () => {
    // 23:59 UTC: cobra.
    const casiMedianoche = Math.floor(T0 / 86_400) * 86_400 + 86_399;
    await claimDailyBonus(db, USER, DAILY_BONUS, casiMedianoche);

    // Un minuto después ya es otro día UTC: puede volver a cobrar.
    const siguiente = await claimDailyBonus(db, USER, DAILY_BONUS, casiMedianoche + 60);
    expect(siguiente.applied).toBe(true);
  });

  it("dos peticiones a la vez solo pagan una", async () => {
    const resultados = await Promise.allSettled([
      claimDailyBonus(db, USER, DAILY_BONUS, T0),
      claimDailyBonus(db, USER, DAILY_BONUS, T0 + 1),
    ]);

    const pagados = resultados.filter((r) => r.status === "fulfilled").length;
    expect(pagados).toBe(1);
    expect(await getBalance(db, USER)).toBe(110);
    expect((await auditLedger(db)).ok).toBe(true);
  });
});

describe("rescate", () => {
  async function dejarSinSaldo(amount: number, key: string): Promise<void> {
    await debit(db, {
      userId: USER,
      amount,
      reason: "bet",
      origin: "game",
      idempotencyKey: key,
      now: T0,
    });
  }

  it("repone hasta el objetivo cuando el saldo está por debajo", async () => {
    await dejarSinSaldo(95, "bet:arruinarse"); // quedan 5
    const rescate = await claimRescue(db, USER, T0 + 100);

    expect(rescate).toEqual({ applied: true, amount: 5, balance: RESCUE_TARGET });
    const movimientos = await recentMovements(db, USER, 1);
    expect(movimientos[0]).toMatchObject({ amount: 5, reason: "rescue", balanceAfter: RESCUE_TARGET });
    expect((await auditLedger(db)).ok).toBe(true);
  });

  it("no da rescate si el saldo está por encima del umbral", async () => {
    await expect(claimRescue(db, USER, T0 + 100)).rejects.toBeInstanceOf(RescueNotAvailableError);
    expect(await getBalance(db, USER)).toBe(INITIAL_CREDITS);
    expect(RESCUE_THRESHOLD).toBeLessThan(INITIAL_CREDITS);
  });

  it("respeta el enfriamiento y luego vuelve a funcionar", async () => {
    await dejarSinSaldo(95, "bet:1");
    await claimRescue(db, USER, T0 + 100);

    await dejarSinSaldo(8, "bet:2"); // quedan 2
    await expect(claimRescue(db, USER, T0 + 200)).rejects.toBeInstanceOf(RescueCooldownError);

    const tarde = await claimRescue(db, USER, T0 + 100 + RESCUE_COOLDOWN_SECONDS + 1);
    expect(tarde.applied).toBe(true);
    expect(tarde.balance).toBe(RESCUE_TARGET);
    expect((await auditLedger(db)).ok).toBe(true);
  });
});

describe("auditoría", () => {
  it("detecta que alguien tocó el saldo saltándose la billetera", async () => {
    await db.prepare(`UPDATE users SET credits = credits + 500 WHERE user_id = ?`).bind(USER).run();

    const informe = await auditLedger(db);
    expect(informe.ok).toBe(false);
    expect(informe.broken).toEqual([{ userId: USER, credits: 600, ledgerSum: INITIAL_CREDITS }]);
  });
});
