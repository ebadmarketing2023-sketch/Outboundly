import { stringify } from "csv-stringify/sync";
import { neutralizeCsvCell } from "../../core/shared-kernel/csv-safety.js";
import type { ContactRepository } from "../../ports/contact-repository.port.js";

const CORE_COLUMNS = ["email", "first_name", "last_name", "company", "title", "timezone", "source"] as const;

/** CSV export for Leads/Contacts (Section 5.5) — the inverse of importContactsCsv. Every distinct
 * custom_fields key across all contacts becomes its own trailing column, so a re-import of the
 * exported file round-trips losslessly. Cells are re-neutralized here too (Section 23: "neutralized
 * on import AND re-export") as defense in depth -- importContactsCsv already neutralizes on the way
 * in, but a contact could also have been created directly (not via CSV import), so its fields
 * were never neutralized until now. */
export async function exportContactsCsv(contactRepository: ContactRepository): Promise<string> {
  const contacts = await contactRepository.list();

  const customFieldKeys = new Set<string>();
  for (const contact of contacts) {
    for (const key of Object.keys(contact.customFields ?? {})) customFieldKeys.add(key);
  }
  const columns = [...CORE_COLUMNS, ...customFieldKeys];

  const safe = (value: string): string => neutralizeCsvCell(value);

  const rows = contacts.map((contact) => ({
    email: safe(contact.email),
    first_name: safe(contact.firstName ?? ""),
    last_name: safe(contact.lastName ?? ""),
    company: safe(contact.company ?? ""),
    title: safe(contact.title ?? ""),
    timezone: safe(contact.timezone ?? ""),
    source: safe(contact.source),
    ...Object.fromEntries([...customFieldKeys].map((key) => [key, safe(contact.customFields?.[key] ?? "")]))
  }));

  return stringify(rows, { header: true, columns });
}
