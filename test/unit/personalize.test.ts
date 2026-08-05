import { describe, expect, it } from "vitest";
import {
  accountPersonalizationValues,
  contactToPersonalizationValues,
  personalizationValuesFor
} from "../../src/core/campaigns/personalize.js";
import type { Contact } from "../../src/ports/contact-repository.port.js";
import { asContactId } from "../../src/core/shared-kernel/ids.js";

function baseContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: asContactId("c1"),
    email: "lead@example.com",
    source: "manual",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

describe("contactToPersonalizationValues (Section 9.2 stage 3)", () => {
  it("always includes email even when nothing else is known", () => {
    expect(contactToPersonalizationValues(baseContact())).toEqual({ email: "lead@example.com" });
  });

  it("maps known contact fields to their snake_case variable names", () => {
    const values = contactToPersonalizationValues(
      baseContact({ firstName: "Ada", lastName: "Lovelace", company: "Analytical Engines", title: "Engineer", timezone: "Europe/London" })
    );
    expect(values).toEqual({
      email: "lead@example.com",
      first_name: "Ada",
      last_name: "Lovelace",
      company: "Analytical Engines",
      title: "Engineer",
      timezone: "Europe/London"
    });
  });

  it("omits a field entirely rather than mapping it to an empty string when unset", () => {
    const values = contactToPersonalizationValues(baseContact({ firstName: "Ada" }));
    expect(values).not.toHaveProperty("last_name");
    expect(values).not.toHaveProperty("company");
  });

  it("exposes CSV-imported custom fields under their own original header name", () => {
    const values = contactToPersonalizationValues(baseContact({ customFields: { "Favorite Color": "Blue" } }));
    expect(values["Favorite Color"]).toBe("Blue");
  });
});

describe("account tokens", () => {
  it("resolves {{Account Name}} from the mailbox's own profile name, in both casings", () => {
    const values = accountPersonalizationValues({ emailAddress: "me@outboundly.app", displayName: "Ebad" });
    expect(values["Account Name"]).toBe("Ebad");
    expect(values.account_name).toBe("Ebad");
    expect(values["Account Email"]).toBe("me@outboundly.app");
    expect(values.account_email).toBe("me@outboundly.app");
  });

  it("falls back to the mailbox's local part when the account has no profile name", () => {
    // It has to produce *something*: an empty value would make this token the same silent
    // campaign-wide hard stop it exists to fix.
    expect(accountPersonalizationValues({ emailAddress: "outreach@acme.test" })["Account Name"]).toBe("outreach");
    expect(accountPersonalizationValues({ emailAddress: "outreach@acme.test", displayName: "   " })["Account Name"]).toBe("outreach");
  });

  it("wins over a lead field of the same name, so a CSV column can't rewrite the sender's signature", () => {
    const contact = baseContact({ customFields: { "Account Name": "Some Lead's CRM Account" } });
    const values = personalizationValuesFor(contact, { emailAddress: "me@outboundly.app", displayName: "Ebad" });
    expect(values["Account Name"]).toBe("Ebad");
  });

  it("still exposes every lead field alongside them", () => {
    const values = personalizationValuesFor(baseContact({ firstName: "Ada" }), { emailAddress: "me@outboundly.app", displayName: "Ebad" });
    expect(values.first_name).toBe("Ada");
    expect(values["Account Name"]).toBe("Ebad");
  });
});
