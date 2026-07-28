import type { BusinessHoursProfile, BusinessHoursWindow } from "../core/scheduling/types.js";

export interface NewBusinessHoursProfileInput {
  name: string;
  timezone: string;
  windows: Record<string, BusinessHoursWindow[]>;
}

/** Business Hours Profile persistence (Section 5.7) — configuration the Scheduling Policy
 * Engine's Business Hours Policy reads from. */
export interface BusinessHoursProfileRepository {
  create(input: NewBusinessHoursProfileInput): Promise<BusinessHoursProfile>;
  findById(id: string): Promise<BusinessHoursProfile | undefined>;
  list(): Promise<BusinessHoursProfile[]>;
}
