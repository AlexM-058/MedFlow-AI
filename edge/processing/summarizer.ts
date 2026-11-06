import { CaseSummary } from "../../core/schemas/case-summary";

/**
 * Edge Summarizer
 * Responsible for transforming a raw conversation transcript into a structured CaseSummary.
 * In a real scenario, this would call a local LLM with a specific extraction prompt.
 */
export class EdgeSummarizer {
  /**
   * Extracts structured data from the conversation transcript.
   * @param transcript The full conversation between Patient AI and Patient.
   * @param patientId The ID of the patient.
   * @param lang The language of the conversation.
   */
  async summarize(transcript: string, patientId: string, lang: 'ro' | 'en' = 'ro'): Promise<CaseSummary> {
    // In the MVP, we simulate the LLM extraction logic.
    // In production, this would be an Ollama call with a prompt like:
    // "Extract the following fields from this transcript into JSON: chiefComplaint, onset, duration, pattern, severity, associatedSymptoms, currentMedications, allergiesConditions"

    console.log(`[EdgeSummarizer] Processing transcript for patient ${patientId} in ${lang}...`);

    // Simulated extraction based on common patterns in the transcript
    return {
      chiefComplaint: this.extractField(transcript, /chief complaint:?\s*(.*)/i) || "Not specified",
      onset: this.extractField(transcript, /onset:?\s*(.*)/i) || "Not specified",
      duration: this.extractField(transcript, /duration:?\s*(.*)/i) || "Not specified",
      pattern: this.extractField(transcript, /pattern:?\s*(.*)/i) || "Not specified",
      severity: parseInt(this.extractField(transcript, /severity:?\s*(\d+)/i) || "0"),
      associatedSymptoms: this.extractList(transcript, /associated symptoms:?\s*(.*)/i),
      currentMedications: this.extractList(transcript, /medications:?\s*(.*)/i),
      allergiesConditions: this.extractList(transcript, /allergies:?\s*(.*)/i),
      redFlagsDetected: /ATENȚIE|WARNING/i.test(transcript),
      rawTranscript: transcript,
      metadata: {
        timestamp: new Date().toISOString(),
        patientId: patientId,
        language: lang,
      },
    };
  }

  private extractField(text: string, regex: RegExp): string | null {
    const match = text.match(regex);
    // match[1] = the text captured by the first (...) group; TypeScript treats it as possibly undefined.
    const captured = match ? match[1] : undefined;
    return captured !== undefined ? captured.trim() : null;
  }

  private extractList(text: string, regex: RegExp): string[] {
    const match = text.match(regex);
    const captured = match ? match[1] : undefined;
    if (captured === undefined) return [];
    return captured.split(',').map(item => item.trim()).filter(item => item !== "");
  }
}
