import { eq } from "drizzle-orm";
import type { SubjectVariant } from "../../../core/campaigns/sequence.js";
import { asSequenceStepId, generateId } from "../../../core/shared-kernel/ids.js";
import type { SequenceStepId } from "../../../core/shared-kernel/ids.js";
import type { NewSubjectVariantInput, SubjectVariantRepository } from "../../../ports/subject-variant-repository.port.js";
import type { OutboundlyDb } from "../db.js";
import { subjectVariants } from "../schema.js";

type SubjectVariantRow = typeof subjectVariants.$inferSelect;

function toDomain(row: SubjectVariantRow): SubjectVariant {
  return {
    id: row.id,
    sequenceStepId: asSequenceStepId(row.sequenceStepId),
    subjectText: row.subjectText,
    weight: row.weight
  };
}

/** SQLite-backed implementation of SubjectVariantRepository (Section 5.6). */
export class SqliteSubjectVariantRepository implements SubjectVariantRepository {
  constructor(private readonly db: OutboundlyDb) {}

  async create(input: NewSubjectVariantInput): Promise<SubjectVariant> {
    const id = generateId();
    this.db
      .insert(subjectVariants)
      .values({ id, sequenceStepId: input.sequenceStepId, subjectText: input.subjectText, weight: input.weight })
      .run();
    const row = this.db.select().from(subjectVariants).where(eq(subjectVariants.id, id)).get();
    return toDomain(row!);
  }

  async findByStepId(stepId: SequenceStepId): Promise<SubjectVariant[]> {
    return this.db.select().from(subjectVariants).where(eq(subjectVariants.sequenceStepId, stepId)).all().map(toDomain);
  }
}
