import { eq } from "drizzle-orm";
import type { Document } from "../../../core/rendering/document-model.js";
import type { TemplateVariant } from "../../../core/campaigns/template.js";
import { asTemplateId, generateId } from "../../../core/shared-kernel/ids.js";
import type { TemplateId } from "../../../core/shared-kernel/ids.js";
import type { NewTemplateVariantInput, TemplateVariantRepository } from "../../../ports/template-variant-repository.port.js";
import type { OutboundlyDb } from "../db.js";
import { templateVariants } from "../schema.js";

type TemplateVariantRow = typeof templateVariants.$inferSelect;

function toDomain(row: TemplateVariantRow): TemplateVariant {
  return {
    id: row.id,
    templateId: asTemplateId(row.templateId),
    variantLabel: row.variantLabel,
    weight: row.weight,
    documentOverride: row.documentModelOverrideJson ? (JSON.parse(row.documentModelOverrideJson) as Document) : undefined
  };
}

/** SQLite-backed implementation of TemplateVariantRepository (Section 5.6). */
export class SqliteTemplateVariantRepository implements TemplateVariantRepository {
  constructor(private readonly db: OutboundlyDb) {}

  async create(input: NewTemplateVariantInput): Promise<TemplateVariant> {
    const id = generateId();
    this.db
      .insert(templateVariants)
      .values({
        id,
        templateId: input.templateId,
        variantLabel: input.variantLabel,
        weight: input.weight,
        documentModelOverrideJson: input.documentOverride ? JSON.stringify(input.documentOverride) : undefined
      })
      .run();
    const row = this.db.select().from(templateVariants).where(eq(templateVariants.id, id)).get();
    return toDomain(row!);
  }

  async findByTemplateId(templateId: TemplateId): Promise<TemplateVariant[]> {
    return this.db.select().from(templateVariants).where(eq(templateVariants.templateId, templateId)).all().map(toDomain);
  }
}
