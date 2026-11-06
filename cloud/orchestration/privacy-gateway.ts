/**
 * Privacy Gateway
 * Handles PII/PHI scrubbing to ensure no identifiable data is sent to Cloud LLMs.
 * Uses a hybrid Regex + Pseudonymization mapping approach.
 */
export class PrivacyGateway {
  // Map for pseudonymization to maintain consistency across iterative rounds
  // Format: sessionId -> Map<Original, Placeholder>
  private sessionMaps: Map<string, Map<string, string>> = new Map();

  // The patterns run IN THIS ORDER, each one on the text left by the previous ones.
  // Order matters: a longer, more specific pattern must run before a shorter, looser one,
  // otherwise the loose one replaces only part of the value and the rest leaks.
  //
  // Many regexes use (?<!\d) and (?!\d): "not preceded by a digit" / "not followed by a digit".
  // They make sure we match a WHOLE number, never a piece of a longer one
  // (\b is not enough: in "CNP1960312123456" there is no \b between "P" and "1").
  //
  // Medical values must stay intact: "13,5 g/dL", "92 mg/dL", "120/80", "500 mg",
  // "12 - 16", "2025", "250.000/mm3". None of the patterns below match them
  // (see privacy-gateway.test.ts).
  private readonly PHI_PATTERNS = [
    // Email address. First, so the digits inside an email are not taken by the number patterns.
    { name: 'EMAIL', regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, placeholder: '[EMAIL]' },

    // Romanian IBAN: "RO" + 2 check digits + 4 bank letters + 16 letters/digits,
    // e.g. "RO49AAAA1B31007593840000" or grouped "RO49 AAAA 1B31 0075 9384 0000".
    // Before CNP/phones, because an IBAN contains long digit runs that they could half-match.
    { name: 'IBAN', regex: /\bRO\d{2}\s?[A-Z]{4}(?:\s?[A-Z0-9]){16}/gi, placeholder: '[IBAN]' },

    // CNP (Romanian personal numeric code): exactly 13 digits, the first one 1-9.
    // Before the phone patterns: a phone pattern would otherwise replace 10 of the 13 digits
    // and leave the other 3 in the text.
    { name: 'CNP', regex: /(?<!\d)[1-9]\d{12}(?!\d)/g, placeholder: '[CNP]' },

    // Date: day, month, year separated by "/", "-" or "." (14.03.2025, 1.3.25, 14/03/2025, 14-03-2025).
    // Before RO_PHONE: "03.02.2025 10" has 0 + 3 + 8 more digits, so RO_PHONE would take it as a phone.
    // Needs TWO separators, so "120/80", "13.5" and "250.000" are not dates.
    { name: 'DATE', regex: /(?<!\d)\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})(?!\d)/g, placeholder: '[DATE]' },

    // Romanian phone: prefix "+40", "0040" or "0", then 2/3 (landline) or 7 (mobile), then 8 digits.
    // That is 10 digits in national form: 0722 123 456, 0722123456, 0722-123-456, 0722.123.456,
    // +40 722 123 456, +40722123456, 021 123 4567, 0264 123 456.
    // [\s.-]? allows ONE space, dot or dash between digits (so "12 - 16" with " - " never joins).
    { name: 'RO_PHONE', regex: /(?<![\d+])(?:\+40|0040|0)[\s.-]?[237](?:[\s.-]?\d){8}(?!\d)/g, placeholder: '[PHONE]' },

    // US-style phone: (555) 123-4567, 555-123-4567. After RO_PHONE, so Romanian numbers
    // (including the "+40" prefix) are matched whole by the pattern made for them.
    { name: 'PHONE', regex: /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, placeholder: '[PHONE]' },

    // US Social Security Number: 123-45-6789.
    { name: 'SSN', regex: /\b\d{3}-\d{2}-\d{4}\b/g, placeholder: '[SSN]' },
  ];

  /**
   * Scrubs PII/PHI from a string.
   * Fail-closed: anything that is not a string throws, and the orchestrator then
   * refuses to call the LLM (it never sends text it could not scrub).
   */
  async scrub(text: string, sessionId: string): Promise<string> {
    if (typeof text !== 'string') {
      throw new TypeError(`PrivacyGateway.scrub expected a string, got ${typeof text}`);
    }

    let scrubbedText = text;

    // 1. Apply standard regex patterns
    for (const pattern of this.PHI_PATTERNS) {
      scrubbedText = scrubbedText.replace(pattern.regex, pattern.placeholder);
    }

    // 2. Handle session-based pseudonymization for names/identifiers
    // In MVP, we look for common "Name: X" patterns or rely on a simple map
    // if the orchestrator provides specific entities.

    return scrubbedText;
  }

  /**
   * Restores PII/PHI from a scrubbed string (only for final Doctor view).
   */
  async unscrub(text: string, sessionId: string): Promise<string> {
    // In a full implementation, this would use the sessionMap to reverse replacements.
    // For MVP, it ensures placeholders are flagged for the doctor.
    return text;
  }

  /**
   * Recursively scrubs objects (e.g., CaseSummary).
   */
  async scrubObject(obj: any, sessionId: string): Promise<any> {
    if (typeof obj === 'string') {
      return this.scrub(obj, sessionId);
    }
    if (Array.isArray(obj)) {
      return Promise.all(obj.map(item => this.scrubObject(item, sessionId)));
    }
    if (typeof obj === 'object' && obj !== null) {
      const scrubbedObj = { ...obj };
      for (const key in scrubbedObj) {
        scrubbedObj[key] = await this.scrubObject(scrubbedObj[key], sessionId);
      }
      return scrubbedObj;
    }
    return obj;
  }

  /**
   * Recursively unscrubs objects.
   */
  async unscrubObject(obj: any, sessionId: string): Promise<any> {
    if (typeof obj === 'string') {
      return this.unscrub(obj, sessionId);
    }
    if (Array.isArray(obj)) {
      return Promise.all(obj.map(item => this.unscrubObject(item, sessionId)));
    }
    if (typeof obj === 'object' && obj !== null) {
      const unscrubbedObj = { ...obj };
      for (const key in unscrubbedObj) {
        unscrubbedObj[key] = await this.unscrubObject(unscrubbedObj[key], sessionId);
      }
      return unscrubbedObj;
    }
    return obj;
  }
}

export const privacyGateway = new PrivacyGateway();
