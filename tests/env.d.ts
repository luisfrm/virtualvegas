import type { D1Migration } from "@cloudflare/vitest-plugin";

/**
 * `wrangler types` genera `Cloudflare.Env` a partir de wrangler.toml. Aquí se
 * añaden las dos cosas que ese archivo no puede saber:
 *  - los secretos, que viven en .dev.vars o en `wrangler secret put`
 *  - las migraciones que vitest.config.ts inyecta solo en los tests
 */
declare global {
  namespace Cloudflare {
    interface Env {
      WEBHOOK_SECRET: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
