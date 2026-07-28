import { asEnrollmentId } from "../../core/shared-kernel/ids.js";
import type { ConversationRepository, ReplyClassification } from "../../ports/conversation-repository.port.js";
import type { EnrollmentRepository } from "../../ports/enrollment-repository.port.js";
import type { EventRepository } from "../../ports/event-repository.port.js";

export interface LabelReplyDeps {
  conversationRepository: ConversationRepository;
  enrollmentRepository: EnrollmentRepository;
  eventRepository: EventRepository;
}

/**
 * User-applied reply labeling (Section 20.2): there is no automatic classifier, so "interested"
 * vs. "not interested"/"out of office" is always a manual judgment call on one inbound message.
 * Labeling "interested" additionally records a 'positive_reply' event -- attributed to whichever
 * campaign this thread correlates to, via the same thread-correlation lookup already used for
 * reply/bounce attribution (Section 14.3) -- since Positive Reply Rate (Section 20.2) is computed
 * from that event, not from the label column directly. A message that doesn't thread back to a
 * campaign-originated send (e.g. a reply on a manually composed email) is labeled but doesn't
 * produce an event: there's no campaign to attribute it to.
 */
export async function labelReply(
  deps: LabelReplyDeps,
  messageId: string,
  classification: ReplyClassification,
  now: Date = new Date()
): Promise<void> {
  await deps.conversationRepository.setMessageReplyClassification(messageId, classification);
  if (classification !== "interested") return;

  const message = await deps.conversationRepository.findMessageById(messageId);
  if (!message?.threadId) return;
  const campaignEnrollmentId = await deps.conversationRepository.findCampaignEnrollmentIdForThread(message.threadId);
  if (!campaignEnrollmentId) return;
  const enrollment = await deps.enrollmentRepository.findById(asEnrollmentId(campaignEnrollmentId));
  if (!enrollment) return;

  await deps.eventRepository.record({ eventType: "positive_reply", campaignId: enrollment.campaignId, occurredAt: now });
}
