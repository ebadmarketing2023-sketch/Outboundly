import type { Document } from "../core/rendering/document-model.js";
import type { TemplateVariant } from "../core/campaigns/template.js";
import type { TemplateId } from "../core/shared-kernel/ids.js";

export interface NewTemplateVariantInput {
  templateId: TemplateId;
  variantLabel: string;
  weight: number;
  documentOverride?: Document;
}

/** Template content A/B/n variant persistence (Section 5.6). */
export interface TemplateVariantRepository {
  create(input: NewTemplateVariantInput): Promise<TemplateVariant>;
  findByTemplateId(templateId: TemplateId): Promise<TemplateVariant[]>;
}
