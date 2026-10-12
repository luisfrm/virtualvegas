/** Segundos unix, la unidad de tiempo en toda la base de datos. */
export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Índice del día UTC. El bono diario y los límites del plan gratuito de
 * Cloudflare resetean a las 00:00 UTC, así que todo se cuenta en UTC.
 */
export function utcDay(seconds: number): number {
  return Math.floor(seconds / 86_400);
}
