import type { SequenceId, SequenceStepId, TemplateId } from "../shared-kernel/ids.js";

export type SequenceStatus = "draft" | "active" | "archived";

export interface Sequence {
  id: SequenceId;
  name: string;
  description?: string;
  status: SequenceStatus;
  createdAt: Date;
}

/** One step in a sequence (Section 5.6, Section 14.1) — the delay is relative to the previous
 * step (or enrollment, for the first step), re-evaluated by the Scheduling Policy Engine rather
 * than a raw addition once a real send is proposed (Section 14.3). */
export interface SequenceStep {
  id: SequenceStepId;
  sequenceId: SequenceId;
  stepOrder: number;
  delayDays: number;
  delayHours: number;
  templateId: TemplateId;
  stopOnReply: boolean;
  stopOnBounce: boolean;
  conditionJson?: unknown;
}

export interface SubjectVariant {
  id: string;
  sequenceStepId: SequenceStepId;
  subjectText: string;
  weight: number;
}

export interface NewSequenceStepInput {
  delayDays: number;
  delayHours: number;
  templateId: TemplateId;
  stopOnReply?: boolean;
  stopOnBounce?: boolean;
  conditionJson?: unknown;
}

export interface NewSequenceInput {
  name: string;
  description?: string;
  steps: NewSequenceStepInput[];
}

export interface SequenceWithSteps extends Sequence {
  steps: SequenceStep[];
}
