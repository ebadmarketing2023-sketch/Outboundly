import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ToastProvider } from "./components/index.js";

// global.d.ts (Window.outboundly typing) is picked up automatically by the TypeScript compiler
// via tsconfig's "include" — it has no runtime output, so it's a type-only reference, not an import.

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");
createRoot(container).render(
  <ToastProvider>
    <App />
  </ToastProvider>
);
