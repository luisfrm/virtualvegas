import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * Los tests corren en el runtime real de Workers (workerd) vía Miniflare: D1 de
 * verdad, Durable Objects de verdad. Lo único simulado es la API de Telegram
 * (ver tests/helpers.ts).
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./src/db/migrations");

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Valores de mentira solo para los tests; los reales son secretos.
            BOT_TOKEN: "1234567890:TEST-token-aaaaaaaaaaaaaaaaaaaaaaaaa",
            WEBHOOK_SECRET: "test-webhook-secret-0123456789",
          },
        },
      }),
    ],
    test: {
      include: ["tests/**/*.spec.ts"],
      setupFiles: ["./tests/apply-migrations.ts"],
    },
  };
});
