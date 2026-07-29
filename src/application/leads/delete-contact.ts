import type { ContactId } from "../../core/shared-kernel/ids.js";
import type { ContactRepository } from "../../ports/contact-repository.port.js";
import { stopEnrollmentsForContact, type StopEnrollmentsDeps } from "../campaigns/stop-enrollments.js";

export interface DeleteContactDeps extends StopEnrollmentsDeps {
  contactRepository: ContactRepository;
}

/** Deleting a lead (Critical Improvement #3) must not leave a campaign's dashboard counting an
 * enrollment for a contact that no longer exists: every active enrollment for this contact is
 * stopped first (the same manual-stop path Unsubscribe uses, which also runs maybeCompleteCampaign
 * so a campaign auto-completes if this was its last active lead), then the contact itself is
 * soft-deleted (ContactRepository.delete — see that port for why it isn't a hard delete). */
export async function deleteContact(deps: DeleteContactDeps, contactId: ContactId): Promise<void> {
  await stopEnrollmentsForContact(deps, contactId, "stopped_manual");
  await deps.contactRepository.delete(contactId);
}
