import type { ContentGroup, NewContentGroupInput } from "../core/campaigns/content-group.js";
import type { SequenceStepId } from "../core/shared-kernel/ids.js";

/** Content-group (template+subject pair) persistence, scoped to a sequence step. */
export interface ContentGroupRepository {
  create(input: NewContentGroupInput): Promise<ContentGroup>;
  findByStepId(stepId: SequenceStepId): Promise<ContentGroup[]>;
}
