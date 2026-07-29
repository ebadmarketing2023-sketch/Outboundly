import { and, eq, lte } from "drizzle-orm";
import type { CampaignEnrollment, EnrollmentStatus } from "../../../core/campaigns/campaign.js";
import {
  asCampaignId,
  asContactId,
  asEnrollmentId,
  asSequenceStepId,
  generateId,
  type CampaignId,
  type ContactId,
  type EnrollmentId
} from "../../../core/shared-kernel/ids.js";
import type {
  AdvanceEnrollmentInput,
  EnrollmentRepository,
  NewEnrollmentInput
} from "../../../ports/enrollment-repository.port.js";
import type { OutboundlyDb } from "../db.js";
import { campaignEnrollments as enrollmentsTable, campaigns as campaignsTable } from "../schema.js";

type EnrollmentRow = typeof enrollmentsTable.$inferSelect;

function toDomain(row: EnrollmentRow): CampaignEnrollment {
  return {
    id: asEnrollmentId(row.id),
    campaignId: asCampaignId(row.campaignId),
    contactId: asContactId(row.contactId),
    currentStepId: row.currentStepId ? asSequenceStepId(row.currentStepId) : undefined,
    status: row.status as EnrollmentStatus,
    nextSendAt: row.nextSendAt ?? undefined,
    enrolledAt: row.enrolledAt,
    updatedAt: row.updatedAt
  };
}

/** SQLite-backed implementation of EnrollmentRepository (Section 14.2). */
export class SqliteEnrollmentRepository implements EnrollmentRepository {
  constructor(private readonly db: OutboundlyDb) {}

  async enroll(input: NewEnrollmentInput): Promise<CampaignEnrollment> {
    const id = generateId();
    const now = new Date();
    this.db
      .insert(enrollmentsTable)
      .values({
        id,
        campaignId: input.campaignId,
        contactId: input.contactId,
        currentStepId: input.currentStepId,
        status: "active",
        nextSendAt: input.nextSendAt,
        enrolledAt: now,
        updatedAt: now
      })
      .run();
    const row = this.db.select().from(enrollmentsTable).where(eq(enrollmentsTable.id, id)).get();
    return toDomain(row!);
  }

  async findById(id: EnrollmentId): Promise<CampaignEnrollment | undefined> {
    const row = this.db.select().from(enrollmentsTable).where(eq(enrollmentsTable.id, id)).get();
    return row ? toDomain(row) : undefined;
  }

  async findActiveByCampaignAndContact(
    campaignId: CampaignId,
    contactId: ContactId
  ): Promise<CampaignEnrollment | undefined> {
    const row = this.db
      .select()
      .from(enrollmentsTable)
      .where(
        and(
          eq(enrollmentsTable.campaignId, campaignId),
          eq(enrollmentsTable.contactId, contactId),
          eq(enrollmentsTable.status, "active")
        )
      )
      .get();
    return row ? toDomain(row) : undefined;
  }

  async listByCampaign(campaignId: CampaignId): Promise<CampaignEnrollment[]> {
    return this.db.select().from(enrollmentsTable).where(eq(enrollmentsTable.campaignId, campaignId)).all().map(toDomain);
  }

  async findDueForScheduling(now: Date): Promise<CampaignEnrollment[]> {
    // Joins to campaigns.status = 'running' (Section 14.2): an enrollment being individually
    // 'active' is necessary but not sufficient -- its parent campaign must also have been
    // explicitly started and not paused. Before this join existed, a campaign's enrollments fired
    // regardless of the campaign's own status, which meant "Pause" didn't pause anything and a
    // still-'draft' campaign (never clicked "Start") would silently begin sending the moment
    // contacts were enrolled into it.
    const rows = this.db
      .select({ enrollment: enrollmentsTable })
      .from(enrollmentsTable)
      .innerJoin(campaignsTable, eq(enrollmentsTable.campaignId, campaignsTable.id))
      .where(
        and(eq(enrollmentsTable.status, "active"), lte(enrollmentsTable.nextSendAt, now), eq(campaignsTable.status, "running"))
      )
      .all();
    return rows.map((row) => toDomain(row.enrollment));
  }

  async advance(id: EnrollmentId, patch: AdvanceEnrollmentInput): Promise<void> {
    this.db
      .update(enrollmentsTable)
      .set({
        currentStepId: patch.currentStepId,
        nextSendAt: patch.nextSendAt,
        status: patch.status,
        updatedAt: new Date()
      })
      .where(eq(enrollmentsTable.id, id))
      .run();
  }

  async findActiveByContact(contactId: ContactId): Promise<CampaignEnrollment[]> {
    return this.db
      .select()
      .from(enrollmentsTable)
      .where(and(eq(enrollmentsTable.contactId, contactId), eq(enrollmentsTable.status, "active")))
      .all()
      .map(toDomain);
  }
}
