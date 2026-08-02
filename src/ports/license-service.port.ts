import type { LicenseValidationResponse } from "../core/licensing/license-status.js";

export interface MachineActivationResult {
  machineId: string;
}

/**
 * The disclosed license-key model's provider boundary (Section 12.1-style seam): the app never
 * talks to Keygen's HTTP API directly outside this port, so the decision logic in
 * core/licensing/license-status.ts stays testable against a fake, the same way MailProvider is.
 */
export interface LicenseService {
  /** Registers this specific installation (identified by `fingerprint`, a locally-generated,
   * persisted identifier -- not a hardware scan) against the given license key, locking that
   * license to this machine (Max machines on the policy governs how many can be active at once).
   * `machineName` is a human-readable label (e.g. the OS hostname) purely for your own reference
   * in the Keygen dashboard -- it plays no part in enforcement. */
  activateMachine(licenseKey: string, fingerprint: string, machineName: string): Promise<MachineActivationResult>;
  /** Asks Keygen whether this license is currently valid for this specific fingerprint right now.
   * Throws on a genuine network/transport failure (caller distinguishes that from an authoritative
   * "not valid" response) rather than returning a synthetic result for it. */
  validateLicense(licenseKey: string, fingerprint: string): Promise<LicenseValidationResponse>;
  /** Releases this machine's activation slot -- used when re-activating on a new computer isn't
   * desired without first freeing the old one, or when the user explicitly wants to deactivate. */
  deactivateMachine(licenseKey: string, machineId: string): Promise<void>;
}
