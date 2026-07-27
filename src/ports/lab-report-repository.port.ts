import type { DeliverabilityReport } from "../core/deliverability/types.js";

export interface SaveLabReportInput {
  inputSnapshot: unknown;
  report: DeliverabilityReport;
  generatedAt: Date;
}

/** Persistence for Deliverability Lab runs (Section 5.8, Section 18.3) — intentionally separate
 * from deliverability_reports since a lab run has no real message/campaign/account to attach to. */
export interface LabReportRepository {
  save(input: SaveLabReportInput): Promise<void>;
}
