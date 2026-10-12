import { DEFAULT_MAX_PLAYERS, MIN_PLAYERS } from "../../config";
import type { GameEngine, GameStep, PlayerRow, StartInput } from "../types";

/**
 * Juego de prueba de la Fase 2: un sorteo entre los que están en el lobby.
 *
 * No tiene acciones ni turnos a propósito. Su papel es demostrar que el motor
 * de salas cierra un ciclo completo (lobby → arranque → reparto → vuelta a
 * IDLE) y que un lobby cancelado devuelve las apuestas. Los juegos con turnos,
 * estado secreto y timeouts llegan en la Fase 3 sobre esta misma interfaz.
 *
 * Ventaja de la casa: el 5 % del pozo truncado a entero. Con pozos pequeños son
 * cero créditos, que es lo correcto: no tiene sentido quedarse con parte de un
 * pozo de 2. El sobrante de repartir nunca se inventa, simplemente no se paga.
 */

export const SORTEO_TYPE = "sorteo";
const HOUSE_CUT_PERCENT = 5;

export interface SorteoState {
  pot: number;
  houseCut: number;
  winnerId: number;
  payout: number;
}

export const sorteo: GameEngine<SorteoState> = {
  type: SORTEO_TYPE,
  titleKey: "game.sorteo.title",
  minPlayers: MIN_PLAYERS,
  maxPlayers: DEFAULT_MAX_PLAYERS,

  start(input: StartInput): GameStep<SorteoState> {
    const { players, bet, rng, tr } = input;

    const pot = bet * players.length;
    const houseCut = Math.floor((pot * HOUSE_CUT_PERCENT) / 100);
    const winner = rng.pick(players);
    const payout = pot - houseCut;

    const lines = [
      tr("game.sorteo.title"),
      "",
      tr("game.sorteo.bet", { bet }),
      ...players.map((p: PlayerRow) => `· ${p.displayName}`),
      "",
      tr("game.sorteo.pot", { pot }),
    ];
    if (houseCut > 0) {
      lines.push(tr("game.sorteo.house", { cut: houseCut }));
    }
    lines.push("", tr("game.sorteo.winner", { name: winner.displayName, payout }));

    return {
      text: lines.join("\n"),
      state: { pot, houseCut, winnerId: winner.userId, payout },
      timeoutSeconds: null,
      payouts: [{ userId: winner.userId, amount: payout }],
      finished: true,
    };
  },
};
