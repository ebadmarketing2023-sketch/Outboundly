import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { accounts, drafts } from "../../src/adapters/persistence/schema.js";
import { eq } from "drizzle-orm";

describe("SQLite schema + migrations (Section 5, Section 24.6)", () => {
  let db: OutboundlyDb;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "outboundly-db-test-"));
    db = openDatabase(join(dir, "test.sqlite"));
  });

  afterEach(() => {
    // better-sqlite3 handles closes on process exit; nothing further needed for a temp file DB.
  });

  it("applies migrations and enforces foreign keys", () => {
    const accountId = randomUUID();
    const now = new Date();

    db.insert(accounts)
      .values({
        id: accountId,
        provider: "google",
        emailAddress: "me@outboundly.app",
        status: "connected",
        connectedAt: now,
        createdAt: now,
        updatedAt: now
      })
      .run();

    expect(() =>
      db
        .insert(drafts)
        .values({
          id: randomUUID(),
          accountId: "does-not-exist",
          documentModelJson: "{}",
          toAddresses: ["them@example.com"],
          lastSavedAt: now
        })
        .run()
    ).toThrow();

    db.insert(drafts)
      .values({
        id: "draft-1",
        accountId,
        documentModelJson: "{}",
        toAddresses: ["them@example.com"],
        lastSavedAt: now
      })
      .run();

    const found = db.select().from(drafts).where(eq(drafts.id, "draft-1")).get();
    expect(found?.accountId).toBe(accountId);
    expect(found?.toAddresses).toEqual(["them@example.com"]);
  });
});
