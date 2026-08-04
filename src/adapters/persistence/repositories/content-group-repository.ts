import { eq } from "drizzle-orm";
import type { Document } from "../../../core/rendering/document-model.js";
import type { ContentGroup } from "../../../core/campaigns/content-group.js";
import { asSequenceStepId, asTemplateId, generateId } from "../../../core/shared-kernel/ids.js";
import type { SequenceStepId } from "../../../core/shared-kernel/ids.js";
import type { ContentGroupRepository } from "../../../ports/content-group-repository.port.js";
import type { NewContentGroupInput } from "../../../core/campaigns/content-group.js";
import type { OutboundlyDb } from "../db.js";
import { sequenceStepContentGroups } from "../schema.js";

type ContentGroupRow = typeof sequenceStepContentGroups.$inferSelect;

function toDomain(row: ContentGroupRow): ContentGroup {
  return {
    id: row.id,
    sequenceStepId: asSequenceStepId(row.sequenceStepId),
    templateId: asTemplateId(row.templateId),
    subjectVariantId: row.subjectVariantId,
    document: JSON.parse(row.documentModelJson) as Document,
    subjectText: row.subjectText,
    weight: row.weight
  };
}

/** SQLite-backed implementation of ContentGroupRepository. */
export class SqliteContentGroupRepository implements ContentGroupRepository {
  constructor(private readonly db: OutboundlyDb) {}

  async create(input: NewContentGroupInput): Promise<ContentGroup> {
    const id = generateId();
    this.db
      .insert(sequenceStepContentGroups)
      .values({
        id,
        sequenceStepId: input.sequenceStepId,
        templateId: input.templateId,
        subjectVariantId: input.subjectVariantId,
        documentModelJson: JSON.stringify(input.document),
        subjectText: input.subjectText,
        weight: input.weight,
        createdAt: new Date()
      })
      .run();
    const row = this.db.select().from(sequenceStepContentGroups).where(eq(sequenceStepContentGroups.id, id)).get();
    return toDomain(row!);
  }

  async findByStepId(stepId: SequenceStepId): Promise<ContentGroup[]> {
    return this.db
      .select()
      .from(sequenceStepContentGroups)
      .where(eq(sequenceStepContentGroups.sequenceStepId, stepId))
      .all()
      .map(toDomain);
  }
}
