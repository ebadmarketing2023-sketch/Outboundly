import { parseHtmlToDocument } from "./html-parser.js";
import { renderHtml } from "./html-renderer.js";

/**
 * Sanitizes external HTML (Section 23: "inbound synced HTML ... sanitized/parsed against an
 * explicit allowed-node schema before rendering or sending") by round-tripping it through the
 * Internal Document Model: parseHtmlToDocument already drops/normalizes anything outside the
 * allowed node schema (script/style/iframe/etc. entirely, everything else down to a fixed tag
 * set), and renderHtml is a closed serializer that only ever emits that same fixed tag set with
 * every text/attribute value escaped -- so the output can never carry an executable node or
 * attribute regardless of what the input contained.
 *
 * safe because parseHtmlToDocument never produces a `variable` InlineNode (that only exists for
 * outbound personalization templates), so renderHtml's MissingPersonalizationValueError path can
 * never trigger here.
 */
export function sanitizeInboundHtml(html: string | undefined): string | undefined {
  if (html === undefined) return undefined;
  return renderHtml(parseHtmlToDocument(html));
}
