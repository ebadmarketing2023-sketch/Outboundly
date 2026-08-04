import type { Document } from "../../core/rendering/document-model.js";
import type { Campaign } from "../../core/campaigns/campaign.js";
import type { Template } from "../../core/campaigns/template.js";
import type { AccountId } from "../../core/shared-kernel/ids.js";
import type { BusinessHoursProfileRepository } from "../../ports/business-hours-profile-repository.port.js";
import type { CampaignRepository } from "../../ports/campaign-repository.port.js";
import type { ContentGroupRepository } from "../../ports/content-group-repository.port.js";
import type { SequenceRepository } from "../../ports/sequence-repository.port.js";
import type { SubjectVariantRepository } from "../../ports/subject-variant-repository.port.js";
import type { TemplateRepository } from "../../ports/template-repository.port.js";

export interface WizardContentGroupInput {
  subjectText: string;
  document: Document;
  weight: number;
}

export interface WizardFollowUpStepInput {
  document: Document;
  delayDays: number;
  delayHours: number;
}

export interface CreateCampaignFromWizardInput {
  name: string;
  /** Every account here goes into the campaign's own rotation pool (Section 16.3's Provider
   * Selector) -- at least one is required. fireEnrollmentStep prefers keeping a given enrollment on
   * whichever account actually sent its previous step, only rotating to another pool member when
   * that one becomes ineligible, so adding more than one here is purely additional capacity, not a
   * per-message coin flip that could show a recipient two different senders mid-conversation. */
  sendingAccountIds: AccountId[];
  timezone: string;
  /** Lowercase full weekday names ("monday".."sunday") sending is allowed on. */
  days: string[];
  start: string; // "HH:MM", 24-hour
  end: string;
  /** The first step's weighted template+subject pairs -- at least one is required. */
  contentGroups: WizardContentGroupInput[];
  /** Optional, unlimited, single-template (no variation) steps after the first. */
  followUpSteps: WizardFollowUpStepInput[];
}

export interface CreateCampaignFromWizardDeps {
  templateRepository: TemplateRepository;
  subjectVariantRepository: SubjectVariantRepository;
  contentGroupRepository: ContentGroupRepository;
  sequenceRepository: SequenceRepository;
  businessHoursProfileRepository: BusinessHoursProfileRepository;
  campaignRepository: CampaignRepository;
}

/**
 * Composite orchestration behind the campaign-creation wizard (Section 5.6): the user never sees
 * or names a business-hours profile, template, sequence, or subject/template variant directly --
 * this creates real rows for all of them behind the scenes so the rest of the app (fireEnrollmentStep,
 * the standalone Templates/Sequences/Business Hours screens if reopened, analytics rollups) keeps
 * working against the exact same schema those already assume, unchanged.
 *
 * Each content-group pair gets its own real templates row (so the group's document is real content,
 * not a variant override of some shared placeholder) and its own real subject_variants row scoped to
 * the first step, joined together by one sequence_step_content_groups row -- that's what makes the
 * pairing atomic (see fireEnrollmentStep's own comment on why the pre-existing independent
 * template_variants/subject_variants selection can't guarantee that on its own). Follow-up steps get
 * exactly one template + one subject_variants row each, matching the pre-existing single-variant
 * sequence step shape precisely (follow-up subject text is never actually sent -- fireEnrollmentStep
 * always overrides it with "Re: <original subject>" -- so its exact value here is inert, same as it
 * already was for a step built through the pre-existing standalone Sequences screen).
 */
export async function createCampaignFromWizard(deps: CreateCampaignFromWizardDeps, input: CreateCampaignFromWizardInput): Promise<Campaign> {
  if (input.contentGroups.length === 0) {
    throw new Error("At least one template/subject group is required to create a campaign");
  }
  if (input.sendingAccountIds.length === 0) {
    throw new Error("At least one sending account is required to create a campaign");
  }

  const windows: Record<string, { start: string; end: string }[]> = {};
  for (const day of input.days) {
    windows[day] = [{ start: input.start, end: input.end }];
  }
  const businessHoursProfile = await deps.businessHoursProfileRepository.create({
    name: `${input.name} — business hours`,
    timezone: input.timezone,
    windows
  });

  const groupTemplates: Template[] = [];
  for (const [index, group] of input.contentGroups.entries()) {
    groupTemplates.push(
      await deps.templateRepository.create({ name: `${input.name} — Step 1 Group ${index + 1}`, document: group.document })
    );
  }

  const followUpTemplates: Template[] = [];
  for (const [index, step] of input.followUpSteps.entries()) {
    followUpTemplates.push(
      await deps.templateRepository.create({ name: `${input.name} — Follow-up ${index + 1}`, document: step.document })
    );
  }

  const sequence = await deps.sequenceRepository.create({
    name: `${input.name} — sequence`,
    steps: [
      { delayDays: 0, delayHours: 0, templateId: groupTemplates[0]!.id },
      ...input.followUpSteps.map((step, index) => ({
        delayDays: step.delayDays,
        delayHours: step.delayHours,
        templateId: followUpTemplates[index]!.id
      }))
    ]
  });

  const firstStep = sequence.steps[0]!;
  for (const [index, group] of input.contentGroups.entries()) {
    const groupTemplate = groupTemplates[index]!;
    const subjectVariant = await deps.subjectVariantRepository.create({
      sequenceStepId: firstStep.id,
      subjectText: group.subjectText,
      weight: group.weight
    });
    await deps.contentGroupRepository.create({
      sequenceStepId: firstStep.id,
      templateId: groupTemplate.id,
      subjectVariantId: subjectVariant.id,
      document: group.document,
      subjectText: group.subjectText,
      weight: group.weight
    });
  }

  for (const [index] of input.followUpSteps.entries()) {
    const followUpStep = sequence.steps[index + 1]!;
    await deps.subjectVariantRepository.create({ sequenceStepId: followUpStep.id, subjectText: "Follow-up", weight: 1 });
  }

  return deps.campaignRepository.create({
    name: input.name,
    sequenceId: sequence.id,
    sendingAccountIds: input.sendingAccountIds,
    businessHoursProfileId: businessHoursProfile.id
  });
}
