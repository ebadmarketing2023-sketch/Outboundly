import { and, eq, gte, inArray } from "drizzle-orm";
import type { OutboundlyDb } from "../../adapters/persistence/db.js";
import { accounts, messages, sendQueue } from "../../adapters/persistence/schema.js";
import { sentByAccount } from "../../adapters/persistence/sent-by-account.js";
import { isWithinBusinessHours, nextWindowOpening } from "../../core/scheduling/business-hours-window.js";
import { asAccountId, type CampaignId } from "../../core/shared-kernel/ids.js";
import type { AccountHealthRepository } from "../../ports/account-health-repository.port.js";
import type { BusinessHoursProfileRepository } from "../../ports/business-hours-profile-repository.port.js";
import type { CampaignRepository } from "../../ports/campaign-repository.port.js";
import type { EnrollmentRepository } from "../../ports/enrollment-repository.port.js";

/**
 * "Why isn't this campaign sending?" answered from the real state of the database.
 *
 * Every gate between an enrolled lead and a delivered email defers quietly: the Rate Limiter's
 * per-account caps and randomized pacing, a paused campaign, the business-hours window, an account
 * the Provider Selector no longer considers eligible, a token with no value. Each one releases the
 * queue row back to pending and returns -- correct, recoverable, and completely invisible. A
 * campaign can therefore sit "Running" for days with a full queue and nothing to show for it, and
 * the only way to find out which gate is holding it has been to read the source.
 *
 * This reports what is actually true right now, in the order the send path checks it, so the answer
 * is one click away instead of a debugging session.
 */

export type DiagnosisSeverity = "blocking" | "waiting" | "ok";

export interface CampaignDiagnosisFinding {
  severity: DiagnosisSeverity;
  title: string;
  detail: string;
  /** What the user can do about it, when there is something. */
  action?: string;
}

export interface CampaignDiagnosis {
  campaignId: string;
  campaignName: string;
  /** One-line answer to "is anything going to go out?". */
  summary: string;
  findings: CampaignDiagnosisFinding[];
}

