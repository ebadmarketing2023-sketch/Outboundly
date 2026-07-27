import type { BuiltMimeMessage } from "../mime/types.js";
import type { CompatibilityReport } from "../gmail-compatibility/types.js";

/**
 * Section 17: "Will this email / this account perform well?" — deliberately broader and less
 * mechanical than the Gmail Compatibility Layer's narrower "would Gmail generate this?"
 * conformance check (Section 10.4). The `rfc`/`mime` categories here are not re-evaluated by this
 * engine's own rules — they're populated by translating the Gmail Compatibility Layer's own
 * findings (Section 17.2), so there is exactly one implementation of RFC/MIME conformance
 * checking, not two that could disagree.
 *
 * `cadence` (Scheduling Policy Engine) and `list-hygiene` (Campaigns/Leads) categories have no
 * rules registered yet — those subsystems don't exist until Phase 4 — but are named here now so
 * later phases add rules to this same registry rather than a parallel one.
 */

export type DeliverabilitySeverity = "blocking" | "warning" | "info";
export type DeliverabilityCategory =
  | "rfc"
  | "mime"
  | "content"
  | "auth"
  | "sender-consistency"
  | "cadence"
  | "list-hygiene"
  | "reputation";

export interface DeliverabilityFinding {
  ruleId: string;
  category: DeliverabilityCategory;
  severity: DeliverabilitySeverity;
  message: string;
  explanation: string;
  recommendedFix?: string;
}

/**
 * What a DeliverabilityRule evaluates against. Not every rule needs every field: `auth` rules
 * need `authStatus` (Account Health Engine's SPF/DKIM/DMARC posture, Section 19.2), which is
 * optional here because it requires a live DNS lookup the caller may not always have on hand
 * (e.g. the Deliverability Lab, Section 18, can run without it and simply skip auth findings).
 */
export interface MessageContext {
  message: BuiltMimeMessage;
  /** Already computed at pipeline stage 12 (Section 9.2) — reused, not re-run, per Section 10.4. */
  compatibilityReport: CompatibilityReport;
  authenticatedAccountEmail: string;
  bodyHtml?: string;
  bodyText?: string;
  authStatus?: {
    spf: "pass" | "fail" | "none";
    dkim: "pass" | "fail" | "none";
    dmarc: "pass" | "fail" | "none";
  };
}

export interface DeliverabilityRule {
  id: string;
  category: DeliverabilityCategory;
  severity: DeliverabilitySeverity;
  evaluate(ctx: MessageContext): DeliverabilityFinding[];
}

export interface DeliverabilityReport {
  score: number;
  findings: DeliverabilityFinding[];
}
