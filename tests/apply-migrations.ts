import { applyD1Migrations, env } from "cloudflare:test";

// Los setup files corren FUERA del almacenamiento aislado de cada test, así que
// las migraciones quedan aplicadas en la base para todos los tests.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
