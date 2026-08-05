import { describe, expect, it } from "vitest";
import { importContactsCsv } from "../../src/application/leads/import-contacts-csv.js";
import { exportContactsCsv } from "../../src/application/leads/export-contacts-csv.js";
import { CSV_SAFETY_LIMITS, CsvTooLargeError } from "../../src/core/shared-kernel/csv-safety.js";
import type { Contact, ContactRepository, NewContactInput } from "../../src/ports/contact-repository.port.js";
import type { LeadImportBatch, LeadImportBatchRepository, NewLeadImportBatchInput } from "../../src/ports/lead-import-batch-repository.port.js";
import { asContactId, asLeadImportBatchId, generateId } from "../../src/core/shared-kernel/ids.js";

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

class InMemoryLeadImportBatchRepository implements LeadImportBatchRepository {
  private readonly byId = new Map<string, LeadImportBatch>();

  async create(input: NewLeadImportBatchInput): Promise<LeadImportBatch> {
    const batch: LeadImportBatch = { id: asLeadImportBatchId(generateId()), filename: input.filename, importedAt: input.importedAt };
    this.byId.set(batch.id, batch);
    return batch;
  }
  async list(): Promise<LeadImportBatch[]> {
    return [...this.byId.values()];
  }
  async findById(id: string): Promise<LeadImportBatch | undefined> {
    return this.byId.get(id);
  }
}

