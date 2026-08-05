import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { diagnoseCampaign, type DiagnoseCampaignDeps } from "../../src/application/campaigns/diagnose-campaign.js";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { SqliteAccountHealthRepository } from "../../src/adapters/persistence/repositories/account-health-repository.js";
import { SqliteBusinessHoursProfileRepository } from "../../src/adapters/persistence/repositories/business-hours-profile-repository.js";
import { SqliteCampaignRepository } from "../../src/adapters/persistence/repositories/campaign-repository.js";
import { SqliteContactRepository } from "../../src/adapters/persistence/repositories/contact-repository.js";
import { SqliteEnrollmentRepository } from "../../src/adapters/persistence/repositories/enrollment-repository.js";
import { SqliteSequenceRepository } from "../../src/adapters/persistence/repositories/sequence-repository.js";
import { SqliteTemplateRepository } from "../../src/adapters/persistence/repositories/template-repository.js";
import { accounts } from "../../src/adapters/persistence/schema.js";
import { paragraph, textRun } from "../../src/core/rendering/document-model.js";
import { asAccountId, asCampaignId, generateId } from "../../src/core/shared-kernel/ids.js";

/**
 * The report that answers "why isn't this campaign sending?". Every case below is a state a real
 * campaign has actually sat in while showing "Running" and doing nothing.
 */
