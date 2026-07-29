import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { SqliteSuppressionListRepository } from "../../src/adapters/persistence/repositories/suppression-list-repository.js";

describe("SqliteSuppressionListRepository (Section 5.5 persistence)", () => {
  let db: OutboundlyDb;
  let repo: SqliteSuppressionListRepository;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-suppression-list-repo-test-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
    repo = new SqliteSuppressionListRepository(db);
  });

  it("is suppressed after add, and not suppressed before it", async () => {
    expect(await repo.isSuppressed("me@example.com")).toBe(false);
    await repo.add("me@example.com", "unsubscribed");
    expect(await repo.isSuppressed("me@example.com")).toBe(true);
  });

  it("add is idempotent -- adding the same email twice doesn't create a duplicate entry", async () => {
    await repo.add("me@example.com", "unsubscribed");
    await repo.add("me@example.com", "manual");
    expect(await repo.list()).toHaveLength(1);
  });

  it("normalizes email case for isSuppressed/add/remove", async () => {
    await repo.add("Me@Example.com", "unsubscribed");
    expect(await repo.isSuppressed("me@example.com")).toBe(true);
    await repo.remove("ME@EXAMPLE.COM");
    expect(await repo.isSuppressed("me@example.com")).toBe(false);
  });

  it("remove un-suppresses a previously suppressed email", async () => {
    await repo.add("me@example.com", "unsubscribed");
    expect(await repo.isSuppressed("me@example.com")).toBe(true);

    await repo.remove("me@example.com");
    expect(await repo.isSuppressed("me@example.com")).toBe(false);
    expect(await repo.list()).toEqual([]);
  });

  it("remove is a no-op for an email that was never suppressed", async () => {
    await repo.add("other@example.com", "unsubscribed");
    await expect(repo.remove("never-suppressed@example.com")).resolves.toBeUndefined();
    expect(await repo.list()).toHaveLength(1);
  });

  it("remove only affects the targeted email, leaving other suppressions intact", async () => {
    await repo.add("keep@example.com", "unsubscribed");
    await repo.add("remove-me@example.com", "manual");

    await repo.remove("remove-me@example.com");

    expect(await repo.isSuppressed("keep@example.com")).toBe(true);
    expect(await repo.isSuppressed("remove-me@example.com")).toBe(false);
  });
});
