import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { SqliteBusinessHoursProfileRepository } from "../../src/adapters/persistence/repositories/business-hours-profile-repository.js";

describe("SqliteBusinessHoursProfileRepository (Section 5.7)", () => {
  let db: OutboundlyDb;
  let repo: SqliteBusinessHoursProfileRepository;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-bhp-repo-test-"));
    db = openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
    repo = new SqliteBusinessHoursProfileRepository(db);
  });

  it("creates a profile and finds it by id", async () => {
    const created = await repo.create({
      name: "US business hours",
      timezone: "America/New_York",
      windows: { monday: [{ start: "09:00", end: "17:00" }] }
    });
    const found = await repo.findById(created.id);
    expect(found).toEqual(created);
  });

  it("returns undefined for an unknown id", async () => {
    expect(await repo.findById("nonexistent")).toBeUndefined();
  });

  it("lists every created profile", async () => {
    await repo.create({ name: "A", timezone: "UTC", windows: { monday: [{ start: "09:00", end: "17:00" }] } });
    await repo.create({ name: "B", timezone: "UTC", windows: { tuesday: [{ start: "10:00", end: "18:00" }] } });

    const all = await repo.list();
    expect(all.map((p) => p.name).sort()).toEqual(["A", "B"]);
  });

  it("returns an empty list when nothing has been created", async () => {
    expect(await repo.list()).toEqual([]);
  });
});
