import type { OutboundlyRendererApi } from "../ipc-boundary/contracts.js";

declare global {
  interface Window {
    outboundly: OutboundlyRendererApi;
  }
}

export {};
