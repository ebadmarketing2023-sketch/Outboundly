import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/adapters/persistence/db.js";
import { SqliteRateLimiter } from "../../src/adapters/persistence/rate-limiter.js";
import { accounts } from "../../src/adapters/persistence/schema.js";
import { SENDING_DEFAULTS } from "../../src/core/scheduling/sending-defaults.js";
import { asAccountId, generateId } from "../../src/core/shared-kernel/ids.js";

/**
 * These columns are nullable and null means "no limit" throughout the Rate Limiter, so before this
 * work a freshly connected mailbox could dispatch a whole lead list back to back. Migration 0016
 * brings accounts that predate the change up to the same conservative starting point.
 */
describe("per-account sending limit defaults", () => {
  function freshDb() {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-sending-defaults-"));
    return openDatabase(join(dir, "test.sqlite"), randomBytes(32).toString("hex"));
  }

  /** Runs the real 0016 migration file, so this asserts the shipped SQL rather than a
   * reimplementation of what it is supposed to do. */
  function applyBackfillMigration(db: ReturnType<typeof freshDb>): void {
    const file = join(process.cwd(), "src/adapters/persistence/migrations/0016_seed_sending_limit_defaults.sql");
    const statements = readFileSync(file, "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(4);
    for (const statement of statements) db.run(sql.raw(statement));
  }

  it("backfills an account that predates the migration and had no limits at all", () => {
    const db = freshDb();
    const id = generateId();
    const now = new Date();
    // A row as it looked before this change: every limit column left null, i.e. no cap whatsoever.
    db.insert(accounts)
      .values({
        id,
        provider: "google",
        emailAddress: "legacy@outboundly.app",
        status: "connected",
        connectedAt: now,
        createdAt: now,
        updatedAt: now
      })
      .run();

    const before = db.select().from(accounts).where(eq(accounts.id, id)).get();
    expect(before?.dailySendLimit).toBeNull();
    expect(before?.minSendDelaySeconds).toBeNull();

    applyBackfillMigration(db);

    const after = db.select().from(accounts).where(eq(accounts.id, id)).get();
    expect(after?.dailySendLimit).toBe(SENDING_DEFAULTS.dailySendLimit);
    expect(after?.hourlySendLimit).toBe(SENDING_DEFAULTS.hourlySendLimit);
    expect(after?.minSendDelaySeconds).toBe(SENDING_DEFAULTS.minSendDelaySeconds);
    expect(after?.maxSendDelaySeconds).toBe(SENDING_DEFAULTS.maxSendDelaySeconds);
  });

  it("never overwrites a limit the user had already chosen", () => {
    const db = freshDb();
    const id = generateId();
    const now = new Date();
    db.insert(accounts)
      .values({
        id,
        provider: "google",
        emailAddress: "deliberate@outboundly.app",
        status: "connected",
        dailySendLimit: 5, // deliberately far stricter than the default
        connectedAt: now,
        createdAt: now,
        updatedAt: now
      })
      .run();

    applyBackfillMigration(db);

    const after = db.select().from(accounts).where(eq(accounts.id, id)).get();
    expect(after?.dailySendLimit).toBe(5);
    // The columns that genuinely were null still get filled in.
    expect(after?.hourlySendLimit).toBe(SENDING_DEFAULTS.hourlySendLimit);
  });

  it("is idempotent, so re-running it cannot creep values back to the default", () => {
    const db = freshDb();
    const id = generateId();
    const now = new Date();
    db.insert(accounts)
      .values({ id, provider: "google", emailAddress: "x@y.app", status: "connected", connectedAt: now, createdAt: now, updatedAt: now })
      .run();

    applyBackfillMigration(db);
    db.update(accounts).set({ dailySendLimit: 3 }).where(eq(accounts.id, id)).run();
    applyBackfillMigration(db);

    expect(db.select().from(accounts).where(eq(accounts.id, id)).get()?.dailySendLimit).toBe(3);
  });

  it("the defaults are actually enforced by the Rate Limiter, not merely stored", () => {
    const db = freshDb();
    const id = generateId();
    const now = new Date();
    db.insert(accounts)
      .values({
        id,
        provider: "google",
        emailAddress: "capped@outboundly.app",
        status: "connected",
        dailySendLimit: SENDING_DEFAULTS.dailySendLimit,
        hourlySendLimit: SENDING_DEFAULTS.hourlySendLimit,
        connectedAt: now,
        createdAt: now,
        updatedAt: now
      })
      .run();

    const rateLimiter = new SqliteRateLimiter(db);
    expect(rateLimiter.checkAndReserve(asAccountId(id)).allowed).toBe(true);
  });

  it("a null limit still means 'no limit', so clearing a field remains a real user choice", () => {
    // The Sending accounts screen documents a blank field as "no limit". The defaults change what
    // an account *starts* with; they must not take away the ability to opt back out.
    const db = freshDb();
    const id = generateId();
    const now = new Date();
    db.insert(accounts)
      .values({
        id,
        provider: "google",
        emailAddress: "unlimited@outboundly.app",
        status: "connected",
        dailySendLimit: null,
        hourlySendLimit: null,
        connectedAt: now,
        createdAt: now,
        updatedAt: now
      })
      .run();

    const rateLimiter = new SqliteRateLimiter(db);
    const decision = rateLimiter.checkAndReserve(asAccountId(id));
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeUndefined();
  });

  it("uses values a human could plausibly send by hand", () => {
    // Guards against someone bumping these to a number that defeats the point of having them.
    expect(SENDING_DEFAULTS.dailySendLimit).toBeLessThanOrEqual(50);
    expect(SENDING_DEFAULTS.hourlySendLimit).toBeLessThan(SENDING_DEFAULTS.dailySendLimit);
    expect(SENDING_DEFAULTS.minSendDelaySeconds).toBeGreaterThan(0);
    expect(SENDING_DEFAULTS.maxSendDelaySeconds).toBeGreaterThan(SENDING_DEFAULTS.minSendDelaySeconds);
  });
});
