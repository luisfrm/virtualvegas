import type { InlineKeyboard } from "grammy";
import type { TranslationKey } from "../core/i18n";
import type { Rng } from "../core/rng";

/** Atajo de traducción ligado al idioma del jugador. */
export type Translator = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

/**
 * Interfaz que implementa cada juego. Añadir uno nuevo no debe tocar el núcleo:
 * el motor de salas se encarga del lobby, el dinero, los mensajes y los
 * timeouts, y el juego solo calcula el siguiente paso.
 *
 * Los juegos son funciones casi puras: reciben el estado y devuelven un
 * `GameStep`. Quien persiste, paga y edita el mensaje es la sala. Así un juego
 * se puede probar sin Telegram ni base de datos.
 */

export interface PlayerRow {
  userId: number;
  displayName: string;
  /** Créditos que puso en esta partida. */
  amount: number;
}

export interface Payout {
  userId: number;
  /** Entero positivo. La suma de todos los pagos nunca supera el pozo. */
  amount: number;
}

export interface GameStep<S> {
  /**
   * Texto completo del mensaje de la partida. Si se omite, el mensaje no se
   * edita: es lo que devuelve un `action` que rechaza la jugada (por ejemplo,
   * porque no es el turno de quien ha pulsado) sin repintar nada.
   */
  text?: string;
  keyboard?: InlineKeyboard;
  /** Estado propio del juego; se guarda tal cual. */
  state: S;
  /**
   * Segundos hasta el siguiente vencimiento. `null` (u omitido) significa que
   * la partida no espera nada: no se arma alarma.
   */
  timeoutSeconds?: number | null;
  /** Lo que hay que pagar. El resto del pozo se queda la casa. */
  payouts?: Payout[];
  /** La partida ha terminado: la sala vuelve a IDLE. */
  finished?: boolean;
  /** Aviso corto que solo ve quien ha pulsado el botón. */
  answer?: string;
}

export interface StartInput {
  players: readonly PlayerRow[];
  /** Apuesta por jugador; todos apuestan lo mismo. */
  bet: number;
  rng: Rng;
  /**
   * El juego escribe sus propios textos, con claves tipadas: si una clave no
   * existe, falla el compilador y no el grupo de Telegram.
   */
  tr: Translator;
}

export interface ActionInput<S> extends StartInput {
  state: S;
  /** Quien ha pulsado. La sala ya ha comprobado que es participante. */
  userId: number;
  /** Acción pedida, ya decodificada del callback. */
  action: string;
}

export interface TimeoutInput<S> extends StartInput {
  state: S;
}

export interface GameEngine<S = unknown> {
  /** Identificador corto: aparece en `callback_data` y en los logs. */
  readonly type: string;
  /** Título traducible, el que se enseña en el lobby. */
  readonly titleKey: TranslationKey;
  /** Mínimo de jugadores; nunca por debajo de `MIN_PLAYERS`. */
  readonly minPlayers: number;
  readonly maxPlayers: number;
  /** Arranca la partida y devuelve el primer paso. */
  start(input: StartInput): GameStep<S> | Promise<GameStep<S>>;
  /**
   * Alguien ha pulsado un botón de la partida.
   *
   * Aquí es donde se valida el turno: la sala ya ha comprobado que quien pulsa
   * es participante, pero solo el juego sabe a quién le toca. Si no le toca,
   * devolver un paso sin `text` y con `answer` para avisarle sin repintar.
   */
  action?(input: ActionInput<S>): GameStep<S> | Promise<GameStep<S>>;
  /** Se agotó el tiempo de espera de la partida o del turno. */
  timeout?(input: TimeoutInput<S>): GameStep<S> | Promise<GameStep<S>>;
}
