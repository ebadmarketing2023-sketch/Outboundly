import type { NewSequenceInput, SequenceWithSteps } from "../core/campaigns/sequence.js";
import type { SequenceId } from "../core/shared-kernel/ids.js";

export interface SequenceRepository {
  create(input: NewSequenceInput): Promise<SequenceWithSteps>;
  findById(id: SequenceId): Promise<SequenceWithSteps | undefined>;
  list(): Promise<SequenceWithSteps[]>;
  /** Rejects (rather than cascading through) any campaign still bound to this sequence, since
   * campaigns.sequence_id is NOT NULL -- there is no safe "detach" for that reference the way
   * there is for historical message rows below. Otherwise cascades through this sequence's own
   * steps and their subject variants in one transaction. */
  delete(id: SequenceId): Promise<void>;
}
