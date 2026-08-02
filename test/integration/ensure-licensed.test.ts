import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { activateLicense, checkLicenseStatus, type LicenseGateDeps } from "../../src/application/licensing/ensure-licensed.js";
import { getStoredLicenseState } from "../../src/adapters/persistence/settings-support.js";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import type { Clock } from "../../src/ports/clock.port.js";
import type { LicenseService, MachineActivationResult } from "../../src/ports/license-service.port.js";
import type { LicenseValidationResponse } from "../../src/core/licensing/license-status.js";

class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

class FakeLicenseService implements LicenseService {
  activateCalls: { licenseKey: string; fingerprint: string; machineName: string }[] = [];
  validateCalls: { licenseKey: string; fingerprint: string }[] = [];
  nextActivationResult: MachineActivationResult | Error = { machineId: "machine-1" };
  nextValidationResult: LicenseValidationResponse | Error = { valid: true, code: "VALID" };

  async activateMachine(licenseKey: string, fingerprint: string, machineName: string): Promise<MachineActivationResult> {
    this.activateCalls.push({ licenseKey, fingerprint, machineName });
    if (this.nextActivationResult instanceof Error) throw this.nextActivationResult;
    return this.nextActivationResult;
  }

  async validateLicense(licenseKey: string, fingerprint: string): Promise<LicenseValidationResponse> {
    this.validateCalls.push({ licenseKey, fingerprint });
    if (this.nextValidationResult instanceof Error) throw this.nextValidationResult;
    return this.nextValidationResult;
  }

  async deactivateMachine(): Promise<void> {}
}

describe("license gate application layer (Section 12.1-style seam over Keygen)", () => {
  let db: OutboundlyDb;
  let licenseService: FakeLicenseService;
  let clock: FixedClock;
  let deps: LicenseGateDeps;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-ensure-licensed-test-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
    licenseService = new FakeLicenseService();
    clock = new FixedClock(new Date("2026-01-10T00:00:00Z"));
    deps = { db, licenseService, clock, offlineGracePeriodDays: 3, machineName: "test-machine" };
  });

  it("reports needs-activation when nothing has been activated yet, without ever calling the license service", async () => {
    const result = await checkLicenseStatus(deps);
    expect(result).toEqual({ outcome: "needs-activation" });
    expect(licenseService.validateCalls).toHaveLength(0);
  });

  it("activates with a fresh generated fingerprint and persists the resulting state", async () => {
    const result = await activateLicense(deps, "TEST-LICENSE-KEY");
    expect(result).toEqual({ ok: true });

    expect(licenseService.activateCalls).toHaveLength(1);
    const call = licenseService.activateCalls[0]!;
    expect(call.licenseKey).toBe("TEST-LICENSE-KEY");
    expect(call.machineName).toBe("test-machine");
    expect(call.fingerprint).toMatch(/^[0-9a-f-]{36}$/); // a real UUID, not a placeholder

    const stored = getStoredLicenseState(db);
    expect(stored.licenseKey).toBe("TEST-LICENSE-KEY");
    expect(stored.fingerprint).toBe(call.fingerprint);
    expect(stored.machineId).toBe("machine-1");
    expect(stored.lastValidAt).toEqual(clock.now());
  });

  it("surfaces the activation failure reason without persisting anything, when Keygen rejects the activation", async () => {
    licenseService.nextActivationResult = new Error("Too many machines already activated for this license");
    const result = await activateLicense(deps, "TEST-LICENSE-KEY");
    expect(result).toEqual({ ok: false, reason: "Too many machines already activated for this license" });
    expect(getStoredLicenseState(db).licenseKey).toBeUndefined();
  });

  it("checks the stored license after activation and reports valid, using the exact same fingerprint that was activated with", async () => {
    await activateLicense(deps, "TEST-LICENSE-KEY");
    const activatedFingerprint = licenseService.activateCalls[0]!.fingerprint;

    const status = await checkLicenseStatus(deps);
    expect(status).toEqual({ outcome: "valid" });
    expect(licenseService.validateCalls).toEqual([{ licenseKey: "TEST-LICENSE-KEY", fingerprint: activatedFingerprint }]);
  });

  it("reports blocked with the real reason when Keygen says the license was revoked", async () => {
    await activateLicense(deps, "TEST-LICENSE-KEY");
    licenseService.nextValidationResult = { valid: false, code: "SUSPENDED" };

    const status = await checkLicenseStatus(deps);
    expect(status).toEqual({ outcome: "blocked", reason: "This license has been deactivated." });
  });

  it("falls back to the offline grace period when Keygen can't be reached, then blocks once the grace period elapses", async () => {
    await activateLicense(deps, "TEST-LICENSE-KEY");

    licenseService.nextValidationResult = new Error("network unreachable");
    clock.advance(24 * 60 * 60 * 1000); // 1 day later -- well within a 3-day grace period
    const withinGrace = await checkLicenseStatus(deps);
    expect(withinGrace.outcome).toBe("grace");

    clock.advance(4 * 24 * 60 * 60 * 1000); // 5 days total since the last real success -- past grace
    const pastGrace = await checkLicenseStatus(deps);
    expect(pastGrace.outcome).toBe("blocked");
  });

  it("does not extend the grace period just because a check happened during it -- only a real successful validation resets the clock", async () => {
    // Reproduces a real subtle bug this design must avoid: a "grace" outcome must not itself
    // record a new lastValidAt, or an offline machine could stay in perpetual grace forever by
    // just launching once a day, each launch pushing the deadline forward without ever actually
    // reconfirming the license is still good.
    await activateLicense(deps, "TEST-LICENSE-KEY");
    licenseService.nextValidationResult = new Error("network unreachable");

    clock.advance(24 * 60 * 60 * 1000);
    await checkLicenseStatus(deps); // grace -- must not bump lastValidAt

    clock.advance(24 * 60 * 60 * 1000);
    await checkLicenseStatus(deps); // still grace -- must not bump lastValidAt

    clock.advance(24 * 60 * 60 * 1000); // now 3 days total since the one real success
    const stillJustBarelyInGrace = await checkLicenseStatus(deps);
    expect(stillJustBarelyInGrace.outcome).toBe("grace");

    clock.advance(1); // 1ms past the 3-day window from the *original* success
    const nowBlocked = await checkLicenseStatus(deps);
    expect(nowBlocked.outcome).toBe("blocked");
  });
});
