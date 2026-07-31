import { eq } from "drizzle-orm";
import type { Document } from "../../../core/rendering/document-model.js";
import type { NewTemplateInput, Template } from "../../../core/campaigns/template.js";
import { asTemplateId, generateId, type TemplateId } from "../../../core/shared-kernel/ids.js";
import type { TemplateRepository } from "../../../ports/template-repository.port.js";
import type { OutboundlyDb } from "../db.js";
import { messages, sequenceSteps, templateMetricsRollup, templateVariants, templates as templatesTable } from "../schema.js";

type TemplateRow = typeof templatesTable.$inferSelect;

function toDomain(row: TemplateRow): Template {
  return {
    id: asTemplateId(row.id),
    name: row.name,
    document: JSON.parse(row.documentModelJson) as Document,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

/** SQLite-backed implementation of TemplateRepository (Section 5.6). */
export class SqliteTemplateRepository implements TemplateRepository {
  constructor(private readonly db: OutboundlyDb) {}

  async create(input: NewTemplateInput): Promise<Template> {
    const id = generateId();
    const now = new Date();
    this.db
      .insert(templatesTable)
      .values({
        id,
        name: input.name,
        documentModelJson: JSON.stringify(input.document),
        createdAt: now,
        updatedAt: now
      })
      .run();
    const row = this.db.select().from(templatesTable).where(eq(templatesTable.id, id)).get();
    return toDomain(row!);
  }

  async findById(id: TemplateId): Promise<Template | undefined> {
    const row = this.db.select().from(templatesTable).where(eq(templatesTable.id, id)).get();
    return row ? toDomain(row) : undefined;
  }

  async list(): Promise<Template[]> {
    return this.db.select().from(templatesTable).all().map(toDomain);
  }

  /** Rejects deleting a template that any sequence step still requires (sequence_steps.template_id
   * is NOT NULL -- there's no safe way to silently rip a template out from under a step that
   * needs one), matching the same "block, don't cascade" choice sequences.delete makes for
   * campaigns.sequence_id. Once nothing requires it: template_variants and the regenerable
   * template_metrics_rollup rows are deleted outright, and any historical message that used this
   * template (messages.template_id is nullable, unlike the two above) is detached rather than
   * losing that sent message -- same reasoning as SqliteCampaignRepository.delete's handling of
   * events/notifications/error_logs. */
  async delete(id: TemplateId): Promise<void> {
    this.db.transaction((tx) => {
      const inUseCount = tx.select({ id: sequenceSteps.id }).from(sequenceSteps).where(eq(sequenceSteps.templateId, id)).all().length;
      if (inUseCount > 0) {
        throw new Error(
          `This template is used by ${inUseCount} sequence step(s) and can't be deleted while they exist. Remove it from those sequences first.`
        );
      }

      tx.delete(templateVariants).where(eq(templateVariants.templateId, id)).run();
      tx.delete(templateMetricsRollup).where(eq(templateMetricsRollup.templateId, id)).run();
      tx.update(messages).set({ templateId: null }).where(eq(messages.templateId, id)).run();
      tx.delete(templatesTable).where(eq(templatesTable.id, id)).run();
    });
  }
}
