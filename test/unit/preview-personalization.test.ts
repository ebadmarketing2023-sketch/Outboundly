import { describe, expect, it } from "vitest";
import { previewCampaignPersonalization } from "../../src/application/campaigns/preview-personalization.js";
import { asContactId, asLeadImportBatchId } from "../../src/core/shared-kernel/ids.js";
import type { Contact, ContactRepository } from "../../src/ports/contact-repository.port.js";

/**
 * The wizard's pre-launch check, over the two lead sources it really supports. The point of these
 * tests is that the preview reads a CSV the same way importContactsCsv will -- same header
 * aliases, same custom-field naming -- so its warnings describe what sending would actually do.
 */

function contact(overrides: Partial<Contact> & { email: string }): Contact {
  return {
    id: asContactId(`c-${overrides.email}`),
    source: "csv_import",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

function repositoryWith(contacts: Contact[]): ContactRepository {
  return {
    async findByEmail() {
      return undefined;
    },
    async findById() {
      return undefined;
    },
    async upsertByEmail() {
      throw new Error("not used");
    },
    async list() {
      return contacts;
    },
    async delete() {}
  };
}

const deps = { contactRepository: repositoryWith([]) };

describe("previewCampaignPersonalization over a CSV that has not been imported yet", () => {
  const csv = ["Email,First Name,Company", "ada@x.com,Ada,Acme", "bo@x.com,Bo,", "cy@x.com,,Cyberdyne"].join("\n");

  it("resolves the CSV's headers to the same variable names sending will use", async () => {
    const preview = await previewCampaignPersonalization(deps, {
      texts: ["Hi {{first_name}}", "You're at {{company}}."],
      leadsSource: { type: "csv", csvText: csv }
    });

    expect(preview.totalLeads).toBe(3);
    expect(preview.tokens).toEqual([
      { name: "first_name", hasFallback: false, missingCount: 1 },
      { name: "company", hasFallback: false, missingCount: 1 }
    ]);
    expect(preview.leadsMissingRequiredValues).toBe(2);
  });

  it("counts a blank cell as missing, exactly as the resolver does", async () => {
    const preview = await previewCampaignPersonalization(deps, {
      texts: ["You're at {{company}}."],
      leadsSource: { type: "csv", csvText: "Email,Company\nbo@x.com,   \n" }
    });
    expect(preview.tokens[0]).toEqual({ name: "company", hasFallback: false, missingCount: 1 });
  });

  it("exposes an unrecognized column under its own header, so {{Website URL}} resolves", async () => {
    const preview = await previewCampaignPersonalization(deps, {
      texts: ["Saw {{Website URL}}"],
      leadsSource: { type: "csv", csvText: "Email,Website URL\nada@x.com,https://acme.test\nbo@x.com,\n" }
    });
    expect(preview.tokens).toEqual([{ name: "Website URL", hasFallback: false, missingCount: 1 }]);
  });

  it("ignores rows the import itself will reject, rather than blaming the template for them", async () => {
    // No email -> importContactsCsv skips the row entirely, so it is not a lead at all.
    const preview = await previewCampaignPersonalization(deps, {
      texts: ["Hi {{first_name}}"],
      leadsSource: { type: "csv", csvText: "Email,First Name\nada@x.com,Ada\n,Nobody\n" }
    });
    expect(preview.totalLeads).toBe(1);
    expect(preview.leadsMissingRequiredValues).toBe(0);
  });

  it("reports a clean bill of health when every lead has every value", async () => {
    const preview = await previewCampaignPersonalization(deps, {
      texts: ["Hi {{first_name}}, you're at {{company}}."],
      leadsSource: { type: "csv", csvText: "Email,First Name,Company\nada@x.com,Ada,Acme\n" }
    });
    expect(preview.leadsMissingRequiredValues).toBe(0);
    expect(preview.tokens.every((t) => t.missingCount === 0)).toBe(true);
  });
});

describe("previewCampaignPersonalization over an existing import batch", () => {
  it("checks only the chosen batch's contacts, not the whole contact list", async () => {
    const batchId = "batch-1";
    const repository = repositoryWith([
      contact({ email: "in@x.com", firstName: "Ada", importBatchId: asLeadImportBatchId(batchId) }),
      contact({ email: "also-in@x.com", importBatchId: asLeadImportBatchId(batchId) }),
      contact({ email: "other@x.com", importBatchId: asLeadImportBatchId("batch-2") })
    ]);

    const preview = await previewCampaignPersonalization(
      { contactRepository: repository },
      { texts: ["Hi {{first_name}}"], leadsSource: { type: "batch", batchId } }
    );

    expect(preview.totalLeads).toBe(2);
    expect(preview.leadsMissingRequiredValues).toBe(1);
  });

  it("reads a batch contact's CSV-imported custom fields", async () => {
    const batchId = "batch-1";
    const repository = repositoryWith([
      contact({ email: "in@x.com", customFields: { "Website URL": "https://acme.test" }, importBatchId: asLeadImportBatchId(batchId) })
    ]);

    const preview = await previewCampaignPersonalization(
      { contactRepository: repository },
      { texts: ["Saw {{Website URL}}"], leadsSource: { type: "batch", batchId } }
    );

    expect(preview.leadsMissingRequiredValues).toBe(0);
  });
});
