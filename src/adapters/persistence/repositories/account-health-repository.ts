import { desc, eq } from "drizzle-orm";
import { generateId } from "../../../core/shared-kernel/ids.js";
import { asAccountId, type AccountId } from "../../../core/shared-kernel/ids.js";
import type {
  AccountHealthRepository,
  AccountHealthSnapshotRecord,
  SaveAccountHealthSnapshotInput
} from "../../../ports/account-health-repository.port.js";
import type { OutboundlyDb } from "../db.js";
import { accountHealthFindings, accountHealthSnapshots } from "../schema.js";

/** SQLite-backed implementation of AccountHealthRepository (Section 5.2). */
export class SqliteAccountHealthRepository implements AccountHealthRepository {
  constructor(private readonly db: OutboundlyDb) {}

  async save(input: SaveAccountHealthSnapshotInput): Promise<string> {
    const snapshotId = generateId();
    this.db
      .insert(accountHealthSnapshots)
      .values({
        id: snapshotId,
        accountId: input.accountId,
        capturedAt: input.capturedAt,
        replyRate: input.input.metrics.replyRate,
        sendsLast24h: input.input.metrics.sendsLast24h,
        sendsLast7d: input.input.metrics.sendsLast7d,
        accountAgeDays: input.input.metrics.accountAgeDays,
        sendingConsistencyScore: input.input.metrics.sendingConsistencyScore,
        spfStatus: input.input.authStatus.spf,
        dkimStatus: input.input.authStatus.dkim,
        dmarcStatus: input.input.authStatus.dmarc,
        // No rolling failure-history counter is tracked yet (see AccountHealthInput's docblock) —
        // 0/1 here reflects only the live check performed at snapshot time, not a real 30-day window.
        oauthFailureCount30d: input.input.liveAuthCheckPassed ? 0 : 1,
        tokenExpiringSoon: !input.input.liveAuthCheckPassed,
        healthScore: input.result.healthScore,
        riskLevel: input.result.riskLevel
      })
      .run();

    if (input.result.findings.length > 0) {
      this.db
        .insert(accountHealthFindings)
        .values(
          input.result.findings.map((f) => ({
            id: generateId(),
            snapshotId,
            findingType: f.findingType,
            severity: f.severity,
            message: f.message,
            explanation: f.explanation,
            recommendedAction: f.recommendedAction
          }))
        )
        .run();
    }

    return snapshotId;
  }

  async getLatest(accountId: AccountId): Promise<AccountHealthSnapshotRecord | undefined> {
    const snapshot = this.db
      .select()
      .from(accountHealthSnapshots)
      .where(eq(accountHealthSnapshots.accountId, accountId))
      .orderBy(desc(accountHealthSnapshots.capturedAt))
      .limit(1)
      .get();
    if (!snapshot) return undefined;

    const findings = this.db
      .select()
      .from(accountHealthFindings)
      .where(eq(accountHealthFindings.snapshotId, snapshot.id))
      .all();

    return {
      id: snapshot.id,
      accountId: asAccountId(snapshot.accountId),
      capturedAt: snapshot.capturedAt,
      input: {
        metrics: {
          sendsLast24h: snapshot.sendsLast24h,
          sendsLast7d: snapshot.sendsLast7d,
          accountAgeDays: snapshot.accountAgeDays,
          replyRate: snapshot.replyRate ?? undefined,
          sendingConsistencyScore: snapshot.sendingConsistencyScore ?? undefined
        },
        authStatus: {
          spf: snapshot.spfStatus as "pass" | "fail" | "none",
          dkim: snapshot.dkimStatus as "pass" | "fail" | "none",
          dmarc: snapshot.dmarcStatus as "pass" | "fail" | "none"
        },
        liveAuthCheckPassed: !snapshot.tokenExpiringSoon
      },
      result: {
        healthScore: snapshot.healthScore,
        riskLevel: snapshot.riskLevel as AccountHealthSnapshotRecord["result"]["riskLevel"],
        findings: findings.map((f) => ({
          findingType: f.findingType,
          severity: f.severity as "info" | "warning" | "critical",
          message: f.message,
          explanation: f.explanation,
          recommendedAction: f.recommendedAction ?? undefined
        }))
      }
    };
  }
}
