import type { NewTemplateInput, Template } from "../core/campaigns/template.js";
import type { TemplateId } from "../core/shared-kernel/ids.js";

export interface TemplateRepository {
  create(input: NewTemplateInput): Promise<Template>;
  findById(id: TemplateId): Promise<Template | undefined>;
  list(): Promise<Template[]>;
  delete(id: TemplateId): Promise<void>;
}
