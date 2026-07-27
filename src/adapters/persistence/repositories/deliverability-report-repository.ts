import { generateId } from "../../../core/shared-kernel/ids.js";
import type {
  DeliverabilityReportRepository,
  SaveDeliverabilityReportInput
} from "../../../ports/deliverability-report-repository.port.js";
import type { OutboundlyDb } from "../db.js";
import { deliverabilityReports } from "../schema.js";

/** SQLite-backed implementation of the DeliverabilityReportRepository port (Section 5.8). */
export class SqliteDeliverabilityReportRepository implements DeliverabilityReportRepository {
  constructor(private readonly db: OutboundlyDb) {}

  async save(input: SaveDeliverabilityReportInput): Promise<void> {
    this.db
      .insert(deliverabilityReports)
      .values({
        id: generateId(),
        messageId: input.messageId,
        campaignId: input.campaignId,
        accountId: input.accountId,
        scope: input.scope,
        generatedAt: input.generatedAt,
        overallScore: input.report.score,
        findingsJson: input.report.findings.map((f) => ({
          ruleId: f.ruleId,
          category: f.category,
          severity: f.severity,
          explanation: f.explanation
        }))
      })
      .run();
  }
}
