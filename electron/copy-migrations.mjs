import { cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = join(__dirname, "..", "src", "adapters", "persistence", "migrations");
const dest = join(__dirname, "..", "dist", "adapters", "persistence", "migrations");

// tsc only emits compiled .ts files; drizzle-kit's generated .sql/meta files need a plain copy.
cpSync(src, dest, { recursive: true });
console.log("Copied migrations into dist/adapters/persistence/migrations");
