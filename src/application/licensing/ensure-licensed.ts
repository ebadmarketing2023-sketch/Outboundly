import { randomUUID } from "node:crypto";
import { getStoredLicenseState, recordLicenseValidationSuccess, saveLicenseActivation } from "../../adapters/persistence/settings-support.js";
import type { OutboundlyDb } from "../../adapters/persistence/db.js";
import type { Clock } from "../../ports/clock.port.js";
import type { LicenseService } from "../../ports/license-service.port.js";
import { decideLicenseCheck, type LicenseCheckResult } from "../../core/licensing/license-status.js";

export interface LicenseGateDeps {
  db: OutboundlyDb;
  licenseService: LicenseService;
  clock: Clock;
  /** How many days a previously-successful validation stays trusted if the license server can't
   * be reached at all -- a brief internet outage shouldn't lock out an otherwise-valid license. */
  offlineGracePeriodDays: number;
  /** Purely a human-readable label for the Keygen dashboard's Machines list (e.g. the OS
   * hostname) -- plays no part in enforcement, which is scoped by the fingerprint. */
  machineName: string;
}

export type LicenseStatusResult = LicenseCheckResult | { outcome: "needs-activation" };

/**
 * The launch-time (and periodic re-check) entry point: no stored license yet means first-run
 * activation is needed; otherwise asks Keygen whether it's still valid for this installation's
 * fingerprint right now, falling back to the offline grace period only if Keygen itself couldn't
 * be reached at all (see decideLicenseCheck's own doc for why that distinction matters).
 */
export async function checkLicenseStatus(deps: LicenseGateDeps): Promise<LicenseStatusResult> {
  const stored = getStoredLicenseState(deps.db);
  if (!stored.licenseKey || !stored.fingerprint) {
    return { outcome: "needs-activation" };
  }

  let response;
  let networkReachable = true;
  try {
    response = await deps.licenseService.validateLicense(stored.licenseKey, stored.fingerprint);
  } catch {
    networkReachable = false;
  }

  const decision = decideLicenseCheck({
    networkReachable,
    response,
    lastKnownGoodAt: stored.lastValidAt,
    now: deps.clock.now(),
    offlineGracePeriodDays: deps.offlineGracePeriodDays
  });

  if (decision.outcome === "valid") {
    recordLicenseValidationSuccess(deps.db, deps.clock.now());
  }
  return decision;
}

export type ActivateLicenseResult = { ok: true } | { ok: false; reason: string };

/** First-run (or re-activation onto a fresh install) entry point: registers this machine against
 * the given license key. A fresh, locally-generated fingerprint every time this runs is
 * deliberate -- it's what actually binds a license to *this* installation, not a hardware scan
 * that could collide or change across a driver update. */
export async function activateLicense(deps: LicenseGateDeps, licenseKey: string): Promise<ActivateLicenseResult> {
  const fingerprint = randomUUID();
  try {
    const result = await deps.licenseService.activateMachine(licenseKey, fingerprint, deps.machineName);
    saveLicenseActivation(deps.db, { licenseKey, fingerprint, machineId: result.machineId }, deps.clock.now());
    recordLicenseValidationSuccess(deps.db, deps.clock.now());
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
