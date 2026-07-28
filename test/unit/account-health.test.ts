import { describe, expect, it } from "vitest";
import { computeAccountHealth } from "../../src/core/account-health/engine.js";
import type { AccountHealthInput } from "../../src/core/account-health/types.js";

function baseInput(overrides: Partial<AccountHealthInput> = {}): AccountHealthInput {
  return {
    metrics: { sendsLast24h: 2, sendsLast7d: 10, accountAgeDays: 90 },
    authStatus: { spf: "pass", dkim: "pass", dmarc: "pass" },
    liveAuthCheckPassed: true,
    ...overrides
  };
}

describe("Account Health Engine (Section 19)", () => {
  it("scores a fully healthy account at 100 with no findings", () => {
    const result = computeAccountHealth(baseInput());
    expect(result.healthScore).toBe(100);
    expect(result.riskLevel).toBe("healthy");
    expect(result.findings).toEqual([]);
  });

  it("scores a failing live auth check as critical with a reconnect recommendation", () => {
    const result = computeAccountHealth(baseInput({ liveAuthCheckPassed: false }));
    expect(result.riskLevel).toBe("critical");
    const finding = result.findings.find((f) => f.findingType === "auth_check_failed");
    expect(finding?.severity).toBe("critical");
    expect(finding?.recommendedAction).toMatch(/reconnect/i);
  });

  it("flags missing SPF/DKIM and missing DMARC as separate findings", () => {
    const result = computeAccountHealth(
      baseInput({ authStatus: { spf: "none", dkim: "none", dmarc: "none" } })
    );
    expect(result.findings.some((f) => f.findingType === "spf_not_configured")).toBe(true);
    expect(result.findings.some((f) => f.findingType === "dkim_not_configured")).toBe(true);
    expect(result.findings.some((f) => f.findingType === "dmarc_missing")).toBe(true);
    expect(result.healthScore).toBeLessThan(100);
  });

  it("flags a very low reply rate as a warning, but stays silent when reply rate is undefined (insufficient data)", () => {
    const withLowReplyRate = computeAccountHealth(baseInput({ metrics: { ...baseInput().metrics, replyRate: 0.01 } }));
    expect(withLowReplyRate.findings.some((f) => f.findingType === "low_reply_rate")).toBe(true);

    const withoutReplyRateData = computeAccountHealth(baseInput());
    expect(withoutReplyRateData.findings.some((f) => f.findingType === "low_reply_rate")).toBe(false);
  });

  it("flags poor sending consistency, but stays silent when there's insufficient send history", () => {
    const inconsistent = computeAccountHealth(
      baseInput({ metrics: { ...baseInput().metrics, sendingConsistencyScore: 10 } })
    );
    expect(inconsistent.findings.some((f) => f.findingType === "inconsistent_sending_volume")).toBe(true);

    const noData = computeAccountHealth(baseInput());
    expect(noData.findings.some((f) => f.findingType === "inconsistent_sending_volume")).toBe(false);
  });

  it("does not flag or penalize 'unknown' auth status (e.g. DKIM on a consumer @gmail.com address, where no selector is discoverable) the way it does 'none'/'fail'", () => {
    const withUnknown = computeAccountHealth(
      baseInput({ authStatus: { spf: "pass", dkim: "unknown", dmarc: "pass" } })
    );
    expect(withUnknown.findings).toEqual([]);
    expect(withUnknown.healthScore).toBe(100);

    const withGenuinelyMissing = computeAccountHealth(
      baseInput({ authStatus: { spf: "pass", dkim: "none", dmarc: "pass" } })
    );
    expect(withGenuinelyMissing.findings.some((f) => f.findingType === "dkim_not_configured")).toBe(true);
    expect(withGenuinelyMissing.healthScore).toBeLessThan(100);
  });

  it("maps score ranges to the documented risk levels (Section 19.3)", () => {
    expect(computeAccountHealth(baseInput()).riskLevel).toBe("healthy");
    expect(
      computeAccountHealth(baseInput({ authStatus: { spf: "none", dkim: "none", dmarc: "pass" } })).riskLevel
    ).toBe("watch"); // 100 - 15 - 15 = 70
  });

  it("forces risk_level to critical whenever a critical-severity finding exists, even if the numeric score alone would only be at_risk", () => {
    // liveAuthCheckPassed: false alone costs 40 points (score 60, which the score-only bands
    // would call "at_risk") — but an account that can't authenticate at all is critical, not
    // merely "worth watching," so a critical finding overrides the score-derived band.
    const result = computeAccountHealth(baseInput({ liveAuthCheckPassed: false }));
    expect(result.healthScore).toBe(60);
    expect(result.riskLevel).toBe("critical");
  });
});
