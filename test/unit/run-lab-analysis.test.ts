import { describe, expect, it } from "vitest";
import { runLabAnalysis } from "../../src/application/deliverability-lab/run-lab-analysis.js";
import { DraftLifecycleService } from "../../src/core/drafts/draft-lifecycle.js";
import { SystemClock } from "../../src/ports/clock.port.js";
import type { Draft } from "../../src/core/drafts/draft.js";
import type { Repository } from "../../src/ports/repository.port.js";
import type { LabReportRepository, SaveLabReportInput } from "../../src/ports/lab-report-repository.port.js";
import type { DomainAuthChecker, DomainAuthStatus } from "../../src/ports/domain-auth-checker.port.js";
import { paragraph, textRun } from "../../src/core/rendering/document-model.js";
import { EmailAddress } from "../../src/core/shared-kernel/email-address.js";
import type { DraftId } from "../../src/core/shared-kernel/ids.js";

class UnusedDraftRepository implements Repository<Draft, DraftId> {
  async findById(): Promise<Draft | undefined> {
    throw new Error("The Lab must never touch the real drafts table");
  }
  async save(): Promise<void> {
    throw new Error("The Lab must never touch the real drafts table");
  }
  async delete(): Promise<void> {
    throw new Error("The Lab must never touch the real drafts table");
  }
}

class InMemoryLabReportRepository implements LabReportRepository {
  saved: SaveLabReportInput[] = [];
  async save(input: SaveLabReportInput): Promise<void> {
    this.saved.push(input);
  }
}

class FakeDomainAuthChecker implements DomainAuthChecker {
  constructor(private readonly status: DomainAuthStatus) {}
  async check(): Promise<DomainAuthStatus> {
    return this.status;
  }
}

describe("Deliverability Lab (Section 18)", () => {
  const draftLifecycle = new DraftLifecycleService(new UnusedDraftRepository(), new SystemClock());

  it("analyzes a clean hypothetical message without touching any real draft storage", async () => {
    const repo = new InMemoryLabReportRepository();
    const report = await runLabAnalysis({
      input: {
        subject: "Hello",
        document: { blocks: [paragraph(textRun("Hi there, a real message body."))] },
        to: [{ address: EmailAddress.parse("sample@example.com") }],
        from: { address: EmailAddress.parse("me@outboundly.app") },
        sendingDomain: "outboundly.app"
      },
      draftLifecycle,
      repository: repo
    });

    expect(report.score).toBe(100);
    expect(report.findings).toEqual([]);
    expect(repo.saved).toHaveLength(1);
  });

  it("reports an unresolved personalization variable as a finding instead of throwing", async () => {
    const repo = new InMemoryLabReportRepository();
    const report = await runLabAnalysis({
      input: {
        subject: "Hello",
        document: { blocks: [paragraph(textRun("Hi "), { type: "variable", name: "first_name" })] },
        to: [{ address: EmailAddress.parse("sample@example.com") }],
        from: { address: EmailAddress.parse("me@outboundly.app") },
        sendingDomain: "outboundly.app",
        personalizationValues: {}
      },
      draftLifecycle,
      repository: repo
    });

    const finding = report.findings.find((f) => f.ruleId === "content-personalization-unresolved");
    expect(finding?.severity).toBe("blocking");
    expect(finding?.message).toMatch(/first_name/);
  });

  it("includes auth findings only when an auth checker and domain are explicitly supplied", async () => {
    const repo = new InMemoryLabReportRepository();
    const withoutAuth = await runLabAnalysis({
      input: {
        subject: "Hello",
        document: { blocks: [paragraph(textRun("Hi there"))] },
        to: [{ address: EmailAddress.parse("sample@example.com") }],
        from: { address: EmailAddress.parse("me@outboundly.app") },
        sendingDomain: "outboundly.app"
      },
      draftLifecycle,
      repository: repo
    });
    expect(withoutAuth.findings.some((f) => f.category === "auth")).toBe(false);

    const withAuth = await runLabAnalysis({
      input: {
        subject: "Hello",
        document: { blocks: [paragraph(textRun("Hi there"))] },
        to: [{ address: EmailAddress.parse("sample@example.com") }],
        from: { address: EmailAddress.parse("me@outboundly.app") },
        sendingDomain: "outboundly.app",
        authCheck: { domain: "outboundly.app", providerName: "google" }
      },
      draftLifecycle,
      authChecker: new FakeDomainAuthChecker({ spf: "none", dkim: "none", dmarc: "none" }),
      repository: repo
    });
    expect(withAuth.findings.some((f) => f.category === "auth")).toBe(true);
  });
});