export interface DiagnoseCampaignDeps {
  db: OutboundlyDb;
  campaignRepository: CampaignRepository;
  enrollmentRepository: EnrollmentRepository;
  businessHoursProfileRepository: BusinessHoursProfileRepository;
  accountHealthRepository: AccountHealthRepository;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function formatWhen(date: Date, now: Date): string {
  const minutes = Math.round((date.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} hour${hours === 1 ? "" : "s"} (${date.toLocaleString()})`;
  return date.toLocaleString();
}

function countSentSince(db: OutboundlyDb, accountId: string, since: Date): number {
  return db
    .select()
    .from(messages)
    .where(
      and(
        sentByAccount(accountId),
        eq(messages.direction, "outbound"),
        eq(messages.status, "sent"),
        gte(messages.sentAt, since)
      )
    )
    .all().length;
}

export async function diagnoseCampaign(deps: DiagnoseCampaignDeps, campaignId: CampaignId, now: Date): Promise<CampaignDiagnosis> {
  const campaign = await deps.campaignRepository.findById(campaignId);
  if (!campaign) throw new Error("Campaign not found");

  const findings: CampaignDiagnosisFinding[] = [];

  // 1. The campaign's own status -- the send worker holds every queued row while it isn't running.
  if (campaign.status !== "running") {
    findings.push({
      severity: "blocking",
      title: `Campaign is ${campaign.status}, not running`,
      detail: "Queued emails are held until the campaign is running again. Nothing is lost while it waits.",
      action: "Press Resume on this campaign."
    });
  }

  // 2. Business hours, checked exactly the way the send worker checks them at dispatch.
  const profile = await deps.businessHoursProfileRepository.findById(campaign.businessHoursProfileId);
  if (!profile) {
    findings.push({
      severity: "blocking",
      title: "This campaign's sending schedule is missing",
      detail: "The business-hours profile it was created with no longer exists.",
      action: "Recreate the campaign, or pick a schedule for it."
    });
  } else if (!isWithinBusinessHours(now, profile)) {
    const opening = nextWindowOpening(now, profile);
    findings.push({
      severity: "waiting",
      title: "Outside this campaign's sending hours",
      detail: `It's currently outside the ${profile.timezone} schedule you set, so queued emails are held until the window reopens ${formatWhen(opening, now)}.`,
      action: "Widen the days/hours on the campaign if you want it sending now."
    });
  }

  // 3. Every account in the rotation pool, against the same gates the Provider Selector applies.
  let anyAccountReady = false;
  for (const accountId of campaign.sendingAccountIds) {
    const account = deps.db.select().from(accounts).where(eq(accounts.id, accountId)).get();
    if (!account) {
      findings.push({
        severity: "blocking",
        title: "A sending account for this campaign no longer exists",
        detail: `Account ${accountId} was removed. A campaign's sending accounts can't be changed after it's created.`,
        action: "Recreate the campaign with a connected account."
      });
      continue;
    }

    if (account.status !== "connected") {
      findings.push({
        severity: "blocking",
        title: `${account.emailAddress} is ${account.status}, not connected`,
        detail:
          "The send worker will not dispatch from an account that isn't connected, and retries it every few minutes indefinitely — which looks exactly like nothing happening.",
        action: "Reconnect this account on the Accounts screen."
      });
      continue;
    }

    const health = await deps.accountHealthRepository.getLatest(asAccountId(accountId));
    if (health?.result.riskLevel === "critical") {
      findings.push({
        severity: "blocking",
        title: `${account.emailAddress} is flagged critical by Account Health`,
        detail: "The Provider Selector skips a critical account, so this campaign can't dispatch from it.",
        action: "Open Account Health for this account and clear what it reports."
      });
      continue;
    }

    const sentLastDay = countSentSince(deps.db, accountId, new Date(now.getTime() - DAY_MS));
    const sentLastHour = countSentSince(deps.db, accountId, new Date(now.getTime() - HOUR_MS));
    const daily = account.dailySendLimit ?? undefined;
    const hourly = account.hourlySendLimit ?? undefined;

    if (daily !== undefined && sentLastDay >= daily) {
      findings.push({
        severity: "waiting",
        title: `${account.emailAddress} has hit its daily limit (${sentLastDay}/${daily})`,
        detail: "Sending resumes as the rolling 24-hour window moves on. This is the limit doing its job, not a fault.",
        action: "Raise the daily limit on the Accounts screen if you want more throughput."
      });
      continue;
    }

    if (hourly !== undefined && sentLastHour >= hourly) {
      findings.push({
        severity: "waiting",
        title: `${account.emailAddress} has hit its hourly limit (${sentLastHour}/${hourly})`,
        detail: "Sending resumes within the hour as the rolling window moves on.",
        action: "Raise the hourly limit on the Accounts screen if you want more throughput."
      });
      continue;
    }

    if (account.nextAllowedSendAt && account.nextAllowedSendAt.getTime() > now.getTime()) {
      findings.push({
        severity: "waiting",
        title: `${account.emailAddress} is pacing between sends`,
        detail: `A randomized ${account.minSendDelaySeconds ?? "?"}-${account.maxSendDelaySeconds ?? "?"}s gap is enforced after every send so they don't go out back to back. Next send allowed ${formatWhen(account.nextAllowedSendAt, now)}.`
      });
      anyAccountReady = true; // pacing clears by itself in minutes
      continue;
    }

    anyAccountReady = true;
    findings.push({
      severity: "ok",
      title: `${account.emailAddress} is ready to send`,
      detail: `${sentLastHour}${hourly === undefined ? "" : `/${hourly}`} sent in the last hour, ${sentLastDay}${daily === undefined ? "" : `/${daily}`} in the last 24 hours.`
    });
  }

  // 4. The queue itself: what is actually waiting, and when the earliest of it comes due.
  const enrollments = await deps.enrollmentRepository.listByCampaign(campaignId);
  const enrollmentIds = enrollments.map((e) => e.id);
  const queueRows =
    enrollmentIds.length === 0
      ? []
      : deps.db
          .select({ status: sendQueue.status, earliestSendAt: sendQueue.earliestSendAt, attemptCount: sendQueue.attemptCount, lastError: sendQueue.lastError })
          .from(sendQueue)
          .innerJoin(messages, eq(sendQueue.messageId, messages.id))
          .where(inArray(messages.campaignEnrollmentId, enrollmentIds))
          .all();

  const pending = queueRows.filter((r) => r.status === "pending");
  const failed = queueRows.filter((r) => r.status === "failed");
  const dueNow = pending.filter((r) => r.earliestSendAt.getTime() <= now.getTime());
  const nextDue = pending
    .map((r) => r.earliestSendAt)
    .sort((a, b) => a.getTime() - b.getTime())
    .find((d) => d.getTime() > now.getTime());

  if (pending.length > 0 && dueNow.length === 0 && nextDue) {
    findings.push({
      severity: "waiting",
      title: `${pending.length} email(s) queued, none due yet`,
      detail: `The earliest is due ${formatWhen(nextDue, now)}.`
    });
  } else if (dueNow.length > 0) {
    findings.push({
      severity: anyAccountReady ? "ok" : "blocking",
      title: `${dueNow.length} email(s) are due to go out now`,
      detail: anyAccountReady
        ? "These should dispatch on the next send-worker tick, within about a minute."
        : "They are due, but no account in this campaign's pool can send right now — see above."
    });
  }

  if (failed.length > 0) {
    const lastError = failed.map((r) => r.lastError).filter(Boolean).pop();
    findings.push({
      severity: "blocking",
      title: `${failed.length} email(s) failed permanently`,
      detail: lastError ? `Most recent error: ${lastError}` : "No error text was recorded.",
      action: "Check the error log on the Notifications screen for the full history."
    });
  }

  const activeEnrollments = enrollments.filter((e) => e.status === "active");
  const activeDueWithoutQueueRow = activeEnrollments.filter((e) => e.nextSendAt && e.nextSendAt.getTime() <= now.getTime()).length;
  if (activeDueWithoutQueueRow > 0 && pending.length === 0) {
    findings.push({
      severity: "blocking",
      title: `${activeDueWithoutQueueRow} lead(s) are due but nothing has been queued for them`,
      detail:
        "The scheduler couldn't build their email. The usual cause is a {{token}} with no value for those leads — a token no lead can supply (a signature's {{Account Name}}, a typo, a column that never made it into the CSV) blocks every one of them.",
      action: "Check Notifications for the token it named, then give it a fallback like {{first_name|there}}."
    });
  }

  if (enrollments.length === 0) {
    findings.push({
      severity: "blocking",
      title: "This campaign has no leads",
      detail: "Nothing is enrolled, so there is nothing to send.",
      action: "Add leads to the campaign."
    });
  }

  const blocking = findings.filter((f) => f.severity === "blocking");
  const waiting = findings.filter((f) => f.severity === "waiting");
  const summary =
    blocking.length > 0
      ? `Not sending: ${blocking[0]!.title.toLowerCase()}.`
      : waiting.length > 0
        ? `Waiting: ${waiting[0]!.title.toLowerCase()}.`
        : "Everything checks out — emails should be going out on schedule.";

  return { campaignId, campaignName: campaign.name, summary, findings };
}
