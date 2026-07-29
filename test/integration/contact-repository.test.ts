import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { SqliteContactRepository } from "../../src/adapters/persistence/repositories/contact-repository.js";
import { SqliteLeadImportBatchRepository } from "../../src/adapters/persistence/repositories/lead-import-batch-repository.js";
import { SqliteSuppressionListRepository } from "../../src/adapters/persistence/repositories/suppression-list-repository.js";

describe("SqliteContactRepository (Section 5.5 persistence)", () => {
  let db: OutboundlyDb;
  let repo: SqliteContactRepository;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-contact-repo-test-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
    repo = new SqliteContactRepository(db);
  });

  it("creates a contact on first upsert and updates the same row on a second upsert by the same email", async () => {
    const created = await repo.upsertByEmail({ email: "me@example.com", firstName: "Jane", source: "manual" });
    const updated = await repo.upsertByEmail({ email: "me@example.com", firstName: "Janet", source: "manual" });

    expect(updated.id).toBe(created.id);
    expect(updated.firstName).toBe("Janet");

    const all = await repo.list();
    expect(all).toHaveLength(1);
  });

  it("round-trips customFields as real JSON through SQLite", async () => {
    await repo.upsertByEmail({
      email: "me@example.com",
      customFields: { "Favorite Color": "Blue", Region: "EMEA" },
      source: "csv_import"
    });

    const found = await repo.findByEmail("me@example.com");
    expect(found?.customFields).toEqual({ "Favorite Color": "Blue", Region: "EMEA" });
  });

  it("soft-deletes a contact by id: excluded from list() but still resolvable by id/email", async () => {
    const created = await repo.upsertByEmail({ email: "me@example.com", source: "manual" });
    await repo.delete(created.id);

    expect(await repo.list()).toHaveLength(0);
    expect((await repo.findByEmail("me@example.com"))?.deletedAt).toBeInstanceOf(Date);
    expect((await repo.findById(created.id))?.deletedAt).toBeInstanceOf(Date);
  });

  it("un-deletes a soft-deleted contact on re-import by the same email", async () => {
    const created = await repo.upsertByEmail({ email: "me@example.com", source: "manual" });
    await repo.delete(created.id);
    expect(await repo.list()).toHaveLength(0);

    const revived = await repo.upsertByEmail({ email: "me@example.com", firstName: "Jane", source: "csv_import" });

    expect(revived.id).toBe(created.id);
    expect(revived.deletedAt).toBeUndefined();
    expect(await repo.list()).toHaveLength(1);
  });

  it("tags a new contact with its import batch id, and re-tags on re-import to the newest batch", async () => {
    const batchRepo = new SqliteLeadImportBatchRepository(db);
    const batchOne = await batchRepo.create({ filename: "one.csv", importedAt: new Date() });
    const batchTwo = await batchRepo.create({ filename: "two.csv", importedAt: new Date() });

    const created = await repo.upsertByEmail({ email: "me@example.com", source: "csv_import", importBatchId: batchOne.id });
    expect(created.importBatchId).toBe(batchOne.id);

    const retagged = await repo.upsertByEmail({ email: "me@example.com", source: "csv_import", importBatchId: batchTwo.id });
    expect(retagged.importBatchId).toBe(batchTwo.id);

    const untouched = await repo.upsertByEmail({ email: "me@example.com", firstName: "Jane", source: "manual" });
    expect(untouched.importBatchId).toBe(batchTwo.id);
  });
});

describe("SqliteSuppressionListRepository (Section 5.5 persistence)", () => {
  let db: OutboundlyDb;
  let repo: SqliteSuppressionListRepository;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-suppression-repo-test-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
    repo = new SqliteSuppressionListRepository(db);
  });

  it("reports an email as not suppressed until it's added", async () => {
    expect(await repo.isSuppressed("me@example.com")).toBe(false);
    await repo.add("me@example.com", "unsubscribed");
    expect(await repo.isSuppressed("me@example.com")).toBe(true);
  });

  it("is case-insensitive", async () => {
    await repo.add("Me@Example.com", "manual");
    expect(await repo.isSuppressed("me@example.com")).toBe(true);
  });

  it("does not add a duplicate entry for an already-suppressed email", async () => {
    await repo.add("me@example.com", "unsubscribed");
    await repo.add("me@example.com", "manual");
    const all = await repo.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.reason).toBe("unsubscribed");
  });
});
