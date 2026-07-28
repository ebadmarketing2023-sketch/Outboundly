import type { SubjectVariant } from "../core/campaigns/sequence.js";
import type { SequenceStepId } from "../core/shared-kernel/ids.js";

export interface NewSubjectVariantInput {
  sequenceStepId: SequenceStepId;
  subjectText: string;
  weight: number;
}

/** Subject-line A/B/n variant persistence (Section 5.6), scoped to a sequence step. */
export interface SubjectVariantRepository {
  create(input: NewSubjectVariantInput): Promise<SubjectVariant>;
  findByStepId(stepId: SequenceStepId): Promise<SubjectVariant[]>;
}
