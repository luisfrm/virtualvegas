/**
 * Economía acordada. Números pequeños y SIEMPRE enteros: con enteros no hay
 * errores de redondeo, y al repartir un pozo el resto va a la casa o se sortea.
 */
export const INITIAL_CREDITS = 100;
export const DAILY_BONUS = 10;
/** Si el saldo baja de este umbral, el rescate lo repone hasta RESCUE_TARGET. */
export const RESCUE_THRESHOLD = 10;
export const RESCUE_TARGET = 10;
export const RESCUE_COOLDOWN_SECONDS = 6 * 60 * 60;
export const MIN_BET = 1;
export const DEFAULT_MAX_BET = 20;

export const DAY_SECONDS = 86_400;

/** Filas que se muestran en /ranking. */
export const RANKING_LIMIT = 10;

// --- Motor de salas (Fase 2) ---------------------------------------------
// Decisiones confirmadas antes de escribir el motor:
//  · lobby de 60 s: suficiente para que la gente pulse el botón sin que el
//    mensaje se quede estorbando. En la Fase 4 pasará a config por grupo.
//  · de 2 a 8 jugadores: el máximo lo declara cada juego, porque de él depende
//    cómo se reparte el pozo.
//  · el rescate es un COMANDO, no automático: si se repusiera solo, las
//    métricas de economía y de enganche medirían otra cosa.
//  · el ranking de grupo mide ganancia neta jugada (ver `topByGroupNet`).

/** Lo que se espera en el lobby antes de arrancar o cancelar. */
export const LOBBY_SECONDS = 60;
/** Mínimo técnico de un juego grupal: con uno no hay juego. */
export const MIN_PLAYERS = 2;
/** Tope por defecto; cada `GameEngine` puede declarar el suyo. */
export const DEFAULT_MAX_PLAYERS = 8;
/** Los nombres se recortan para que el mensaje del lobby no crezca sin límite. */
export const MAX_DISPLAY_NAME = 32;
