import { fallback, dictionaries, es, type TranslationKey } from "./es";

export type { TranslationKey };
export { es };

/**
 * Traduce una clave y rellena los huecos `{nombre}`.
 * Si el idioma no existe o le falta la clave, cae en español.
 */
export function t(
  languageCode: string | null | undefined,
  key: TranslationKey,
  params: Record<string, string | number> = {},
): string {
  const language = normalize(languageCode);
  const template = dictionaries[language]?.[key] ?? fallback[key];

  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** Telegram manda cosas como `es-ES` o `pt-BR`; nos quedamos con la base. */
function normalize(languageCode: string | null | undefined): string {
  if (!languageCode) return "es";
  return languageCode.toLowerCase().split(/[-_]/)[0] ?? "es";
}

/**
 * Atajo ligado al idioma, para no repetir el idioma en cada llamada.
 * `const tr = translator(ctx.from?.language_code)` permite `tr("balance.title")`.
 */
export function translator(languageCode: string | null | undefined) {
  return (key: TranslationKey, params?: Record<string, string | number>) =>
    t(languageCode, key, params);
}

/**
 * Telegram interpreta HTML en los mensajes, así que cualquier texto que venga
 * del usuario (nombres, sobre todo) hay que escaparlo antes de meterlo.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
