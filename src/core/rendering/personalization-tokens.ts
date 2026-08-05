import type { InlineNode } from "./document-model.js";
import { textRun } from "./document-model.js";

/**
 * The `{{token}}` syntax shared by template bodies and subject lines.
 *
 * A real, shipped bug this exists to fix: resolveVariables only ever replaced nodes of
 * `type: "variable"`, but nothing in the application ever constructed one --
 * parsePlainTextToDocument turned every line into a plain TextRun, so a template body of
 * "Hi {{first_name}}," was stored, rendered and *sent* with that literal text in it. The
 * personalization machinery was complete and well tested; it simply was never fed any input,
 * because every test built variable nodes by hand rather than going through the parser real code
 * uses. This module is the missing tokenizer, and it is deliberately the single definition of the
 * syntax so a body and a subject can never disagree about what a token looks like.
 *
 * Syntax:
 *   {{first_name}}          - required; a lead with no value for it is a hard stop for that lead
 *   {{first_name|there}}    - falls back to "there" when the lead has no value
 *   {{company|}}            - falls back to empty, i.e. "render nothing rather than fail"
 *
 * The name deliberately allows spaces, because a CSV's own column headers become custom field
 * names verbatim on import (import-contacts-csv.ts), so `{{Website URL}}` has to be expressible.
 * Only `|`, `{` and `}` are excluded, since those delimit the token itself.
 */
const TOKEN_PATTERN = /\{\{([^|{}]+)(?:\|([^{}]*))?\}\}/g;

export interface ParsedToken {
  name: string;
  /** Undefined means the token is required; an empty string is a real fallback meaning "render
   * nothing", which is distinct from having no fallback at all. */
  fallback?: string;
}

/** A token's value is "missing" when the lead has no value at all *or* only whitespace -- a CSV
 * row with an empty company cell must behave the same as one with no company column. */
export function isMissingValue(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

export function parseToken(rawName: string, rawFallback: string | undefined): ParsedToken {
  const name = rawName.trim();
  return rawFallback === undefined ? { name } : { name, fallback: rawFallback.trim() };
}

/** Every distinct token in the text, in first-seen order. */
export function collectTextTokens(text: string): ParsedToken[] {
  const seen = new Set<string>();
  const tokens: ParsedToken[] = [];
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const token = parseToken(match[1]!, match[2]);
    if (seen.has(token.name)) continue;
    seen.add(token.name);
    tokens.push(token);
  }
  return tokens;
}

/**
 * Splits a line of text into alternating literal and variable nodes. Text with no tokens produces
 * a single TextRun, which is exactly what the parser produced before this existed -- so an
 * ordinary template is unchanged.
 */
export function splitTextIntoInlineNodes(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const start = match.index!;
    if (start > lastIndex) nodes.push(textRun(text.slice(lastIndex, start)));
    const { name, fallback } = parseToken(match[1]!, match[2]);
    nodes.push({ type: "variable", name, fallback });
    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) nodes.push(textRun(text.slice(lastIndex)));
  return nodes;
}

/**
 * Resolves tokens in a bare string -- used for subject lines, which are plain strings rather than
 * Documents and so can't go through resolveVariables. Kept here beside the tokenizer so a subject
 * and a body resolve by identical rules.
 *
 * `onMissing` is supplied by the caller rather than throwing directly, so the Document and string
 * paths can share this logic while each raising its own error type.
 */
export function resolveTextTokens(
  text: string,
  values: Record<string, string>,
  onMissing: (name: string) => string
): string {
  return text.replace(TOKEN_PATTERN, (_full, rawName: string, rawFallback: string | undefined) => {
    const { name, fallback } = parseToken(rawName, rawFallback);
    const value = values[name];
    if (!isMissingValue(value)) return value!;
    return fallback ?? onMissing(name);
  });
}
