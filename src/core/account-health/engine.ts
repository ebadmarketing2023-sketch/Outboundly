import type { AccountHealthFinding, AccountHealthInput, AccountHealthResult, RiskLevel } from "./types.js";

/**
 * The Account Health Engine's scoring logic (Section 19.3): pure and I/O-free — everything it
 * needs (metrics, DNS auth posture, a live auth check result) is gathered by the application
 * layer beforehand, matching the same separation the Deliverability Engine and Gmail
 * Compatibility Layer already use.
 */

const PENALTY = {
  authCheckFailed: 40,
  spfNotConfigured: 15,
  dkimNotConfigured: 15,
  dmarcMissing: 5,
  lowReplyRate: 10,
  poorSendingConsistency: 10
} as const;

const LOW_REPLY_RATE_THRESHOLD = 0.05;
const POOR_CONSISTENCY_THRESHOLD = 40;

export function computeAccountHealth(input: AccountHealthInput): AccountHealthResult {
  const findings: AccountHealthFinding[] = [];
  let penalty = 0;

  if (!input.liveAuthCheckPassed) {
    penalty += PENALTY.authCheckFailed;
    findings.push({
      findingType: "auth_check_failed",
      severity: "critical",
      message: "This account's authentication is currently failing",
      explanation: "A live check just attempted to authenticate against this account's provider and it failed — sends and inbox sync will not work until this is resolved.",
      recommendedAction: "Reconnect this account (sign in again) from the compose screen."
    });
  }

  // "unknown" (e.g. DKIM on a consumer @gmail.com/@outlook.com address, where the real selector
  // isn't discoverable — see DnsDomainAuthChecker) deliberately raises no finding at all: it means
  // this checker has no reliable way to verify the record, not that one is missing.
  if (input.authStatus.spf === "fail" || input.authStatus.spf === "none") {
    penalty += PENALTY.spfNotConfigured;
    findings.push({
      findingType: "spf_not_configured",
      severity: "warning",
      message: `SPF is not properly configured for this sending domain (status: ${input.authStatus.spf})`,
      explanation: "Without a valid SPF record, receiving mail systems have a weaker basis for trusting mail claiming to come from this domain.",
      recommendedAction: "Publish or fix an SPF TXT record authorizing this provider to send on the domain's behalf."
    });
  }

  if (input.authStatus.dkim === "fail" || input.authStatus.dkim === "none") {
    penalty += PENALTY.dkimNotConfigured;
    findings.push({
      findingType: "dkim_not_configured",
      severity: "warning",
      message: `DKIM is not properly configured for this sending domain (status: ${input.authStatus.dkim})`,
      explanation: "Without DKIM, a message's integrity and origin can't be cryptographically verified by the recipient's mail system.",
      recommendedAction: "Enable DKIM signing with your provider and publish the corresponding DNS record."
    });
  }

  if (input.authStatus.dmarc === "none") {
    penalty += PENALTY.dmarcMissing;
    findings.push({
      findingType: "dmarc_missing",
      severity: "info",
      message: "No DMARC record found for this sending domain",
      explanation: "DMARC ties SPF/DKIM together and tells receiving systems what to do with mail that fails alignment; without it, spoofed mail impersonating this domain isn't reported back to you.",
      recommendedAction: "Publish a DMARC TXT record, starting with a monitor-only policy (p=none) if unsure."
    });
  }

  if (input.metrics.replyRate !== undefined && input.metrics.replyRate < LOW_REPLY_RATE_THRESHOLD) {
    penalty += PENALTY.lowReplyRate;
    findings.push({
      findingType: "low_reply_rate",
      severity: "warning",
      message: `Reply rate is unusually low (${Math.round(input.metrics.replyRate * 100)}%)`,
      explanation: "A very low reply rate across recent conversations can indicate content, targeting, or deliverability problems, not just recipient disinterest.",
      recommendedAction: "Review recent message content and targeting; check whether mail may be landing in spam."
    });
  }

  if (
    input.metrics.sendingConsistencyScore !== undefined &&
    input.metrics.sendingConsistencyScore < POOR_CONSISTENCY_THRESHOLD
  ) {
    penalty += PENALTY.poorSendingConsistency;
    findings.push({
      findingType: "inconsistent_sending_volume",
      severity: "info",
      message: "Daily sending volume has been highly inconsistent recently",
      explanation: "A sudden spike or highly variable day-to-day volume is itself a risk signal to receiving mail systems, independent of content quality.",
      recommendedAction: "Aim for a steadier daily sending pattern rather than large bursts."
    });
  }

  const healthScore = Math.max(0, 100 - penalty);
  // A critical-severity finding (currently only "auth check failed") means the account is
  // actively unusable right now, not merely trending in a bad direction — that overrides the
  // numeric-score risk band regardless of what the score alone would say.
  const riskLevel = findings.some((f) => f.severity === "critical") ? "critical" : riskLevelFor(healthScore);
  return { healthScore, riskLevel, findings };
}

function riskLevelFor(score: number): RiskLevel {
  if (score >= 85) return "healthy";
  if (score >= 65) return "watch";
  if (score >= 40) return "at_risk";
  return "critical";
}