describe("diagnoseCampaign", () => {
  let db: OutboundlyDb;
  let deps: DiagnoseCampaignDeps;
  let accountId: string;
  let allDayProfileId: string;
  let templateRepository: SqliteTemplateRepository;

  const now = new Date(Date.UTC(2026, 7, 5, 14, 0, 0)); // a Wednesday, 14:00 UTC

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-diagnose-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
    accountId = generateId();
    db.insert(accounts)
      .values({
        id: accountId,
        provider: "google",
        emailAddress: "me@outboundly.app",
        status: "connected",
        dailySendLimit: 40,
        hourlySendLimit: 8,
        connectedAt: now,
        createdAt: now,
        updatedAt: now
      })
      .run();

    const businessHoursProfileRepository = new SqliteBusinessHoursProfileRepository(db);
    const allDay = [{ start: "00:00", end: "23:59" }];
    allDayProfileId = (
      await businessHoursProfileRepository.create({
        name: "Always open",
        timezone: "UTC",
        windows: { sunday: allDay, monday: allDay, tuesday: allDay, wednesday: allDay, thursday: allDay, friday: allDay, saturday: allDay }
      })
    ).id;

    templateRepository = new SqliteTemplateRepository(db);
    deps = {
      db,
      campaignRepository: new SqliteCampaignRepository(db),
      enrollmentRepository: new SqliteEnrollmentRepository(db),
      businessHoursProfileRepository,
      accountHealthRepository: new SqliteAccountHealthRepository(db)
    };
  });

  async function makeCampaign(businessHoursProfileId = allDayProfileId) {
    const template = await templateRepository.create({ name: "T", document: { blocks: [paragraph(textRun("Hi"))] } });
    const sequence = await new SqliteSequenceRepository(db).create({
      name: "Seq",
      steps: [{ delayDays: 0, delayHours: 0, templateId: template.id }]
    });
    return deps.campaignRepository.create({
      name: "Camp",
      sequenceId: sequence.id,
      sendingAccountIds: [asAccountId(accountId)],
      businessHoursProfileId
    });
  }

  async function enrollOne(campaignId: ReturnType<typeof asCampaignId>) {
    const contact = await new SqliteContactRepository(db).upsertByEmail({ email: "lead@example.com", source: "manual" });
    return deps.enrollmentRepository.enroll({ campaignId, contactId: contact.id, nextSendAt: new Date(now.getTime() - 60_000) });
  }

  it("names a disconnected account as blocking, which is the failure that never clears on its own", async () => {
    // The Provider Selector skips a non-connected account and the send worker retries every five
    // minutes forever, so the campaign reads "Running" with a full queue and no emails, indefinitely.
    const campaign = await makeCampaign();
    await enrollOne(campaign.id);
    db.update(accounts).set({ status: "disconnected" }).where(eq(accounts.id, accountId)).run();

    const diagnosis = await diagnoseCampaign(deps, campaign.id, now);

    const finding = diagnosis.findings.find((f) => f.title.includes("disconnected"));
    expect(finding?.severity).toBe("blocking");
    expect(finding?.action).toMatch(/[Rr]econnect/);
    expect(diagnosis.summary).toMatch(/^Not sending/);
  });

  it("names a paused campaign", async () => {
    const campaign = await makeCampaign();
    await enrollOne(campaign.id);
    await deps.campaignRepository.setStatus(campaign.id, "paused");

    const diagnosis = await diagnoseCampaign(deps, campaign.id, now);

    expect(diagnosis.findings[0]?.title).toContain("paused");
    expect(diagnosis.findings[0]?.severity).toBe("blocking");
  });

  it("explains an out-of-hours wait and says when sending resumes", async () => {
    const weekday = [{ start: "09:00", end: "17:00" }];
    const profile = await deps.businessHoursProfileRepository.create({
      name: "Weekdays",
      timezone: "America/New_York",
      windows: { monday: weekday, tuesday: weekday, wednesday: weekday, thursday: weekday, friday: weekday }
    });
    const campaign = await makeCampaign(profile.id);
    await enrollOne(campaign.id);

    // 03:00 UTC on a Thursday is 23:00 Wednesday in New York -- outside the window.
    const lateAtNight = new Date(Date.UTC(2026, 7, 6, 3, 0, 0));
    const diagnosis = await diagnoseCampaign(deps, campaign.id, lateAtNight);

    const finding = diagnosis.findings.find((f) => f.title.includes("Outside"));
    expect(finding?.severity).toBe("waiting");
    expect(finding?.detail).toContain("America/New_York");
    expect(finding?.detail).toMatch(/reopens/);
  });

  it("reports an account that has hit its hourly cap as waiting, not broken", async () => {
    const campaign = await makeCampaign();
    await enrollOne(campaign.id);
    const { messages } = await import("../../src/adapters/persistence/schema.js");
    for (let i = 0; i < 8; i++) {
      db.insert(messages)
        .values({
          id: generateId(),
          accountId,
          direction: "outbound",
          status: "sent",
          fromAddress: "me@outboundly.app",
          toAddresses: ["lead@example.com"],
          subject: "s",
          messageIdHeader: `<sent-${i}@outboundly.app>`,
          sentAt: new Date(now.getTime() - 60_000),
          createdAt: now,
          updatedAt: now
        })
        .run();
    }

    const diagnosis = await diagnoseCampaign(deps, campaign.id, now);

    const finding = diagnosis.findings.find((f) => f.title.includes("hourly limit"));
    expect(finding?.severity).toBe("waiting");
    expect(finding?.title).toContain("8/8");
  });

  it("points at an unresolvable token when leads are due but nothing was ever queued for them", async () => {
    const campaign = await makeCampaign();
    await enrollOne(campaign.id);

    const diagnosis = await diagnoseCampaign(deps, campaign.id, now);

    const finding = diagnosis.findings.find((f) => f.title.includes("nothing has been queued"));
    expect(finding?.severity).toBe("blocking");
    expect(finding?.detail).toContain("Account Name");
  });

  it("says so plainly when a campaign has no leads at all", async () => {
    const campaign = await makeCampaign();

    const diagnosis = await diagnoseCampaign(deps, campaign.id, now);

    expect(diagnosis.findings.some((f) => f.title === "This campaign has no leads")).toBe(true);
  });

  it("gives a clean bill of health when the account is ready and nothing is outstanding", async () => {
    const campaign = await makeCampaign();

    // No enrollments due, account connected and under its limits.
    const diagnosis = await diagnoseCampaign(deps, campaign.id, now);

    expect(diagnosis.findings.some((f) => f.title.includes("ready to send"))).toBe(true);
  });
});
