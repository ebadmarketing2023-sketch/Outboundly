import type { Config } from "drizzle-kit";

export default {
  schema: "./src/adapters/persistence/schema.ts",
  out: "./src/adapters/persistence/migrations",
  dialect: "sqlite"
} satisfies Config;
