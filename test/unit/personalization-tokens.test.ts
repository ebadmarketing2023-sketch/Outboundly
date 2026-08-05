import { describe, expect, it } from "vitest";
import { previewPersonalization } from "../../src/core/campaigns/personalization-preview.js";
import { MissingPersonalizationValueError, collectVariableNames, resolveVariables } from "../../src/core/rendering/document-model.js";
import { collectTextTokens, resolveTextTokens, splitTextIntoInlineNodes } from "../../src/core/rendering/personalization-tokens.js";
import { parsePlainTextToDocument } from "../../src/core/rendering/plain-text-parser.js";
import { renderPlainText } from "../../src/core/rendering/text-renderer.js";

/**
 * The bug behind all of this: personalization was fully implemented and thoroughly tested, but
 * every one of those tests hand-built `{ type: "variable" }` nodes. Nothing in src/ ever
 * constructed one -- parsePlainTextToDocument turned each line into a plain TextRun -- so real
 * templates were rendered and sent with "Hi {{first_name}}," literally in them.
 *
 * Hence the rule these tests follow: anything asserting personalization works must start from the
 * text a user actually types and go through the real parser, never from a hand-built node.
 */

describe("token tokenizer", () => {
  it("splits a line into literal and variable nodes", () => {
    expect(splitTextIntoInlineNodes("Hi {{first_name}}, welcome")).toEqual([
      { type: "text", text: "Hi ", marks: [] },
      { type: "variable", name: "first_name", fallback: undefined },
      { type: "text", text: ", welcome", marks: [] }
    ]);
  });

  it("produces exactly one TextRun for text with no tokens, i.e. the pre-existing behavior", () => {
    expect(splitTextIntoInlineNodes("Just checking in.")).toEqual([{ type: "text", text: "Just checking in.", marks: [] }]);
  });

  it("captures a fallback and distinguishes an empty one from none at all", () => {
    expect(collectTextTokens("{{a}} {{b|there}} {{c|}}")).toEqual([
      { name: "a" },
      { name: "b", fallback: "there" },
      { name: "c", fallback: "" }
    ]);
  });

  it("allows spaces in a name, because CSV headers become custom field names verbatim", () => {
    expect(collectTextTokens("See {{Website URL}}")).toEqual([{ name: "Website URL" }]);
  });

  it("reports each distinct token once, in first-seen order", () => {
    expect(collectTextTokens("{{b}} {{a}} {{b}}").map((t) => t.name)).toEqual(["b", "a"]);
  });

  it("leaves malformed or unclosed braces alone rather than guessing", () => {
    expect(splitTextIntoInlineNodes("{{unclosed and { single } braces")).toEqual([
      { type: "text", text: "{{unclosed and { single } braces", marks: [] }
    ]);
  });
});

describe("a typed template body, through the real parser", () => {
  it("turns {{first_name}} into a variable the resolver can actually see", () => {
    const doc = parsePlainTextToDocument("Hi {{first_name}},\n\nSaw you're at {{company}}.");
    expect(collectVariableNames(doc)).toEqual(["first_name", "company"]);
  });

  it("renders the contact's real values, not the literal token text", () => {
    const doc = parsePlainTextToDocument("Hi {{first_name}},\n\nSaw you're at {{company}}.");
    const resolved = resolveVariables(doc, { first_name: "Ada", company: "Acme" });
    expect(renderPlainText(resolved)).toBe("Hi Ada,\n\nSaw you're at Acme.");
    expect(renderPlainText(resolved)).not.toContain("{{");
  });

  it("uses the fallback when the lead has no value", () => {
    const doc = parsePlainTextToDocument("Saw you're at {{company|your company}}.");
    expect(renderPlainText(resolveVariables(doc, { email: "x@y.z" }))).toBe("Saw you're at your company.");
  });

  it("treats a blank CSV cell exactly like a missing column", () => {
    const doc = parsePlainTextToDocument("Saw you're at {{company|your company}}.");
    expect(renderPlainText(resolveVariables(doc, { company: "   " }))).toBe("Saw you're at your company.");
  });

  it("honors an empty fallback as a real instruction to render nothing", () => {
    const doc = parsePlainTextToDocument("Hi{{suffix|}}.");
    expect(renderPlainText(resolveVariables(doc, {}))).toBe("Hi.");
  });

  it("hard-stops on a token with no fallback and no value, rather than sending \"Hi ,\"", () => {
    const doc = parsePlainTextToDocument("Hi {{first_name}},");
    expect(() => resolveVariables(doc, { email: "x@y.z" })).toThrow(MissingPersonalizationValueError);
  });

  it("keeps line structure intact around tokens", () => {
    const doc = parsePlainTextToDocument("Hi {{first_name}},\n\nBest,\nMe");
    const resolved = resolveVariables(doc, { first_name: "Ada" });
    expect(renderPlainText(resolved)).toBe("Hi Ada,\n\nBest,\nMe");
  });
});

