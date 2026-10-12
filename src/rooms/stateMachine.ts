import type { Phase } from "./roomStore";

/**
 * Máquina de estados de la sala:
 *
 *   IDLE ──abrir lobby──▶ LOBBY ──arrancar──▶ PLAYING ──terminar──▶ FINISHED
 *     ▲                     │                    │                    │
 *     └─────cancelar────────┴────────────────────┘◀────volver a IDLE──┘
 *
 * Las transiciones se aplican con un UPDATE guardado (`WHERE phase IN (...)`),
 * así que un update duplicado de Telegram no puede mover la sala dos veces:
 * el segundo intento no encuentra la fila en la fase esperada y no hace nada.
 */

export const PHASES = ["IDLE", "LOBBY", "PLAYING", "FINISHED"] as const;

/** A qué fases se puede ir desde cada una. */
const ALLOWED: Record<Phase, readonly Phase[]> = {
  IDLE: ["LOBBY"],
  // De LOBBY se arranca, o se vuelve a IDLE si se cancela (y se devuelve todo).
  LOBBY: ["PLAYING", "IDLE"],
  // De PLAYING se termina, o se vuelve a IDLE si hay que abortar la partida.
  PLAYING: ["FINISHED", "IDLE"],
  // FINISHED es un estado de paso: se vuelve a IDLE al limpiar la mesa.
  FINISHED: ["IDLE"],
};

export function isPhase(value: string): value is Phase {
  return (PHASES as readonly string[]).includes(value);
}

export function canTransition(from: Phase, to: Phase): boolean {
  return ALLOWED[from].includes(to);
}

/** Fases desde las que se puede pasar a `to`. Sirve para el guard del UPDATE. */
export function sourcesFor(to: Phase): Phase[] {
  return PHASES.filter((from) => canTransition(from, to));
}

export function describeTransition(from: Phase, to: Phase): string {
  return `${from} → ${to}`;
}
