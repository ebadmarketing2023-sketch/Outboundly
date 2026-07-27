import { evaluateGmailCompatibility } from "../../core/gmail-compatibility/engine.js";
import { evaluateDeliverability } from "../../core/deliverability/engine.js";
import type { DeliverabilityFinding, DeliverabilityReport } from "../../core/deliverability/types.js";
import type { DraftLifecycleService } from "../../core/drafts/draft-lifecycle.js";
import type { Draft } from "../../core/drafts/draft.js";
import { collectVariableNames, resolveVariables } from "../../core/rendering/document-model.js";
import type { Document } from "../../core/rendering/document-model.js";
import { extractPlainAndHtmlBodies } from "../../core/mime/mime-generator.js";
import type { NamedEmailAddress } from "../../core/shared-kernel/email-address.js";
import { generateId } from "../../core/shared-kernel/ids.js";
import { asAccountId, asDraftId } from "../../core/shared-kernel/ids.js";
import type { DomainAuthChecker } from "../../ports/domain-auth-checker.port.js";
import type { LabReportRepository } from "../../ports/lab-report-repository.port.js";

/**
 * The Deliverability Lab (Section 18): an on-demand "what if" sandbox, zero side effects — no
 * account is touched to build the message, nothing is queued or sent. The Draft object used here
 * is entirely synthetic (a random id, never persisted, never touching the drafts table) — the
 * exact same DraftLifecycleService.buildMimeMessage() the real send pipeline uses is pure/I-O
 * free (Section 9.2 stage 4-9 logic), so it works identically against a fabricated Draft as
 * against a real one.
 */

export interface LabAnalysisInput {
  subject: string;
  document: Document;
  to: NamedEmailAddress[];
  from: NamedEmailAddress;
  sendingDomain: string;
  personalizationValues?: Record<string, string>;
  /** Optional — Section 18.2's "Authentication" check, delegated to the Account Health Engine's
   * domain-auth checks (Section 19.2). Omitted entirely if the caller doesn't supply a checker
   * and domain, since "no account is touched" unless the user explicitly asks for this. */
  authCheck?: { domain: string; providerName: string };
}

const UNRESOLVED_PLACEHOLDER_PREFIX = "[missing sample value: ";

export interface RunLabAnalysisParams {
  input: LabAnalysisInput;
  draftLifecycle: DraftLifecycleService;
  authChecker?: DomainAuthChecker;
  repository: LabReportRepository;
  now?: Date;
}

export async function runLabAnalysis(params: RunLabAnalysisParams): Promise<DeliverabilityReport> {
  const values = params.input.personalizationValues ?? {};
  const requiredVariables = collectVariableNames(params.input.document);
  const missingVariables = requiredVariables.filter((name) => values[name] === undefined);

  // Section 18.2: "whether every personalization variable actually resolves for the supplied
  // sample data" is itself one of the Lab's checks, not something that should abort the whole
  // analysis the way an unresolved token does in the real send pipeline (Section 9.2 stage 3) —
  // a placeholder lets the rest of the message still get built and analyzed.
  const placeholderValues = { ...values };
  for (const name of missingVariables) {
    placeholderValues[name] = `${UNRESOLVED_PLACEHOLDER_PREFIX}${name}]`;
  }

  const fakeDraft: Draft = {
    id: asDraftId(generateId()),
    accountId: asAccountId("deliverability-lab-sandbox"),
    subject: params.input.subject,
    document: resolveVariables(params.input.document, placeholderValues),
    to: params.input.to,
    cc: [],
    bcc: [],
    autosaveVersion: 0,
    lastSavedAt: params.now ?? new Date()
  };

  const built = params.draftLifecycle.buildMimeMessage(fakeDraft, {
    from: params.input.from,
    sendingDomain: params.input.sendingDomain
    // No personalizationValues here: already resolved above (with placeholders) so the
    // missing-variable findings below are the ones the caller sees, not a second silent pass.
  });

  const compatibilityReport = evaluateGmailCompatibility(built);
  const bodies = extractPlainAndHtmlBodies(built.root);

  const authStatus =
    params.input.authCheck && params.authChecker
      ? await params.authChecker.check(params.input.authCheck.domain, params.input.authCheck.providerName)
      : undefined;

  const deliverabilityReport = evaluateDeliverability({
    message: built,
    compatibilityReport,
    authenticatedAccountEmail: params.input.from.address.toString(),
    bodyHtml: bodies.html,
    bodyText: bodies.text,
    authStatus
  });

  const unresolvedFindings: DeliverabilityFinding[] = missingVariables.map((name) => ({
    ruleId: "content-personalization-unresolved",
    category: "content",
    severity: "blocking",
    message: `Personalization variable "${name}" has no sample value`,
    explanation: 'A real send would hard-stop here (Section 9.2 stage 3) rather than send "Hi {{first_name}},". Supply a sample value to see the rest of the analysis as it would really render.'
  }));

  const report: DeliverabilityReport = {
    findings: [...unresolvedFindings, ...deliverabilityReport.findings],
    score: unresolvedFindings.length > 0 ? Math.max(0, deliverabilityReport.score - unresolvedFindings.length * 30) : deliverabilityReport.score
  };

  await params.repository.save({
    inputSnapshot: {
      subject: params.input.subject,
      to: params.input.to.map((a) => a.address.toString()),
      from: params.input.from.address.toString(),
      sendingDomain: params.input.sendingDomain,
      personalizationValues: values
    },
    report,
    generatedAt: params.now ?? new Date()
  });

  return report;
}
