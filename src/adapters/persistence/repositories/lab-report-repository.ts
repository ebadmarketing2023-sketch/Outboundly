import { generateId } from "../../../core/shared-kernel/ids.js";
import type { LabReportRepository, SaveLabReportInput } from "../../../ports/lab-report-repository.port.js";
import type { OutboundlyDb } from "../db.js";
import { labReports } from "../schema.js";

/** SQLite-backed implementation of LabReportRepository (Section 5.8). */
export class SqliteLabReportRepository implements LabReportRepository {
  constructor(private readonly db: OutboundlyDb) {}

  async save(input: SaveLabReportInput): Promise<void> {
    this.db
      .insert(labReports)
      .values({
        id: generateId(),
        inputSnapshotJson: JSON.stringify(input.inputSnapshot),
        score: input.report.score,
        findingsJson: input.report.findings.map((f) => ({
          ruleId: f.ruleId,
          category: f.category,
          severity: f.severity,
          explanation: f.explanation
        })),
        generatedAt: input.generatedAt
      })
      .run();
  }
}
