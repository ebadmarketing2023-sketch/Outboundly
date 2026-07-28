import type { Document } from "../rendering/document-model.js";
import type { TemplateId } from "../shared-kernel/ids.js";

/** Reusable message content (Section 5.6) — the same Internal Document Model shape a Draft uses
 * (Section 8.1), so a template renders through the identical Rendering Engine/MIME pipeline a
 * manually composed message does. */
export interface Template {
  id: TemplateId;
  name: string;
  document: Document;
  createdAt: Date;
  updatedAt: Date;
}

export interface TemplateVariant {
  id: string;
  templateId: TemplateId;
  variantLabel: string;
  weight: number;
  documentOverride?: Document;
}

export interface NewTemplateInput {
  name: string;
  document: Document;
}
