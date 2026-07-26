import type { BuiltMimeMessage } from "../mime/types.js";
import { GMAIL_COMPATIBILITY_RULES } from "./rules.js";
import type { CompatibilityReport, CompatibilityRule } from "./types.js";

/**
 * The Gmail Compatibility Layer's entry point (Section 10.3). Reused unmodified by the main
 * pipeline (Section 9.2, stage 12), the Deliverability Lab (Section 18), and the MIME
 * Compatibility Testing regression suite (Section 24.7) — one implementation, three consumers.
 */

const SEVERITY_PENALTY = { blocking: 30, warning: 10, info: 2 } as const;

export function evaluateGmailCompatibility(
  message: BuiltMimeMessage,
  rules: CompatibilityRule[] = GMAIL_COMPATIBILITY_RULES
): CompatibilityReport {
  const findings = rules.flatMap((rule) => rule.evaluate(message));
  const penalty = findings.reduce((sum, f) => sum + SEVERITY_PENALTY[f.severity], 0);
  const score = Math.max(0, 100 - penalty);
  return { score, findings };
}

export function hasBlockingFindings(report: CompatibilityReport): boolean {
  return report.findings.some((f) => f.severity === "blocking");
}
