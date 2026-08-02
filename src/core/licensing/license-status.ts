/**
 * Licensing (disclosed license-key model): pure decision logic for what a launch/re-check should
 * do with a license validation attempt. Kept separate from the actual Keygen HTTP call (the
 * LicenseService port/adapter) so this is testable without a real network request, the same
 * pattern the rest of this codebase uses (Gmail Compatibility/Deliverability engines are pure
 * evaluators over an already-fetched input too).
 */

/** The raw shape Keygen's "validate license" action returns (meta.valid / meta.code). */
export interface LicenseValidationResponse {
  valid: boolean;
  code: string;
}

export type LicenseCheckResult =
  | { outcome: "valid" }
  /** Keygen explicitly said no (suspended/expired/wrong machine/etc), or the offline grace period
   * ran out -- the app must not proceed. */
  | { outcome: "blocked"; reason: string }
  /** Couldn't reach the license server at all, but a validation succeeded recently enough to still
   * trust -- the app proceeds, but this is surfaced so the UI can show it's running on borrowed
   * time until it can verify again. */
  | { outcome: "grace"; reason: string; graceExpiresAt: Date };

/** Keygen's own documented validation codes for a license that IS valid right now -- everything
 * else (SUSPENDED, EXPIRED, NOT_FOUND, NO_MACHINE, FINGERPRINT_SCOPE_MISMATCH, TOO_MANY_MACHINES,
 * etc.) is treated as "not valid," described below rather than enumerated, since an unrecognized
 * code should fail closed (blocked), not silently pass. */
const VALID_CODES = new Set(["VALID"]);

function describeInvalidCode(code: string): string {
  switch (code) {
    case "SUSPENDED":
      return "This license has been deactivated.";
    case "EXPIRED":
      return "This license has expired.";
    case "NOT_FOUND":
      return "This license key was not recognized.";
    case "NO_MACHINE":
    case "FINGERPRINT_SCOPE_MISMATCH":
      return "This license is not activated for this computer.";
    case "TOO_MANY_MACHINES":
      return "This license is already activated on another computer.";
    default:
      return `This license is not valid (${code}).`;
  }
}

export function interpretValidationResponse(response: LicenseValidationResponse): { outcome: "valid" } | { outcome: "invalid"; reason: string } {
  if (response.valid || VALID_CODES.has(response.code)) return { outcome: "valid" };
  return { outcome: "invalid", reason: describeInvalidCode(response.code) };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whether a cached "last known good" validation is still recent enough to trust while the
 * license server can't be reached -- a brief internet outage shouldn't lock someone out of an
 * otherwise-valid license. */
export function isWithinOfflineGracePeriod(lastKnownGoodAt: Date | undefined, now: Date, gracePeriodDays: number): boolean {
  if (!lastKnownGoodAt) return false;
  return now.getTime() - lastKnownGoodAt.getTime() <= gracePeriodDays * MS_PER_DAY;
}

export interface LicenseCheckInput {
  /** False when the validate call itself couldn't complete (network/DNS/timeout failure) --
   * distinct from the call succeeding and Keygen answering "not valid." */
  networkReachable: boolean;
  response?: LicenseValidationResponse;
  lastKnownGoodAt?: Date;
  now: Date;
  offlineGracePeriodDays: number;
}

/**
 * The single decision point a launch-time (or periodic) license check reduces to: proceed, block,
 * or proceed-on-grace. Keygen actually being reachable and answering is always authoritative over
 * the cached grace period -- grace only ever applies when the server couldn't be reached at all.
 */
export function decideLicenseCheck(input: LicenseCheckInput): LicenseCheckResult {
  if (input.networkReachable && input.response) {
    const interpreted = interpretValidationResponse(input.response);
    if (interpreted.outcome === "valid") return { outcome: "valid" };
    return { outcome: "blocked", reason: interpreted.reason };
  }

  if (isWithinOfflineGracePeriod(input.lastKnownGoodAt, input.now, input.offlineGracePeriodDays)) {
    return {
      outcome: "grace",
      reason: "Couldn't reach the license server -- running on a temporary offline grace period.",
      graceExpiresAt: new Date(input.lastKnownGoodAt!.getTime() + input.offlineGracePeriodDays * MS_PER_DAY)
    };
  }

  return {
    outcome: "blocked",
    reason: "Couldn't verify your license and the offline grace period has expired. Please connect to the internet and try again."
  };
}
