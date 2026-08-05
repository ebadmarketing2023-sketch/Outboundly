import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/adapters/persistence/db.js";
import { contacts } from "../../src/adapters/persistence/schema.js";
import { generateId } from "../../src/core/shared-kernel/ids.js";

/**
 * Migration 0017 repairs leads that CSV import escaped before storing them — the value that
 * personalization puts straight into the email a lead reads. Runs the real shipped .sql file, so
 * this asserts the migration itself rather than a reimplementation of what it should do.
 */
describe("0017 unescape contact fields", () => {
  function freshDb() {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-unescape-migration-"));
    return openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
  }

  function applyMigration(db: ReturnType<typeof freshDb>): void {
    const file = join(process.cwd(), "src/adapters/persistence/migrations/0017_unescape_contact_fields.sql");
    const statements = readFileSync(file, "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) db.run(sql.raw(statement));
  }

  function insertContact(db: ReturnType<typeof freshDb>, values: Partial<typeof contacts.$inferInsert>): string {
    const id = generateId();
    const now = new Date();
    db.insert(contacts)
      .values({ id, email: `${id}@example.com`, source: "csv_import", createdAt: now, updatedAt: now, ...values })
      .run();
    return id;
  }

  function read(db: ReturnType<typeof freshDb>, id: string) {
    return db.select().from(contacts).where(eq(contacts.id, id)).get();
  }

  it("unescapes every scalar field a CSV import could have mangled", () => {
    const db = freshDb();
    const id = insertContact(db, {
      firstName: "'=Jane",
      lastName: "'+Doe",
      company: "'+Post Inc",
      title: "'-Head of Growth",
      timezone: "'@UTC"
    });

    applyMigration(db);

    const after = read(db, id);
    expect(after?.firstName).toBe("=Jane");
    expect(after?.lastName).toBe("+Doe");
    expect(after?.company).toBe("+Post Inc");
    expect(after?.title).toBe("-Head of Growth");
    expect(after?.timezone).toBe("@UTC");
  });

  it("leaves a value that genuinely begins with an apostrophe alone", () => {
    const db = freshDb();
    const id = insertContact(db, { company: "'Tis Season Ltd", lastName: "O'Brien" });

    applyMigration(db);

    const after = read(db, id);
    expect(after?.company).toBe("'Tis Season Ltd");
    expect(after?.lastName).toBe("O'Brien");
  });

  it("unescapes inside the custom_fields JSON without disturbing anything else in it", () => {
    const db = freshDb();
    const id = insertContact(db, {
      customFields: { "Website URL": "'=https://acme.test", Notes: "Met at '=conf", Plain: "-not escaped by us" }
    });

    applyMigration(db);

    const after = read(db, id);
    // Only the value position (immediately after `:"`) is rewritten -- an apostrophe-formula
    // sequence in the middle of some other value is left exactly as it was.
    expect(after?.customFields).toEqual({
      "Website URL": "=https://acme.test",
      Notes: "Met at '=conf",
      Plain: "-not escaped by us"
    });
  });

  it("is idempotent, so re-running it cannot eat a second character", () => {
    const db = freshDb();
    const id = insertContact(db, { company: "'+Post Inc", customFields: { X: "'=1" } });

    applyMigration(db);
    applyMigration(db);

    const after = read(db, id);
    expect(after?.company).toBe("+Post Inc");
    expect(after?.customFields).toEqual({ X: "=1" });
  });

  it("leaves untouched rows exactly as they were, including nulls", () => {
    const db = freshDb();
    const id = insertContact(db, { firstName: "Ada", company: "Acme, Inc." });

    applyMigration(db);

    const after = read(db, id);
    expect(after?.firstName).toBe("Ada");
    expect(after?.company).toBe("Acme, Inc.");
    expect(after?.title).toBeNull();
    expect(after?.customFields).toBeNull();
  });
});
