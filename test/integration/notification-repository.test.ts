import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { SqliteNotificationRepository } from "../../src/adapters/persistence/repositories/notification-repository.js";

describe("SqliteNotificationRepository (Section 3 Notifications module)", () => {
  let db: OutboundlyDb;
  let repo: SqliteNotificationRepository;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-notification-repo-test-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
    repo = new SqliteNotificationRepository(db);
  });

  it("records a notification and returns it with a generated id", async () => {
    const record = await repo.record({
      notificationType: "reply_arrived",
      severity: "info",
      message: "A contact replied",
      createdAt: new Date("2026-01-01T00:00:00.000Z")
    });
    expect(record.id).toBeTruthy();
    expect(record.notificationType).toBe("reply_arrived");
    expect(record.readAt).toBeUndefined();
  });

  it("finds unread notifications newest first, respecting the limit", async () => {
    await repo.record({ notificationType: "reply_arrived", severity: "info", message: "first", createdAt: new Date("2026-01-01T00:00:00.000Z") });
    await repo.record({ notificationType: "send_failure", severity: "critical", message: "second", createdAt: new Date("2026-01-02T00:00:00.000Z") });
    await repo.record({ notificationType: "account_health_issue", severity: "warning", message: "third", createdAt: new Date("2026-01-03T00:00:00.000Z") });

    const all = await repo.findUnread(10);
    expect(all.map((n) => n.message)).toEqual(["third", "second", "first"]);

    const limited = await repo.findUnread(2);
    expect(limited.map((n) => n.message)).toEqual(["third", "second"]);
  });

  it("excludes a notification from findUnread once marked read", async () => {
    const record = await repo.record({
      notificationType: "reply_arrived",
      severity: "info",
      message: "will be read",
      createdAt: new Date()
    });

    expect(await repo.findUnread(10)).toHaveLength(1);
    await repo.markRead(record.id);
    expect(await repo.findUnread(10)).toEqual([]);
  });
});
