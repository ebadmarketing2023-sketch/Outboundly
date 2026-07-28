import type { NewSequenceInput, SequenceWithSteps } from "../core/campaigns/sequence.js";
import type { SequenceId } from "../core/shared-kernel/ids.js";

export interface SequenceRepository {
  create(input: NewSequenceInput): Promise<SequenceWithSteps>;
  findById(id: SequenceId): Promise<SequenceWithSteps | undefined>;
  list(): Promise<SequenceWithSteps[]>;
}
