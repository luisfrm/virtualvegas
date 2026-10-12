import { sorteo } from "./sorteo";
import type { GameEngine } from "./types";

/**
 * Registro de juegos. El motor de salas solo conoce esta tabla: añadir un juego
 * es implementar `GameEngine` y registrarlo aquí.
 *
 * El tipo del registro es `GameEngine<unknown>` a propósito: la sala guarda el
 * estado como JSON y no necesita saber de qué forma tiene cada juego.
 */
const engines = new Map<string, GameEngine<unknown>>();

export function registerEngine(engine: GameEngine<unknown>): void {
  if (engines.has(engine.type)) {
    throw new Error(`ya hay un juego registrado con el tipo ${engine.type}`);
  }
  engines.set(engine.type, engine);
}

export function getEngine(type: string): GameEngine<unknown> | undefined {
  return engines.get(type);
}

registerEngine(sorteo);
