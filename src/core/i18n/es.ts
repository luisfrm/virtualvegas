/**
 * Textos. Español por defecto; cualquier idioma que falte cae en `es`.
 * Las claves llevan huecos `{nombre}` que rellena `t()`.
 */

export const es = {
  "help.title": "<b>🎰 VirtualVegas</b>",
  "help.body": [
    "Un casino virtual de ocio. Los créditos no valen dinero ni se pueden canjear.",
    "",
    "<b>Comandos</b>",
    "/saldo — mira tus créditos",
    "/bono — cobra 10 créditos, uno por día",
    "/rescate — si estás por debajo de 10, te repongo el saldo",
    "/ranking — los que más tienen",
    "/sorteo [apuesta] — abre una partida en el grupo",
    "/ping — comprueba que el bot responde",
    "/ayuda — este mensaje",
  ].join("\n"),
  "help.games_soon": "Los demás juegos (/dados, /ruleta, /tragamonedas) llegan en la próxima fase.",

  "ping.ok":
    "pong 🎰\nWorker ✅ · Sala <code>{room}</code> ✅ · D1 ✅\n{users} jugadores registrados.",

  "balance.title": "💰 Tienes <b>{credits}</b> créditos.",
  "balance.movements": "<b>Últimos movimientos</b>",
  "balance.empty": "Todavía no hay movimientos.",

  "bonus.ok": "🎁 Bono diario: <b>+{bonus}</b> créditos. Ahora tienes <b>{credits}</b>.",
  "bonus.already": "Ya has cobrado el bono de hoy. Vuelve mañana (se resetea a las 00:00 UTC).",

  "rescue.ok": "🚑 Rescate aplicado: <b>+{amount}</b> créditos. Ahora tienes <b>{credits}</b>.",
  "rescue.not_needed": "No necesitas rescate: tu saldo ({credits}) está por encima de {threshold}.",
  "rescue.cooldown": "Ya te has rescatado hace poco. Vuelve en <b>{minutes}</b> min.",

  "ranking.global": "🏆 <b>Ranking global</b>",
  "ranking.group": "🏆 <b>Ranking de este grupo</b> (ganancia neta jugada)",
  "ranking.empty": "Todavía no hay nadie en la tabla.",
  "ranking.row": "{position}. {name} — <b>{value}</b>",

  "reason.initial": "alta",
  "reason.bonus": "bono",
  "reason.rescue": "rescate",
  "reason.bet": "apuesta",
  "reason.payout": "premio",
  "reason.refund": "reembolso",
  "reason.purchase": "compra",

  "game.sorteo.title": "🎟️ <b>Sorteo</b>",
  "game.sorteo.bet": "Apuesta por jugador: <b>{bet}</b> créditos",
  "game.sorteo.pot": "Pozo: <b>{pot}</b>",
  "game.sorteo.house": "La casa se lleva {cut}",
  "game.sorteo.winner": "🏆 Gana <b>{name}</b> con <b>{payout}</b> créditos.",
  "game.timeout": "⏱️ Se agotó el tiempo de la partida.",
  "game.stale_button": "Ese botón es de una partida que ya no está en marcha.",
  "game.not_your_turn": "No es tu turno.",
  "game.not_playing": "No estás jugando esta partida.",

  "lobby.header": "{title} — apuesta: <b>{bet}</b> créditos",
  "lobby.timer": "Cierra en {seconds} s.",
  "lobby.players": "<b>Jugadores</b> ({count}/{max})",
  "lobby.empty": "Todavía no hay nadie.",
  "lobby.hint": "Pulsa <b>Unirme</b> para entrar.",
  "lobby.btn.join": "Unirme",
  "lobby.btn.leave": "Salir",
  "lobby.btn.start": "Empezar",
  "lobby.joined": "Dentro ({count}/{max})",
  "lobby.left": "Has salido. Te devuelvo <b>{amount}</b> créditos.",
  "lobby.starting": "¡Empieza la partida!",
  "lobby.cancelled": "⏱️ Lobby cerrado sin empezar. Apuestas devueltas ({count}).",
  "lobby.cancelled_empty": "⏱️ Lobby cerrado: no se apuntó nadie.",
  "lobby.error.busy": "Ya hay una partida abierta en este chat.",
  "lobby.error.already": "Ya estás dentro.",
  "lobby.error.full": "La partida está llena ({max}).",
  "lobby.error.not_member": "No estás en esta partida.",
  "lobby.error.not_host": "Solo quien abrió la partida puede empezarla.",
  "lobby.error.not_enough": "Hacen falta al menos {min} jugadores.",
  "lobby.error.stale": "Ese botón es de una partida que ya no está en marcha.",
  "lobby.error.group_only": "Los juegos grupales van en un grupo, no en el chat privado.",
  "lobby.error.bet_range": "La apuesta tiene que ser un entero entre {min} y {max}.",
  "lobby.error.no_funds": "No te llega el saldo: tienes {credits} y la apuesta es {bet}.",

  "error.unknown_user": "No encuentro tu cuenta. Prueba otra vez en un momento.",
  "error.insufficient": "No te llega el saldo: tienes {credits} y la apuesta es {amount}.",
  "error.generic": "Uf, algo se ha roto por dentro. Ya está anotado.",
  "error.not_a_command": "No conozco ese comando. Prueba /ayuda.",
} as const;

export type TranslationKey = keyof typeof es;

export const dictionaries: Record<string, Partial<Record<TranslationKey, string>>> = { es };

/** Español es el idioma de referencia: si falta una clave en otro idioma, se usa este. */
export const fallback = es;
