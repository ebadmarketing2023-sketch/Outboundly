import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OutboundlyDb } from "../../src/adapters/persistence/db.js";
import { accounts } from "../../src/adapters/persistence/schema.js";
import { SqliteDraftRepository } from "../../src/adapters/persistence/repositories/draft-repository.js";
import { DraftLifecycleService } from "../../src/core/drafts/draft-lifecycle.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import { paragraph, textRun } from "../../src/core/rendering/document-model.js";
import { EmailAddress } from "../../src/core/shared-kernel/email-address.js";
import { asAccountId } from "../../src/core/shared-kernel/ids.js";

describe("SqliteDraftRepository (Section 7 persistence)", () => {
  let db: OutboundlyDb;
  let accountId: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "outboundly-draft-repo-test-"));
    db = openDatabase(join(dir, "test.sqlite"));
    accountId = randomUUID();
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

  it("round-trips a draft, including its Internal Document Model and named addresses", async () => {
    const repo = new SqliteDraftRepository(db);
    const service = new DraftLifecycleService(repo, new SystemClock());

    const created = await service.createDraft({
      accountId: asAccountId(accountId),
      subject: "Hello",
      document: { blocks: [paragraph(textRun("Hi there", ["bold"]))] },
      to: [{ address: EmailAddress.parse("them@example.com"), displayName: "Them" }]
    });

    const reloaded = await repo.findById(created.id);
    expect(reloaded).toBeDefined();
    expect(reloaded?.subject).toBe("Hello");
    expect(reloaded?.to[0]?.displayName).toBe("Them");
    expect(reloaded?.to[0]?.address.toString()).toBe("them@example.com");
    expect(reloaded?.document).toEqual(created.document);

    const resaved = await service.autosave(created.id, { subject: "Updated subject" });
    const reloadedAgain = await repo.findById(created.id);
    expect(reloadedAgain?.subject).toBe("Updated subject");
    expect(reloadedAgain?.autosaveVersion).toBe(resaved.autosaveVersion);
  });
});
