/**
 * Azar. Nunca `Math.random()`: en Workers, `crypto.getRandomValues` es la
 * fuente criptográfica y es la única que no se puede predecir.
 *
 * Se inyecta como dependencia en los juegos para que los tests puedan pasar un
 * generador determinista y comprobar el reparto sin depender de la suerte.
 */
export interface Rng {
  /** Entero en [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Elige un elemento; lanza si la lista está vacía. */
  pick<T>(items: readonly T[]): T;
}

/**
 * Muestreo por rechazo: con `%` el sesgo es pequeño pero real, y aquí el azar
 * decide dinero.
 */
export const cryptoRng: Rng = {
  int(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError(`maxExclusive debe ser un entero positivo: ${maxExclusive}`);
    }
    if (maxExclusive === 1) return 0;

    // Se busca el mayor múltiplo de maxExclusive que cabe en 32 bits sin signo.
    const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
    const buffer = new Uint32Array(1);
    let value: number;
    do {
      crypto.getRandomValues(buffer);
      value = buffer[0] ?? 0;
    } while (value >= limit);

    return value % maxExclusive;
  },

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("no se puede elegir de una lista vacía");
    const item = items[this.int(items.length)];
    // `noUncheckedIndexedAccess` no puede saber que el índice es válido.
    return item as T;
  },
};

/**
 * Generador determinista para tests (xorshift32). No es criptográfico: solo
 * sirve para que una partida de prueba sea reproducible.
 */
export function seededRng(seed: number): Rng {
  let state = seed >>> 0 || 1;
  const next = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  return {
    int(maxExclusive: number): number {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new RangeError(`maxExclusive debe ser un entero positivo: ${maxExclusive}`);
      }
      return next() % maxExclusive;
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new RangeError("no se puede elegir de una lista vacía");
      return items[this.int(items.length)] as T;
    },
  };
}
