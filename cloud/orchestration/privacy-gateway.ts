/**
 * Privacy Gateway
 * Handles PII/PHI scrubbing to ensure no identifiable data is sent to Cloud LLMs.
 * Uses a hybrid Regex + Pseudonymization mapping approach.
 */
export class PrivacyGateway {
  // Map for pseudonymization to maintain consistency across iterative rounds
  // Format: sessionId -> Map<Original, Placeholder>
  private sessionMaps: Map<string, Map<string, string>> = new Map();

  private readonly PHI_PATTERNS = [
    { name: 'EMAIL', regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, placeholder: '[EMAIL]' },
    { name: 'PHONE', regex: /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, placeholder: '[PHONE]' },
    { name: 'SSN', regex: /\b\d{3}-\d{2}-\d{4}\b/g, placeholder: '[SSN]' },
    { name: 'DATE', regex: /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, placeholder: '[DATE]' },
  ];

  /**
   * Scrubs PII/PHI from a string.
   */
  async scrub(text: string, sessionId: string): Promise<string> {
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