describe("resolveTextTokens (subject lines)", () => {
  it("resolves a subject by the same rules as a body", () => {
    const onMissing = (name: string): string => {
      throw new MissingPersonalizationValueError(name);
    };
    expect(resolveTextTokens("Quick question, {{first_name}}", { first_name: "Ada" }, onMissing)).toBe("Quick question, Ada");
    expect(resolveTextTokens("Quick question, {{first_name|there}}", {}, onMissing)).toBe("Quick question, there");
    expect(() => resolveTextTokens("Hi {{first_name}}", {}, onMissing)).toThrow(MissingPersonalizationValueError);
  });
});

describe("previewPersonalization (the wizard's pre-launch check)", () => {
  const leads = [
    { email: "a@x.com", first_name: "Ada", company: "Acme" },
    { email: "b@x.com", first_name: "Bo" },
    { email: "c@x.com" }
  ];

  it("counts, per token, how many leads have no value", () => {
    const preview = previewPersonalization(["Hi {{first_name}}", "You're at {{company}}."], leads);
    expect(preview.totalLeads).toBe(3);
    expect(preview.tokens).toEqual([
      { name: "first_name", hasFallback: false, missingCount: 1 },
      { name: "company", hasFallback: false, missingCount: 2 }
    ]);
  });

  it("reports how many leads would be skipped outright, deduplicating leads short of several tokens", () => {
    // c@x.com is missing both, but it is one lead, not two.
    const preview = previewPersonalization(["Hi {{first_name}}, you're at {{company}}."], leads);
    expect(preview.leadsMissingRequiredValues).toBe(2);
  });

  it("does not count a token with a fallback against the skip total", () => {
    const preview = previewPersonalization(["Hi {{first_name|there}}, you're at {{company|your company}}."], leads);
    expect(preview.leadsMissingRequiredValues).toBe(0);
    expect(preview.tokens.every((t) => t.hasFallback)).toBe(true);
    // Still surfaces the coverage gap, since the user may prefer to fix the data.
    expect(preview.tokens.find((t) => t.name === "company")?.missingCount).toBe(2);
  });

  it("treats a token written both with and without a fallback as required", () => {
    // The occurrence lacking one is the occurrence that throws, so the warning must reflect that.
    const preview = previewPersonalization(["Hi {{first_name|there}}", "Following up, {{first_name}}"], leads);
    expect(preview.tokens).toEqual([{ name: "first_name", hasFallback: false, missingCount: 1 }]);
    expect(preview.leadsMissingRequiredValues).toBe(1);
  });

  it("agrees with what resolveVariables really does for each lead", () => {
    const body = "Hi {{first_name}}, you're at {{company}}.";
    const preview = previewPersonalization([body], leads);
    const doc = parsePlainTextToDocument(body);
    const actuallyFailed = leads.filter((values) => {
      try {
        resolveVariables(doc, values);
        return false;
      } catch {
        return true;
      }
    }).length;
    expect(preview.leadsMissingRequiredValues).toBe(actuallyFailed);
  });

  it("says there is nothing to check when the copy uses no tokens", () => {
    const preview = previewPersonalization(["Just checking in."], leads);
    expect(preview.tokens).toEqual([]);
    expect(preview.leadsMissingRequiredValues).toBe(0);
  });

  it("handles having no leads at all without dividing the user's attention by zero", () => {
    const preview = previewPersonalization(["Hi {{first_name}}"], []);
    expect(preview.totalLeads).toBe(0);
    expect(preview.tokens).toEqual([{ name: "first_name", hasFallback: false, missingCount: 0 }]);
  });
});
