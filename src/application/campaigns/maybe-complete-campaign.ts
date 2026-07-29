import type { CampaignId } from "../../core/shared-kernel/ids.js";
import type { CampaignRepository } from "../../ports/campaign-repository.port.js";
import type { EnrollmentRepository } from "../../ports/enrollment-repository.port.js";

export interface MaybeCompleteCampaignDeps {
  campaignRepository: CampaignRepository;
  enrollmentRepository: EnrollmentRepository;
}

/**
 * A campaign automatically becomes 'completed' once every one of its enrollments has reached a
 * terminal state (completed, or any stopped_* status) -- Section 14.1's campaign status enum
 * lists 'completed', but until now nothing ever set it. Requires at least one enrollment to exist
 * (a freshly started campaign nobody has enrolled anyone into yet must stay 'running', not flip to
 * 'completed' the instant it's started), and only ever transitions a campaign that is currently
 * 'running' -- a 'paused' campaign is left alone here on purpose, since resuming it should still
 * see its own enrollments through rather than having already been silently marked done while
 * paused.
 *
 * Called from the two places an enrollment actually reaches a terminal state:
 * fireEnrollmentStep (its last step completing) and stopEnrollmentsForContact (a
 * reply/bounce/suppression/manual stop) -- there's no need for a separate periodic sweep for this.
 */
export async function maybeCompleteCampaign(deps: MaybeCompleteCampaignDeps, campaignId: CampaignId): Promise<boolean> {
  const campaign = await deps.campaignRepository.findById(campaignId);
  if (!campaign || campaign.status !== "running") return false;

  const enrollments = await deps.enrollmentRepository.listByCampaign(campaignId);
  if (enrollments.length === 0) return false;
  if (enrollments.some((e) => e.status === "active")) return false;

  await deps.campaignRepository.setStatus(campaignId, "completed");
  return true;
}
