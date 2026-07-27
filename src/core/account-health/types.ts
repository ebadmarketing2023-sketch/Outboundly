import type { AccountMetrics } from "../../ports/account-health-metrics.port.js";
import type { DomainAuthStatus } from "../../ports/domain-auth-checker.port.js";

/**
 * Section 19: "Is this sending account itself healthy?" — account-scoped and continuously
 * evaluated, independent of any single send, distinct from the Deliverability Engine's
 * message/campaign-scoped question (Section 19.1).
 */

export type RiskLevel = "healthy" | "watch" | "at_risk" | "critical";

export interface AccountHealthFinding {
  findingType: string;
  severity: "info" | "warning" | "critical";
  message: string;
  explanation: string;
  recommendedAction?: string;
}

export interface AccountHealthInput {
  metrics: AccountMetrics;
  authStatus: DomainAuthStatus;
  /** Result of actually attempting to authenticate against this account's provider right now —
   * a live check performed at snapshot time, not a rolling failure-history counter, since no
   * such history is tracked anywhere in the app yet (Section 19.2's "technical health"). */
  liveAuthCheckPassed: boolean;
}

export interface AccountHealthResult {
  healthScore: number;
  riskLevel: RiskLevel;
  findings: AccountHealthFinding[];
}
