import type { CampaignId, ContactId } from "../../core/shared-kernel/ids.js";
import type { EventRepository } from "../../ports/event-repository.port.js";

/** Campaign Conversion (Section 20.2): a user-defined goal event ("meeting booked," "marked
 * Won"), applied manually today -- there is no CRM/calendar integration to trigger this
 * automatically yet (Section 25). contactId is carried in metadata since the events table has no
 * contactId column of its own (Section 5.9); campaignId is what conversion-rate rollups key on. */
export async function recordConversion(
  eventRepository: EventRepository,
  campaignId: CampaignId,
  contactId: ContactId,
  now: Date = new Date()
): Promise<void> {
  await eventRepository.record({
    eventType: "conversion",
    campaignId,
    occurredAt: now,
    metadata: { contactId }
  });
}
