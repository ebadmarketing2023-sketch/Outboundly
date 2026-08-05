import type { Contact } from "../../ports/contact-repository.port.js";

/** Just the parts of a Contact that personalization can read. Split out from Contact itself so the
 * campaign wizard can run this same mapping over CSV rows that have not been imported yet (and so
 * have no id/timestamps), guaranteeing its warnings describe what sending would really do. */
export interface PersonalizableContactFields {
  email: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  timezone?: string;
  customFields?: Record<string, string>;
}

/**
 * Maps a Contact's known fields (plus any CSV-imported custom fields) to the personalization
 * variable names a Template's document uses (Section 9.2 stage 3) — e.g. {{first_name}} resolves
 * against contact.firstName. Custom fields are exposed under their own original header name, same
 * as they were captured on CSV import (import-contacts-csv.ts), not renamed to a fixed schema.
 */
export function contactFieldsToPersonalizationValues(contact: PersonalizableContactFields): Record<string, string> {
  const values: Record<string, string> = { email: contact.email };
  if (contact.firstName) values.first_name = contact.firstName;
  if (contact.lastName) values.last_name = contact.lastName;
  if (contact.company) values.company = contact.company;
  if (contact.title) values.title = contact.title;
  if (contact.timezone) values.timezone = contact.timezone;
  if (contact.customFields) {
    for (const [key, value] of Object.entries(contact.customFields)) {
      values[key] = value;
    }
  }
  return values;
}

export function contactToPersonalizationValues(contact: Contact): Record<string, string> {
  return contactFieldsToPersonalizationValues(contact);
}

/**
 * Tokens that describe the *sending* account rather than the lead — for signing off a message with
 * the name on the mailbox it goes out from, which is the one thing a signature always needs and no
 * CSV can ever supply. Both casings of each name work, so {{Account Name}} and {{account_name}}
 * are the same token.
 *
 * These are reserved: they win over a lead field of the same name, so a CSV that happens to carry
 * an "Account Name" column can't quietly rewrite the sender's own signature.
 *
 * They also always resolve, which matters more than it sounds. A token no lead has a value for is
 * a hard stop for *every* lead, so before these existed, putting {{Account Name}} in a signature
 * silently stalled the entire campaign -- nothing sent, nothing reported.
 */
export const ACCOUNT_TOKEN_NAMES = ["Account Name", "account_name", "Account Email", "account_email"] as const;

export function accountPersonalizationValues(account: { emailAddress: string; displayName?: string }): Record<string, string> {
  // An account connected without a profile name still has to produce something, or the token it
  // was meant to fix becomes the same hard stop all over again. The mailbox's local part is the
  // closest thing to a name we actually hold.
  const name = account.displayName?.trim() || account.emailAddress.split("@")[0]!;
  return {
    "Account Name": name,
    account_name: name,
    "Account Email": account.emailAddress,
    account_email: account.emailAddress
  };
}

/** Lead values with the sending account's reserved tokens layered on top. */
export function personalizationValuesFor(
  contact: Contact | undefined,
  account: { emailAddress: string; displayName?: string }
): Record<string, string> {
  return { ...(contact ? contactToPersonalizationValues(contact) : {}), ...accountPersonalizationValues(account) };
}
