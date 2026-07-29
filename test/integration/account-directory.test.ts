import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { SqliteAccountDirectory } from "../../src/adapters/persistence/repositories/account-directory.js";
import { accounts } from "../../src/adapters/persistence/schema.js";
import { generateId } from "../../src/core/shared-kernel/ids.js";

describe("SqliteAccountDirectory (Section 13.3 persistence)", () => {
  let db: OutboundlyDb;
  let directory: SqliteAccountDirectory;
  let accountId: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-account-directory-test-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
    directory = new SqliteAccountDirectory(db);
    accountId = generateId();
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
  });

  it("lists an account with its current status", async () => {
    const entries = await directory.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: accountId, provider: "google", emailAddress: "me@outboundly.app", status: "connected" });
  });

  it("updateStatus writes 'disconnected' (the status a real Disconnect action sets)", async () => {
    await directory.updateStatus(accountId, "disconnected");
    const entries = await directory.list();
    expect(entries[0]?.status).toBe("disconnected");
  });

  it("updateStatus writes 'reauth_required' and back to 'connected'", async () => {
    await directory.updateStatus(accountId, "reauth_required");
    expect((await directory.list())[0]?.status).toBe("reauth_required");

    await directory.updateStatus(accountId, "connected");
    expect((await directory.list())[0]?.status).toBe("connected");
  });
});
