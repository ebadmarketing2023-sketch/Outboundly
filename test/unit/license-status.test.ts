import { describe, expect, it } from "vitest";
import { decideLicenseCheck, interpretValidationResponse, isWithinOfflineGracePeriod } from "../../src/core/licensing/license-status.js";

describe("interpretValidationResponse", () => {
  it("treats Keygen's VALID code (or a bare valid:true) as valid", () => {
    expect(interpretValidationResponse({ valid: true, code: "VALID" })).toEqual({ outcome: "valid" });
    expect(interpretValidationResponse({ valid: true, code: "SOMETHING_ELSE" })).toEqual({ outcome: "valid" });
  });

  it("describes each known invalid code in plain language", () => {
    expect(interpretValidationResponse({ valid: false, code: "SUSPENDED" })).toEqual({
      outcome: "invalid",
      reason: "This license has been deactivated."
    });
    expect(interpretValidationResponse({ valid: false, code: "EXPIRED" })).toEqual({
      outcome: "invalid",
      reason: "This license has expired."
    });
    expect(interpretValidationResponse({ valid: false, code: "NOT_FOUND" })).toEqual({
      outcome: "invalid",
      reason: "This license key was not recognized."
    });
    expect(interpretValidationResponse({ valid: false, code: "NO_MACHINE" })).toEqual({
      outcome: "invalid",
      reason: "This license is not activated for this computer."
    });
    expect(interpretValidationResponse({ valid: false, code: "FINGERPRINT_SCOPE_MISMATCH" })).toEqual({
      outcome: "invalid",
      reason: "This license is not activated for this computer."
    });
    expect(interpretValidationResponse({ valid: false, code: "TOO_MANY_MACHINES" })).toEqual({
      outcome: "invalid",
      reason: "This license is already activated on another computer."
    });
  });

  it("fails closed (treats as invalid) on an unrecognized code, rather than silently passing", () => {
    expect(interpretValidationResponse({ valid: false, code: "SOME_FUTURE_CODE" })).toEqual({
      outcome: "invalid",
      reason: "This license is not valid (SOME_FUTURE_CODE)."
    });
  });
});

describe("isWithinOfflineGracePeriod", () => {
  it("is false with no prior successful validation at all", () => {
    expect(isWithinOfflineGracePeriod(undefined, new Date(), 3)).toBe(false);
  });

  it("is true within the configured window and false just past it", () => {
    const lastGood = new Date("2026-01-01T00:00:00Z");
    const twoDaysLater = new Date("2026-01-03T00:00:00Z");
    const fourDaysLater = new Date("2026-01-05T00:00:01Z");
    expect(isWithinOfflineGracePeriod(lastGood, twoDaysLater, 3)).toBe(true);
    expect(isWithinOfflineGracePeriod(lastGood, fourDaysLater, 3)).toBe(false);
  });
});

describe("decideLicenseCheck", () => {
  const now = new Date("2026-01-10T00:00:00Z");

  it("is valid when the server is reachable and answers valid", () => {
    const result = decideLicenseCheck({
      networkReachable: true,
      response: { valid: true, code: "VALID" },
      now,
      offlineGracePeriodDays: 3
    });
    expect(result).toEqual({ outcome: "valid" });
  });

  it("blocks immediately when the server is reachable and explicitly says not valid -- grace period never applies here", () => {
    const result = decideLicenseCheck({
      networkReachable: true,
      response: { valid: false, code: "SUSPENDED" },
      lastKnownGoodAt: now, // even a validation from this very instant doesn't matter
      now,
      offlineGracePeriodDays: 3
    });
    expect(result).toEqual({ outcome: "blocked", reason: "This license has been deactivated." });
  });

  it("falls back to the offline grace period when the server can't be reached at all, if a recent success exists", () => {
    const lastKnownGoodAt = new Date("2026-01-09T00:00:00Z"); // 1 day before `now`
    const result = decideLicenseCheck({
      networkReachable: false,
      lastKnownGoodAt,
      now,
      offlineGracePeriodDays: 3
    });
    expect(result.outcome).toBe("grace");
    if (result.outcome !== "grace") return;
    expect(result.graceExpiresAt).toEqual(new Date("2026-01-12T00:00:00Z"));
  });

  it("blocks when the server can't be reached and there's no recent success (or the grace period has elapsed)", () => {
    const noHistory = decideLicenseCheck({ networkReachable: false, now, offlineGracePeriodDays: 3 });
    expect(noHistory.outcome).toBe("blocked");

    const staleHistory = decideLicenseCheck({
      networkReachable: false,
      lastKnownGoodAt: new Date("2026-01-01T00:00:00Z"), // 9 days before `now`, past a 3-day grace period
      now,
      offlineGracePeriodDays: 3
    });
    expect(staleHistory.outcome).toBe("blocked");
  });
});
