import type { Contact } from "../../ports/contact-repository.port.js";

/**
 * Maps a Contact's known fields (plus any CSV-imported custom fields) to the personalization
 * variable names a Template's document uses (Section 9.2 stage 3) — e.g. {{first_name}} resolves
 * against contact.firstName. Custom fields are exposed under their own original header name, same
 * as they were captured on CSV import (import-contacts-csv.ts), not renamed to a fixed schema.
 */
export function contactToPersonalizationValues(contact: Contact): Record<string, string> {
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
