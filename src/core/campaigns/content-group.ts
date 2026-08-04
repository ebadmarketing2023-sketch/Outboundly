import type { Document } from "../rendering/document-model.js";
import type { SequenceStepId, TemplateId } from "../shared-kernel/ids.js";

/**
 * One atomic template+subject pair for a sequence step (Section 5.6, campaign-creation wizard) --
 * the group is what's weighted-selected as a single unit, so a subject line from one group can
 * never end up paired with another group's template. templateId/subjectVariantId point at real
 * rows (see SqliteContentGroupRepository) purely so the existing per-template/per-subject analytics
 * rollups keep working unchanged; document/subjectText are carried directly on the group too so
 * selecting one is self-sufficient at fire time.
 */
export interface ContentGroup {
  id: string;
  sequenceStepId: SequenceStepId;
  templateId: TemplateId;
  subjectVariantId: string;
  document: Document;
  subjectText: string;
  weight: number;
}

export interface NewContentGroupInput {
  sequenceStepId: SequenceStepId;
  templateId: TemplateId;
  subjectVariantId: string;
  document: Document;
  subjectText: string;
  weight: number;
}
