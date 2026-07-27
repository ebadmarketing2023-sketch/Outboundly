import { parseNamedAddress } from "../shared-kernel/email-address.js";

/**
 * Participant matching (Section 11.2): reconciles the same real contact appearing under
 * different display names or address casing within one conversation. This function derives the
 * raw participant list from one message's headers; deduping against a thread's existing
 * participants (upsert-by-email) is the inbox sync use case's job, since that requires reading
 * current state (I/O), not something this pure function can decide alone.
 */

export type ParticipantRole = "sender" | "to" | "cc";

export interface DerivedParticipant {
  emailAddress: string;
  displayName?: string;
  role: ParticipantRole;
}

export interface ParticipantSourceMessage {
  from: string;
  to: string[];
  cc?: string[];
}

export function deriveParticipants(message: ParticipantSourceMessage): DerivedParticipant[] {
  const participants: DerivedParticipant[] = [];

  const pushAddress = (raw: string, role: ParticipantRole) => {
    // Inbound headers are untrusted external input (Section 23) — a single malformed address
    // (a mailing-list header quirk, a group-syntax address, etc.) should be skipped, not crash
    // processing of the rest of the message.
    try {
      const parsed = parseNamedAddress(raw);
      participants.push({
        emailAddress: parsed.address.toString(),
        displayName: parsed.displayName,
        role
      });
    } catch {
      // Skip unparsable address rather than failing the whole message.
    }
  };

  if (message.from) pushAddress(message.from, "sender");
  message.to.forEach((addr) => pushAddress(addr, "to"));
  (message.cc ?? []).forEach((addr) => pushAddress(addr, "cc"));

  return participants;
}
