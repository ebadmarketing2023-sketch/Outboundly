import type { BuiltMimeMessage } from "../mime/types.js";

/** Section 10: "Would Gmail generate this message?" — a mechanical conformance checker. */

export type CompatibilitySeverity = "blocking" | "warning" | "info";
export type CompatibilityCategory = "headers" | "mime" | "rfc";

export interface CompatibilityFinding {
  ruleId: string;
  category: CompatibilityCategory;
  severity: CompatibilitySeverity;
  message: string;
  explanation: string;
  recommendedFix: string;
}

export interface CompatibilityRule {
  id: string;
  category: CompatibilityCategory;
  severity: CompatibilitySeverity;
  evaluate(message: BuiltMimeMessage): CompatibilityFinding[];
}

export interface CompatibilityReport {
  score: number;
  findings: CompatibilityFinding[];
}
