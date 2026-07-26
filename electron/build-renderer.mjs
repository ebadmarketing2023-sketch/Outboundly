import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(__dirname, "..", "src", "ui", "main-renderer.tsx")],
  bundle: true,
  outfile: join(__dirname, "renderer", "bundle.js"),
  format: "iife",
  platform: "browser",
  target: "chrome120",
  loader: { ".tsx": "tsx", ".ts": "ts" }
});

console.log("Renderer bundle built: electron/renderer/bundle.js");
