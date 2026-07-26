import type { CompatibilityReport } from "../core/gmail-compatibility/types.js";

/**
 * The typed contract crossing the UI <-> core boundary (Section 1.3, Section 23). Both the
 * preload script and the renderer import these types, so a payload shape change is a compile
 * error on both sides rather than a runtime surprise.
 */

export interface AccountSummary {
  id: string;
  provider: string;
  emailAddress: string;
  displayName?: string;
  status: string;
}

export interface DraftSummary {
  id: string;
  accountId: string;
  subject: string;
  to: string[];
  autosaveVersion: number;
  lastSavedAt: string;
}

export interface CreateDraftRequest {
  accountId: string;
  subject: string;
  to: string[];
  body: string;
}

export interface AutosaveDraftRequest {
  draftId: string;
  subject?: string;
  body?: string;
}

export interface SendDraftRequest {
  draftId: string;
}

export interface SendDraftResponse {
  sent: boolean;
  compatibilityReport: CompatibilityReport;
  providerMessageId?: string;
}

export interface OutboundlyRendererApi {
  listAccounts(): Promise<AccountSummary[]>;
  connectGoogleAccount(): Promise<AccountSummary>;
  createDraft(request: CreateDraftRequest): Promise<DraftSummary>;
  autosaveDraft(request: AutosaveDraftRequest): Promise<DraftSummary>;
  sendDraft(request: SendDraftRequest): Promise<SendDraftResponse>;
}
