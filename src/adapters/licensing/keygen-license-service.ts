import type { LicenseService, MachineActivationResult } from "../../ports/license-service.port.js";
import type { LicenseValidationResponse } from "../../core/licensing/license-status.js";

const KEYGEN_API_BASE = "https://api.keygen.sh/v1";
const KEYGEN_MEDIA_TYPE = "application/vnd.api+json";

interface KeygenErrorBody {
  errors?: { detail?: string }[];
}

interface KeygenMachineResponseBody {
  data?: { id?: string };
}

interface KeygenValidateResponseBody {
  meta?: { valid?: boolean; code?: string };
}

/**
 * Keygen.sh adapter for the LicenseService port (Section 12.3-style: this is the only file that
 * knows Keygen's actual wire format). Authenticates every request as the license itself (the
 * Policy's "License" authentication strategy) -- never a shared account/product token -- so the
 * only credential this app ever carries is the one unique key a customer enters, scoped to
 * exactly their own license and nothing else.
 *
 * NOTE: built against Keygen's documented v1 REST API from training-time knowledge, not verified
 * against a live account yet -- the very first real activateMachine/validateLicense call against
 * a real license key is what actually confirms the exact request/response shape. If Keygen
 * returns an error body shaped differently than expected here, that's the first thing to check.
 */
export class KeygenLicenseService implements LicenseService {
  constructor(private readonly accountId: string) {}

  private baseUrl(): string {
    return `${KEYGEN_API_BASE}/accounts/${this.accountId}`;
  }

  async activateMachine(licenseKey: string, fingerprint: string, machineName: string): Promise<MachineActivationResult> {
    const res = await fetch(`${this.baseUrl()}/machines`, {
      method: "POST",
      headers: {
        Authorization: `License ${licenseKey}`,
        "Content-Type": KEYGEN_MEDIA_TYPE,
        Accept: KEYGEN_MEDIA_TYPE
      },
      body: JSON.stringify({
        data: {
          type: "machines",
          attributes: { fingerprint, name: machineName }
        }
      })
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => undefined)) as KeygenErrorBody | undefined;
      const detail = body?.errors?.[0]?.detail ?? `Activation failed (HTTP ${res.status})`;
      throw new Error(detail);
    }

    const body = (await res.json().catch(() => undefined)) as KeygenMachineResponseBody | undefined;
    const machineId = body?.data?.id;
    if (!machineId) throw new Error("Keygen did not return a machine id on activation");
    return { machineId };
  }

  async validateLicense(licenseKey: string, fingerprint: string): Promise<LicenseValidationResponse> {
    const res = await fetch(`${this.baseUrl()}/licenses/actions/validate-key`, {
      method: "POST",
      headers: {
        "Content-Type": KEYGEN_MEDIA_TYPE,
        Accept: KEYGEN_MEDIA_TYPE
      },
      body: JSON.stringify({
        meta: { key: licenseKey, scope: { fingerprint } }
      })
    });

    // Keygen answers a recognized-but-invalid license with 200 and meta.valid=false, not a non-2xx
    // status -- so the JSON body's meta block is the actual source of truth, not res.ok alone. A
    // missing meta block (not even a well-formed Keygen response) is what genuinely signals
    // something transport-level went wrong, distinct from an authoritative "not valid."
    const body = (await res.json().catch(() => undefined)) as KeygenValidateResponseBody | undefined;
    if (!body?.meta) {
      throw new Error(`Unexpected response from the license server (HTTP ${res.status})`);
    }
    return { valid: Boolean(body.meta.valid), code: body.meta.code ?? "UNKNOWN" };
  }

  async deactivateMachine(licenseKey: string, machineId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl()}/machines/${machineId}`, {
      method: "DELETE",
      headers: {
        Authorization: `License ${licenseKey}`,
        Accept: KEYGEN_MEDIA_TYPE
      }
    });
    // 404 here means it's already gone (e.g. you deleted it from the dashboard yourself) -- that's
    // the desired end state, not a failure.
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to deactivate machine (HTTP ${res.status})`);
    }
  }
}
