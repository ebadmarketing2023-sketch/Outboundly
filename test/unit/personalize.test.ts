import { describe, expect, it } from "vitest";
import { contactToPersonalizationValues } from "../../src/core/campaigns/personalize.js";
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
