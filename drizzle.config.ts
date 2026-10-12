import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` produce el SQL de src/db/migrations, que es el mismo
// que consumen `wrangler d1 migrations apply` y los tests.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
});
