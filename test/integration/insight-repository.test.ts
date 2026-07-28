import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { SqliteInsightRepository } from "../../src/adapters/persistence/repositories/insight-repository.js";

describe("SqliteInsightRepository (Section 5.9, Section 20.3)", () => {
  let db: OutboundlyDb;
  let repo: SqliteInsightRepository;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-insight-repo-test-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
    repo = new SqliteInsightRepository(db);
  });

  it("records an insight and returns it with a generated id", async () => {
    const record = await repo.record({
      scope: "campaign",
      scopeId: "camp-1",
      insightType: "bounce_rate_ceiling",
      severity: "warning",
      message: "Bounce rate is 8%",
      explanation: "Above the safe ceiling.",
      recommendedAction: "Clean the list.",
      generatedAt: new Date("2026-01-05T00:00:00.000Z")
    });
    expect(record.id).toBeTruthy();
    expect(record.severity).toBe("warning");
    expect(record.dismissedAt).toBeUndefined();
  });

  it("finds active insights for one scope, newest first, excluding a different scope", async () => {
    await repo.record({
      scope: "campaign",
      scopeId: "camp-1",
      insightType: "a",
      severity: "info",
      message: "first",
      explanation: "e",
      generatedAt: new Date("2026-01-01T00:00:00.000Z")
    });
    await repo.record({
      scope: "campaign",
      scopeId: "camp-1",
      insightType: "b",
      severity: "info",
      message: "second",
      explanation: "e",
      generatedAt: new Date("2026-01-02T00:00:00.000Z")
    });
    await repo.record({
      scope: "campaign",
      scopeId: "camp-2",
      insightType: "c",
      severity: "info",
      message: "other campaign",
      explanation: "e",
      generatedAt: new Date("2026-01-03T00:00:00.000Z")
    });

    const found = await repo.findActiveForScope("campaign", "camp-1");
    expect(found.map((i) => i.message)).toEqual(["second", "first"]);
  });

  it("excludes dismissed insights from findActiveForScope and findActiveFeed", async () => {
    const recorded = await repo.record({
      scope: "account",
      scopeId: "acct-1",
      insightType: "reply_rate_cliff_anomaly",
      severity: "critical",
      message: "cliff",
      explanation: "e",
      generatedAt: new Date()
    });

    expect(await repo.findActiveForScope("account", "acct-1")).toHaveLength(1);
    await repo.dismiss(recorded.id);
    expect(await repo.findActiveForScope("account", "acct-1")).toEqual([]);

    const feed = await repo.findActiveFeed(10);
    expect(feed.find((i) => i.id === recorded.id)).toBeUndefined();
  });

  it("findActiveFeed spans scopes and respects the limit", async () => {
    await repo.record({
      scope: "campaign",
      scopeId: "camp-1",
      insightType: "x",
      severity: "info",
      message: "m1",
      explanation: "e",
      generatedAt: new Date("2026-01-01T00:00:00.000Z")
    });
    await repo.record({
      scope: "account",
      scopeId: "acct-1",
      insightType: "y",
      severity: "warning",
      message: "m2",
      explanation: "e",
      generatedAt: new Date("2026-01-02T00:00:00.000Z")
    });

    const feed = await repo.findActiveFeed(1);
    expect(feed).toHaveLength(1);
    expect(feed[0]?.message).toBe("m2");
  });
});
