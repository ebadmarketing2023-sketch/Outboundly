import { eq } from "drizzle-orm";
import type { Document } from "../../../core/rendering/document-model.js";
import type { NewTemplateInput, Template } from "../../../core/campaigns/template.js";
import { asTemplateId, generateId, type TemplateId } from "../../../core/shared-kernel/ids.js";
import type { TemplateRepository } from "../../../ports/template-repository.port.js";
import type { OutboundlyDb } from "../db.js";
import { templates as templatesTable } from "../schema.js";

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

  async delete(id: TemplateId): Promise<void> {
    this.db.delete(templatesTable).where(eq(templatesTable.id, id)).run();
  }
}
