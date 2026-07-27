/**
 * Reference graph reconstruction (Section 11.2). Unlike a flat `thread_id`, this builds the
 * actual ordered chain of ancestor Message-IDs a message references, which is what makes correct
 * reply attribution possible even across forwards and partial quote chains — and is the only
 * mechanism that works uniformly across every provider, including SMTP/IMAP accounts that have
 * no native thread concept at all (Section 11.3).
 */

const MESSAGE_ID_TOKEN_PATTERN = /<[^<>\s]+>/g;

export interface ReferenceChainInput {
  inReplyToHeader?: string;
  referencesHeader?: string;
}

/** Ordered ancestor Message-IDs (oldest first), with the immediate parent (In-Reply-To) guaranteed to be present and last. */
export function parseReferenceChain(input: ReferenceChainInput): string[] {
  const fromReferences = input.referencesHeader?.match(MESSAGE_ID_TOKEN_PATTERN) ?? [];
  const inReplyTo = input.inReplyToHeader?.match(MESSAGE_ID_TOKEN_PATTERN)?.[0];

  const chain = [...fromReferences];
  if (inReplyTo && !chain.includes(inReplyTo)) {
    chain.push(inReplyTo);
  }
  return chain;
}
