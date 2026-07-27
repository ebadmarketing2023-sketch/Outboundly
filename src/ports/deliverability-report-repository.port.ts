import type { DeliverabilityReport } from "../core/deliverability/types.js";
import type { AccountId, MessageId } from "../core/shared-kernel/ids.js";

export interface SaveDeliverabilityReportInput {
  scope: "message" | "campaign" | "account";
  messageId?: MessageId;
  /** No FK yet — Campaigns (Section 5.6) don't exist until Phase 4. */
  campaignId?: string;
  accountId?: AccountId;
  generatedAt: Date;
  report: DeliverabilityReport;
}

/** Persistence for the Deliverability Engine's reports (Section 5.8, Section 17.3). */
export interface DeliverabilityReportRepository {
  save(input: SaveDeliverabilityReportInput): Promise<void>;
}
