import { eq } from "drizzle-orm";
import type { NewSequenceInput, SequenceStep, SequenceWithSteps } from "../../../core/campaigns/sequence.js";
import { asSequenceId, asSequenceStepId, asTemplateId, generateId, type SequenceId } from "../../../core/shared-kernel/ids.js";
import type { SequenceRepository } from "../../../ports/sequence-repository.port.js";
import type { OutboundlyDb } from "../db.js";
import { sequences as sequencesTable, sequenceSteps as sequenceStepsTable } from "../schema.js";

type SequenceRow = typeof sequencesTable.$inferSelect;
type SequenceStepRow = typeof sequenceStepsTable.$inferSelect;

function stepToDomain(row: SequenceStepRow): SequenceStep {
  return {
    id: asSequenceStepId(row.id),
    sequenceId: asSequenceId(row.sequenceId),
    stepOrder: row.stepOrder,
    delayDays: row.delayDays,
    delayHours: row.delayHours,
    templateId: asTemplateId(row.templateId),
    stopOnReply: row.stopOnReply,
    stopOnBounce: row.stopOnBounce,
    conditionJson: row.conditionJson ?? undefined
  };
}

/** SQLite-backed implementation of SequenceRepository (Section 5.6). Sequence + its steps are
 * created inside one transaction so a sequence never exists without at least the steps it was
 * created with (there is no separate "add a step later" mutation in this phase). */
export class SqliteSequenceRepository implements SequenceRepository {
  constructor(private readonly db: OutboundlyDb) {}

  async create(input: NewSequenceInput): Promise<SequenceWithSteps> {
    const sequenceId = generateId();
    const now = new Date();

    this.db.transaction((tx) => {
      tx.insert(sequencesTable)
        .values({ id: sequenceId, name: input.name, description: input.description, status: "draft", createdAt: now })
        .run();

      input.steps.forEach((step, index) => {
        tx.insert(sequenceStepsTable)
          .values({
            id: generateId(),
            sequenceId,
            stepOrder: index + 1,
            delayDays: step.delayDays,
            delayHours: step.delayHours,
            templateId: step.templateId,
            stopOnReply: step.stopOnReply ?? true,
            stopOnBounce: step.stopOnBounce ?? true,
            conditionJson: step.conditionJson
          })
          .run();
      });
    });

    const created = await this.findById(asSequenceId(sequenceId));
    return created!;
  }

  async findById(id: SequenceId): Promise<SequenceWithSteps | undefined> {
    const sequenceRow = this.db.select().from(sequencesTable).where(eq(sequencesTable.id, id)).get();
    if (!sequenceRow) return undefined;
    return this.withSteps(sequenceRow);
  }

  async list(): Promise<SequenceWithSteps[]> {
    const rows = this.db.select().from(sequencesTable).all();
    return rows.map((row) => this.withSteps(row));
  }

  private withSteps(row: SequenceRow): SequenceWithSteps {
    const stepRows = this.db
      .select()
      .from(sequenceStepsTable)
      .where(eq(sequenceStepsTable.sequenceId, row.id))
      .all()
      .sort((a, b) => a.stepOrder - b.stepOrder);

    return {
      id: asSequenceId(row.id),
      name: row.name,
      description: row.description ?? undefined,
      status: row.status as SequenceWithSteps["status"],
      createdAt: row.createdAt,
      steps: stepRows.map(stepToDomain)
    };
  }
}
