import type { CompatibilityFinding } from "../gmail-compatibility/types.js";
import { DELIVERABILITY_RULES } from "./rules.js";
import type { DeliverabilityFinding, DeliverabilityReport, DeliverabilityRule, MessageContext } from "./types.js";

/**
 * The Deliverability Engine's entry point (Section 17.3): runs pre-send as a blocking gate and,
 * later phases, as a periodic background sweep too. Reuses the Gmail Compatibility Layer's
 * already-computed findings for the `rfc`/`mime` categories (Section 17.2, Section 10.4) rather
 * than re-running that logic — translated into this engine's own Finding shape so callers only
 * ever deal with one report type.
 */

const SEVERITY_PENALTY = { blocking: 30, warning: 10, info: 2 } as const;

function mapCompatibilityCategory(category: CompatibilityFinding["category"]): "rfc" | "mime" {
  // Gmail Compatibility's "headers" category is about RFC-required headers (Message-ID, Date,
  // From, etc. — see Section 10.2), so it maps to this engine's "rfc" category alongside its own
  // "rfc" category; "mime" maps straight across.
  return category === "mime" ? "mime" : "rfc";
}

function translateCompatibilityFinding(finding: CompatibilityFinding): DeliverabilityFinding {
  return {
    ruleId: finding.ruleId,
    category: mapCompatibilityCategory(finding.category),
    severity: finding.severity,
    message: finding.message,
    explanation: finding.explanation,
    recommendedFix: finding.recommendedFix
  };
}

export function evaluateDeliverability(
  ctx: MessageContext,
  rules: DeliverabilityRule[] = DELIVERABILITY_RULES
): DeliverabilityReport {
  const delegatedFindings = ctx.compatibilityReport.findings.map(translateCompatibilityFinding);
  const ruleFindings = rules.flatMap((rule) => rule.evaluate(ctx));
  const findings = [...delegatedFindings, ...ruleFindings];

  const penalty = findings.reduce((sum, f) => sum + SEVERITY_PENALTY[f.severity], 0);
  const score = Math.max(0, 100 - penalty);
  return { score, findings };
}

export function hasBlockingFindings(report: DeliverabilityReport): boolean {
  return report.findings.some((f) => f.severity === "blocking");
}
