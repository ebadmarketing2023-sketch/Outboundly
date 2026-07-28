import { describe, expect, it } from "vitest";
import { importContactsCsv } from "../../src/application/leads/import-contacts-csv.js";
import { exportContactsCsv } from "../../src/application/leads/export-contacts-csv.js";
import type { Contact, ContactRepository, NewContactInput } from "../../src/ports/contact-repository.port.js";
import { asContactId, generateId } from "../../src/core/shared-kernel/ids.js";

class InMemoryContactRepository implements ContactRepository {
  private readonly byEmail = new Map<string, Contact>();

  async findByEmail(email: string): Promise<Contact | undefined> {
    return this.byEmail.get(email);
  }
  async findById(id: string): Promise<Contact | undefined> {
    return [...this.byEmail.values()].find((c) => c.id === id);
  }
  async upsertByEmail(input: NewContactInput): Promise<Contact> {
    const existing = this.byEmail.get(input.email);
    const now = new Date();
    const contact: Contact = {
      id: existing?.id ?? asContactId(generateId()),
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      company: input.company,
      title: input.title,
      timezone: input.timezone,
      customFields: input.customFields,
      source: input.source,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.byEmail.set(input.email, contact);
    return contact;
  }
  async list(): Promise<Contact[]> {
    return [...this.byEmail.values()];
  }
  async delete(id: string): Promise<void> {
    for (const [email, contact] of this.byEmail) {
      if (contact.id === id) this.byEmail.delete(email);
    }
  }
}

describe("importContactsCsv (Section 5.5)", () => {
  it("imports known columns and folds unrecognized columns into customFields", async () => {
    const repo = new InMemoryContactRepository();
    const csv = "Email,First Name,Last Name,Company,Favorite Color\nme@example.com,Jane,Doe,Acme,Blue\n";

    const result = await importContactsCsv(csv, repo);
    expect(result.imported).toBe(1);
    expect(result.skipped).toEqual([]);

    const contact = await repo.findByEmail("me@example.com");
    expect(contact?.firstName).toBe("Jane");
    expect(contact?.lastName).toBe("Doe");
    expect(contact?.company).toBe("Acme");
    expect(contact?.customFields).toEqual({ "Favorite Color": "Blue" });
    expect(contact?.source).toBe("csv_import");
  });

  it("handles a real RFC-4180 quoted field with an embedded comma correctly", async () => {
    const repo = new InMemoryContactRepository();
    const csv = 'email,company\nme@example.com,"Acme, Inc."\n';
    await importContactsCsv(csv, repo);
    const contact = await repo.findByEmail("me@example.com");
    expect(contact?.company).toBe("Acme, Inc.");
  });

  it("skips rows with a missing or invalid email instead of aborting the whole import (Section 21.3)", async () => {
    const repo = new InMemoryContactRepository();
    const csv = "email,first_name\nnot-an-email,Bad\n,NoEmail\nreal@example.com,Good\n";

    const result = await importContactsCsv(csv, repo);
    expect(result.imported).toBe(1);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0]).toMatchObject({ row: 2 });
    expect(result.skipped[1]).toMatchObject({ row: 3 });
    expect(await repo.findByEmail("real@example.com")).toBeDefined();
  });

  it("upserts by email rather than creating a duplicate on re-import", async () => {
    const repo = new InMemoryContactRepository();
    await importContactsCsv("email,first_name\nme@example.com,Jane\n", repo);
    await importContactsCsv("email,first_name\nme@example.com,Janet\n", repo);

    const all = await repo.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.firstName).toBe("Janet");
  });
});

describe("exportContactsCsv (Section 5.5)", () => {
  it("round-trips core fields and custom fields through export then re-import", async () => {
    const repo = new InMemoryContactRepository();
    await repo.upsertByEmail({
      email: "me@example.com",
      firstName: "Jane",
      company: "Acme, Inc.",
      customFields: { "Favorite Color": "Blue" },
      source: "manual"
    });

    const csv = await exportContactsCsv(repo);
    expect(csv).toContain("email");
    expect(csv).toContain("Favorite Color");

    const reimportRepo = new InMemoryContactRepository();
    const result = await importContactsCsv(csv, reimportRepo);
    expect(result.imported).toBe(1);
    const reimported = await reimportRepo.findByEmail("me@example.com");
    expect(reimported?.firstName).toBe("Jane");
    expect(reimported?.company).toBe("Acme, Inc.");
    expect(reimported?.customFields).toEqual({ "Favorite Color": "Blue" });
  });
});
