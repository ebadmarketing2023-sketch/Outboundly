import { describe, expect, it } from "vitest";
import { maybeCompleteCampaign, type MaybeCompleteCampaignDeps } from "../../src/application/campaigns/maybe-complete-campaign.js";
import type { Campaign, CampaignStatus, CampaignEnrollment, EnrollmentStatus } from "../../src/core/campaigns/campaign.js";
import type { CampaignRepository } from "../../src/ports/campaign-repository.port.js";
import type { EnrollmentRepository } from "../../src/ports/enrollment-repository.port.js";
import { asCampaignId, asContactId, asEnrollmentId, asSequenceId, generateId } from "../../src/core/shared-kernel/ids.js";

function fakeDeps(campaignStatus: CampaignStatus, enrollmentStatuses: EnrollmentStatus[]): MaybeCompleteCampaignDeps & { campaign: Campaign } {
  const campaign: Campaign = {
    id: asCampaignId(generateId()),
    name: "Test",
    sequenceId: asSequenceId(generateId()),
    sendingAccountIds: [],
    businessHoursProfileId: "bhp-1",
    status: campaignStatus,
    createdAt: new Date()
  };

  const enrollments: CampaignEnrollment[] = enrollmentStatuses.map((status) => ({
    id: asEnrollmentId(generateId()),
    campaignId: campaign.id,
    contactId: asContactId(generateId()),
    currentStepId: undefined,
    status,
    nextSendAt: undefined,
    enrolledAt: new Date(),
    updatedAt: new Date()
  }));

  const campaignRepository: Pick<CampaignRepository, "findById" | "setStatus"> = {
    async findById() {
      return campaign;
    },
    async setStatus(_id, status) {
      campaign.status = status;
    }
  };

  const enrollmentRepository: Pick<EnrollmentRepository, "listByCampaign"> = {
    async listByCampaign() {
      return enrollments;
    }
  };

  return {
    campaign,
    campaignRepository: campaignRepository as CampaignRepository,
    enrollmentRepository: enrollmentRepository as EnrollmentRepository
  };
}

describe("maybeCompleteCampaign (Section 14.1)", () => {
  it("completes a running campaign once every enrollment is terminal", async () => {
    const deps = fakeDeps("running", ["completed", "stopped_bounce"]);

    const result = await maybeCompleteCampaign(deps, deps.campaign.id);

    expect(result).toBe(true);
    expect(deps.campaign.status).toBe("completed");
  });

  it("does not complete a running campaign with a still-active enrollment", async () => {
    const deps = fakeDeps("running", ["completed", "active"]);

    const result = await maybeCompleteCampaign(deps, deps.campaign.id);

    expect(result).toBe(false);
    expect(deps.campaign.status).toBe("running");
  });

  it("does not complete a campaign with zero enrollments (never started sending anyone)", async () => {
    const deps = fakeDeps("running", []);

    const result = await maybeCompleteCampaign(deps, deps.campaign.id);

    expect(result).toBe(false);
    expect(deps.campaign.status).toBe("running");
  });

  it("does not touch a paused campaign even if every enrollment is terminal", async () => {
    const deps = fakeDeps("paused", ["completed"]);

    const result = await maybeCompleteCampaign(deps, deps.campaign.id);

    expect(result).toBe(false);
    expect(deps.campaign.status).toBe("paused");
  });

  it("does not touch a draft campaign", async () => {
    const deps = fakeDeps("draft", ["completed"]);

    const result = await maybeCompleteCampaign(deps, deps.campaign.id);

    expect(result).toBe(false);
    expect(deps.campaign.status).toBe("draft");
  });
});
