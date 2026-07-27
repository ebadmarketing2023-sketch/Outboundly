import type { MimeHeader } from "./types.js";

export function findHeaderValue(headers: MimeHeader[], name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}
