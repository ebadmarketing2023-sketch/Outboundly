import { stringify } from "csv-stringify/sync";
import type { ContactRepository } from "../../ports/contact-repository.port.js";

const CORE_COLUMNS = ["email", "first_name", "last_name", "company", "title", "timezone", "source"] as const;

/** CSV export for Leads/Contacts (Section 5.5) — the inverse of importContactsCsv. Every distinct
 * custom_fields key across all contacts becomes its own trailing column, so a re-import of the
 * exported file round-trips losslessly. */
export async function exportContactsCsv(contactRepository: ContactRepository): Promise<string> {
  const contacts = await contactRepository.list();

  const customFieldKeys = new Set<string>();
  for (const contact of contacts) {
    for (const key of Object.keys(contact.customFields ?? {})) customFieldKeys.add(key);
  }
  const columns = [...CORE_COLUMNS, ...customFieldKeys];

  const rows = contacts.map((contact) => ({
    email: contact.email,
    first_name: contact.firstName ?? "",
    last_name: contact.lastName ?? "",
    company: contact.company ?? "",
    title: contact.title ?? "",
    timezone: contact.timezone ?? "",
    source: contact.source,
    ...Object.fromEntries([...customFieldKeys].map((key) => [key, contact.customFields?.[key] ?? ""]))
  }));

  return stringify(rows, { header: true, columns });
}
