const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class InvalidEmailAddressError extends Error {
  constructor(raw: string) {
    super(`"${raw}" is not a valid email address`);
    this.name = "InvalidEmailAddressError";
  }
}

/**
 * A validated email address. Domain comparison is case-insensitive per RFC 5321;
 * the local part is preserved as-authored since the RFC leaves its case significance
 * to the receiving system.
 */
export class EmailAddress {
  readonly localPart: string;
  readonly domain: string;

  private constructor(localPart: string, domain: string) {
    this.localPart = localPart;
    this.domain = domain;
  }

  static parse(raw: string): EmailAddress {
    const trimmed = raw.trim();
    if (!EMAIL_PATTERN.test(trimmed)) {
      throw new InvalidEmailAddressError(raw);
    }
    const atIndex = trimmed.lastIndexOf("@");
    return new EmailAddress(trimmed.slice(0, atIndex), trimmed.slice(atIndex + 1));
  }

  static tryParse(raw: string): EmailAddress | undefined {
    try {
      return EmailAddress.parse(raw);
    } catch {
      return undefined;
    }
  }

  toString(): string {
    return `${this.localPart}@${this.domain}`;
  }

  equals(other: EmailAddress): boolean {
    return (
      this.localPart === other.localPart &&
      this.domain.toLowerCase() === other.domain.toLowerCase()
    );
  }
}

export interface NamedEmailAddress {
  address: EmailAddress;
  displayName?: string;
}

export function formatNamedAddress(named: NamedEmailAddress): string {
  if (!named.displayName) {
    return named.address.toString();
  }
  const escaped = named.displayName.replace(/"/g, '\\"');
  return `"${escaped}" <${named.address.toString()}>`;
}

const NAMED_ADDRESS_PATTERN = /^"?([^"<]*)"?\s*<([^>]+)>$/;

/** Parses the "Name" <address> form back into a NamedEmailAddress (used for DB round-tripping). */
export function parseNamedAddress(raw: string): NamedEmailAddress {
  const trimmed = raw.trim();
  const match = trimmed.match(NAMED_ADDRESS_PATTERN);
  if (match) {
    const [, displayName, email] = match;
    const trimmedName = displayName?.trim();
    return { address: EmailAddress.parse(email!), displayName: trimmedName || undefined };
  }
  return { address: EmailAddress.parse(trimmed) };
}