describe("importContactsCsv (Section 5.5)", () => {
  it("imports known columns and folds unrecognized columns into customFields", async () => {
    const repo = new InMemoryContactRepository();
    const csv = "Email,First Name,Last Name,Company,Favorite Color\nme@example.com,Jane,Doe,Acme,Blue\n";

    const result = await importContactsCsv(csv, repo, new InMemoryLeadImportBatchRepository(), "test.csv");
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
    await importContactsCsv(csv, repo, new InMemoryLeadImportBatchRepository(), "test.csv");
    const contact = await repo.findByEmail("me@example.com");
    expect(contact?.company).toBe("Acme, Inc.");
  });

  it("skips rows with a missing or invalid email instead of aborting the whole import (Section 21.3)", async () => {
    const repo = new InMemoryContactRepository();
    const csv = "email,first_name\nnot-an-email,Bad\n,NoEmail\nreal@example.com,Good\n";

    const result = await importContactsCsv(csv, repo, new InMemoryLeadImportBatchRepository(), "test.csv");
    expect(result.imported).toBe(1);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0]).toMatchObject({ row: 2 });
    expect(result.skipped[1]).toMatchObject({ row: 3 });
    expect(await repo.findByEmail("real@example.com")).toBeDefined();
  });

  it("upserts by email rather than creating a duplicate on re-import", async () => {
    const repo = new InMemoryContactRepository();
    const batchRepo = new InMemoryLeadImportBatchRepository();
    await importContactsCsv("email,first_name\nme@example.com,Jane\n", repo, batchRepo, "test.csv");
    await importContactsCsv("email,first_name\nme@example.com,Janet\n", repo, batchRepo, "test.csv");

    const all = await repo.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.firstName).toBe("Janet");
  });

  it("stores a value beginning with a formula character verbatim, because the lead reads it in an email", async () => {
    // Import used to escape this to "'+Post Inc" before storing, so personalization put
    // "Saw you're at '+Post Inc." in the actual email. The spreadsheet guard belongs on export
    // (asserted below), where a spreadsheet app is the thing being protected.
    const repo = new InMemoryContactRepository();
    const csv = "email,company,title\nme@example.com,+Post Inc,-Head of Growth\n";

    await importContactsCsv(csv, repo, new InMemoryLeadImportBatchRepository(), "test.csv");
    const contact = await repo.findByEmail("me@example.com");
    expect(contact?.company).toBe("+Post Inc");
    expect(contact?.title).toBe("-Head of Growth");
  });

  it("stores a custom field verbatim too, including a genuine formula payload", async () => {
    const repo = new InMemoryContactRepository();
    const csv = 'email,notes\nme@example.com,"=HYPERLINK(""http://evil.example"",""click"")"\n';

    await importContactsCsv(csv, repo, new InMemoryLeadImportBatchRepository(), "test.csv");
    const contact = await repo.findByEmail("me@example.com");
    // Stored as written: nothing evaluates a string in this app, and export re-escapes it before
    // it can reach anything that would.
    expect(contact?.customFields?.notes).toBe('=HYPERLINK("http://evil.example","click")');
  });

  it("strips the escaping apostrophe a CSV written by this app carries, so a re-import doesn't accumulate one", async () => {
    const repo = new InMemoryContactRepository();
    const csv = "email,company\nme@example.com,'+Post Inc\n";

    await importContactsCsv(csv, repo, new InMemoryLeadImportBatchRepository(), "test.csv");
    expect((await repo.findByEmail("me@example.com"))?.company).toBe("+Post Inc");
  });

  it("leaves a name that genuinely starts with an apostrophe alone", async () => {
    const repo = new InMemoryContactRepository();
    const csv = "email,company\nme@example.com,'Tis Season Ltd\n";

    await importContactsCsv(csv, repo, new InMemoryLeadImportBatchRepository(), "test.csv");
    expect((await repo.findByEmail("me@example.com"))?.company).toBe("'Tis Season Ltd");
  });

  it("skips a row whose field exceeds the maximum allowed length instead of storing it truncated or aborting the import", async () => {
    const repo = new InMemoryContactRepository();
    const tooLong = "x".repeat(CSV_SAFETY_LIMITS.maxFieldLength + 1);
    const csv = `email,company\nme@example.com,${tooLong}\ngood@example.com,Acme\n`;

    const result = await importContactsCsv(csv, repo, new InMemoryLeadImportBatchRepository(), "test.csv");
    expect(result.imported).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toMatch(/exceeds the maximum allowed length/);
    expect(await repo.findByEmail("good@example.com")).toBeDefined();
    expect(await repo.findByEmail("me@example.com")).toBeUndefined();
  });

  it("rejects a CSV whose raw text exceeds the maximum allowed size before attempting to parse it", async () => {
    const repo = new InMemoryContactRepository();
    const huge = "x".repeat(CSV_SAFETY_LIMITS.maxTextLength + 1);

    await expect(importContactsCsv(huge, repo, new InMemoryLeadImportBatchRepository(), "test.csv")).rejects.toThrow(CsvTooLargeError);
  });

  it("rejects a CSV with more rows than the maximum allowed", async () => {
    const repo = new InMemoryContactRepository();
    const rows = Array.from({ length: CSV_SAFETY_LIMITS.maxRows + 1 }, (_, i) => `person${i}@example.com`).join("\n");
    const csv = `email\n${rows}\n`;

    await expect(importContactsCsv(csv, repo, new InMemoryLeadImportBatchRepository(), "test.csv")).rejects.toThrow(CsvTooLargeError);
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
    const result = await importContactsCsv(csv, reimportRepo, new InMemoryLeadImportBatchRepository(), "test.csv");
    expect(result.imported).toBe(1);
    const reimported = await reimportRepo.findByEmail("me@example.com");
    expect(reimported?.firstName).toBe("Jane");
    expect(reimported?.company).toBe("Acme, Inc.");
    expect(reimported?.customFields).toEqual({ "Favorite Color": "Blue" });
  });

  it("neutralizes a formula-injection payload on export even for a contact never created via CSV import (Section 23)", async () => {
    const repo = new InMemoryContactRepository();
    // Simulates a contact created through some other path (e.g. manual entry) whose field was
    // never neutralized on the way in -- exportContactsCsv must neutralize it on the way out.
    await repo.upsertByEmail({
      email: "me@example.com",
      company: "=cmd|'/c calc'!A1",
      source: "manual"
    });

    const csv = await exportContactsCsv(repo);
    expect(csv).toContain("'=cmd|'/c calc'!A1");
  });

  it("round-trips a formula-character value unchanged: escaped in the file, intact once re-imported", async () => {
    // The property that matters end to end -- the file on disk is safe to open in Excel, and the
    // value that comes back (and goes into an email) is exactly what the user started with.
    const repo = new InMemoryContactRepository();
    await repo.upsertByEmail({ email: "me@example.com", company: "+Post Inc", title: "@Large", source: "manual" });

    const csv = await exportContactsCsv(repo);
    expect(csv).toContain("'+Post Inc");
    expect(csv).toContain("'@Large");

    const reimportRepo = new InMemoryContactRepository();
    await importContactsCsv(csv, reimportRepo, new InMemoryLeadImportBatchRepository(), "test.csv");
    const reimported = await reimportRepo.findByEmail("me@example.com");
    expect(reimported?.company).toBe("+Post Inc");
    expect(reimported?.title).toBe("@Large");
  });
});
