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
  data?: { id?: string };
}

/**
 * Keygen.sh adapter for the LicenseService port (Section 12.3-style: this is the only file that
 * knows Keygen's actual wire format). Verified for real against a live Keygen account -- one thing
 * below differs from a first draft that only matched the docs on paper:
 *
 * Creating a machine requires an explicit `relationships.license` linkage in the request body
 * (confirmed: omitting it returns 400 "is missing" at /data/relationships). The license's own
 * opaque resource id (needed for that linkage) isn't something the app ever otherwise has --
 * customers only see/enter their raw key -- so activation first resolves the id via the same
 * validate-key action validateLicense already uses (confirmed for real: validate-key's response
 * body's `data.id` is the license's true resource id -- notably *not* the same value Keygen
 * echoes back in the unrelated `Keygen-License` response *header* on every request, which stays
 * constant regardless of what's actually being requested and is not this license's id at all --
 * a real, hours-long red herring during manual debugging that the response body itself never had).
 *
 * Everything here authenticates with nothing but the customer's own license key -- no separate
 * product/admin token embedded anywhere. A license key can validate itself, and (confirmed for
 * real, once the correct license id was used) can also create/delete its own machine via
 * `Authorization: License <key>`, since license.create/delete of *its own* machine is within a
 * license bearer's own permission set (see Keygen's Authorization docs' permission matrix --
 * `machine.create`/`machine.delete` are both plain, unconditional checks for the `license` role).
 */
export class KeygenLicenseService implements LicenseService {
  constructor(private readonly accountId: string) {}

  private baseUrl(): string {
    return `${KEYGEN_API_BASE}/accounts/${this.accountId}`;
  }

  private async resolveLicenseId(licenseKey: string): Promise<string> {
    const res = await fetch(`${this.baseUrl()}/licenses/actions/validate-key`, {
      method: "POST",
      headers: {
        "Content-Type": KEYGEN_MEDIA_TYPE,
        Accept: KEYGEN_MEDIA_TYPE
      },
      body: JSON.stringify({ meta: { key: licenseKey } })
    });
    const body = (await res.json().catch(() => undefined)) as KeygenValidateResponseBody | undefined;
    const id = body?.data?.id;
    if (!id) throw new Error("Could not resolve this license key to a license id");
    return id;
  }

  async activateMachine(licenseKey: string, fingerprint: string, machineName: string): Promise<MachineActivationResult> {
    const licenseId = await this.resolveLicenseId(licenseKey);

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
          attributes: { fingerprint, name: machineName },
          relationships: {
            license: { data: { type: "licenses", id: licenseId } }
          }
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
